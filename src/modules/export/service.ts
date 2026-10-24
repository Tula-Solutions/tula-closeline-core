import {
  type createExportRequestSchema,
  decodeCursor,
  ERRORS,
  EXPORT_ERRORS,
  EXPORT_LINK_HOURS,
  EXPORT_SERVICES,
  type ExportDownload,
  type ExportFailureReason,
  type ExportJob,
  type ExportJobId,
  type ExportService,
  encodeCursor,
  exportDownloadSchema,
  exportJobSchema,
  formatId,
  type listExportsQuerySchema,
  MAX_EXPORTS_PER_DAY,
  type OrganizationId,
  type Page,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { enqueueEvents } from '~/modules/prospect/events'
import type { OrganizationScope } from '~/ports/core-store'
import type {
  ExportJobRecord,
  ExportPartFailureReason,
  ExportPartRecord,
} from '~/ports/export-store'
import { type ExportFilePage, exportCursorSchema } from './schema'
import { mintExportDownloadToken, readExportDownloadToken } from './token'

/** What the export service and its worker need from the container. */
export type ExportDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'jobs' | 'objects' | 'env'>

/** How long an export may stay queued or running before it counts as failed (`timed_out`), in ms. */
export const EXPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000

/** How long a presigned link in a download page works, in seconds. */
export const EXPORT_FILE_LINK_SECONDS = 300

/** The most files the manifest lists for one service's part. */
export const MAX_MANIFEST_FILES_PER_PART = 10_000

const HOUR_MS = 60 * 60 * 1000

type CreateRequest = z.output<typeof createExportRequestSchema>
type ListQuery = z.output<typeof listExportsQuerySchema>

/** What a call is given besides its request: the trace id and the validated `Idempotency-Key`. */
export type ExportCallOptions = { traceId: string; idempotencyKey?: string | undefined }

/**
 * The services that must each deliver a part before an export is ready: core always, plus the
 * services named in `EXPORT_PART_SERVICES`, in the contract's order.
 */
export function exportServices(env: { EXPORT_PART_SERVICES: string }): ExportService[] {
  const named = new Set(env.EXPORT_PART_SERVICES.split(',').map((name) => name.trim()))
  named.add('core')
  return EXPORT_SERVICES.filter((service) => named.has(service))
}

/** The object-storage prefix of a service's part of an export. */
export function exportPartPrefix(exportId: ExportJobId, service: ExportService): string {
  return `exports/${exportId}/${service}`
}

/** The key of an export's manifest. */
export function exportManifestKey(exportId: ExportJobId): string {
  return `exports/${exportId}/manifest.json`
}

const isActive = (job: ExportJobRecord): boolean =>
  job.state === 'queued' || job.state === 'running'

const isStale = (job: ExportJobRecord, now: Date): boolean =>
  isActive(job) && now.getTime() - job.requestedAt.getTime() > EXPORT_TIMEOUT_MS

const isDue = (job: ExportJobRecord, now: Date): boolean =>
  job.state === 'ready' && job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime()

/**
 * The API shape of a job as of `now`. The state is read, never stored, for two cases: a job past
 * its time limit reads as failed (`timed_out`) and a ready job past its expiry reads as expired.
 * The link is never part of it.
 */
export function toExportJob(
  job: ExportJobRecord,
  parts: readonly ExportPartRecord[],
  now: Date
): ExportJob {
  const stale = isStale(job, now)
  const state = stale ? 'failed' : isDue(job, now) ? 'expired' : job.state
  return exportJobSchema.parse({
    id: job.id,
    kind: 'organization',
    format: null,
    filter: null,
    state,
    requestedByMembershipId: job.requestedByMembershipId,
    includeRecordingLinks: job.includeRecordingLinks,
    parts: parts
      .filter((part) => part.exportId === job.id)
      .map((part) => ({
        service: part.service,
        state: part.state,
        fileCount: part.fileCount,
        bytes: part.bytes,
        readyAt: part.readyAt?.toISOString() ?? null,
      })),
    failureReason: stale ? 'timed_out' : job.failureReason,
    requestedAt: job.requestedAt.toISOString(),
    completedAt:
      (stale
        ? new Date(job.requestedAt.getTime() + EXPORT_TIMEOUT_MS)
        : job.completedAt
      )?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
  })
}

async function readJob(
  scope: OrganizationScope,
  id: ExportJobId,
  now: Date
): Promise<ExportJob | null> {
  const job = await scope.getExportJob(id)
  if (!job) {
    return null
  }
  return toExportJob(job, await scope.listExportParts([id]), now)
}

/** Locks the Organization; `false` when it is gone, so a job for it ends. */
async function lockOrganization(scope: OrganizationScope): Promise<boolean> {
  const organization = await scope.lockOrganization()
  return organization !== null && organization.status !== 'deleted'
}

/**
 * Fails an active job and audits it (`export.failed`, a system action). The Organization must be
 * locked. Returns `false`, writing nothing, when the job was no longer active.
 */
export async function failExportIn(
  scope: OrganizationScope,
  organizationId: OrganizationId,
  jobId: ExportJobId,
  reason: ExportFailureReason,
  at: Date,
  detail: Record<string, string> = {}
): Promise<boolean> {
  if (!(await scope.failExportJob(jobId, reason, at))) {
    return false
  }
  await Audit.recordIn(scope, organizationId, {
    occurredAt: at,
    actor: { kind: 'system' },
    action: 'export.failed',
    subject: { type: 'export', id: jobId },
    metadata: { reason, ...detail },
  })
  return true
}

/** Publishes the job that builds core's part; `false` when the queue refused it. */
async function publishBuildJob(
  deps: ExportDeps,
  organizationId: OrganizationId,
  exportId: ExportJobId,
  traceId: string
): Promise<boolean> {
  const job = jobRegistry.create({
    type: 'export.build_core_part',
    payload: { exportId, dataset: 'organization', cursor: null, chunk: 0, files: 0, bytes: 0 },
    organizationId,
    traceId,
  })
  try {
    return (await deps.jobs.publishBatch([job])).failed.length === 0
  } catch {
    return false
  }
}

/**
 * Starts the build after the request committed (a worker must never look for a job that is not
 * yet committed). When the queue refuses it the job is failed (`storage_unavailable`) and the
 * caller gets `server.unavailable`, so no export waits for a build nobody will run.
 */
async function startBuild(
  deps: ExportDeps,
  organizationId: OrganizationId,
  exportId: ExportJobId,
  traceId: string
): Promise<void> {
  if (await publishBuildJob(deps, organizationId, exportId, traceId)) {
    return
  }
  await deps.store.withOrganization(organizationId, async (scope) => {
    if (await lockOrganization(scope)) {
      await failExportIn(scope, organizationId, exportId, 'storage_unavailable', deps.clock.now())
    }
  })
  throw domainError(ERRORS['server.unavailable'])
}

/**
 * Requests an export of the Organization's data. Owner and Admin only. One export runs at a time
 * (`export.already_running`) and at most two are requested in 24 hours (`export.daily_limit`); an
 * export stuck past its time limit is failed first and frees the slot. The request is audited and
 * `export.requested` is published through the outbox in the same transaction; the build is queued
 * once it commits. The same `Idempotency-Key` again returns the first job (200).
 */
export async function createExport(
  deps: ExportDeps,
  caller: Caller,
  request: CreateRequest,
  options: ExportCallOptions
): Promise<IdempotentAnswer<202, ExportJob>> {
  if (request.kind !== 'organization') {
    throw domainError(ERRORS['request.invalid'], { field: 'kind' })
  }
  const services = exportServices(deps.env)
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'exports.create',
        request: { body: request },
        status: 202,
        response: exportJobSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'export.create')
        const active = await scope.getActiveExportJob()
        if (active && isStale(active, now)) {
          await failExportIn(scope, caller.organizationId, active.id, 'timed_out', now)
        } else if (active) {
          throw domainError(EXPORT_ERRORS['export.already_running'])
        }
        const since = new Date(now.getTime() - 24 * HOUR_MS)
        if ((await scope.countExportsSince(since)) >= MAX_EXPORTS_PER_DAY) {
          throw domainError(EXPORT_ERRORS['export.daily_limit'])
        }
        const id = formatId('exp', crypto.randomUUID())
        const inserted = await scope.insertExportJob({
          id,
          requestedByMembershipId: access.membershipId,
          includeRecordingLinks: request.includeRecordingLinks,
          requestedAt: now,
          services,
        })
        if (!inserted) {
          throw domainError(EXPORT_ERRORS['export.already_running'])
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'export.requested',
          subject: { type: 'export', id },
          metadata: {
            withMediaLinks: request.includeRecordingLinks,
            parts: services.join(','),
          },
        })
        await enqueueEvents(scope, caller.organizationId, options.traceId, [
          {
            type: 'export.requested',
            id: crypto.randomUUID(),
            payload: {
              exportId: id,
              requestedByMembershipId: access.membershipId,
              includeRecordingLinks: request.includeRecordingLinks,
              requestedAt: now.toISOString(),
            },
          },
        ])
        const created = await readJob(scope, id, now)
        if (!created) {
          throw domainError(ERRORS['server.internal'])
        }
        return created
      }
    )
  )
  // A replay of a request whose build is still waiting publishes it again: the build is
  // idempotent per step, and the first publish may have been lost between commit and publish.
  if (!answer.replayed || answer.body.state === 'queued') {
    await startBuild(deps, caller.organizationId, answer.body.id, options.traceId)
  }
  return { status: 202, body: answer.body, replayed: answer.replayed }
}

/** One page of the Organization's exports, newest first. Owner and Admin only. */
export async function listExports(
  deps: Pick<ExportDeps, 'store' | 'clock'>,
  caller: Caller,
  query: ListQuery
): Promise<Page<ExportJob>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, exportCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'export.read')
    const rows = await scope.listExportJobs({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after: { requestedAt: new Date(after.at), id: after.id } }),
    })
    const page = rows.slice(0, query.limit)
    const parts = await scope.listExportParts(page.map((row) => row.id))
    const last = page.at(-1)
    return {
      items: page.map((row) => toExportJob(row, parts, now)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.requestedAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/** One export. Owner and Admin only; another Organization's export is `export.not_found`. */
export async function getExport(
  deps: Pick<ExportDeps, 'store' | 'clock'>,
  caller: Caller,
  exportId: ExportJobId
): Promise<ExportJob> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'export.read')
    const found = await readJob(scope, exportId, now)
    if (!found) {
      throw domainError(EXPORT_ERRORS['export.not_found'])
    }
    return found
  })
}

/**
 * Marks a ready export past its expiry as expired and audits it once (`export.expired`, a system
 * action). The Organization must be locked.
 */
async function expireExportIn(
  scope: OrganizationScope,
  organizationId: OrganizationId,
  jobId: ExportJobId,
  now: Date
): Promise<void> {
  if (await scope.expireExportJob(jobId)) {
    await Audit.recordIn(scope, organizationId, {
      occurredAt: now,
      actor: { kind: 'system' },
      action: 'export.expired',
      subject: { type: 'export', id: jobId },
    })
  }
}

/**
 * Asks for the link that downloads a ready export; it is valid until the export expires, 24 hours
 * after it finished. Owner and Admin only. The link is a signed token of core's: nothing about it
 * is stored or logged, and the audit entry (`export.downloaded`) names the export, not the link.
 * An export that is not ready is `export.not_ready`; one past its expiry is `export.expired`
 * (audited once). The same `Idempotency-Key` again returns the first link (200).
 */
export async function createExportDownload(
  deps: Pick<ExportDeps, 'store' | 'clock' | 'logger' | 'env'>,
  caller: Caller,
  exportId: ExportJobId,
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<201, ExportDownload>> {
  const now = deps.clock.now()
  const expired = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'export.download')
    const job = await scope.getExportJob(exportId)
    if (!job) {
      throw domainError(EXPORT_ERRORS['export.not_found'])
    }
    if (job.state === 'expired') {
      return true
    }
    if (isDue(job, now)) {
      await expireExportIn(scope, caller.organizationId, exportId, now)
      return true
    }
    return false
  })
  if (expired) {
    throw domainError(EXPORT_ERRORS['export.expired'])
  }
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'exports.create_download',
        request: { exportId },
        status: 201,
        response: exportDownloadSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'export.download')
        const job = await scope.getExportJob(exportId)
        if (!job) {
          throw domainError(EXPORT_ERRORS['export.not_found'])
        }
        if (job.state !== 'ready' || isStale(job, now) || job.expiresAt === null) {
          throw domainError(EXPORT_ERRORS['export.not_ready'])
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'export.downloaded',
          subject: { type: 'export', id: exportId },
        })
        const token = mintExportDownloadToken(deps.env.UNSUBSCRIBE_TOKEN_KEY, {
          organizationId: caller.organizationId,
          exportId,
          expiresAt: job.expiresAt,
        })
        return exportDownloadSchema.parse({
          exportId,
          url: new URL(`/exports/download/${token}`, deps.env.PORTAL_BASE_URL).toString(),
          expiresAt: job.expiresAt.toISOString(),
        })
      }
    )
  )
}

/**
 * Lists the files of an export for a link's holder, each with a fresh short-lived presigned URL.
 * The token is the only credential: a token that is not core's, or for an export that is gone or
 * not ready, is `export.not_found`; one past the export's expiry is `export.expired`. Pages with the
 * object store's own cursor, at most `limit` files (O(limit)).
 */
export async function readPublicDownload(
  deps: Pick<ExportDeps, 'store' | 'clock' | 'objects' | 'env'>,
  request: { token: string; cursor?: string | undefined; limit: number }
): Promise<ExportFilePage> {
  const claims = readExportDownloadToken(deps.env.UNSUBSCRIBE_TOKEN_KEY, request.token)
  if (!claims) {
    throw domainError(EXPORT_ERRORS['export.not_found'])
  }
  const now = deps.clock.now()
  const { organizationId, exportId } = claims
  const state = await deps.store.withOrganization(organizationId, async (scope) => {
    const job = await scope.getExportJob(exportId)
    if (!job) {
      return 'missing'
    }
    if (job.state === 'expired' || isDue(job, now) || claims.expiresAt.getTime() <= now.getTime()) {
      return job.state === 'ready' ? 'due' : job.state === 'expired' ? 'expired' : 'missing'
    }
    return job.state === 'ready' ? 'ok' : 'missing'
  })
  if (state === 'due') {
    await deps.store.withOrganization(organizationId, async (scope) => {
      if (await lockOrganization(scope)) {
        await expireExportIn(scope, organizationId, exportId, now)
      }
    })
  }
  if (state === 'due' || state === 'expired') {
    throw domainError(EXPORT_ERRORS['export.expired'])
  }
  if (state === 'missing') {
    throw domainError(EXPORT_ERRORS['export.not_found'])
  }
  const page = await deps.objects.list(organizationId, {
    prefix: `exports/${exportId}/`,
    limit: request.limit,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  })
  const expiresAt = new Date(now.getTime() + EXPORT_FILE_LINK_SECONDS * 1000).toISOString()
  const items = await Promise.all(
    page.items.map(async (item) => ({
      key: item.key,
      bytes: item.size,
      url: await deps.objects.presignGet(organizationId, item.key, {
        expiresInSeconds: EXPORT_FILE_LINK_SECONDS,
      }),
      expiresAt,
    }))
  )
  return { items, nextCursor: page.nextCursor ?? null }
}

/**
 * Takes a failed export back to queued, and its failed parts to pending, unless another export is
 * active. Owner and Admin only. Core's part is built again only if it is not already ready;
 * `export.requested` is published again so the other services deliver their failed parts (each
 * must treat the same export id as idempotent).
 */
export async function retryExport(
  deps: ExportDeps,
  caller: Caller,
  exportId: ExportJobId,
  options: { traceId: string }
): Promise<ExportJob> {
  const now = deps.clock.now()
  const outcome = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'export.create')
    const job = await scope.getExportJob(exportId)
    if (!job) {
      throw domainError(EXPORT_ERRORS['export.not_found'])
    }
    const active = await scope.getActiveExportJob()
    if (active && isStale(active, now)) {
      await failExportIn(scope, caller.organizationId, active.id, 'timed_out', now)
    }
    if (!(await scope.retryExportJob(exportId, now))) {
      throw domainError(
        job.state === 'failed' || isStale(job, now)
          ? EXPORT_ERRORS['export.already_running']
          : EXPORT_ERRORS['export.not_ready']
      )
    }
    await Audit.recordIn(scope, caller.organizationId, {
      occurredAt: now,
      actor: { kind: 'member', membershipId: access.membershipId },
      action: 'export.retried',
      subject: { type: 'export', id: exportId },
    })
    await enqueueEvents(scope, caller.organizationId, options.traceId, [
      {
        type: 'export.requested',
        id: crypto.randomUUID(),
        payload: {
          exportId,
          requestedByMembershipId: access.membershipId,
          includeRecordingLinks: job.includeRecordingLinks,
          requestedAt: now.toISOString(),
        },
      },
    ])
    const parts = await scope.listExportParts([exportId])
    const corePending = parts.some((part) => part.service === 'core' && part.state === 'pending')
    const retried = await readJob(scope, exportId, now)
    if (!retried) {
      throw domainError(ERRORS['server.internal'])
    }
    return { job: retried, corePending }
  })
  if (outcome.corePending) {
    await startBuild(deps, caller.organizationId, exportId, options.traceId)
  }
  return outcome.job
}

/**
 * A service's part is ready: records it and, when every part is, finishes the export. Ignored
 * for an export that is gone or no longer running, a service that owes no part, or a prefix
 * outside the export's own folder. Idempotent: the first result for a part wins.
 */
export async function receivePartReady(
  deps: ExportDeps,
  organizationId: OrganizationId,
  part: {
    exportId: ExportJobId
    service: ExportService
    prefix: string
    fileCount: number
    bytes: number
    readyAt: string
  }
): Promise<void> {
  if (
    part.service === 'core' ||
    part.prefix.replace(/\/+$/, '') !== `exports/${part.exportId}/${part.service}`
  ) {
    deps.logger.warn('an export part was refused', {
      exportId: part.exportId,
      service: part.service,
    })
    return
  }
  const recorded = await deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await lockOrganization(scope))) {
      return false
    }
    return scope.markExportPartReady(part.exportId, part.service, {
      prefix: part.prefix.replace(/\/+$/, ''),
      fileCount: part.fileCount,
      bytes: part.bytes,
      readyAt: new Date(part.readyAt),
    })
  })
  if (recorded) {
    await finishExportIfReady(deps, organizationId, part.exportId)
  }
}

/**
 * A service's part failed: records it and fails the export at once (`part_failed`, audited).
 * Ignored for an export that is gone or no longer active; the first result wins.
 */
export async function receivePartFailed(
  deps: ExportDeps,
  organizationId: OrganizationId,
  part: { exportId: ExportJobId; service: ExportService; reason: ExportPartFailureReason }
): Promise<void> {
  await failPart(deps, organizationId, part)
}

/**
 * Records a part as failed and fails its export (`part_failed`, audited); shared by a part event
 * and by core's own build giving up. Returns whether it changed anything.
 */
export async function failPart(
  deps: Pick<ExportDeps, 'store' | 'clock'>,
  organizationId: OrganizationId,
  part: { exportId: ExportJobId; service: ExportService; reason: ExportPartFailureReason }
): Promise<boolean> {
  return deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await lockOrganization(scope))) {
      return false
    }
    if (!(await scope.markExportPartFailed(part.exportId, part.service, part.reason))) {
      return false
    }
    return failExportIn(scope, organizationId, part.exportId, 'part_failed', deps.clock.now(), {
      service: part.service,
      partReason: part.reason,
    })
  })
}

/**
 * Finishes an export whose parts are all ready: writes the manifest (a fixed key, so a repeat
 * overwrites it with the same content) and marks the job ready with a link valid for 24 hours. An
 * export past its time limit is failed instead. Safe to run twice: only the first completes it.
 */
export async function finishExportIfReady(
  deps: ExportDeps,
  organizationId: OrganizationId,
  exportId: ExportJobId
): Promise<void> {
  const now = deps.clock.now()
  const ready = await deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await lockOrganization(scope))) {
      return null
    }
    const job = await scope.getExportJob(exportId)
    if (!job || !isActive(job)) {
      return null
    }
    if (isStale(job, now)) {
      await failExportIn(scope, organizationId, exportId, 'timed_out', now)
      return null
    }
    const parts = await scope.listExportParts([exportId])
    return parts.length > 0 && parts.every((part) => part.state === 'ready') ? parts : null
  })
  if (!ready) {
    return
  }
  const sections = []
  for (const part of ready) {
    const files: { key: string; bytes: number }[] = []
    let cursor: string | undefined
    do {
      const page = await deps.objects.list(organizationId, {
        prefix: `${part.prefix}/`,
        limit: 1_000,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const item of page.items) {
        files.push({ key: item.key, bytes: item.size })
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined && files.length < MAX_MANIFEST_FILES_PER_PART)
    sections.push({
      service: part.service,
      prefix: part.prefix,
      fileCount: part.fileCount,
      bytes: part.bytes,
      files,
    })
  }
  const manifest = { exportId, kind: 'organization', organizationId, parts: sections }
  await deps.objects.put(
    organizationId,
    exportManifestKey(exportId),
    new TextEncoder().encode(JSON.stringify(manifest)),
    { contentType: 'application/json' }
  )
  await deps.store.withOrganization(organizationId, async (scope) => {
    if (await lockOrganization(scope)) {
      const expiresAt = new Date(now.getTime() + EXPORT_LINK_HOURS * HOUR_MS)
      await scope.completeExportJob(exportId, now, expiresAt)
    }
  })
}

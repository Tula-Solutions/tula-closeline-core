import {
  type ExportJobId,
  exportJobIdSchema,
  membershipIdSchema,
  type OrganizationId,
  prospectCompanyIdSchema,
  prospectIdSchema,
  suppressionEntryIdSchema,
  teamIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import { describeError } from '~/describe-error'
import { jobRegistry } from '~/messages'
import type { OrganizationScope } from '~/ports/core-store'
import { type ExportDeps, exportPartPrefix, failPart, finishExportIfReady } from './service'

/** The datasets of core's slice, in the order they are written. */
export const EXPORT_DATASETS = [
  'organization',
  'teams',
  'members',
  'prospects',
  'companies',
  'consents',
  'suppression',
  'removed-suppression',
  'audit',
] as const

/** One of {@link EXPORT_DATASETS}. */
export type ExportDataset = (typeof EXPORT_DATASETS)[number]

/** How many times a step is tried before core's part is given up as failed. */
export const EXPORT_MAX_ATTEMPTS = 3

/** What a test may shrink: rows per file and files per queued step. */
export type ExportRunOptions = {
  /** The most rows in one file (default 1000). */
  chunkRows?: number
  /** The most files one queued step writes before it hands on to a new step (default 10). */
  stepChunks?: number
}

const DEFAULT_CHUNK_ROWS = 1_000
const DEFAULT_STEP_CHUNKS = 10
const EVENT_PAGE = 500
const PROSPECT_PAGE = 50

/** What a build step is given: the Organization, the trace and the position. */
export type ExportBuildInput = {
  organizationId: OrganizationId
  traceId: string
  position: {
    exportId: ExportJobId
    dataset: string
    cursor: string | null
    chunk: number
    files: number
    bytes: number
  }
}

type Page = { rows: Record<string, unknown>[]; next: string | null }

const dateIso = z.iso.datetime()
const idCursor = <S extends z.ZodType<string>>(schema: S) => z.object({ id: schema })
const createdCursor = <S extends z.ZodType<string>>(schema: S) =>
  z.object({ at: dateIso, id: schema })

function parseCursor<T>(schema: z.ZodType<T>, cursor: string | null): T | undefined {
  if (cursor === null) {
    return undefined
  }
  return schema.parse(JSON.parse(cursor))
}

const writeCursor = (value: Record<string, string>): string => JSON.stringify(value)

const iso = (date: Date): string => date.toISOString()

/** Reads one page of a dataset after `cursor`; the rows hold only what the export may carry. */
async function readDataset(
  scope: OrganizationScope,
  dataset: ExportDataset,
  cursor: string | null,
  limit: number
): Promise<Page> {
  switch (dataset) {
    case 'organization': {
      const organization = await scope.getOrganization()
      return {
        rows: organization
          ? [
              {
                id: organization.id,
                name: organization.name,
                region: organization.region,
                status: organization.status,
                createdAt: iso(organization.createdAt),
                updatedAt: iso(organization.updatedAt),
              },
            ]
          : [],
        next: null,
      }
    }
    case 'teams': {
      const after = parseCursor(idCursor(teamIdSchema), cursor)
      const rows = await scope.listTeams({ limit, ...(after ? { after: after.id } : {}) })
      return {
        rows: rows.map((team) => ({
          id: team.id,
          name: team.name,
          createdAt: iso(team.createdAt),
          updatedAt: iso(team.updatedAt),
        })),
        next: rows.length === limit ? writeCursor({ id: rows[rows.length - 1]?.id ?? '' }) : null,
      }
    }
    case 'members': {
      const after = parseCursor(idCursor(membershipIdSchema), cursor)
      const rows = await scope.listMembers({ limit, ...(after ? { after: after.id } : {}) })
      return {
        rows: rows.map((member) => ({
          id: member.id,
          userId: member.userId,
          email: member.email,
          name: member.name,
          role: member.role,
          createdAt: iso(member.createdAt),
          updatedAt: iso(member.updatedAt),
        })),
        next: rows.length === limit ? writeCursor({ id: rows[rows.length - 1]?.id ?? '' }) : null,
      }
    }
    case 'prospects': {
      const after = parseCursor(createdCursor(prospectIdSchema), cursor)
      const rows = await scope.listProspects({
        visibility: { kind: 'all' },
        limit,
        ...(after
          ? { after: { createdAt: new Date(after.at), id: prospectIdSchema.parse(after.id) } }
          : {}),
      })
      const fields = await scope.listCurrentFields(
        'prospect',
        rows.map((row) => row.id)
      )
      const last = rows[rows.length - 1]
      return {
        rows: rows.map((prospect) => ({
          id: prospect.id,
          companyId: prospect.companyId,
          ownerMembershipId: prospect.ownerMembershipId,
          status: prospect.status,
          source: prospect.source,
          tags: prospect.tags,
          notes: prospect.notes,
          createdAt: iso(prospect.createdAt),
          updatedAt: iso(prospect.updatedAt),
          fields: (fields.get(prospect.id) ?? []).map((field) => ({
            field: field.field,
            value: field.value,
            source: field.source,
            sourceRef: field.sourceRef,
            setAt: iso(field.setAt),
          })),
        })),
        next:
          rows.length === limit && last
            ? writeCursor({ at: iso(last.createdAt), id: last.id })
            : null,
      }
    }
    case 'companies': {
      const after = parseCursor(createdCursor(prospectCompanyIdSchema), cursor)
      const rows = await scope.listProspectCompanies({
        limit,
        ...(after
          ? {
              after: { createdAt: new Date(after.at), id: prospectCompanyIdSchema.parse(after.id) },
            }
          : {}),
      })
      const last = rows[rows.length - 1]
      return {
        rows: rows.map((company) => ({
          id: company.id,
          name: company.name,
          domain: company.domain,
          industry: company.industry,
          region: company.region,
          employeeCount: company.employeeCount,
          technologies: company.technologies,
          createdAt: iso(company.createdAt),
          updatedAt: iso(company.updatedAt),
        })),
        next:
          rows.length === limit && last
            ? writeCursor({ at: iso(last.createdAt), id: last.id })
            : null,
      }
    }
    case 'consents':
      return readConsents(scope, cursor, limit)
    case 'suppression':
    case 'removed-suppression': {
      const removed = dataset === 'removed-suppression'
      const after = parseCursor(createdCursor(suppressionEntryIdSchema), cursor)
      const rows = await scope.listSuppressionEntries({
        limit,
        state: removed ? 'removed' : 'active',
        ...(after
          ? { after: { at: new Date(after.at), id: suppressionEntryIdSchema.parse(after.id) } }
          : {}),
      })
      const last = rows[rows.length - 1]
      const position = removed ? last?.removedAt : last?.createdAt
      return {
        rows: rows.map((entry) => ({
          id: entry.id,
          addressKind: entry.addressKind,
          maskedAddress: entry.maskedAddress,
          reason: entry.reason,
          channel: entry.channel,
          sourceRef: entry.sourceRef,
          removable: entry.removable,
          createdAt: iso(entry.createdAt),
          removedAt: entry.removedAt ? iso(entry.removedAt) : null,
          removalReason: entry.removalReason,
        })),
        next:
          rows.length === limit && last && position
            ? writeCursor({ at: iso(position), id: last.id })
            : null,
      }
    }
    case 'audit': {
      const after = parseCursor(z.object({ at: dateIso, sequence: z.number().int() }), cursor)
      const rows = await scope.listAuditEvents({
        visibility: { kind: 'all' },
        order: 'oldest',
        limit,
        filter: {},
        ...(after ? { after: { occurredAt: new Date(after.at), sequence: after.sequence } } : {}),
      })
      const last = rows[rows.length - 1]
      return {
        rows: rows.map((event) => ({
          id: event.id,
          sequence: event.sequence,
          occurredAt: iso(event.occurredAt),
          actor: event.actor,
          action: event.action,
          subject: event.subject,
          prospectId: event.prospectId,
          instructionVersion: event.instructionVersion,
          requestId: event.requestId,
          metadata: event.metadata,
        })),
        next:
          rows.length === limit && last
            ? JSON.stringify({ at: iso(last.occurredAt), sequence: last.sequence })
            : null,
      }
    }
  }
}

/**
 * Reads whole Prospects' consent events until at least `limit` rows are collected, so one file
 * holds complete ledgers; evidence references are left out.
 */
async function readConsents(
  scope: OrganizationScope,
  cursor: string | null,
  limit: number
): Promise<Page> {
  let after = parseCursor(createdCursor(prospectIdSchema), cursor)
  const rows: Record<string, unknown>[] = []
  for (;;) {
    const prospects = await scope.listProspects({
      visibility: { kind: 'all' },
      limit: PROSPECT_PAGE,
      ...(after
        ? { after: { createdAt: new Date(after.at), id: prospectIdSchema.parse(after.id) } }
        : {}),
    })
    for (const prospect of prospects) {
      let seq: number | undefined
      for (;;) {
        const events = await scope.listConsentEvents({
          prospectId: prospect.id,
          limit: EVENT_PAGE,
          ...(seq === undefined ? {} : { after: { seq } }),
        })
        for (const { event } of events) {
          rows.push({
            id: event.id,
            prospectId: event.prospectId,
            channel: event.channel,
            kind: event.kind,
            source: event.source,
            wordingId: event.wordingId,
            callId: event.callId,
            formId: event.formId,
            stopAll: event.stopAll,
            occurredAt: event.occurredAt,
            recordedAt: event.recordedAt,
          })
        }
        if (events.length < EVENT_PAGE) {
          break
        }
        seq = events[events.length - 1]?.seq
      }
      after = { at: iso(prospect.createdAt), id: prospect.id }
      if (rows.length >= limit) {
        return { rows, next: JSON.stringify(after) }
      }
    }
    if (prospects.length < PROSPECT_PAGE) {
      return { rows, next: null }
    }
  }
}

const encoder = new TextEncoder()

/**
 * Runs one step of core's slice: writes up to `stepChunks` newline-delimited JSON files (at most
 * `chunkRows` rows each) under `exports/<id>/core/`, then either queues the next step or marks
 * core's part ready and finishes the export if that was the last part. The keys follow from the
 * position in the payload, so a redelivered step rewrites the same objects and nothing is
 * duplicated. A step that keeps failing is given up after {@link EXPORT_MAX_ATTEMPTS} receives:
 * the part and the export are marked failed, with a reason. Rows are never logged.
 */
export async function runExportBuildStep(
  deps: ExportDeps,
  input: ExportBuildInput,
  receiveCount: number,
  options: ExportRunOptions = {}
): Promise<void> {
  const { organizationId, traceId } = input
  const exportId = exportJobIdSchema.parse(input.position.exportId)
  const chunkRows = options.chunkRows ?? DEFAULT_CHUNK_ROWS
  const stepChunks = options.stepChunks ?? DEFAULT_STEP_CHUNKS
  const status = await deps.store.withOrganization(organizationId, async (scope) => {
    const job = await scope.getExportJob(exportId)
    if (!job) {
      return 'unknown'
    }
    const parts = await scope.listExportParts([exportId])
    const core = parts.find((part) => part.service === 'core')
    if ((job.state !== 'queued' && job.state !== 'running') || core?.state !== 'pending') {
      return 'done'
    }
    if (job.state === 'queued' && (await scope.lockOrganization())) {
      await scope.markExportRunning(exportId)
    }
    return 'go'
  })
  if (status === 'unknown') {
    throw new Error('An export build step names an export that does not exist')
  }
  if (status === 'done') {
    return
  }
  try {
    let { dataset, cursor, chunk, files, bytes } = input.position
    let index = EXPORT_DATASETS.indexOf(dataset as ExportDataset)
    if (index < 0) {
      throw new Error('An export build step names an unknown dataset')
    }
    let written = 0
    while (index < EXPORT_DATASETS.length) {
      if (written >= stepChunks) {
        const next = jobRegistry.create({
          type: 'export.build_core_part',
          payload: {
            exportId,
            dataset: EXPORT_DATASETS[index] ?? dataset,
            cursor,
            chunk,
            files,
            bytes,
          },
          organizationId,
          traceId,
        })
        const published = await deps.jobs.publishBatch([next])
        if (published.failed.length > 0) {
          throw new Error('The queue refused the next step of an export')
        }
        return
      }
      const current = EXPORT_DATASETS[index] as ExportDataset
      const page = await deps.store.withOrganization(organizationId, (scope) =>
        readDataset(scope, current, cursor, chunkRows)
      )
      if (page.rows.length > 0) {
        const body = encoder.encode(`${page.rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
        await deps.objects.put(
          organizationId,
          `${exportPartPrefix(exportId, 'core')}/${current}-${chunk}.ndjson`,
          body,
          { contentType: 'application/x-ndjson' }
        )
        chunk += 1
        files += 1
        bytes += body.byteLength
        written += 1
      }
      cursor = page.next
      if (cursor === null) {
        index += 1
      }
    }
    const readyAt = deps.clock.now()
    await deps.store.withOrganization(organizationId, async (scope) => {
      if (await scope.lockOrganization()) {
        await scope.markExportPartReady(exportId, 'core', {
          prefix: exportPartPrefix(exportId, 'core'),
          fileCount: files,
          bytes,
          readyAt,
        })
      }
    })
    await finishExportIfReady(deps, organizationId, exportId)
  } catch (error) {
    if (receiveCount < EXPORT_MAX_ATTEMPTS) {
      throw error
    }
    deps.logger.error('the core part of an export failed', {
      exportId,
      organizationId,
      error: describeError(error),
    })
    await failPart(deps, organizationId, {
      exportId,
      service: 'core',
      reason: 'write_failed',
    })
  }
}

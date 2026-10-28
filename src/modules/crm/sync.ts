import {
  type CrmStage as ApiCrmStage,
  CRM_ERRORS,
  type CrmProvider,
  type CrmRunState,
  type CrmStageMapping,
  type CrmStageMappingEntry,
  type CrmSyncRun,
  type CrmSyncRunId,
  type crmSyncPreviewSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  MAX_CRM_PREVIEW_COUNT,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { newOutboxId } from '~/modules/prospect/events'
import type { OrganizationScope } from '~/ports/core-store'
import type { CrmProvider as CrmProviderPort } from '~/ports/crm-provider'
import { CrmRevokedError, CrmUnavailableError } from '~/ports/crm-provider'
import { crmRunCursorSchema, toCrmStageMappingResponse, toCrmSyncRunResponse } from './schema'
import * as Tokens from './tokens'

/** What the CRM Deal pull needs from the container. */
export type CrmSyncDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'secretBox' | 'crmProviders' | 'playbookDeals' | 'jobs'
>

/** The time one CRM read of the request path or the job may take. */
export const CRM_READ_TIMEOUT_MS = 20_000

/** The answer of the preview route. */
type CrmSyncPreview = z.infer<typeof crmSyncPreviewSchema>

/** The kind of object this pull supports; Calls, Companies and Contacts are other tickets. */
const SUPPORTED_KIND = 'deal' as const

/** The run a caller named, as the type the store takes. */
type RunId = CrmSyncRunId

/** The object kind of the request, checked: only Deals are pulled for now. */
function requireDeal(kind: string): void {
  if (kind !== SUPPORTED_KIND) {
    throw domainError(ERRORS['request.invalid'])
  }
}

/** The provider adapter, or the rate-limited answer a missing one gets (as {@link Tokens.accessToken} does). */
function providerOf(
  deps: Pick<CrmSyncDeps, 'crmProviders'>,
  provider: CrmProvider
): CrmProviderPort {
  const crm = deps.crmProviders[provider]
  if (!crm) {
    throw domainError(CRM_ERRORS['crm.rate_limited'])
  }
  return crm
}

/** Maps what a CRM read throws to the contract's codes. */
export function crmReadError(error: unknown): unknown {
  if (error instanceof CrmRevokedError) {
    return domainError(CRM_ERRORS['crm.needs_reconnect'])
  }
  if (error instanceof CrmUnavailableError) {
    return domainError(CRM_ERRORS['crm.rate_limited'])
  }
  return error
}

/** Reads the CRM's stages with a timeout, mapping its failures to the contract's codes. */
async function readStages(
  deps: Pick<CrmSyncDeps, 'crmProviders'>,
  provider: CrmProvider,
  token: string
) {
  return providerOf(deps, provider)
    .listStages(token, AbortSignal.timeout(CRM_READ_TIMEOUT_MS))
    .catch((error: unknown) => {
      throw crmReadError(error)
    })
}

/**
 * Whether the confirmed mapping names an Outcome for every stage the CRM has now. A stage the CRM
 * added since is unmapped, so no Deal is pulled until an Admin maps it.
 */
export function mappingCovers(
  entries: readonly CrmStageMappingEntry[],
  stageIds: readonly string[]
): boolean {
  const mapped = new Set(entries.map((e) => e.stageId))
  return stageIds.every((id) => mapped.has(id))
}

/** The shared gate of a preview, a start and a retry: a token, then a confirmed mapping that covers the CRM's stages. */
async function requireReady(deps: CrmSyncDeps, caller: Caller, provider: CrmProvider) {
  const token = await Tokens.accessToken(deps, caller.organizationId, provider)
  const stages = await readStages(deps, provider, token)
  const mapping = await deps.store.withOrganization(caller.organizationId, (scope) =>
    scope.getCrmStageMapping(provider)
  )
  if (
    !mapping ||
    mapping.confirmedAt === null ||
    !mappingCovers(
      mapping.entries,
      stages.map((s) => s.stageId)
    )
  ) {
    throw domainError(CRM_ERRORS['crm.mapping_incomplete'])
  }
  return token
}

/** Reads the Stage mapping. Owner, Admin and Manager. */
export async function getMapping(
  deps: Pick<CrmSyncDeps, 'store'>,
  caller: Caller,
  provider: CrmProvider
): Promise<CrmStageMapping> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.read')
    const record = await scope.getCrmStageMapping(provider)
    if (!record) {
      throw domainError(CRM_ERRORS['crm.not_connected'])
    }
    return toCrmStageMappingResponse(provider, record)
  })
}

/** Replaces the Stage mapping; saving it is the confirmation. Owner and Admin. */
export async function setMapping(
  deps: CrmSyncDeps,
  caller: Caller,
  provider: CrmProvider,
  entries: CrmStageMappingEntry[],
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<200, CrmStageMapping>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'crm.set_stage_mapping',
        request: { provider, entries },
        status: 200,
        response: z.custom<CrmStageMapping>(),
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'crm.connect')
        const stored = await scope.replaceCrmStageMapping(
          provider,
          entries,
          access.membershipId,
          now
        )
        if (!stored) {
          throw domainError(CRM_ERRORS['crm.not_connected'])
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'crm.stage_mapping_confirmed',
          subject: { type: 'crm_connection', id: provider },
          metadata: { provider, stages: entries.length },
        })
        const record = await scope.getCrmStageMapping(provider)
        if (!record) {
          throw domainError(CRM_ERRORS['crm.not_connected'])
        }
        return toCrmStageMappingResponse(provider, record)
      }
    )
  )
}

/** The cursor of the stage list: how many stages the earlier pages held. */
const stageCursorSchema = z.strictObject({ n: z.number().int().min(0).max(1_000) })

/**
 * Lists the CRM's deal stages live, for an Admin to map. The CRM returns all of them at once (at
 * most 500), so the page is cut here; the cursor is the offset.
 */
export async function listStages(
  deps: CrmSyncDeps,
  caller: Caller,
  provider: CrmProvider,
  query: { cursor?: string | undefined; limit: number }
): Promise<{ items: ApiCrmStage[]; nextCursor: string | null }> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, stageCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.connect')
  })
  const token = await Tokens.accessToken(deps, caller.organizationId, provider)
  const stages = await readStages(deps, provider, token)
  const start = after?.n ?? 0
  const items = stages.slice(start, start + query.limit)
  return {
    items,
    nextCursor:
      start + query.limit < stages.length ? encodeCursor({ n: start + query.limit }) : null,
  }
}

/** Counts what a first load of Deals would pull, writing nothing. Owner and Admin. */
export async function preview(
  deps: CrmSyncDeps,
  caller: Caller,
  provider: CrmProvider,
  objectKind: string
): Promise<CrmSyncPreview> {
  requireDeal(objectKind)
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.connect')
  })
  const token = await requireReady(deps, caller, provider)
  const total = await providerOf(deps, provider)
    .countDeals(token, { cursor: null }, AbortSignal.timeout(CRM_READ_TIMEOUT_MS))
    .catch((error: unknown) => {
      throw crmReadError(error)
    })
  // shortcut: a count cannot see Deals with no stage, so `skipped` stays empty, until the CRM can count them.
  return {
    objectKind: SUPPORTED_KIND,
    total: Math.min(total, MAX_CRM_PREVIEW_COUNT),
    skipped: [],
    truncated: total > MAX_CRM_PREVIEW_COUNT,
  }
}

/**
 * Queues a run in the caller's scope: the run row and its job through the outbox, in one
 * transaction, so a run is never queued without its job.
 */
async function queueRun(
  scope: OrganizationScope,
  deps: Pick<CrmSyncDeps, 'clock'>,
  caller: Caller,
  membershipId: NonNullable<
    Parameters<OrganizationScope['insertCrmSyncRun']>[0]['requestedByMembershipId']
  >,
  provider: CrmProvider,
  trigger: CrmSyncRun['trigger'],
  retryOfRunId: RunId | null,
  traceId: string
): Promise<CrmSyncRun> {
  const now = deps.clock.now()
  const id: RunId = formatId('crun', crypto.randomUUID())
  const run = await scope.insertCrmSyncRun({
    id,
    provider,
    objectKind: SUPPORTED_KIND,
    trigger,
    requestedAt: now.toISOString(),
    requestedByMembershipId: membershipId,
    retryOfRunId,
  })
  if (!run) {
    throw domainError(CRM_ERRORS['crm.not_connected'])
  }
  const job = jobRegistry.create({
    type: 'crm.sync_run',
    payload: { runId: id },
    organizationId: caller.organizationId,
    traceId,
  })
  await scope.enqueueOutbox({
    id: newOutboxId(),
    topic: job.type,
    dedupeKey: `crm.sync_run:${id}`,
    payload: { eventId: job.id, occurredAt: job.occurredAt, traceId, payload: job.payload },
  })
  await Audit.recordIn(scope, caller.organizationId, {
    occurredAt: now,
    actor: { kind: 'member', membershipId },
    action: 'crm.sync_requested',
    subject: { type: 'crm_sync_run', id },
    metadata: { provider, trigger },
  })
  return toCrmSyncRunResponse(run)
}

/**
 * Queues a Deal run and answers 202 with it, queued; nothing is pulled on the request. A run
 * already queued or running is answered as it is (200), so two Admins never start two. The first
 * run is a `first_load`, later ones pull what changed after the stored cursor. Owner and Admin.
 */
export async function start(
  deps: CrmSyncDeps,
  caller: Caller,
  provider: CrmProvider,
  objectKind: string,
  options: { traceId: string; idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<202, CrmSyncRun> & { existing: boolean }> {
  requireDeal(objectKind)
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.connect')
  })
  await requireReady(deps, caller, provider)
  let existing = false
  const answer = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    existing = false
    return idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'crm.start_sync',
        request: { provider, objectKind },
        status: 202,
        response: z.custom<CrmSyncRun>(),
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'crm.connect')
        const active = await scope.findActiveCrmSyncRun(provider, SUPPORTED_KIND)
        if (active) {
          existing = true
          return toCrmSyncRunResponse(active)
        }
        const first = (await scope.latestCrmCursor(provider, SUPPORTED_KIND)) === null
        return queueRun(
          scope,
          deps,
          caller,
          access.membershipId,
          provider,
          first ? 'first_load' : 'manual',
          null,
          options.traceId
        )
      }
    )
  })
  return { ...answer, existing }
}

/**
 * Starts a new run that resumes a failed one from its stored cursor. Only a failed run can be
 * retried; the failed run stays as the record of what went wrong. Owner and Admin.
 */
export async function retry(
  deps: CrmSyncDeps,
  caller: Caller,
  provider: CrmProvider,
  runId: RunId,
  options: { traceId: string; idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<202, CrmSyncRun> & { existing: boolean }> {
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.connect')
  })
  await requireReady(deps, caller, provider)
  let existing = false
  const answer = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    existing = false
    return idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'crm.retry_sync',
        request: { provider, runId },
        status: 202,
        response: z.custom<CrmSyncRun>(),
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'crm.connect')
        const failed = await scope.getCrmSyncRun(runId)
        if (!failed || failed.provider !== provider) {
          throw domainError(ERRORS['request.not_found'])
        }
        if (failed.state !== 'failed') {
          throw domainError(ERRORS['request.conflict'])
        }
        const active = await scope.findActiveCrmSyncRun(provider, failed.objectKind)
        if (active) {
          existing = true
          return toCrmSyncRunResponse(active)
        }
        return queueRun(
          scope,
          deps,
          caller,
          access.membershipId,
          provider,
          'retry',
          failed.id,
          options.traceId
        )
      }
    )
  })
  return { ...answer, existing }
}

/** Lists a provider's runs, newest first, one page at a time. Owner, Admin and Manager. */
export async function listRuns(
  deps: Pick<CrmSyncDeps, 'store'>,
  caller: Caller,
  provider: CrmProvider,
  query: {
    cursor?: string | undefined
    limit: number
    state?: CrmRunState | undefined
    objectKind?: 'deal' | 'call' | 'company' | 'contact' | undefined
  }
): Promise<{ items: CrmSyncRun[]; nextCursor: string | null }> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, crmRunCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.read')
    if (!(await scope.getCrmConnection(provider))) {
      throw domainError(CRM_ERRORS['crm.not_connected'])
    }
    const rows = await scope.listCrmSyncRuns({
      provider,
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.objectKind === undefined ? {} : { objectKind: query.objectKind }),
      ...(after === undefined ? {} : { after: { requestedAt: after.t, id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toCrmSyncRunResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ t: last.requestedAt, id: last.id })
          : null,
    }
  })
}

/** Reads one run. A run of another Organization or provider is `request.not_found`. Owner, Admin and Manager. */
export async function getRun(
  deps: Pick<CrmSyncDeps, 'store'>,
  caller: Caller,
  provider: CrmProvider,
  runId: RunId
): Promise<CrmSyncRun> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.read')
    const run = await scope.getCrmSyncRun(runId)
    if (!run || run.provider !== provider) {
      throw domainError(ERRORS['request.not_found'])
    }
    return toCrmSyncRunResponse(run)
  })
}

import {
  CORE_ERRORS,
  type CRM_FAILURE_REASONS,
  type CrmStageMappingEntry,
  type CrmSyncRun,
  type CrmSyncRunId,
  MAX_CRM_RUN_FAILURES,
  type OrganizationId,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import { crmRunCompletedEvent, enqueueEvents } from '~/modules/prospect/events'
import {
  type CrmDeal,
  CrmRefusedError,
  CrmRevokedError,
  CrmUnavailableError,
} from '~/ports/crm-provider'
import type { CrmSyncRunRecord } from '~/ports/crm-sync-store'
import { PlaybookRejectedError, PlaybookUnavailableError } from '~/ports/playbook-deals'
import { CRM_READ_TIMEOUT_MS, type CrmSyncDeps, crmReadError } from './sync'
import * as Tokens from './tokens'

/** Deals read from the CRM and committed together. */
export const CRM_SYNC_PAGE_SIZE = 100

/** How long one run of the job works before it hands the rest to a fresh job, in ms. */
export const CRM_SYNC_RUN_BUDGET_MS = 60_000

/** After this many deliveries of one job a CRM or Playbook that still fails ends the run instead of waiting again. */
export const CRM_SYNC_MAX_DELIVERIES = 5

/** What names one job. */
export type CrmSyncJob = { organizationId: OrganizationId; runId: CrmSyncRunId; traceId: string }

/** Tunables of one job run; the defaults are the production ones. */
export type CrmSyncRunOptions = { budgetMs?: number; pageSize?: number }

/** Whether the run is over (`done`) or stopped on its budget and a new job must go on (`continue`). */
export type CrmSyncOutcome = 'done' | 'continue'

type RunCode = NonNullable<CrmSyncRun['errorCode']>

/** The Playbook idempotency key of one version of one Deal: a repeat of it has no effect. */
export function dealIdempotencyKey(provider: string, externalId: string, version: string): string {
  return `crm:${provider}:deal:${externalId}:${version}`
}

/** The Playbook's id for a CRM Deal; stable, so a changed Deal updates the same record. */
export function playbookDealId(provider: string, externalId: string): string {
  return `${provider}-${externalId}`
}

/** Marks the run failed with a closed code; the cursor of its last committed page stays for a retry. */
async function failRun(deps: CrmSyncDeps, job: CrmSyncJob, code: RunCode): Promise<CrmSyncOutcome> {
  await finish(deps, job, 'failed', code)
  return 'done'
}

/** Ends the run (`completed` or `failed`), records it and publishes `crm.run_completed`. */
async function finish(
  deps: CrmSyncDeps,
  job: CrmSyncJob,
  state: 'completed' | 'failed',
  code: RunCode | null
): Promise<void> {
  const now = deps.clock.now()
  await deps.store.withOrganization(job.organizationId, async (scope) => {
    if (!(await scope.lockOrganization())) {
      return
    }
    const run = await scope.getCrmSyncRun(job.runId)
    if (!run || (run.state !== 'running' && run.state !== 'queued')) {
      return
    }
    const connection = await scope.getCrmConnection(run.provider)
    await scope.updateCrmSyncRun(run.id, {
      state,
      ...(run.startedAt === null ? { startedAt: now.toISOString() } : {}),
      completedAt: now.toISOString(),
      errorCode: code,
    })
    if (state === 'completed') {
      await scope.setCrmLastSynced(run.provider, now)
    }
    await Audit.recordIn(scope, job.organizationId, {
      occurredAt: now,
      actor: { kind: 'system' },
      action: state === 'completed' ? 'crm.sync_completed' : 'crm.sync_failed',
      subject: { type: 'crm_sync_run', id: run.id },
      metadata: { provider: run.provider, ...(code === null ? {} : { errorCode: code }) },
    })
    if (connection) {
      await enqueueEvents(scope, job.organizationId, job.traceId, [
        crmRunCompletedEvent({
          runId: run.id,
          connectionId: connection.id,
          provider: run.provider,
          objectKind: run.objectKind,
          state,
          completedAt: now.toISOString(),
        }),
      ])
    }
  })
}

type PageResult = { kind: 'ok' } | { kind: 'stopped' } | { kind: 'unmapped' }

/** The Outcome the mapping gives a stage, or `undefined` when the stage is not mapped. */
function outcomeOf(entries: readonly CrmStageMappingEntry[], stageId: string) {
  return entries.find((e) => e.stageId === stageId)?.outcome
}

/**
 * Pulls the Deals of one run into the Playbook, a page at a time. Each page is read from the CRM,
 * sent to the Playbook with an idempotency key made of provider, object and version, and then
 * committed in one transaction with its links, counts, failures and the new cursor, so the cursor
 * moves only after the page is committed and a redelivery repeats at most one page, harmlessly.
 * A record the CRM cannot read, or the Playbook refuses, is named in the run and does not stop it.
 * A CRM or Playbook that is down throws, so the queue redelivers; after
 * {@link CRM_SYNC_MAX_DELIVERIES} the run ends `failed`. A revoked grant or an unmapped stage ends
 * it at once. Only the `deal` kind is pulled. Logs carry ids only, never a token or a Deal.
 */
export async function processCrmSyncRun(
  deps: CrmSyncDeps,
  job: CrmSyncJob,
  receiveCount: number,
  options: CrmSyncRunOptions = {}
): Promise<CrmSyncOutcome> {
  const budgetMs = options.budgetMs ?? CRM_SYNC_RUN_BUDGET_MS
  const pageSize = options.pageSize ?? CRM_SYNC_PAGE_SIZE
  const startedAt = deps.clock.now().getTime()
  const now = deps.clock.now()
  const run = await deps.store.withOrganization(job.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization) {
      return null
    }
    if (organization.status === 'suspended') {
      throw domainError(CORE_ERRORS['organization.suspended'])
    }
    const current = await scope.getCrmSyncRun(job.runId)
    if (!current || (current.state !== 'queued' && current.state !== 'running')) {
      return null
    }
    if (current.state === 'queued') {
      return scope.updateCrmSyncRun(current.id, {
        state: 'running',
        startedAt: now.toISOString(),
      })
    }
    return current
  })
  if (!run) {
    return 'done'
  }
  const crm = deps.crmProviders[run.provider]
  const giveUp = receiveCount >= CRM_SYNC_MAX_DELIVERIES
  let token: string
  try {
    token = await Tokens.accessToken(deps, job.organizationId, run.provider)
  } catch (error) {
    if (error instanceof AppError && error.code === 'crm.rate_limited') {
      return giveUp ? failRun(deps, job, 'crm.rate_limited') : rethrow(error)
    }
    if (error instanceof AppError) {
      // Not connected any more, or the grant is gone: only an Admin can fix it.
      return failRun(deps, job, 'crm.needs_reconnect')
    }
    throw error
  }
  if (!crm) {
    return failRun(deps, job, 'crm.needs_reconnect')
  }
  let cursor = run.cursor ?? (await readLatestCursor(deps, job, run))
  for (;;) {
    let page: Awaited<ReturnType<typeof crm.listDeals>>
    try {
      page = await crm.listDeals(
        token,
        { cursor, limit: pageSize },
        AbortSignal.timeout(CRM_READ_TIMEOUT_MS)
      )
    } catch (error) {
      if (error instanceof CrmRevokedError || error instanceof CrmRefusedError) {
        return failRun(deps, job, 'crm.needs_reconnect')
      }
      if (error instanceof CrmUnavailableError) {
        // shortcut: the contract has no closed code for a plain outage, so it ends as crm.rate_limited; add one with the next contract release.
        return giveUp ? failRun(deps, job, 'crm.rate_limited') : rethrow(crmReadError(error))
      }
      throw error
    }
    let result: PageResult
    try {
      result = await commitPage(deps, job, run, page)
    } catch (error) {
      if (error instanceof PlaybookUnavailableError) {
        // shortcut: the contract has no closed code for a plain outage, so it ends as crm.rate_limited; add one with the next contract release.
        return giveUp ? failRun(deps, job, 'crm.rate_limited') : rethrow(error)
      }
      throw error
    }
    if (result.kind === 'unmapped') {
      return failRun(deps, job, 'crm.mapping_incomplete')
    }
    if (result.kind === 'stopped') {
      return 'done'
    }
    cursor = page.cursor ?? cursor
    if (!page.hasMore) {
      await finish(deps, job, 'completed', null)
      return 'done'
    }
    if (deps.clock.now().getTime() - startedAt >= budgetMs) {
      return 'continue'
    }
  }
}

/** Throws `error` from a place that must return an outcome, so the job stays unacknowledged. */
function rethrow(error: unknown): never {
  throw error
}

/** The cursor a run with none of its own starts from: the newest one a run of this kind committed. */
async function readLatestCursor(
  deps: CrmSyncDeps,
  job: CrmSyncJob,
  run: CrmSyncRunRecord
): Promise<string | null> {
  return deps.store.withOrganization(job.organizationId, (scope) =>
    scope.latestCrmCursor(run.provider, run.objectKind)
  )
}

/** Adds a failure to the run's list once per record, capped at the contract's maximum. */
function addFailure(
  run: { failures: CrmSyncRun['failures']; failuresTruncated: boolean; failed: number },
  objectRef: string,
  reason: (typeof CRM_FAILURE_REASONS)[number]
): void {
  if (run.failures.some((f) => f.objectRef === objectRef)) {
    return
  }
  run.failed += 1
  if (run.failures.length < MAX_CRM_RUN_FAILURES) {
    run.failures.push({ objectRef, reason })
  } else {
    run.failuresTruncated = true
  }
}

/**
 * Sends one page's Deals to the Playbook and commits the page. The links are read first (one
 * short transaction), the Playbook is called with no transaction open, and the links, counts,
 * failures and cursor are written together under the Organization lock.
 */
async function commitPage(
  deps: CrmSyncDeps,
  job: CrmSyncJob,
  run: CrmSyncRunRecord,
  page: Awaited<ReturnType<CrmSyncDepsProvider['listDeals']>>
): Promise<PageResult> {
  const known = await deps.store.withOrganization(job.organizationId, async (scope) => {
    const mapping = await scope.getCrmStageMapping(run.provider)
    const refs = new Map<string, { lastSeenVersion: string | null } | null>()
    for (const deal of page.deals) {
      refs.set(deal.id, await scope.getCrmExternalRef(run.provider, run.objectKind, deal.id))
    }
    return { mapping, refs }
  })
  if (!known.mapping || known.mapping.confirmedAt === null) {
    return { kind: 'unmapped' }
  }
  const entries = known.mapping.entries
  const sent: { deal: CrmDeal; created: boolean }[] = []
  const tally = { created: 0, updated: 0, skipped: 0, failed: 0 }
  const missingField = { count: 0 }
  const found: { objectRef: string; reason: (typeof CRM_FAILURE_REASONS)[number] }[] = []
  for (const deal of page.deals) {
    const ref = known.refs.get(deal.id) ?? null
    if (ref?.lastSeenVersion === deal.version) {
      continue
    }
    if (deal.stageId === null) {
      missingField.count += 1
      tally.skipped += 1
      continue
    }
    const outcome = outcomeOf(entries, deal.stageId)
    if (outcome === undefined) {
      return { kind: 'unmapped' }
    }
    try {
      await deps.playbookDeals.recordDeal(
        {
          organizationId: job.organizationId,
          dealId: playbookDealId(run.provider, deal.id),
          name: deal.name ?? '',
          outcome,
          closedAt: deal.closedAt,
          amount: deal.amount,
          currency: deal.currency,
          idempotencyKey: dealIdempotencyKey(run.provider, deal.id, deal.version),
        },
        AbortSignal.timeout(CRM_READ_TIMEOUT_MS)
      )
    } catch (error) {
      if (error instanceof PlaybookRejectedError) {
        found.push({ objectRef: deal.id, reason: 'write_rejected' })
        continue
      }
      throw error
    }
    sent.push({ deal, created: ref === null })
  }
  for (const id of page.invalid) {
    found.push({ objectRef: id, reason: 'invalid_record' })
  }
  const at = deps.clock.now()
  return deps.store.withOrganization(job.organizationId, async (scope): Promise<PageResult> => {
    if (!(await scope.lockOrganization())) {
      return { kind: 'stopped' }
    }
    const current = await scope.getCrmSyncRun(run.id)
    if (!current || current.state !== 'running') {
      return { kind: 'stopped' }
    }
    for (const { deal } of sent) {
      await scope.upsertCrmExternalRef({
        provider: run.provider,
        objectKind: run.objectKind,
        externalId: deal.id,
        localId: playbookDealId(run.provider, deal.id),
        version: deal.version,
        at,
      })
    }
    // Merged into the run as stored now, so failures of earlier pages are kept.
    const report = {
      failures: [...current.failures],
      failuresTruncated: current.failuresTruncated,
      failed: 0,
    }
    for (const f of found) {
      addFailure(report, f.objectRef, f.reason)
    }
    const created = sent.filter((s) => s.created).length
    const skipped = new Map(current.skipped.map((s) => [s.reason, s.count]))
    if (missingField.count > 0) {
      skipped.set(
        'missing_required_field',
        (skipped.get('missing_required_field') ?? 0) + missingField.count
      )
    }
    await scope.updateCrmSyncRun(run.id, {
      counts: {
        ...current.counts,
        created: current.counts.created + created,
        updated: current.counts.updated + (sent.length - created),
        skipped: current.counts.skipped + tally.skipped,
        failed: current.counts.failed + report.failed,
      },
      skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
      failures: report.failures,
      failuresTruncated: report.failuresTruncated,
      ...(page.cursor === null ? {} : { cursor: page.cursor }),
    })
    return { kind: 'ok' }
  })
}

/** The provider port, for the page type. */
type CrmSyncDepsProvider = NonNullable<
  CrmSyncDeps['crmProviders'][keyof CrmSyncDeps['crmProviders']]
>

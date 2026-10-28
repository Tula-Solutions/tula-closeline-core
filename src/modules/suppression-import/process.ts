import {
  CORE_ERRORS,
  formatId,
  isBlankCsvRecord,
  MAX_SUPPRESSION_IMPORT_ROWS,
  type OrganizationId,
  parseCsv,
  type SuppressionImportId,
  type UserId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import { enqueueEvents, type PendingEvent, suppressionAddedEvent } from '~/modules/prospect/events'
import {
  type AddressKind,
  hashAddress,
  maskAddress,
  normaliseAddress,
} from '~/modules/suppression/address'
import type { OrganizationScope } from '~/ports/core-store'
import type {
  SuppressionImportFailureReason,
  SuppressionImportRowRecord,
} from '~/ports/suppression-import-store'
import { isAddressHeader } from './service'

/** What the import job needs from the container. */
export type SuppressionImportDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'jobs' | 'objects' | 'env'
>

/** How many rows one transaction applies. */
export const SUPPRESSION_IMPORT_BATCH_ROWS = 100

/** How long one run of the job works before it hands the rest to a fresh job, in ms. */
export const SUPPRESSION_IMPORT_RUN_BUDGET_MS = 60_000

/** What names one job. */
export type SuppressionImportJob = {
  organizationId: OrganizationId
  importId: SuppressionImportId
  actorUserId: UserId
  traceId: string
}

/** Tunables of one run; the defaults are the production ones. */
export type SuppressionImportRunOptions = { budgetMs?: number; batchRows?: number }

/** Whether the import is finished (`done`) or the run stopped on its budget and a new job must go on (`continue`). */
export type SuppressionImportOutcome = 'done' | 'continue'

type Judged = { address: { kind: AddressKind; value: string } } | { reason: InvalidReason }
type InvalidReason = 'unreadable_address' | 'unsupported_address'

/** An email with a local part and a dotted domain, after normalising. */
const EMAIL_SHAPE = /^[^@]+@[^@.]+(\.[^@.]+)+$/

/** A phone number as typed: digits with the usual separators, maybe a leading + or (. */
const PHONE_LOOKING = /^[+\d(][\d\s().+-]*$/

/** Judges one CSV record: which kind of address it holds and its normalised form, or why it is invalid. */
export function judgeRecord(record: readonly string[]): Judged {
  const cell = record[0]?.trim()
  if (record.length !== 1 || cell === undefined || isBlankCsvRecord(record)) {
    return { reason: 'unreadable_address' }
  }
  let kind: AddressKind
  if (cell.includes('@')) {
    kind = 'email'
  } else if (/linkedin\.com\//i.test(cell)) {
    kind = 'linkedin'
  } else if (PHONE_LOOKING.test(cell)) {
    kind = 'phone'
  } else {
    return { reason: 'unsupported_address' }
  }
  const value = normaliseAddress(kind, cell)
  // The shared normaliser accepts `a@b`; a list of strangers' addresses needs a dotted domain.
  const wellFormed = value !== undefined && (kind !== 'email' || EMAIL_SHAPE.test(value))
  return wellFormed ? { address: { kind, value } } : { reason: 'unreadable_address' }
}

type Decoded =
  | { ok: true; records: string[][] }
  | { ok: false; reason: SuppressionImportFailureReason }

/** Reads the stored file and returns its data records; nothing here depends on the database. */
async function decode(
  deps: SuppressionImportDeps,
  job: SuppressionImportJob,
  objectKey: string
): Promise<Decoded> {
  const stored = await deps.objects.get(job.organizationId, objectKey)
  if (!stored) {
    return { ok: false, reason: 'unreadable' }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stored.body)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const parsed = parseCsv(text, { maxRecords: MAX_SUPPRESSION_IMPORT_ROWS + 1 })
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.failure === 'too_many_records' ? 'too_many_rows' : 'unreadable',
    }
  }
  const [header, ...records] = parsed.records
  if (!header || !isAddressHeader(header)) {
    return { ok: false, reason: 'unreadable' }
  }
  return { ok: true, records }
}

/** Fails an import that has not ended, with `reason`; one that completed or already failed is left alone. */
export async function failSuppressionImport(
  deps: Pick<SuppressionImportDeps, 'store' | 'clock'>,
  organizationId: OrganizationId,
  importId: SuppressionImportId,
  reason: SuppressionImportFailureReason
): Promise<void> {
  await deps.store.withOrganization(organizationId, async (scope) => {
    await scope.lockOrganization()
    const locked = await scope.lockSuppressionImport(importId)
    if (locked && locked.state !== 'completed' && locked.state !== 'failed') {
      await scope.updateSuppressionImport(
        importId,
        { state: 'failed', failureReason: reason },
        deps.clock.now()
      )
    }
  })
}

/** Adds one judged row to the Suppression list and says what happened to it. */
async function applyRow(
  deps: SuppressionImportDeps,
  scope: OrganizationScope,
  job: SuppressionImportJob,
  judged: Judged,
  rowNumber: number,
  now: Date,
  events: PendingEvent[]
): Promise<SuppressionImportRowRecord> {
  if ('reason' in judged) {
    return { rowNumber, result: 'invalid', reason: judged.reason }
  }
  const { kind, value } = judged.address
  const { entry, created } = await scope.insertSuppressionEntry({
    id: formatId('sup', crypto.randomUUID()),
    addressKind: kind,
    addressHash: hashAddress(deps.env.CONSENT_HASH_KEY, job.organizationId, kind, value),
    maskedAddress: maskAddress(kind, value),
    reason: 'manual',
    channel: null,
    sourceRef: job.importId,
    addedByUserId: job.actorUserId,
    now,
  })
  if (!created) {
    return { rowNumber, result: 'already_suppressed', reason: null }
  }
  events.push(
    suppressionAddedEvent({
      suppressionEntryId: entry.id,
      addressKind: entry.addressKind,
      reason: entry.reason,
      prospectId: await scope.findProspectByIdentity(kind, value),
    })
  )
  return { rowNumber, result: 'added', reason: null }
}

/**
 * Runs an import: reads the stored file, then adds its addresses in transactions of
 * {@link SUPPRESSION_IMPORT_BATCH_ROWS}, each of which stores its row results and its progress
 * together, so a run that stops anywhere resumes after the last committed batch with nothing done
 * twice. The Organization's status is read again before each batch (the uploader is kept for
 * attribution only). Returns `continue` when the run's budget ended first; the caller then queues a
 * fresh job.
 */
export async function processSuppressionImport(
  deps: SuppressionImportDeps,
  job: SuppressionImportJob,
  options: SuppressionImportRunOptions = {}
): Promise<SuppressionImportOutcome> {
  const budgetMs = options.budgetMs ?? SUPPRESSION_IMPORT_RUN_BUDGET_MS
  const batchRows = options.batchRows ?? SUPPRESSION_IMPORT_BATCH_ROWS
  const started = performance.now()
  const first = await deps.store.withOrganization(job.organizationId, (scope) =>
    scope.getSuppressionImport(job.importId)
  )
  if (!first || first.state === 'completed' || first.state === 'failed') {
    return 'done'
  }
  const decoded = await decode(deps, job, first.objectKey)
  if (!decoded.ok) {
    await failSuppressionImport(deps, job.organizationId, job.importId, decoded.reason)
    return 'done'
  }

  for (;;) {
    const step = await runBatch(deps, job, decoded.records, batchRows)
    if (step !== 'more') {
      return 'done'
    }
    if (performance.now() - started >= budgetMs) {
      return 'continue'
    }
  }
}

/** Applies the next batch in one transaction; says whether more remain. */
async function runBatch(
  deps: SuppressionImportDeps,
  job: SuppressionImportJob,
  records: readonly string[][],
  batchRows: number
): Promise<'more' | 'finished'> {
  const events: PendingEvent[] = []
  return deps.store.withOrganization(job.organizationId, async (scope) => {
    events.length = 0
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'finished'
    }
    if (organization.status === 'suspended') {
      // Not acknowledged: the queue delivers the job again, and its retry limit and dead-letter
      // queue bound the wait, so the import continues if the Organization is reinstated.
      throw domainError(CORE_ERRORS['organization.suspended'])
    }
    const locked = await scope.lockSuppressionImport(job.importId)
    if (!locked || locked.state === 'completed' || locked.state === 'failed') {
      return 'finished'
    }
    const now = deps.clock.now()
    const start = locked.processedRows
    const end = Math.min(start + batchRows, records.length)
    const results: SuppressionImportRowRecord[] = []
    for (let index = start; index < end; index++) {
      const record = records[index] ?? []
      results.push(await applyRow(deps, scope, job, judgeRecord(record), index + 2, now, events))
    }
    await scope.insertSuppressionImportRows(job.importId, results)
    await enqueueEvents(scope, job.organizationId, job.traceId, events)
    if (end < records.length) {
      await scope.updateSuppressionImport(
        job.importId,
        { state: 'processing', processedRows: end },
        now
      )
      return 'more'
    }
    const counts = await scope.countSuppressionImportRows(job.importId)
    await scope.updateSuppressionImport(
      job.importId,
      {
        state: 'completed',
        processedRows: end,
        counts: {
          total: records.length,
          added: counts.added,
          alreadySuppressed: counts.already_suppressed,
          invalid: counts.invalid,
        },
      },
      now
    )
    // One audit event per import, not per address: each entry carries the import as its source reference.
    await Audit.recordIn(scope, job.organizationId, {
      occurredAt: now,
      actor: { kind: 'system' },
      action: 'suppression_import.completed',
      subject: { type: 'suppression_import', id: job.importId },
      metadata: { totalRows: records.length, addedRows: counts.added },
    })
    return 'finished'
  })
}

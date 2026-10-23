import {
  formatId,
  MAX_PROSPECT_IMPORT_ROWS,
  type MembershipId,
  type OrganizationId,
  type ProspectCompanyId,
  type ProspectId,
  type ProspectImportFailureReason,
  type ProspectImportId,
  parseCsv,
  type UserId,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { openOrganizationForWrite } from '~/modules/organization/access'
import {
  createdEvent,
  type PendingEvent,
  publishEvents,
  updatedEvent,
} from '~/modules/prospect/events'
import { writeFields } from '~/modules/prospect/fields'
import { decideFieldWrite, type FieldWrite } from '~/modules/prospect/provenance'
import type {
  OrganizationScope,
  ProspectCompanyRecord,
  ProspectImportRowRecord,
} from '~/ports/core-store'
import { evaluateRows, type ParsedRow, readHeader } from './rows'

/** What the import job needs from the container. */
export type ImportDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'jobs' | 'objects'
>

/** The Source every imported value carries (ADR 0020). */
const SOURCE = 'import'

/** How many rows one transaction applies. */
export const IMPORT_BATCH_ROWS = 100

/** How long one run of the job works before it hands the rest to a fresh job, in ms. */
export const IMPORT_RUN_BUDGET_MS = 60_000

/** What names one job. */
export type ImportJob = {
  organizationId: OrganizationId
  importId: ProspectImportId
  actorUserId: UserId
  traceId: string
}

/** Tunables of one run; the defaults are the production ones. */
export type ImportRunOptions = { budgetMs?: number; batchRows?: number }

/** Whether the import is finished (`done`) or the run stopped on its budget and a new job must go on (`continue`). */
export type ImportOutcome = 'done' | 'continue'

type Owner = { id: MembershipId; role: string } | null

type BatchContext = {
  importId: ProspectImportId
  now: Date
  owners: Map<string, Owner>
  events: PendingEvent[]
}

type Decoded =
  | { ok: true; rows: ReturnType<typeof evaluateRows> }
  | { ok: false; reason: ProspectImportFailureReason }

const PROSPECT_FIELDS = [
  ['firstName', 'firstName'],
  ['lastName', 'lastName'],
  ['jobTitle', 'jobTitle'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['linkedinUrl', 'linkedinUrl'],
] as const

/** The field writes of one row, for the fields the file gave. */
function writesOf(row: ParsedRow, importId: ProspectImportId): FieldWrite[] {
  const writes: FieldWrite[] = []
  for (const [key, field] of PROSPECT_FIELDS) {
    const value = row[key]
    if (value !== undefined) {
      writes.push({ field, value, source: SOURCE, sourceRef: importId })
    }
  }
  return writes
}

/** Finds the row's company, or makes it; the name defaults to the domain. */
async function resolveCompany(
  scope: OrganizationScope,
  ctx: BatchContext,
  row: ParsedRow
): Promise<ProspectCompanyId | null> {
  if (row.companyDomain === undefined && row.companyName === undefined) {
    return null
  }
  let company: ProspectCompanyRecord | null =
    row.companyDomain !== undefined
      ? await scope.findProspectCompany({ domain: row.companyDomain })
      : await scope.findProspectCompany({ name: row.companyName as string })
  if (!company) {
    const name = row.companyName ?? (row.companyDomain as string)
    const id = formatId('pco', crypto.randomUUID())
    company = await scope.insertProspectCompany({
      id,
      name,
      domain: row.companyDomain ?? null,
      now: ctx.now,
    })
    const writes: FieldWrite[] = [
      { field: 'name', value: name, source: SOURCE, sourceRef: ctx.importId },
    ]
    if (row.companyDomain !== undefined) {
      writes.push({
        field: 'domain',
        value: row.companyDomain,
        source: SOURCE,
        sourceRef: ctx.importId,
      })
    }
    await writeFields(scope, 'company', id, writes, { userId: null, at: ctx.now })
  }
  return company.id
}

/** Applies one valid row: creates a Prospect, updates the one it names, or skips it. */
async function applyRow(
  scope: OrganizationScope,
  ctx: BatchContext,
  actorUserId: UserId,
  row: ParsedRow,
  rowNumber: number
): Promise<ProspectImportRowRecord> {
  const rejected = (
    reason: 'owner_not_found' | 'owner_not_allowed' | 'identity_conflict'
  ): ProspectImportRowRecord => ({ rowNumber, result: 'rejected', reason, prospectId: null })

  let owner: Owner = null
  if (row.ownerEmail !== undefined) {
    if (!ctx.owners.has(row.ownerEmail)) {
      const found = await scope.getMembershipByEmail(row.ownerEmail)
      ctx.owners.set(row.ownerEmail, found ? { id: found.id, role: found.role } : null)
    }
    owner = ctx.owners.get(row.ownerEmail) ?? null
    if (!owner) {
      return rejected('owner_not_found')
    }
    if (owner.role !== 'rep' && owner.role !== 'manager') {
      return rejected('owner_not_allowed')
    }
  }

  const matches = new Set<ProspectId>()
  const identities: ['email' | 'phone' | 'linkedin', string | undefined][] = [
    ['email', row.email],
    ['phone', row.phone],
    ['linkedin', row.linkedinUrl],
  ]
  for (const [kind, value] of identities) {
    if (value !== undefined) {
      const found = await scope.findProspectByIdentity(kind, value)
      if (found) {
        matches.add(found)
      }
    }
  }
  if (matches.size > 1) {
    return rejected('identity_conflict')
  }
  const writes = writesOf(row, ctx.importId)
  const existing = [...matches][0]

  if (existing === undefined) {
    const companyId = await resolveCompany(scope, ctx, row)
    const id = formatId('prs', crypto.randomUUID())
    const record = await scope.insertProspect({
      id,
      companyId,
      ownerMembershipId: owner?.id ?? null,
      source: SOURCE,
      tags: row.tags,
      notes: null,
      now: ctx.now,
    })
    await writeFields(scope, 'prospect', id, writes, { userId: actorUserId, at: ctx.now })
    ctx.events.push(
      createdEvent({
        prospectId: id,
        companyId: record.companyId,
        ownerMembershipId: record.ownerMembershipId,
        source: SOURCE,
      })
    )
    return { rowNumber, result: 'created', reason: null, prospectId: id }
  }

  const current = new Map(
    ((await scope.listCurrentFields('prospect', [existing])).get(existing) ?? []).map((f) => [
      f.field,
      f,
    ])
  )
  const manualKept = writes.some((write) => {
    const held = current.get(write.field)
    const decision = decideFieldWrite(held, write)
    return decision.kind === 'record' && held?.source === 'manual'
  })
  const { changedFields } = await writeFields(scope, 'prospect', existing, writes, {
    userId: actorUserId,
    at: ctx.now,
  })
  if (changedFields.length > 0) {
    await scope.updateProspect(existing, {}, ctx.now)
    ctx.events.push(
      updatedEvent({
        prospectId: existing,
        changedFields: changedFields as (
          | 'email'
          | 'firstName'
          | 'jobTitle'
          | 'lastName'
          | 'linkedinUrl'
          | 'phone'
        )[],
        ownerChanged: false,
        companyChanged: false,
        statusChanged: false,
        source: SOURCE,
      })
    )
    return { rowNumber, result: 'updated', reason: null, prospectId: existing }
  }
  return {
    rowNumber,
    result: 'skipped',
    reason: manualKept ? 'manual_values_kept' : 'no_change',
    prospectId: existing,
  }
}

/** Reads the stored file and judges every row; nothing here depends on the database. */
async function decode(deps: ImportDeps, job: ImportJob, objectKey: string): Promise<Decoded> {
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
  const parsed = parseCsv(text, { maxRecords: MAX_PROSPECT_IMPORT_ROWS + 1 })
  if (!parsed.ok) {
    return {
      ok: false,
      reason: parsed.failure === 'too_many_records' ? 'too_many_rows' : 'unreadable',
    }
  }
  const [header, ...records] = parsed.records
  if (!header) {
    return { ok: false, reason: 'unreadable' }
  }
  const columns = readHeader(header)
  if (!columns.ok) {
    return { ok: false, reason: 'unreadable' }
  }
  return { ok: true, rows: evaluateRows(columns.columns, records) }
}

/**
 * Runs an import: parses the stored file, judges every row, then applies rows in transactions of
 * {@link IMPORT_BATCH_ROWS}, each of which stores its row results and its progress together, so a
 * run that stops anywhere resumes after the last committed batch with nothing done twice. The
 * actor's role is read again before each batch. Returns `continue` when the run's budget ended
 * first; the caller then queues a fresh job.
 */
export async function processImport(
  deps: ImportDeps,
  job: ImportJob,
  options: ImportRunOptions = {}
): Promise<ImportOutcome> {
  const budgetMs = options.budgetMs ?? IMPORT_RUN_BUDGET_MS
  const batchRows = options.batchRows ?? IMPORT_BATCH_ROWS
  const started = performance.now()
  const first = await deps.store.withOrganization(job.organizationId, (scope) =>
    scope.getProspectImport(job.importId)
  )
  if (!first || first.state === 'completed' || first.state === 'failed') {
    return 'done'
  }
  const decoded = await decode(deps, job, first.objectKey)
  if (!decoded.ok) {
    await deps.store.withOrganization(job.organizationId, async (scope) => {
      await scope.lockOrganization()
      const locked = await scope.lockProspectImport(job.importId)
      if (locked && locked.state !== 'completed' && locked.state !== 'failed') {
        await scope.updateProspectImport(
          job.importId,
          { state: 'failed', failureReason: decoded.reason },
          deps.clock.now()
        )
      }
    })
    return 'done'
  }
  const { rows } = decoded

  for (;;) {
    const step = await runBatch(deps, job, rows, batchRows)
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
  deps: ImportDeps,
  job: ImportJob,
  rows: ReturnType<typeof evaluateRows>,
  batchRows: number
): Promise<'more' | 'finished'> {
  const events: PendingEvent[] = []
  let outcome: 'more' | 'finished'
  try {
    outcome = await deps.store.withOrganization(job.organizationId, async (scope) => {
      events.length = 0
      await openOrganizationForWrite(scope, { userId: job.actorUserId }, 'prospect_import.create')
      const locked = await scope.lockProspectImport(job.importId)
      if (!locked || locked.state === 'completed' || locked.state === 'failed') {
        return 'finished'
      }
      const now = deps.clock.now()
      const start = locked.processedRows
      const end = Math.min(start + batchRows, rows.length)
      const ctx: BatchContext = { importId: job.importId, now, owners: new Map(), events }
      const results: ProspectImportRowRecord[] = []
      for (let index = start; index < end; index++) {
        const rowNumber = index + 2
        const evaluated = rows[index]
        if (!evaluated) {
          continue
        }
        results.push(
          evaluated.ok
            ? await applyRow(scope, ctx, job.actorUserId, evaluated.row, rowNumber)
            : { rowNumber, result: 'rejected', reason: evaluated.reason, prospectId: null }
        )
      }
      await scope.insertProspectImportRows(job.importId, results)
      if (end < rows.length) {
        await scope.updateProspectImport(
          job.importId,
          { state: 'processing', processedRows: end },
          now
        )
        return 'more'
      }
      const counts = await scope.countProspectImportRows(job.importId)
      await scope.updateProspectImport(
        job.importId,
        {
          state: 'completed',
          processedRows: end,
          counts: {
            rowCount: rows.length,
            created: counts.created,
            updated: counts.updated,
            skipped: counts.skipped,
            rejected: counts.rejected,
          },
        },
        now
      )
      return 'finished'
    })
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      // The actor may no longer import (removed or demoted): drop the job; nothing is retried.
      deps.logger.error('a prospect import was dropped because its actor may no longer import', {
        organizationId: job.organizationId,
        importId: job.importId,
        reason: describeError(error),
      })
      return 'finished'
    }
    throw error
  }
  await publishEvents(deps, job.organizationId, job.traceId, events)
  return outcome
}

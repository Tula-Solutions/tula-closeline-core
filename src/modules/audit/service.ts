import {
  AUDIT_ERRORS,
  type AuditActor,
  type AuditEvent,
  type AuditEventId,
  auditEventSchema,
  type auditRecordedEvent,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listAuditEventsQuerySchema,
  MAX_AUDIT_CSV_PAGE_SIZE,
  MAX_AUDIT_RANGE_DAYS,
  type OrganizationId,
  type verifyAuditQuerySchema,
  type verifyAuditResponseSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { AuditEventRecord, AuditFilterRequest } from '~/ports/audit-store'
import type { OrganizationScope, ProspectVisibility } from '~/ports/core-store'
import { hashAuditEvent } from './hash'
import { auditCsvCursorSchema, auditListCursorSchema } from './schema'

/** What the audit log needs from the container. */
export type AuditDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** The `data` of an `audit.recorded` event: one event, as a service reports it. */
export type AuditRecordedData = z.output<typeof auditRecordedEvent.schema.shape.data>

/** What a caller of {@link recordIn} says happened. The id, sequence and hashes are core's to assign. */
export type AuditEntry = {
  /** The event id; a fresh one when absent. Recording the same id twice writes one event. */
  id?: AuditEventId
  occurredAt: Date
  actor: AuditActor
  action: string
  subject: AuditEvent['subject']
  prospectId?: AuditEvent['prospectId']
  instructionVersion?: AuditEvent['instructionVersion']
  requestId?: AuditEvent['requestId']
  metadata?: AuditEvent['metadata']
}

type ListAuditEventsQuery = z.output<typeof listAuditEventsQuerySchema>
type AuditFilter = Omit<ListAuditEventsQuery, 'cursor' | 'limit'>
type VerifyAuditQuery = z.output<typeof verifyAuditQuerySchema>
type VerifyAuditResponse = z.output<typeof verifyAuditResponseSchema>

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Appends one event to the Organization's chain inside the caller's transaction, which must have
 * locked the Organization (the chain has one writer at a time). Returns `false`, writing nothing,
 * when the id is already recorded (a replay). One read and one insert, whatever the log's size.
 */
export async function recordIn(
  scope: OrganizationScope,
  organizationId: OrganizationId,
  entry: AuditEntry
): Promise<boolean> {
  const last = await scope.lastAuditEvent()
  const content: Omit<AuditEventRecord, 'hash'> = {
    id: entry.id ?? (formatId('aud', crypto.randomUUID()) as AuditEventId),
    sequence: (last?.sequence ?? 0) + 1,
    occurredAt: entry.occurredAt,
    actor: entry.actor,
    action: entry.action,
    subject: entry.subject,
    prospectId: entry.prospectId ?? null,
    instructionVersion: entry.instructionVersion ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? {},
    previousHash: last?.hash ?? null,
  }
  return scope.insertAuditEvent({ ...content, hash: hashAuditEvent(organizationId, content) })
}

/** What {@link consume} did with a message. */
export type ConsumeResult = 'written' | 'replayed' | 'dropped'

/**
 * Handles one `audit.recorded` message: appends the event to its Organization's chain. Idempotent
 * on the event id, so a redelivery writes nothing (`replayed`); a message for an Organization that
 * does not exist is `dropped`, since there is no log to put it in. The Organization is the
 * message's own, which the queue's envelope carries.
 */
export async function consume(
  deps: Pick<AuditDeps, 'store'>,
  message: { organizationId: OrganizationId; data: AuditRecordedData }
): Promise<ConsumeResult> {
  const { organizationId, data } = message
  return deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await scope.lockOrganization())) {
      return 'dropped'
    }
    const written = await recordIn(scope, organizationId, {
      id: data.auditEventId,
      occurredAt: new Date(data.occurredAt),
      actor: data.actor,
      action: data.action,
      subject: data.subject,
      prospectId: data.prospectId,
      instructionVersion: data.instructionVersion,
      requestId: data.requestId,
      metadata: data.metadata,
    })
    return written ? 'written' : 'replayed'
  })
}

/** Refuses a range longer than the cap, or one that ends before it starts. */
function checkRange(filter: Pick<AuditFilter, 'from' | 'to'>): void {
  if (filter.from === undefined || filter.to === undefined) {
    return
  }
  const span = Date.parse(filter.to) - Date.parse(filter.from)
  if (span < 0 || span > MAX_AUDIT_RANGE_DAYS * DAY_MS) {
    throw domainError(AUDIT_ERRORS['audit.range_too_large'], { maxDays: MAX_AUDIT_RANGE_DAYS })
  }
}

/** The store's filter for the contract's: times become dates and absent filters stay absent. */
function filterOf(filter: AuditFilter): AuditFilterRequest {
  return {
    ...(filter.actorKind === undefined ? {} : { actorKind: filter.actorKind }),
    ...(filter.actorId === undefined ? {} : { actorId: filter.actorId }),
    ...(filter.action === undefined ? {} : { action: filter.action }),
    ...(filter.subjectType === undefined ? {} : { subjectType: filter.subjectType }),
    ...(filter.subjectId === undefined ? {} : { subjectId: filter.subjectId }),
    ...(filter.prospectId === undefined ? {} : { prospectId: filter.prospectId }),
    ...(filter.from === undefined ? {} : { from: new Date(filter.from) }),
    ...(filter.to === undefined ? {} : { to: new Date(filter.to) }),
  }
}

/** Which events the caller may read: all for an Owner or Admin, a Team's Prospects for a Manager. */
async function visibilityOf(scope: OrganizationScope, caller: Caller): Promise<ProspectVisibility> {
  if (caller.role !== 'manager') {
    return { kind: 'all' }
  }
  const own = await scope.getMembershipByUser(caller.userId)
  if (!own) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return { kind: 'team', managerMembershipId: own.id }
}

/** The API shape of a stored event, through the contract's schema, which refuses an inconsistent one. */
export function toAuditEvent(record: AuditEventRecord): AuditEvent {
  return auditEventSchema.parse({ ...record, occurredAt: record.occurredAt.toISOString() })
}

/** Reads a cursor or refuses it as a bad request. */
function cursorOf<T extends z.ZodType>(
  cursor: string | undefined,
  schema: T
): z.output<T> | undefined {
  if (cursor === undefined) {
    return undefined
  }
  const decoded = decodeCursor(cursor, schema)
  if (decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return decoded
}

/**
 * Lists audit events, newest first, one page at a time (at most 100), narrowed by the filters. An
 * Owner or Admin sees every event; a Manager only events about their Team's Prospects.
 */
export async function list(
  deps: Pick<AuditDeps, 'store'>,
  caller: Caller,
  query: ListAuditEventsQuery
): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
  checkRange(query)
  const after = cursorOf(query.cursor, auditListCursorSchema)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'audit.list')
    const rows = await scope.listAuditEvents({
      visibility: await visibilityOf(scope, caller),
      order: 'newest',
      limit: query.limit + 1,
      ...(after === undefined
        ? {}
        : { after: { occurredAt: new Date(after.at), sequence: after.sequence } }),
      filter: filterOf(query),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toAuditEvent),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.occurredAt.toISOString(), sequence: last.sequence })
          : null,
    }
  })
}

/** Reads one event. One outside the caller's view, or of another Organization, is not found. */
export async function get(
  deps: Pick<AuditDeps, 'store'>,
  caller: Caller,
  id: string
): Promise<AuditEvent> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'audit.read')
    const record = await scope.getAuditEvent(id, await visibilityOf(scope, caller))
    if (!record) {
      throw domainError(AUDIT_ERRORS['audit.event_not_found'])
    }
    return toAuditEvent(record)
  })
}

/** The columns of the download, in order. */
const CSV_COLUMNS = [
  'sequence',
  'id',
  'occurred_at',
  'actor_kind',
  'actor_id',
  'action',
  'subject_type',
  'subject_id',
  'prospect_id',
  'instruction_version',
  'request_id',
  'metadata',
  'previous_hash',
  'hash',
] as const

/**
 * One CSV cell. A cell that starts with `=`, `+`, `-` or `@` (or a tab or carriage return) gets a
 * leading apostrophe so a spreadsheet does not run it; a cell with a comma, quote or line break
 * is quoted.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) {
    return ''
  }
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

const actorIdOf = (actor: AuditActor): string | null => {
  switch (actor.kind) {
    case 'member':
      return actor.membershipId
    case 'api_key':
      return actor.apiKeyId
    case 'agent':
      return actor.agentKind
    case 'system':
      return null
  }
}

const csvRow = (event: AuditEventRecord): string =>
  [
    event.sequence,
    event.id,
    event.occurredAt.toISOString(),
    event.actor.kind,
    actorIdOf(event.actor),
    event.action,
    event.subject?.type ?? null,
    event.subject?.id ?? null,
    event.prospectId,
    event.instructionVersion,
    event.requestId,
    JSON.stringify(event.metadata),
    event.previousHash,
    event.hash,
  ]
    .map(csvCell)
    .join(',')

/**
 * One page of the log as CSV, oldest first (at most 1,000 rows), with the cursor of the next page.
 * Owner and Admin only. The download is itself audited, in the same transaction.
 */
export async function csv(
  deps: AuditDeps,
  caller: Caller,
  query: { cursor?: string; limit: number } & AuditFilter
): Promise<{ body: string; nextCursor: string | null }> {
  checkRange(query)
  const after = cursorOf(query.cursor, auditCsvCursorSchema)
  const limit = Math.min(query.limit, MAX_AUDIT_CSV_PAGE_SIZE)
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'audit.csv')
    const upTo = after?.upTo ?? (await scope.lastAuditEvent())?.sequence ?? 0
    const found = await scope.listAuditEvents({
      visibility: { kind: 'all' },
      order: 'oldest',
      limit: limit + 1,
      ...(after === undefined ? {} : { after: { occurredAt: now, sequence: after.sequence } }),
      filter: filterOf(query),
    })
    const rows = found.filter((row) => row.sequence <= upTo)
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    await recordIn(scope, caller.organizationId, {
      occurredAt: now,
      actor: { kind: 'member', membershipId: access.membershipId },
      action: 'audit.exported',
      subject: { type: 'organization', id: caller.organizationId },
      metadata: { rows: page.length },
    })
    return {
      body: `${[CSV_COLUMNS.join(','), ...page.map(csvRow)].join('\r\n')}\r\n`,
      nextCursor:
        rows.length > limit && last ? encodeCursor({ sequence: last.sequence, upTo }) : null,
    }
  })
}

/**
 * Checks the hash chain from a sequence number, at most `count` events (1,000), so the work does
 * not grow with the log. An event is broken when its place is not the next one, its link is not
 * the stored hash of the one before, or its own hash is not the hash of what it says. Reports
 * the first break, and stops there. Owner and Admin only.
 */
export async function verify(
  deps: Pick<AuditDeps, 'store'>,
  caller: Caller,
  query: VerifyAuditQuery
): Promise<VerifyAuditResponse> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'audit.verify')
    const rows = await scope.readAuditChain(query.fromSequence, query.count)
    let previous = rows.find((row) => row.sequence === query.fromSequence - 1)
    let expected = query.fromSequence
    let checked = 0
    for (const row of rows) {
      if (row.sequence < query.fromSequence) {
        continue
      }
      checked += 1
      const linked = row.previousHash === (previous?.hash ?? null)
      const { hash, ...content } = row
      if (
        row.sequence !== expected ||
        !linked ||
        hash !== hashAuditEvent(caller.organizationId, content)
      ) {
        return { checked, firstBrokenSequence: expected, nextSequence: null }
      }
      previous = row
      expected += 1
    }
    return {
      checked,
      firstBrokenSequence: null,
      nextSequence: checked === query.count ? expected : null,
    }
  })
}

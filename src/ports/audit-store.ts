import type { AuditActorKind, AuditEvent } from 'tula-closeline-contract'
import type { ProspectVisibility } from './core-store'

/** One audit event as the store keeps it: the contract's event with a real time. */
export type AuditEventRecord = Omit<AuditEvent, 'occurredAt'> & { occurredAt: Date }

/** The filters of a read of the audit log. Every one only narrows what the visibility allows. */
export type AuditFilterRequest = {
  actorKind?: AuditActorKind
  /** A Membership, an API key or an agent kind, whichever the event's actor carries. */
  actorId?: string
  action?: string
  subjectType?: string
  subjectId?: string
  prospectId?: string
  /** Events at or after this time. */
  from?: Date
  /** Events at or before this time. */
  to?: Date
}

/**
 * A keyset page of the audit log. `newest` orders by time then sequence, both descending (the
 * list); `oldest` orders by sequence ascending (the download), and `after` then uses the sequence.
 */
export type AuditPageRequest = {
  visibility: ProspectVisibility
  order: 'newest' | 'oldest'
  limit: number
  after?: { occurredAt: Date; sequence: number }
  filter: AuditFilterRequest
}

/** The audit methods of an Organization scope. */
export interface AuditScope {
  /** The last event of the chain (its sequence and hash), or `null` for an empty log. One indexed read. */
  lastAuditEvent(): Promise<Pick<AuditEventRecord, 'sequence' | 'hash'> | null>
  /**
   * Appends one event. Call only after `lockOrganization`, so the chain has one writer. Returns
   * `false`, writing nothing, when the Organization already has an event with this id (a replay).
   * There is no method to change or delete an event, and the database refuses both.
   */
  insertAuditEvent(event: AuditEventRecord): Promise<boolean>
  /** One page of events, at most `limit`, in the order asked for, inside the visibility. */
  listAuditEvents(request: AuditPageRequest): Promise<AuditEventRecord[]>
  /** One event by id, or `null` when it does not exist or is outside the visibility. */
  getAuditEvent(id: string, visibility: ProspectVisibility): Promise<AuditEventRecord | null>
  /**
   * Up to `count` events in sequence order from `fromSequence`, preceded by the event before it
   * when there is one, so the first link can be checked. One indexed range read.
   */
  readAuditChain(fromSequence: number, count: number): Promise<AuditEventRecord[]>
}

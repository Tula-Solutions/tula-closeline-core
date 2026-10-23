import type { OrganizationId } from 'tula-closeline-contract'

/** What a service writes into the outbox, in the transaction that decided the event. */
export type OutboxEntry = {
  /** The row id: `obx_` and 32 lower-case hex digits. It is the id of the message the drain publishes. */
  id: string
  /** The kind of message, such as `prospect.created`. */
  topic: string
  /** A JSON object of at most 16 KiB. Never a secret, a token, an address or a message body. */
  payload: Record<string, unknown>
  /** What makes a repeat of the same event one row: unique per Organization. */
  dedupeKey: string
}

/** A row the drain has claimed: leased to it, with the attempt this claim counted. */
export type ClaimedOutboxRow = {
  organizationId: OrganizationId
  id: string
  topic: string
  payload: Record<string, unknown>
  /** How many times the row has been claimed, this claim included; the database parks it at 50. */
  attempts: number
}

/** The two keys that name one outbox row. */
export type OutboxRowRef = { organizationId: OrganizationId; id: string }

/**
 * The drain's side of the outbox, across every Organization. A claim is a lease: the row is hidden
 * from other drains for `leaseMs` and handed out again if it is neither completed nor failed by
 * then, so publishing is at-least-once.
 */
export interface OutboxStore {
  /** Claims up to `limit` due rows (1 to 100), oldest first, for `leaseMs`; rows at 50 attempts are never returned. */
  claim(limit: number, leaseMs: number): Promise<ClaimedOutboxRow[]>
  /** Marks rows published (1 to 100 at a time); a row already published is skipped. */
  complete(rows: readonly OutboxRowRef[]): Promise<void>
  /** Records a failed publish by error code (never a message) and the delay before the row may be claimed again. */
  fail(row: OutboxRowRef, errorCode: string, retryAfterMs: number): Promise<void>
}

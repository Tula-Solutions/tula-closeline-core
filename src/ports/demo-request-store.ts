import type { ClaimedDemoNotice, DemoRequestInput, DemoRequestSubmission } from 'tula-closeline-db'

export type { ClaimedDemoNotice, DemoRequestInput, DemoRequestSubmission }

/** The state a notice settles in. */
export type NoticeOutcome = 'sent' | 'failed'

/**
 * Stores Demo Requests and the queue of team notices that goes with them. A Demo Request belongs
 * to no Organization: nothing here is tenant data, and no route reads one back. Every field is a
 * Visitor's: an implementation must never log or put one in an error message.
 */
export interface DemoRequestStore {
  /**
   * Stores a Demo Request and queues its notice in one step, or finds the one already stored under
   * the same idempotency key (`replayed`, with `sameFields` false when the fields differ).
   */
  submit(input: DemoRequestInput): Promise<DemoRequestSubmission>
  /**
   * Claims up to `limit` pending notices, oldest first, skipping any tried within the last
   * `backoffSeconds`; each claim counts as an attempt. Two concurrent claims never share a row.
   */
  claimNotices(limit: number, backoffSeconds: number): Promise<ClaimedDemoNotice[]>
  /** Settles a pending notice; false when it is unknown or already settled. */
  settleNotice(id: string, outcome: NoticeOutcome): Promise<boolean>
  /** Deletes at most `limit` Demo Requests older than twelve months and returns how many went. */
  purgeExpired(limit: number): Promise<number>
}

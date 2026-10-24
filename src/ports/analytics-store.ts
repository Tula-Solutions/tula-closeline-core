import type { AnalyticsMetric } from 'tula-closeline-contract'

/** The channels a rollup can be split by: the touch channels, as the ledger keeps them. */
export type AnalyticsChannel = 'email' | 'linkedin' | 'chat' | 'phone'

/** The ways a rollup row can be grouped; `total` has the empty key. */
export type RollupGroupKind = 'total' | 'channel' | 'agent_kind' | 'campaign' | 'rep'

/** One thing that happened, to be counted once on the day it happened. */
export type AnalyticsEventEntry = {
  metric: AnalyticsMetric
  /** What makes this thing the same thing on a replay: an event, Message or booking id (1 to 64 characters). */
  dedupeKey: string
  /** The UTC calendar day it happened on (`YYYY-MM-DD`), never the day it was processed. */
  day: string
  /** The channel it happened on, or `null` when it has none (it then counts in the total only). */
  channel: AnalyticsChannel | null
}

/** A request for the lines (one per group key) of one metric over a range of days. */
export type RollupSeriesRequest = {
  metric: AnalyticsMetric
  groupKind: RollupGroupKind
  /** Reads only this group key; the empty key for `total`. */
  groupKey?: string
  /** First and last day, inclusive (`YYYY-MM-DD`). */
  from: string
  to: string
  /** The last group key of the previous page; lines come in key order. */
  afterKey?: string
  /** At most this many lines. */
  limit: number
}

/** One line of a series: the days that have a count, oldest first. */
export type RollupLine = {
  groupKey: string
  points: { day: string; count: number }[]
}

/** What a reconcile found and fixed. */
export type ReconcileResult = {
  /** Rollup cells compared. */
  cells: number
  /** Cells whose count differed from the ledger and were rewritten. */
  repaired: number
}

/** The analytics rollup methods of one Organization's transaction. */
export interface AnalyticsScope {
  /**
   * Counts one thing: writes its ledger row and, only when that row is new, adds one to the
   * `total` cell and (with a channel) the `channel` cell of its day. Returns `false` and changes
   * nothing when the ledger already has the key (a replay). Needs the Organization lock.
   */
  recordAnalyticsEvent(entry: AnalyticsEventEntry): Promise<boolean>
  /** Lines of one metric over a range, in key order, at most `limit` lines of at most one point a day. */
  listRollupSeries(request: RollupSeriesRequest): Promise<RollupLine[]>
  /**
   * Recounts the `total` and `channel` cells of the days from `from` to `to` (inclusive) from the
   * ledger and rewrites any cell that differs, zero for a cell the ledger no longer supports.
   * Needs the Organization lock. Work grows with the ledger rows of the range, not the Organization.
   */
  reconcileRollups(range: { from: string; to: string }): Promise<ReconcileResult>
}

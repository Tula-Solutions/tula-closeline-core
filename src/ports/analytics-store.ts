import type { AnalyticsMetric, MembershipId } from 'tula-closeline-contract'
import type { ProspectVisibility } from './core-store'

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
  /** The Rep it belongs to, when the event says (a booking does); it then also counts in that Rep's cell. */
  repMembershipId?: MembershipId
}

/** A request for the lines (one per group key) of some metrics, summed, over a range of days. */
export type RollupSeriesRequest = {
  /** The metrics to read; their counts are added per day (a Win rate's denominator is won plus lost). */
  metrics: AnalyticsMetric[]
  groupKind: RollupGroupKind
  /** Reads only this group key; the empty key for `total`. */
  groupKey?: string
  /** Reads only these group keys (a page already chosen by another metric). */
  groupKeys?: string[]
  /** For the `rep` kind: reads only the Reps this visibility allows. Other kinds ignore it. */
  visibility?: ProspectVisibility
  /** For the `rep` kind: adds the allowed Reps into one line with the empty key. */
  sumGroups?: boolean
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

/** A request for the totals (one row per group key) of every metric over a range of days. */
export type RollupTableRequest = {
  groupKind: Exclude<RollupGroupKind, 'total'>
  /** Reads only this group key. */
  groupKey?: string
  /** For the `rep` kind: reads only the Reps this visibility allows. */
  visibility?: ProspectVisibility
  from: string
  to: string
  /** The last group key of the previous page; rows come in key order. */
  afterKey?: string
  /** At most this many rows. */
  limit: number
}

/** One row of a table: a group key and the count of each metric over the range (0 for none). */
export type RollupTableRow = {
  groupKey: string
  totals: Record<AnalyticsMetric, number>
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
   * `total` cell, the `channel` cell (with a channel) and the `rep` cell (with a Rep) of its day.
   * Reconcile recounts only `total` and `channel`; the ledger has no Rep column. Returns `false` and changes
   * nothing when the ledger already has the key (a replay). Needs the Organization lock.
   */
  recordAnalyticsEvent(entry: AnalyticsEventEntry): Promise<boolean>
  /** Lines of one metric over a range, in key order, at most `limit` lines of at most one point a day. */
  listRollupSeries(request: RollupSeriesRequest): Promise<RollupLine[]>
  /** Rows of totals over a range, in key order, at most `limit` rows; only keys that have a count appear. */
  listRollupTable(request: RollupTableRequest): Promise<RollupTableRow[]>
  /** Whether the Membership is one the visibility allows as a Rep group (the Manager's own, or a Rep on their Team). */
  repVisible(visibility: ProspectVisibility, membershipId: string): Promise<boolean>
  /**
   * Recounts the `total` and `channel` cells of the days from `from` to `to` (inclusive) from the
   * ledger and rewrites any cell that differs, zero for a cell the ledger no longer supports.
   * Needs the Organization lock. Work grows with the ledger rows of the range, not the Organization.
   */
  reconcileRollups(range: { from: string; to: string }): Promise<ReconcileResult>
}

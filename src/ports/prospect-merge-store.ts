import type {
  BookingId,
  ConversationId,
  ProspectId,
  ProspectMergeId,
  UserId,
} from 'tula-closeline-contract'
import type { FieldRecord, ProspectIdentityKind, ProspectRecord } from './core-store'

/** One entry of a Prospect field's history: the current value, an older one or a suggestion. */
export type FieldHistoryRow = FieldRecord & { state: 'current' | 'superseded' | 'suggested' }

/** The records that pointed at a Prospect and are moved with a merge: Bookings and Conversations. */
export type ProspectLinks = { bookingIds: BookingId[]; conversationIds: ConversationId[] }

/** A pair of Prospects that share an address, `first` sorting before `second`. */
export type DuplicatePair = {
  first: ProspectId
  second: ProspectId
  matchedOn: ProspectIdentityKind[]
}

/** A keyset page request over {@link DuplicatePair}s, in `first` then `second` order. */
export type DuplicatePageRequest = {
  /** Only pairs that include this Prospect. */
  prospectId?: ProspectId
  after?: { first: ProspectId; second: ProspectId }
  limit: number
}

/** A merge as the store holds it. `snapshot` is what undo restores; the API never returns it. */
export type ProspectMergeRecord = {
  id: ProspectMergeId
  survivorProspectId: ProspectId
  mergedProspectIds: ProspectId[]
  fieldChoices: Record<string, string>
  state: 'merged' | 'undone'
  mergedByUserId: UserId
  snapshot: Record<string, unknown>
  createdAt: Date
  undoableUntil: Date
  undoneAt: Date | null
}

/** The columns of a merge that change: undo sets the state and clears the snapshot. */
export type ProspectMergePatch = Pick<ProspectMergeRecord, 'state' | 'snapshot' | 'undoneAt'>

/** The merge, duplicate and undo methods of an Organization scope. Every write needs the Organization lock. */
export interface ProspectMergeScope {
  /**
   * One page of Prospect pairs where one holds, as its current address, a value the other once
   * had. Found from the history rows that are not current, joined to the identity primary key,
   * so the cost follows the history and not the Prospects. Ordered by `first`, then `second`.
   */
  listProspectDuplicates(request: DuplicatePageRequest): Promise<DuplicatePair[]>
  /** Every field history entry of a Prospect (at most 50 per field), oldest first. */
  listProspectFieldHistory(prospectId: ProspectId): Promise<FieldHistoryRow[]>
  /** Replaces a Prospect's whole field history with these rows, which keep their order. */
  replaceProspectFields(prospectId: ProspectId, rows: readonly FieldHistoryRow[]): Promise<void>
  /** Inserts a Prospect with the stored times; an owner or company that is gone is dropped to `null`. */
  restoreProspect(record: ProspectRecord): Promise<void>
  /** Points the Bookings and Conversations of `from` at `to` and returns which ones moved. */
  moveProspectLinks(from: ProspectId, to: ProspectId): Promise<ProspectLinks>
  /** Points these Bookings and Conversations back at `prospectId`. */
  restoreProspectLinks(prospectId: ProspectId, links: ProspectLinks): Promise<void>
  /** Stores a merge. */
  insertProspectMerge(record: ProspectMergeRecord): Promise<void>
  /** One merge by id, or `null`. No lock. */
  getProspectMerge(id: ProspectMergeId): Promise<ProspectMergeRecord | null>
  /** Like {@link getProspectMerge}, under a row lock held to the end of the transaction. */
  lockProspectMerge(id: ProspectMergeId): Promise<ProspectMergeRecord | null>
  /** Changes a merge; `null` when it does not exist. */
  updateProspectMerge(
    id: ProspectMergeId,
    patch: ProspectMergePatch
  ): Promise<ProspectMergeRecord | null>
  /** A merge still in force (state `merged`) that merged away any of these Prospects, or `null`. */
  findActiveMerge(prospectIds: readonly ProspectId[]): Promise<ProspectMergeRecord | null>
}

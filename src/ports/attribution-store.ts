import {
  type CitationRef,
  citationRefSchema,
  type DealRecordId,
  type MembershipId,
  type MessageId,
  MIN_SOURCE_SAMPLE,
  type ProspectId,
  type TouchId,
} from 'tula-closeline-contract'
import type { InboxChannel } from './inbox-store'

/** The kinds of Playbook source whose win rate is kept. */
export type PerformanceSourceKind = 'moment' | 'document'

/** One outbound Message of a Prospect that may be credited with a Deal's Outcome. */
export type AttributionCandidate = {
  messageId: MessageId
  channel: InboxChannel
  authorKind: 'agent' | 'rep'
  /** The Rep who wrote or approved it, when a Rep did. */
  authorMembershipId: MembershipId | null
  /** When it was sent. */
  occurredAt: Date
  /** The Playbook sources its Draft cited, in citation order. */
  sources: CitationRef[]
}

/** One touch to store for a Deal. */
export type NewAttributedTouch = {
  id: TouchId
  messageId: MessageId
  prospectId: ProspectId
  channel: InboxChannel
  repMembershipId: MembershipId | null
  occurredAt: Date
  firstTouch: boolean
  lastTouch: boolean
  citedSources: CitationRef[]
}

/** A stored touch, as the store keeps it. */
export type AttributedTouchRecord = NewAttributedTouch & { dealRecordId: DealRecordId }

/** One source a Deal's touches cited, counted once per Deal. */
export type SourceCredit = { kind: PerformanceSourceKind; key: string }

/** When a source is flagged `cited_often_lost`: enough Deals, and a win rate below the bound. */
export type SourceFlagRule = { minSample: number; winRateBelow: number }

/** The performance of one source as the store keeps it. */
export type SourcePerformanceRecord = {
  kind: PerformanceSourceKind
  key: string
  dealsTouched: number
  dealsWon: number
  flag: 'cited_often_lost' | null
}

/** The Attribution methods of one Organization's transaction. Writes need the Organization lock. */
export interface AttributionScope {
  /** Whether any touch is already credited to this Deal; a Deal is attributed once. */
  hasAttributedTouches(dealRecordId: DealRecordId): Promise<boolean>
  /**
   * The Prospect's outbound Messages sent in `[from, to]` that no Deal holds as a touch yet, the
   * `limit` oldest or newest of them (`order`), each with the Sources its Draft cited. Rows come
   * in the order asked for.
   */
  listAttributionCandidates(
    prospectId: ProspectId,
    window: { from: Date; to: Date },
    limit: number,
    order: 'oldest' | 'newest'
  ): Promise<AttributionCandidate[]>
  /**
   * Stores the touches for a Deal. A Message already held by a Deal is left alone (a Message is
   * credited to one Deal). Returns how many were stored.
   */
  attributeTouches(dealRecordId: DealRecordId, touches: NewAttributedTouch[]): Promise<number>
  /**
   * Counts a Deal once for each source: one more Deal touched, and one more won when `won`. The
   * flag is set from `rule` on the new counts. Returns nothing.
   */
  creditSources(credits: SourceCredit[], won: boolean, rule: SourceFlagRule): Promise<void>
  /** A Deal's touches, oldest first, at most `limit`; `after` is the last touch of the previous page. */
  listDealTouches(
    dealRecordId: DealRecordId,
    limit: number,
    after?: { occurredAt: Date; id: TouchId }
  ): Promise<AttributedTouchRecord[]>
  /** The ids of the touches with first-touch and last-touch credit for a Deal, `null` for none. */
  dealCreditEnds(
    dealRecordId: DealRecordId
  ): Promise<{ firstTouchId: TouchId | null; lastTouchId: TouchId | null }>
  /**
   * The sources' performance, most touched first, then by kind and key descending; `after` is the
   * last row of the previous page; `flag` narrows to flagged ones. At most `limit` rows.
   */
  listSourcePerformance(request: {
    limit: number
    flag?: 'cited_often_lost'
    after?: { dealsTouched: number; kind: PerformanceSourceKind; key: string }
  }): Promise<SourcePerformanceRecord[]>
}

/** The win rate under which a source cited in enough Deals is flagged `cited_often_lost` (a proposal). */
export const CITED_OFTEN_LOST_BELOW = 0.2

/**
 * The Citation a stored Moment reference (`callId:dealRecordId[:momentIndex]`) stands for, or
 * `null` when the reference is not one the contract accepts.
 */
export function citationOfMomentRef(sourceRef: string): CitationRef | null {
  const [callId, dealRecordId, index, ...rest] = sourceRef.split(':')
  if (rest.length > 0 || (index !== undefined && !/^\d{1,6}$/.test(index))) {
    return null
  }
  const parsed = citationRefSchema.safeParse({
    kind: 'moment',
    callId,
    dealRecordId,
    ...(index === undefined ? {} : { momentIndex: Number(index) }),
  })
  return parsed.success ? parsed.data : null
}

/** The key a source is counted under: the Moment reference, or the document id and page. */
export function sourceKeyOf(source: CitationRef): string {
  return source.kind === 'moment'
    ? `${source.callId}:${source.dealRecordId}${
        source.momentIndex === undefined ? '' : `:${source.momentIndex}`
      }`
    : `${source.documentId}:${source.page ?? 'all'}`
}

/** A source's win rate: its value once it touched the minimum sample of Deals, else "not enough data". */
export function sourceWinRate(
  dealsTouched: number,
  dealsWon: number
): { state: 'ok'; value: number } | { state: 'not_enough_data'; value: null } {
  return dealsTouched >= MIN_SOURCE_SAMPLE
    ? { state: 'ok', value: dealsWon / dealsTouched }
    : { state: 'not_enough_data', value: null }
}

import type { DealRecordId, OrganizationId } from 'tula-closeline-contract'

/** One moment of a won Deal's call, as the Playbook returns it. Its text is untrusted data. */
export type PlaybookMoment = {
  callId: string
  dealRecordId: DealRecordId
  momentIndex: number | null
  /** What the Prospect said. */
  prospect: string
  /** What the Rep said next. */
  repNext: string
}

/** What a search finds: the moments, and how much evidence the Playbook holds behind them. */
export type MomentSearchResult = {
  moments: PlaybookMoment[]
  /** The Playbook's evidence base: how many moments and Deals the search covered. */
  evidence: { moments: number; deals: number }
}

/**
 * The Organization's Playbook, searched for moments of won Deals that answer what a Prospect
 * said. It is scoped to `organizationId`, so it can never return another Organization's moments.
 * It throws when the Playbook is unreachable or `signal` aborts.
 */
export interface MomentSearch {
  /** Finds at most `limit` moments of won Deals that are close to `query`. */
  searchWonMoments(
    input: { organizationId: OrganizationId; query: string; limit: number },
    signal: AbortSignal
  ): Promise<MomentSearchResult>
}

/** The pattern a stored Source reference must match: the database checks the same. */
const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * The reference a moment is cited and stored by: `callId:dealRecordId[:momentIndex]`, or `null`
 * when the parts do not make a reference the database accepts.
 */
export function momentSourceRef(moment: PlaybookMoment): string | null {
  const ref = `${moment.callId}:${moment.dealRecordId}${
    moment.momentIndex === null ? '' : `:${moment.momentIndex}`
  }`
  return SOURCE_REF.test(ref) ? ref : null
}

import type { CitationRef, OrganizationId } from 'tula-closeline-contract'
import {
  type AttributedTouchRecord,
  type AttributionCandidate,
  type AttributionScope,
  citationOfMomentRef,
  type SourcePerformanceRecord,
} from '~/ports/attribution-store'
import type { InboxState } from './inbox-state'

type TouchRow = AttributedTouchRecord & { organizationId: OrganizationId }
type PerformanceRow = SourcePerformanceRecord & { organizationId: OrganizationId }

/** What the in-memory store keeps for Attribution: the touches credited to Deals and each source's counts. */
export type AttributionState = {
  /** Keyed by Organization and Message: the unique key of the table. */
  attributedTouches: Map<string, TouchRow>
  /** Keyed by Organization, source kind and source key. */
  sourcePerformance: Map<string, PerformanceRow>
}

/** An empty {@link AttributionState}. */
export function emptyAttributionState(): AttributionState {
  return { attributedTouches: new Map(), sourcePerformance: new Map() }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyAttributionState(state: AttributionState): AttributionState {
  return {
    attributedTouches: new Map(state.attributedTouches),
    sourcePerformance: new Map(state.sourcePerformance),
  }
}

const touchKey = (organizationId: string, messageId: string) => `${organizationId}|${messageId}`
const performanceKey = (organizationId: string, kind: string, key: string) =>
  `${organizationId}|${kind}|${key}`

const byNewest = (
  a: { dealsTouched: number; kind: string; key: string },
  b: { dealsTouched: number; kind: string; key: string }
) =>
  b.dealsTouched - a.dealsTouched ||
  (a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0) ||
  (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)

const byOldestTouch = (a: { occurredAt: Date; id: string }, b: { occurredAt: Date; id: string }) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Builds the Attribution methods of one transaction's scope, with the database's own rules. */
export function createAttributionScope(env: {
  organizationId: OrganizationId
  read: () => AttributionState & InboxState
  write: () => AttributionState
  requireLock: () => void
}): AttributionScope {
  const { organizationId, read, write, requireLock } = env

  return {
    hasAttributedTouches: async (dealRecordId) => {
      for (const row of read().attributedTouches.values()) {
        if (row.organizationId === organizationId && row.dealRecordId === dealRecordId) {
          return true
        }
      }
      return false
    },

    listAttributionCandidates: async (prospectId, window, limit, order) => {
      const view = read()
      const conversations = new Set<string>()
      for (const conversation of view.conversations.values()) {
        if (
          conversation.organizationId === organizationId &&
          conversation.prospectId === prospectId
        ) {
          conversations.add(conversation.id)
        }
      }
      const found: AttributionCandidate[] = []
      for (const message of view.messages) {
        if (
          message.organizationId !== organizationId ||
          message.direction !== 'outbound' ||
          message.authorKind === 'prospect' ||
          !conversations.has(message.conversationId) ||
          message.sentAt < window.from ||
          message.sentAt > window.to
        ) {
          continue
        }
        const stored = message.draftId === null ? undefined : view.draftRefs.get(message.draftId)
        const draft = stored?.organizationId === organizationId ? stored : undefined
        const sources: CitationRef[] = []
        for (const source of [...(draft?.agent?.sources ?? [])].sort(
          (a, b) => a.position - b.position
        )) {
          const cited = citationOfMomentRef(source.sourceRef)
          if (cited) {
            sources.push(cited)
          }
        }
        if (view.attributedTouches.has(touchKey(organizationId, message.id))) {
          continue
        }
        found.push({
          messageId: message.id,
          channel: message.channel,
          authorKind: message.authorKind,
          authorMembershipId: message.authorMembershipId,
          occurredAt: message.sentAt,
          sources,
        })
      }
      const sign = order === 'oldest' ? 1 : -1
      return found
        .sort(
          (a, b) =>
            sign *
            (a.occurredAt.getTime() - b.occurredAt.getTime() ||
              (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0))
        )
        .slice(0, limit)
    },

    attributeTouches: async (dealRecordId, touches) => {
      requireLock()
      const state = write()
      let stored = 0
      for (const touch of touches) {
        const key = touchKey(organizationId, touch.messageId)
        if (state.attributedTouches.has(key)) {
          continue
        }
        state.attributedTouches.set(key, { ...touch, organizationId, dealRecordId })
        stored += 1
      }
      return stored
    },

    creditSources: async (credits, won, rule) => {
      requireLock()
      const state = write()
      for (const credit of credits) {
        const key = performanceKey(organizationId, credit.kind, credit.key)
        const before = state.sourcePerformance.get(key)
        const dealsTouched = (before?.dealsTouched ?? 0) + 1
        const dealsWon = (before?.dealsWon ?? 0) + (won ? 1 : 0)
        const flagged =
          dealsTouched >= rule.minSample && dealsWon / dealsTouched < rule.winRateBelow
        // Replaced, never changed in place: a copy of the map shares its values with the original.
        state.sourcePerformance.set(key, {
          organizationId,
          kind: credit.kind,
          key: credit.key,
          dealsTouched,
          dealsWon,
          flag: flagged ? 'cited_often_lost' : null,
        })
      }
    },

    listDealTouches: async (dealRecordId, limit, after) =>
      [...read().attributedTouches.values()]
        .filter((row) => row.organizationId === organizationId && row.dealRecordId === dealRecordId)
        .sort(byOldestTouch)
        .filter((row) => after === undefined || byOldestTouch(after, row) < 0)
        .slice(0, limit)
        .map(({ organizationId: _organizationId, ...touch }) => touch),

    dealCreditEnds: async (dealRecordId) => {
      const rows = [...read().attributedTouches.values()].filter(
        (row) => row.organizationId === organizationId && row.dealRecordId === dealRecordId
      )
      return {
        firstTouchId: rows.find((row) => row.firstTouch)?.id ?? null,
        lastTouchId: rows.find((row) => row.lastTouch)?.id ?? null,
      }
    },

    listSourcePerformance: async (request) =>
      [...read().sourcePerformance.values()]
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            (request.flag === undefined || row.flag === request.flag) &&
            (request.after === undefined || byNewest(request.after, row) < 0)
        )
        .sort(byNewest)
        .slice(0, request.limit)
        .map(({ organizationId: _organizationId, ...row }) => row),
  }
}

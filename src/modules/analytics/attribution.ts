import {
  ATTRIBUTION_LOOKBACK_DAYS,
  type CitationRef,
  formatId,
  MAX_TOUCH_SOURCES,
  MIN_SOURCE_SAMPLE,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { JobEnvelope } from '~/messages'
import {
  type AttributionCandidate,
  CITED_OFTEN_LOST_BELOW,
  type NewAttributedTouch,
  type SourceCredit,
  sourceKeyOf,
} from '~/ports/attribution-store'

/** What Attribution needs from the container. */
export type AttributionDeps = Pick<Container, 'store'>

/** The queued job that attributes a Deal's Outcome. */
export type OutcomeChangedEnvelope = Extract<JobEnvelope, { type: 'deal.outcome_changed' }>

/** The most Messages one Deal reads: the Prospect's most recent outbound Messages in the window. */
export const ATTRIBUTION_CANDIDATE_LIMIT = 500

/** What attributing one Outcome did. */
export type AttributionResult =
  | { state: 'attributed'; touches: number; sources: number }
  | {
      state: 'skipped'
      reason:
        | 'organization_gone'
        | 'no_prospect'
        | 'not_decided'
        | 'already_attributed'
        | 'no_touches'
    }

const DAY_MS = 24 * 60 * 60 * 1000

const byOldest = (a: AttributionCandidate, b: AttributionCandidate) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() ||
  (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0)

/**
 * Credits a Deal's Outcome to the Prospect's touches and updates the win rate of the sources they
 * cited. It runs on the jobs queue, never on a request path, in one transaction under the
 * Organization lock, so a redelivery after a crash finds either all of it or none of it.
 *
 * The touches are the Prospect's outbound Messages (Agent or Rep) sent in the look-back window
 * ending when the Outcome changed; the earliest has first-touch credit and the latest last-touch
 * credit (one Message gets both). A Message already credited to another Deal is left with that
 * Deal. Each distinct source the touches cited counts the Deal once, as touched and, when won,
 * as won. A Deal is attributed once: a replay, or a later change of its Outcome, changes nothing.
 * Work is bounded by {@link ATTRIBUTION_CANDIDATE_LIMIT}, not by the size of the Organization.
 * Calls are not touches here: the Call record belongs to the playbook service and core has no
 * feed of them.
 */
export async function attributeOutcome(
  deps: AttributionDeps,
  organizationId: OrganizationId,
  envelope: OutcomeChangedEnvelope
): Promise<AttributionResult> {
  const { dealRecordId, prospectId, outcome, changedAt } = envelope.payload
  if (prospectId === null) {
    return { state: 'skipped', reason: 'no_prospect' }
  }
  if (outcome === 'open') {
    return { state: 'skipped', reason: 'not_decided' }
  }
  const to = new Date(changedAt)
  const from = new Date(to.getTime() - ATTRIBUTION_LOOKBACK_DAYS * DAY_MS)
  return deps.store.withOrganization(organizationId, async (scope): Promise<AttributionResult> => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return { state: 'skipped', reason: 'organization_gone' }
    }
    if (await scope.hasAttributedTouches(dealRecordId)) {
      return { state: 'skipped', reason: 'already_attributed' }
    }
    const candidates = await scope.listAttributionCandidates(
      prospectId,
      { from, to },
      ATTRIBUTION_CANDIDATE_LIMIT
    )
    const eligible = candidates.filter((c) => c.creditedTo === null).sort(byOldest)
    const first = eligible.at(0)
    const last = eligible.at(-1)
    if (!first || !last) {
      return { state: 'skipped', reason: 'no_touches' }
    }
    const touches = eligible.map(
      (c): NewAttributedTouch => ({
        id: formatId('tch', crypto.randomUUID().replaceAll('-', '')),
        messageId: c.messageId,
        prospectId,
        channel: c.channel,
        repMembershipId: c.authorKind === 'rep' ? c.authorMembershipId : null,
        occurredAt: c.occurredAt,
        firstTouch: c === first,
        lastTouch: c === last,
        citedSources: c.sources.slice(0, MAX_TOUCH_SOURCES),
      })
    )
    const stored = await scope.attributeTouches(dealRecordId, touches)
    const credits = creditsOf(touches)
    await scope.creditSources(credits, outcome === 'won', {
      minSample: MIN_SOURCE_SAMPLE,
      winRateBelow: CITED_OFTEN_LOST_BELOW,
    })
    return { state: 'attributed', touches: stored, sources: credits.length }
  })
}

/** The distinct sources a Deal's touches cited, each once. */
function creditsOf(touches: readonly { citedSources: readonly CitationRef[] }[]): SourceCredit[] {
  const credits = new Map<string, SourceCredit>()
  for (const touch of touches) {
    for (const source of touch.citedSources) {
      const credit: SourceCredit = { kind: source.kind, key: sourceKeyOf(source) }
      credits.set(`${credit.kind}|${credit.key}`, credit)
    }
  }
  return [...credits.values()]
}

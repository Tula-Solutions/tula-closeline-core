import {
  type BookingTypeId,
  formatId,
  MAX_ELIGIBLE_REPS,
  MAX_ROUTING_RULES,
  type MembershipId,
  type ProspectId,
  type RoutingAttributes,
  type RoutingResult,
  type RoutingSkipReason,
} from 'tula-closeline-contract'
import { localDayOf } from '~/modules/availability/slots'
import type { OrganizationScope } from '~/ports/core-store'
import type { RoutingRuleRecord } from '~/ports/routing-store'
import { isDefaultRule, matches } from './match'

/** How a pick treats the round-robin state: advance it under a lock, or only read it. */
export type PickMode = { store: { prospectId: ProspectId } | null }

/** The Reps a rule's target names, in Membership id order, at most {@link MAX_ELIGIBLE_REPS}. */
async function repsOf(scope: OrganizationScope, rule: RoutingRuleRecord): Promise<MembershipId[]> {
  const { target } = rule
  let ids: MembershipId[]
  if (target.kind === 'team') {
    // shortcut: one page of 100 Team members, the first 20 Reps of it; page on when Teams get larger.
    const members = await scope.listTeamMembers({ teamId: target.teamId, limit: 100 })
    ids = members.filter((member) => member.role === 'rep').map((member) => member.id)
  } else {
    const named = target.kind === 'rep' ? [target.membershipId] : target.membershipIds
    const found = await Promise.all(named.map((id) => scope.getMembership(id)))
    ids = found.flatMap((member) => (member?.role === 'rep' ? [member.id] : []))
  }
  return ids.sort().slice(0, MAX_ELIGIBLE_REPS)
}

/** Why a Rep cannot take a lead now, or `null` when they can. */
async function skipReasonOf(
  scope: OrganizationScope,
  membershipId: MembershipId,
  now: Date
): Promise<RoutingSkipReason | null> {
  const hours = await scope.getWorkingHours(membershipId)
  if (hours?.awayUntil && hours.awayUntil > now) {
    return 'on_leave'
  }
  if (!hours) {
    return 'off_shift'
  }
  const local = localDayOf(hours.timeZone, now.getTime())
  const inShift = hours.windows.some(
    (window) =>
      window.day === local.weekday && local.minutes >= window.start && local.minutes < window.end
  )
  if (!inShift) {
    return 'off_shift'
  }
  const connection = await scope.getCalendarConnection(membershipId)
  if (!connection) {
    return 'calendar_not_connected'
  }
  if (connection.state === 'needs_reconnect') {
    return 'needs_reconnect'
  }
  if (hours.dailyCap !== null) {
    const booked = await scope.countActiveBookings(
      membershipId,
      new Date(local.startMs),
      new Date(local.endMs)
    )
    if (booked >= hours.dailyCap) {
      return 'daily_cap_reached'
    }
  }
  return null
}

/**
 * Picks the first rule that matches (the default rule matches everything) and orders its Reps:
 * round-robin targets start after the Rep picked last. With `mode.store` the round-robin row is
 * locked, advanced to the first candidate, and the decision stored; without it nothing is written.
 * Cost is the rules (at most 200) plus the Reps (at most 20), each Rep checked in sequence.
 */
export async function pick(
  scope: OrganizationScope,
  request: {
    attributes: RoutingAttributes
    bookingTypeId: BookingTypeId | undefined
    now: Date
    mode: PickMode
  }
): Promise<RoutingResult> {
  const { attributes, bookingTypeId, now, mode } = request
  const rules = await scope.listRoutingRules({ limit: MAX_ROUTING_RULES })
  const rule = rules.find((row) => matches(row.conditions, attributes, bookingTypeId)) ?? null
  const candidates: RoutingResult['candidates'] = []
  const skipped: RoutingResult['skipped'] = []
  let chosen: MembershipId | null = null

  if (rule) {
    const { target } = rule
    const stateKey =
      target.kind === 'team'
        ? `team:${target.teamId}`
        : target.kind === 'pool'
          ? `rule:${rule.id}`
          : null
    let reps = await repsOf(scope, rule)
    if (stateKey !== null) {
      const state = mode.store
        ? await scope.lockRoutingState(stateKey, now)
        : await scope.readRoutingState(stateKey)
      const last = state.lastMembershipId
      const start = last === null ? 0 : reps.findIndex((id) => id > last)
      const from = start < 0 ? 0 : start
      reps = [...reps.slice(from), ...reps.slice(0, from)]
    }
    const reason = isDefaultRule(rule.conditions)
      ? 'default_rule'
      : target.kind === 'rep'
        ? 'named_rep'
        : target.kind === 'team'
          ? 'round_robin_team'
          : 'round_robin_pool'
    for (const membershipId of reps) {
      const why = await skipReasonOf(scope, membershipId, now)
      if (why === null) {
        candidates.push({ membershipId, reason })
      } else {
        skipped.push({ membershipId, reason: why })
      }
    }
    chosen = candidates[0]?.membershipId ?? null
    if (mode.store && stateKey !== null && chosen !== null) {
      await scope.saveRoutingState(stateKey, chosen, now)
    }
  }

  if (!mode.store) {
    return {
      decisionId: null,
      matchedRuleId: rule?.id ?? null,
      candidates,
      skipped,
      decidedAt: null,
    }
  }
  const decisionId = formatId('rdc', crypto.randomUUID())
  await scope.insertRoutingDecision({
    id: decisionId,
    purpose: 'booking',
    prospectId: mode.store.prospectId,
    bookingTypeId: bookingTypeId ?? null,
    ruleId: rule?.id ?? null,
    chosenMembershipId: chosen,
    candidates,
    skipped,
    reason: rule ? `Matched rule ${rule.id}` : 'No rule matched',
    now,
  })
  return {
    decisionId,
    matchedRuleId: rule?.id ?? null,
    candidates,
    skipped,
    decidedAt: now.toISOString(),
  }
}

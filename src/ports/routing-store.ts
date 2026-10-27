import type {
  BookingTypeId,
  MembershipId,
  ProspectId,
  RoutingConditions,
  RoutingDecisionId,
  RoutingResult,
  RoutingRuleId,
  RoutingTarget,
  TeamId,
} from 'tula-closeline-contract'

/** A Routing Rule as the store keeps it; `position` is dense from 1 and a rule without conditions is the default. */
export type RoutingRuleRecord = {
  id: RoutingRuleId
  name: string
  conditions: RoutingConditions
  target: RoutingTarget
  position: number
  createdAt: Date
}

/** The fields of a rule a create or an update sets. */
export type RoutingRuleFields = Pick<RoutingRuleRecord, 'name' | 'conditions' | 'target'>

/** The round-robin position of one target: the Rep picked last, or `null` before the first pick. */
export type RoutingStateRecord = { lastMembershipId: MembershipId | null }

/** One routing decision as stored: the rule, the Rep picked first and the lists the caller was given. */
export type NewRoutingDecision = {
  id: RoutingDecisionId
  purpose: 'booking' | 'handoff' | 'test'
  prospectId: ProspectId | null
  bookingTypeId: BookingTypeId | null
  ruleId: RoutingRuleId | null
  chosenMembershipId: MembershipId | null
  candidates: RoutingResult['candidates']
  skipped: RoutingResult['skipped']
  reason: string
  now: Date
}

/** The Routing Rule, round-robin and decision methods of an Organization scope. */
export interface RoutingScope {
  /** Rules in order, after `afterPosition`; at most `limit` rows. */
  listRoutingRules(request: { limit: number; afterPosition?: number }): Promise<RoutingRuleRecord[]>
  /** One rule, or `null` when this Organization has none with the id. */
  findRoutingRule(id: RoutingRuleId): Promise<RoutingRuleRecord | null>
  /** Stores a rule at the position it carries. Needs the Organization lock. */
  insertRoutingRule(input: RoutingRuleRecord): Promise<RoutingRuleRecord>
  /** Replaces a rule's name, conditions and target, or answers `null` when there is none. Needs the Organization lock. */
  updateRoutingRule(
    id: RoutingRuleId,
    fields: RoutingRuleFields,
    now: Date
  ): Promise<RoutingRuleRecord | null>
  /** Deletes a rule and answers whether there was one. Needs the Organization lock. */
  deleteRoutingRule(id: RoutingRuleId): Promise<boolean>
  /** Numbers the named rules 1, 2, 3 in the order given. Needs the Organization lock. */
  setRoutingRulePositions(ids: RoutingRuleId[], now: Date): Promise<void>
  /** Creates the state row of `targetKey` if missing, locks it until the transaction ends and answers it. */
  lockRoutingState(targetKey: string, now: Date): Promise<RoutingStateRecord>
  /** The state of `targetKey` without locking or creating it. */
  readRoutingState(targetKey: string): Promise<RoutingStateRecord>
  /** Records who was picked last for `targetKey`; the row must be locked by this transaction. */
  saveRoutingState(targetKey: string, lastMembershipId: MembershipId, now: Date): Promise<void>
  /** Stores a routing decision. */
  insertRoutingDecision(input: NewRoutingDecision): Promise<void>
  /** The stored routing decisions, newest first, at most `limit`. */
  listRoutingDecisions(request: { limit: number }): Promise<NewRoutingDecision[]>
  /** How many Bookings that are not cancelled a Rep has starting in `[from, to)`. */
  countActiveBookings(membershipId: MembershipId, from: Date, to: Date): Promise<number>
  /** Whether the Membership is on the Team. */
  isTeamMember(teamId: TeamId, membershipId: MembershipId): Promise<boolean>
}

import type { MembershipId, OrganizationId, RoutingRuleId, TeamId } from 'tula-closeline-contract'
import type { BookingState } from '~/adapters/memory/booking-state'
import type { NewRoutingDecision, RoutingRuleRecord, RoutingScope } from '~/ports/routing-store'

/** A Booking as far as routing counts it: whose, when, and whether it still stands. */
export type RoutingBooking = {
  organizationId: OrganizationId
  membershipId: MembershipId
  startsAt: Date
  status: 'pending' | 'confirmed' | 'cancelled'
}

/** What the in-memory store keeps for routing. The maps are replaced, never changed in place, once a transaction has taken its copy. */
export type RoutingState = {
  /** `organization/id` to the rule. */
  routingRules: Map<string, RoutingRuleRecord & { organizationId: OrganizationId }>
  /** `organization/target key` to the Rep picked last. */
  routingState: Map<string, MembershipId>
  routingDecisions: (NewRoutingDecision & { organizationId: OrganizationId })[]
  /** Bookings seeded by a test; there is no Booking store yet. */
  routingBookings: RoutingBooking[]
}

/** An empty {@link RoutingState}. */
export function emptyRoutingState(): RoutingState {
  return {
    routingRules: new Map(),
    routingState: new Map(),
    routingDecisions: [],
    routingBookings: [],
  }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copyRoutingState(state: RoutingState): RoutingState {
  return {
    routingRules: new Map(state.routingRules),
    routingState: new Map(state.routingState),
    routingDecisions: [...state.routingDecisions],
    routingBookings: state.routingBookings,
  }
}

const keyOf = (organizationId: OrganizationId, id: string): string => `${organizationId}\u0000${id}`

/** What a method needs from the transaction it runs in. */
export type RoutingEnvironment = {
  organizationId: OrganizationId
  read: () => RoutingState & Pick<BookingState, 'bookings'>
  write: () => RoutingState
  /** Whether the Team has the Membership; the Team places live in another state. */
  hasTeamPlace: (teamId: TeamId, membershipId: MembershipId) => boolean
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

const publicRule = ({
  organizationId: _,
  ...rule
}: RoutingRuleRecord & { organizationId: OrganizationId }): RoutingRuleRecord => rule

/** Builds the routing methods of one transaction's scope. */
export function createRoutingScope(env: RoutingEnvironment): RoutingScope {
  const { organizationId, read, write, hasTeamPlace, requireLock } = env
  const ownRules = (): (RoutingRuleRecord & { organizationId: OrganizationId })[] =>
    [...read().routingRules.values()]
      .filter((row) => row.organizationId === organizationId)
      .sort((a, b) => a.position - b.position)

  return {
    listRoutingRules: async ({ limit, afterPosition }) =>
      ownRules()
        .filter((row) => afterPosition === undefined || row.position > afterPosition)
        .slice(0, limit)
        .map(publicRule),

    findRoutingRule: async (id) => {
      const stored = read().routingRules.get(keyOf(organizationId, id))
      return stored ? publicRule(stored) : null
    },

    insertRoutingRule: async (input) => {
      requireLock()
      write().routingRules.set(keyOf(organizationId, input.id), { ...input, organizationId })
      return input
    },

    updateRoutingRule: async (id, fields) => {
      requireLock()
      const stored = read().routingRules.get(keyOf(organizationId, id))
      if (!stored) {
        return null
      }
      const next = { ...stored, ...fields }
      write().routingRules.set(keyOf(organizationId, id), next)
      return publicRule(next)
    },

    deleteRoutingRule: async (id) => {
      requireLock()
      return write().routingRules.delete(keyOf(organizationId, id))
    },

    setRoutingRulePositions: async (ids: RoutingRuleId[]) => {
      requireLock()
      ids.forEach((id, index) => {
        const stored = read().routingRules.get(keyOf(organizationId, id))
        if (stored) {
          write().routingRules.set(keyOf(organizationId, id), { ...stored, position: index + 1 })
        }
      })
    },

    lockRoutingState: async (targetKey) => ({
      lastMembershipId: read().routingState.get(keyOf(organizationId, targetKey)) ?? null,
    }),

    readRoutingState: async (targetKey) => ({
      lastMembershipId: read().routingState.get(keyOf(organizationId, targetKey)) ?? null,
    }),

    saveRoutingState: async (targetKey, lastMembershipId) => {
      write().routingState.set(keyOf(organizationId, targetKey), lastMembershipId)
    },

    insertRoutingDecision: async (input) => {
      write().routingDecisions.push({ ...input, organizationId })
    },

    listRoutingDecisions: async ({ limit }) =>
      read()
        .routingDecisions.filter((row) => row.organizationId === organizationId)
        .reverse()
        .slice(0, limit)
        .map(({ organizationId: _, ...row }) => row),

    countActiveBookings: async (membershipId, from, to) =>
      [...read().routingBookings, ...read().bookings.values()].filter(
        (row) =>
          row.organizationId === organizationId &&
          row.membershipId === membershipId &&
          ('status' in row ? row.status : row.state) !== 'cancelled' &&
          row.startsAt >= from &&
          row.startsAt < to
      ).length,

    isTeamMember: async (teamId, membershipId) => hasTeamPlace(teamId, membershipId),
  }
}

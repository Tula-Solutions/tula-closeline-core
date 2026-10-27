import type { MembershipId, OrganizationId } from 'tula-closeline-contract'
import type { CalendarConnectionRecord, OrganizationScope } from '~/ports/core-store'

/** A connection with the Organization it belongs to and its sealed credential. */
type StoredCalendarConnection = {
  organizationId: OrganizationId
  record: CalendarConnectionRecord
  credentialSealed: Uint8Array
}

/** What the in-memory store keeps for calendar connections. The map is replaced, never changed in place, once a transaction has taken its copy. */
export type CalendarState = {
  /** `organization/membership` to the connection. */
  calendarConnections: Map<string, StoredCalendarConnection>
}

/** An empty {@link CalendarState}. */
export function emptyCalendarState(): CalendarState {
  return { calendarConnections: new Map() }
}

/** A copy of the shell of the map, for a transaction's first write. */
export function copyCalendarState(state: CalendarState): CalendarState {
  return { calendarConnections: new Map(state.calendarConnections) }
}

const keyOf = (organizationId: OrganizationId, membershipId: MembershipId): string =>
  `${organizationId}\u0000${membershipId}`

/** The calendar connection methods of an {@link OrganizationScope}. */
export type CalendarScope = Pick<
  OrganizationScope,
  | 'getCalendarConnection'
  | 'getCalendarSealedCredential'
  | 'upsertCalendarConnection'
  | 'setCalendarConnectionState'
  | 'deleteCalendarConnection'
>

/** What a method needs from the transaction it runs in. */
export type CalendarEnvironment = {
  organizationId: OrganizationId
  read: () => CalendarState
  write: () => CalendarState
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

/** Builds the calendar connection methods of one transaction's scope. */
export function createCalendarScope(env: CalendarEnvironment): CalendarScope {
  const { organizationId, read, write, requireLock } = env
  const own = (membershipId: MembershipId): StoredCalendarConnection | undefined => {
    const stored = read().calendarConnections.get(keyOf(organizationId, membershipId))
    return stored?.organizationId === organizationId ? stored : undefined
  }

  return {
    getCalendarConnection: async (membershipId) => {
      const stored = own(membershipId)
      return stored ? { ...stored.record } : null
    },

    getCalendarSealedCredential: async (membershipId) => {
      const stored = own(membershipId)
      return stored ? new Uint8Array(stored.credentialSealed) : null
    },

    upsertCalendarConnection: async (input) => {
      requireLock()
      const record: CalendarConnectionRecord = {
        id: input.id,
        membershipId: input.membershipId,
        provider: input.provider,
        state: 'healthy',
        connectedAt: input.now,
        lastCheckedAt: null,
      }
      write().calendarConnections.set(keyOf(organizationId, input.membershipId), {
        organizationId,
        record,
        credentialSealed: new Uint8Array(input.credentialSealed),
      })
      return { ...record }
    },

    setCalendarConnectionState: async (membershipId, state, checkedAt) => {
      requireLock()
      const stored = own(membershipId)
      if (!stored) {
        return null
      }
      const record = { ...stored.record, state, lastCheckedAt: checkedAt }
      write().calendarConnections.set(keyOf(organizationId, membershipId), { ...stored, record })
      return { ...record }
    },

    deleteCalendarConnection: async (membershipId) => {
      requireLock()
      const stored = own(membershipId)
      if (!stored) {
        return null
      }
      write().calendarConnections.delete(keyOf(organizationId, membershipId))
      return { ...stored.record }
    },
  }
}

/** Test helper: the sealed bytes held for a Rep's connection, to show nothing plain is stored. */
export function sealedCalendarBytesOf(
  state: CalendarState,
  organizationId: OrganizationId,
  membershipId: MembershipId
): Uint8Array | null {
  return (
    state.calendarConnections.get(keyOf(organizationId, membershipId))?.credentialSealed ?? null
  )
}

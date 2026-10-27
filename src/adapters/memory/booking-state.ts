import type { BookingTypeId, MembershipId, OrganizationId } from 'tula-closeline-contract'
import {
  type BookingScope,
  BookingTypeNameTakenError,
  type BookingTypeRecord,
  type WorkingHoursRecord,
} from '~/ports/booking-store'

/** What the in-memory store keeps for Booking Types and working hours. The maps are replaced, never changed in place, once a transaction has taken its copy. */
export type BookingState = {
  /** `organization/id` to the Booking Type. */
  bookingTypes: Map<string, BookingTypeRecord & { organizationId: OrganizationId }>
  /** `organization/membership` to the Rep's hours. */
  workingHours: Map<string, WorkingHoursRecord & { organizationId: OrganizationId }>
}

/** An empty {@link BookingState}. */
export function emptyBookingState(): BookingState {
  return { bookingTypes: new Map(), workingHours: new Map() }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copyBookingState(state: BookingState): BookingState {
  return { bookingTypes: new Map(state.bookingTypes), workingHours: new Map(state.workingHours) }
}

const keyOf = (organizationId: OrganizationId, id: string): string => `${organizationId}\u0000${id}`

/** The hours without the memory-only Organization column, with copied windows. */
const hoursOf = ({
  organizationId: _,
  ...hours
}: WorkingHoursRecord & { organizationId: OrganizationId }) => ({
  ...hours,
  windows: hours.windows.map((window) => ({ ...window })),
})

/** What a method needs from the transaction it runs in. */
export type BookingEnvironment = {
  organizationId: OrganizationId
  read: () => BookingState
  write: () => BookingState
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

const publicRecord = (stored: BookingTypeRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organizationId, ...record } = stored
  return record
}

/** Builds the Booking Type and working-hours methods of one transaction's scope. */
export function createBookingScope(env: BookingEnvironment): BookingScope {
  const { organizationId, read, write, requireLock } = env
  const ownTypes = (): (BookingTypeRecord & { organizationId: OrganizationId })[] =>
    [...read().bookingTypes.values()].filter((row) => row.organizationId === organizationId)
  const nameTaken = (name: string, except?: BookingTypeId): boolean =>
    ownTypes().some((row) => row.id !== except && row.name.toLowerCase() === name.toLowerCase())

  return {
    insertBookingType: async (input) => {
      requireLock()
      if (nameTaken(input.name)) {
        throw new BookingTypeNameTakenError()
      }
      const { now, ...fields } = input
      const stored = { ...fields, organizationId, state: 'active' as const, createdAt: now }
      write().bookingTypes.set(keyOf(organizationId, input.id), stored)
      return publicRecord(stored)
    },

    findBookingType: async (id) => {
      const stored = read().bookingTypes.get(keyOf(organizationId, id))
      return stored ? publicRecord(stored) : null
    },

    listBookingTypes: async ({ limit, after, state }) =>
      ownTypes()
        .filter((row) => state === undefined || row.state === state)
        .filter(
          (row) =>
            !after ||
            row.createdAt < after.at ||
            (row.createdAt.getTime() === after.at.getTime() && row.id < after.id)
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(publicRecord),

    updateBookingType: async (id, changes) => {
      requireLock()
      const stored = read().bookingTypes.get(keyOf(organizationId, id))
      if (!stored) {
        return null
      }
      if (changes.name !== undefined && nameTaken(changes.name, id)) {
        throw new BookingTypeNameTakenError()
      }
      const next = { ...stored, ...changes }
      write().bookingTypes.set(keyOf(organizationId, id), next)
      return publicRecord(next)
    },

    retireBookingType: async (id) => {
      requireLock()
      const stored = read().bookingTypes.get(keyOf(organizationId, id))
      if (!stored) {
        return null
      }
      const next = { ...stored, state: 'retired' as const }
      write().bookingTypes.set(keyOf(organizationId, id), next)
      return publicRecord(next)
    },

    getWorkingHours: async (membershipId: MembershipId) => {
      const stored = read().workingHours.get(keyOf(organizationId, membershipId))
      return stored ? hoursOf(stored) : null
    },

    putWorkingHours: async (input) => {
      requireLock()
      const stored = {
        ...input,
        windows: input.windows.map((window) => ({ ...window })),
        organizationId,
      }
      write().workingHours.set(keyOf(organizationId, input.membershipId), stored)
      return hoursOf(stored)
    },
  }
}

import type {
  BookingId,
  BookingTypeId,
  MembershipId,
  OrganizationId,
} from 'tula-closeline-contract'
import {
  type BookingRecord,
  type BookingScope,
  BookingSlotTakenError,
  BookingTypeNameTakenError,
  type BookingTypeRecord,
  type BusyRange,
  MAX_BUSY_RANGES,
  MAX_REP_BOOKINGS,
  type WorkingHoursRecord,
} from '~/ports/booking-store'

/** What the in-memory store keeps for Booking Types and working hours. The maps are replaced, never changed in place, once a transaction has taken its copy. */
export type BookingState = {
  /** `organization/id` to the Booking Type. */
  bookingTypes: Map<string, BookingTypeRecord & { organizationId: OrganizationId }>
  /** `organization/membership` to the Rep's hours. */
  workingHours: Map<string, WorkingHoursRecord & { organizationId: OrganizationId }>
  /** `organization/membership` to the Rep's busy ranges, earliest first; the arrays are replaced whole. */
  busyBlocks: Map<string, BusyRange[]>
  /** `organization/id` to the Booking. */
  bookings: Map<string, BookingRecord & { organizationId: OrganizationId }>
}

/** An empty {@link BookingState}. */
export function emptyBookingState(): BookingState {
  return {
    bookingTypes: new Map(),
    workingHours: new Map(),
    busyBlocks: new Map(),
    bookings: new Map(),
  }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copyBookingState(state: BookingState): BookingState {
  return {
    bookingTypes: new Map(state.bookingTypes),
    workingHours: new Map(state.workingHours),
    busyBlocks: new Map(state.busyBlocks),
    bookings: new Map(state.bookings),
  }
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

const bookingOf = ({
  organizationId: _,
  ...record
}: BookingRecord & { organizationId: OrganizationId }) => record

/** Builds the Booking Type, working-hours and Booking methods of one transaction's scope. */
export function createBookingScope(env: BookingEnvironment): BookingScope {
  const { organizationId, read, write, requireLock } = env
  const ownTypes = (): (BookingTypeRecord & { organizationId: OrganizationId })[] =>
    [...read().bookingTypes.values()].filter((row) => row.organizationId === organizationId)
  const ownBookings = (): (BookingRecord & { organizationId: OrganizationId })[] =>
    [...read().bookings.values()].filter((row) => row.organizationId === organizationId)
  // Stands in for the db exclusion constraint: confirmed Bookings of one Rep never overlap.
  const requireFree = (id: BookingId, membershipId: MembershipId, from: Date, until: Date) => {
    const clash = ownBookings().some(
      (row) =>
        row.id !== id &&
        row.membershipId === membershipId &&
        row.state === 'confirmed' &&
        row.blockedFrom < until &&
        from < row.blockedUntil
    )
    if (clash) {
      throw new BookingSlotTakenError()
    }
  }
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

    replaceBusyBlocks: async (membershipId, { from, to }, blocks) => {
      requireLock()
      const key = keyOf(organizationId, membershipId)
      const kept = (read().busyBlocks.get(key) ?? []).filter(
        (row) => row.endsAt <= from || row.startsAt >= to
      )
      const next = [...kept, ...blocks.map((block) => ({ ...block }))]
      write().busyBlocks.set(
        key,
        next.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      )
    },

    listBusyBlocks: async (membershipId, from, to) =>
      (read().busyBlocks.get(keyOf(organizationId, membershipId)) ?? [])
        .filter((row) => row.endsAt > from && row.startsAt < to)
        .slice(0, MAX_BUSY_RANGES)
        .map((row) => ({ ...row })),

    insertBooking: async (input) => {
      requireLock()
      const { now, ...fields } = input
      const stored = {
        ...fields,
        organizationId,
        state: 'pending' as const,
        calendarEventId: null,
        joinUrl: null,
        cancelledAt: null,
        createdAt: now,
      }
      write().bookings.set(keyOf(organizationId, input.id), stored)
      return bookingOf(stored)
    },

    findBooking: async (id) => {
      const stored = read().bookings.get(keyOf(organizationId, id))
      return stored ? bookingOf(stored) : null
    },

    findBookingByKeyHash: async (keyHash) => {
      const stored = ownBookings().find((row) => row.keyHash === keyHash)
      return stored ? bookingOf(stored) : null
    },

    listBookings: async ({ limit, after, state, membershipIds, prospectId, from, to }) =>
      ownBookings()
        .filter(
          (row) =>
            (state === undefined || row.state === state) &&
            (membershipIds === undefined || membershipIds.includes(row.membershipId)) &&
            (prospectId === undefined || row.prospectId === prospectId) &&
            (from === undefined || row.startsAt >= from) &&
            (to === undefined || row.startsAt < to) &&
            (!after ||
              row.startsAt < after.startsAt ||
              (row.startsAt.getTime() === after.startsAt.getTime() && row.id < after.id))
        )
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(bookingOf),

    listRepBookings: async (membershipId, from, to, pendingSince) =>
      ownBookings()
        .filter(
          (row) =>
            row.membershipId === membershipId &&
            row.state !== 'cancelled' &&
            (row.state === 'confirmed' || row.createdAt >= pendingSince) &&
            row.blockedUntil > from &&
            row.blockedFrom < to
        )
        .sort((a, b) => a.blockedFrom.getTime() - b.blockedFrom.getTime())
        .slice(0, MAX_REP_BOOKINGS)
        .map(bookingOf),

    confirmBooking: async (id, event) => {
      requireLock()
      const stored = read().bookings.get(keyOf(organizationId, id))
      if (!stored || stored.state !== 'pending') {
        return null
      }
      requireFree(id, stored.membershipId, stored.blockedFrom, stored.blockedUntil)
      const next = { ...stored, ...event, state: 'confirmed' as const }
      write().bookings.set(keyOf(organizationId, id), next)
      return bookingOf(next)
    },

    moveBooking: async (id, time) => {
      requireLock()
      const stored = read().bookings.get(keyOf(organizationId, id))
      if (!stored) {
        return null
      }
      requireFree(id, stored.membershipId, time.blockedFrom, time.blockedUntil)
      const next = { ...stored, ...time }
      write().bookings.set(keyOf(organizationId, id), next)
      return bookingOf(next)
    },

    cancelBooking: async (id, now) => {
      requireLock()
      const stored = read().bookings.get(keyOf(organizationId, id))
      if (!stored) {
        return null
      }
      const next = { ...stored, state: 'cancelled' as const, cancelledAt: now }
      write().bookings.set(keyOf(organizationId, id), next)
      return bookingOf(next)
    },

    deletePendingBooking: async (id) => {
      requireLock()
      const stored = read().bookings.get(keyOf(organizationId, id))
      if (stored?.state === 'pending') {
        write().bookings.delete(keyOf(organizationId, id))
      }
    },
  }
}

import type {
  BookingId,
  BookingMode,
  BookingState,
  BookingTypeId,
  BookingTypeState,
  MembershipId,
  ProspectId,
  RoutingDecisionId,
} from 'tula-closeline-contract'

/** Another Booking Type in this Organization already has the name, ignoring case. */
export class BookingTypeNameTakenError extends Error {
  constructor() {
    super('A Booking Type with that name already exists')
    this.name = 'BookingTypeNameTakenError'
  }
}

/** Another confirmed Booking of the Rep already holds part of the time (the db exclusion constraint). */
export class BookingSlotTakenError extends Error {
  constructor() {
    super('The Rep already has a Booking in that time')
    this.name = 'BookingSlotTakenError'
  }
}

/** A Booking as the store keeps it. `blockedFrom` and `blockedUntil` are its time widened by the buffers. */
export type BookingRecord = {
  id: BookingId
  bookingTypeId: BookingTypeId
  membershipId: MembershipId
  prospectId: ProspectId
  state: BookingState
  mode: BookingMode
  startsAt: Date
  endsAt: Date
  blockedFrom: Date
  blockedUntil: Date
  /** SHA-256 hex of the caller and the `Idempotency-Key`. */
  keyHash: string
  routingDecisionId: RoutingDecisionId | null
  calendarEventId: string | null
  joinUrl: string | null
  cancelledAt: Date | null
  createdAt: Date
}

/** What storing a pending Booking takes. */
export type NewBooking = Pick<
  BookingRecord,
  | 'id'
  | 'bookingTypeId'
  | 'membershipId'
  | 'prospectId'
  | 'mode'
  | 'startsAt'
  | 'endsAt'
  | 'blockedFrom'
  | 'blockedUntil'
  | 'keyHash'
  | 'routingDecisionId'
> & { now: Date }

/** The most Bookings of one Rep that a slots call reads. */
export const MAX_REP_BOOKINGS = 2000

/** A Booking Type as the store keeps it; only the hash of its link token is stored. */
export type BookingTypeRecord = {
  id: BookingTypeId
  name: string
  lengthMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minimumNoticeMinutes: number
  mode: BookingMode
  state: BookingTypeState
  /** SHA-256 hex of the link token, or `null` while the public page is off. */
  publicTokenHash: string | null
  createdAt: Date
}

/** What creating a Booking Type stores. */
export type NewBookingType = Omit<BookingTypeRecord, 'state' | 'createdAt'> & { now: Date }

/** The fields an update may change. */
export type BookingTypeChanges = Partial<
  Pick<
    BookingTypeRecord,
    | 'name'
    | 'lengthMinutes'
    | 'bufferBeforeMinutes'
    | 'bufferAfterMinutes'
    | 'minimumNoticeMinutes'
    | 'mode'
  >
>

/** A keyset position in the newest-first list of Booking Types. */
export type BookingTypePosition = { at: Date; id: BookingTypeId }

/** One weekly window as stored: `day` 0 to 6 with Monday 0, `start` and `end` in minutes after midnight. */
export type StoredWindow = { day: number; start: number; end: number }

/** A Rep's working hours as the store keeps them. */
export type WorkingHoursRecord = {
  membershipId: MembershipId
  timeZone: string
  windows: StoredWindow[]
  dailyCap: number | null
  awayUntil: Date | null
}

/** A time range a Rep is busy in, as the calendar reported it; times only, never titles. */
export type BusyRange = { startsAt: Date; endsAt: Date }

/** The most busy ranges one Rep keeps; the calendar port never returns more. */
export const MAX_BUSY_RANGES = 5000

/** The Booking Type, working-hours and busy-block methods of an Organization scope. */
export interface BookingScope {
  /** Stores a Booking Type. Throws {@link BookingTypeNameTakenError}. Needs the Organization lock. */
  insertBookingType(input: NewBookingType): Promise<BookingTypeRecord>
  /** One Booking Type, or `null` when this Organization has none with the id. */
  findBookingType(id: BookingTypeId): Promise<BookingTypeRecord | null>
  /** Booking Types newest first, after `after`, optionally of one state; at most `limit` rows. */
  listBookingTypes(request: {
    limit: number
    after?: BookingTypePosition
    state?: BookingTypeState
  }): Promise<BookingTypeRecord[]>
  /** Changes fields of a Booking Type, or `null` when there is none. Throws {@link BookingTypeNameTakenError}. Needs the Organization lock. */
  updateBookingType(
    id: BookingTypeId,
    changes: BookingTypeChanges,
    now: Date
  ): Promise<BookingTypeRecord | null>
  /** Marks a Booking Type retired (it keeps its token hash) and answers it, or `null` when there is none. Needs the Organization lock. */
  retireBookingType(id: BookingTypeId, now: Date): Promise<BookingTypeRecord | null>
  /** A Rep's working hours, or `null` when never set. */
  getWorkingHours(membershipId: MembershipId): Promise<WorkingHoursRecord | null>
  /** Replaces a Rep's working hours (one row per Rep). Needs the Organization lock. */
  putWorkingHours(input: WorkingHoursRecord, now: Date): Promise<WorkingHoursRecord>

  /** Replaces a Rep's busy ranges overlapping `[from, to)` with `blocks`. Needs the Organization lock. */
  replaceBusyBlocks(
    membershipId: MembershipId,
    window: { from: Date; to: Date },
    blocks: BusyRange[],
    now: Date
  ): Promise<void>
  /** A Rep's busy ranges overlapping `[from, to)`, earliest first; at most {@link MAX_BUSY_RANGES}. */
  listBusyBlocks(membershipId: MembershipId, from: Date, to: Date): Promise<BusyRange[]>

  /** Stores a Booking as `pending`. Needs the Organization lock. */
  insertBooking(input: NewBooking): Promise<BookingRecord>
  /** One Booking, or `null` when this Organization has none with the id. */
  findBooking(id: BookingId): Promise<BookingRecord | null>
  /** The Booking a key hash made, or `null`. */
  findBookingByKeyHash(keyHash: string): Promise<BookingRecord | null>
  /**
   * Bookings latest start first, after `after`, at most `limit` rows. `membershipIds` narrows to
   * those Reps (`undefined` is every Rep); the other filters narrow further.
   */
  listBookings(request: {
    limit: number
    after?: { startsAt: Date; id: BookingId }
    state?: BookingState
    membershipIds?: MembershipId[]
    prospectId?: ProspectId
    from?: Date
    to?: Date
  }): Promise<BookingRecord[]>
  /**
   * A Rep's Bookings whose blocked range overlaps `[from, to)`, not cancelled; a `pending` one
   * counts only when created at or after `pendingSince`. At most {@link MAX_REP_BOOKINGS}.
   */
  listRepBookings(
    membershipId: MembershipId,
    from: Date,
    to: Date,
    pendingSince: Date
  ): Promise<BookingRecord[]>
  /** Confirms a Booking with its calendar event. Throws {@link BookingSlotTakenError}. Needs the lock. */
  confirmBooking(
    id: BookingId,
    event: { calendarEventId: string; joinUrl: string | null },
    now: Date
  ): Promise<BookingRecord | null>
  /** Moves a Booking to a new time. Throws {@link BookingSlotTakenError}. Needs the lock. */
  moveBooking(
    id: BookingId,
    time: { startsAt: Date; endsAt: Date; blockedFrom: Date; blockedUntil: Date },
    now: Date
  ): Promise<BookingRecord | null>
  /** Marks a Booking cancelled. Needs the lock. */
  cancelBooking(id: BookingId, now: Date): Promise<BookingRecord | null>
  /** Removes a Booking that is still `pending`; a confirmed one is never removed. Needs the lock. */
  deletePendingBooking(id: BookingId): Promise<void>
}

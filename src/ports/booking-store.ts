import type {
  BookingMode,
  BookingTypeId,
  BookingTypeState,
  MembershipId,
} from 'tula-closeline-contract'

/** Another Booking Type in this Organization already has the name, ignoring case. */
export class BookingTypeNameTakenError extends Error {
  constructor() {
    super('A Booking Type with that name already exists')
    this.name = 'BookingTypeNameTakenError'
  }
}

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
}

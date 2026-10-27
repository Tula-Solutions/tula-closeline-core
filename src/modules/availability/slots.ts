import {
  BOOKING_ERRORS,
  type BookingTypeId,
  type MembershipId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { BusyRange, StoredWindow } from '~/ports/booking-store'

const MINUTE_MS = 60_000

/** The longest range one slots call covers, in days: the horizon the busy times are kept for. */
export const MAX_SLOT_RANGE_DAYS = 14

/** The most slots one call answers. */
export const MAX_SLOTS = 500

/** What {@link computeSlots} reads; times are epoch milliseconds, window minutes are local. */
export type SlotInput = {
  timeZone: string
  windows: StoredWindow[]
  lengthMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minimumNoticeMinutes: number
  now: number
  awayUntil: number | null
  from: number
  to: number
  /** Busy ranges as epoch milliseconds, earliest start first. */
  busy: { start: number; end: number }[]
  limit: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The parts of the local wall clock of `ms` in `zone`, as a UTC-based timestamp (offset included). */
function wallClockMs(zone: string, ms: number): number {
  let format = formatters.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(zone, format)
  }
  const part: Record<string, number> = {}
  for (const { type, value } of format.formatToParts(ms)) {
    part[type] = Number(value)
  }
  return Date.UTC(
    part.year ?? 1970,
    (part.month ?? 1) - 1,
    part.day ?? 1,
    part.hour ?? 0,
    part.minute ?? 0,
    part.second ?? 0
  )
}

/** The instant at which the wall clock of `zone` reads `wall` (a UTC-based timestamp); a skipped time moves forward. */
function instantOf(zone: string, wall: number): number {
  const first = wall - (wallClockMs(zone, wall) - wall)
  const second = wall - (wallClockMs(zone, first) - first)
  return second
}

/** Merges ranges that touch or overlap; the input is sorted by start. */
/** Where `ms` falls on a Rep's wall clock: the weekday (Monday 0), minutes after midnight, and the instants their local day starts and ends. */
export function localDayOf(
  zone: string,
  ms: number
): { weekday: number; minutes: number; startMs: number; endMs: number } {
  const wall = wallClockMs(zone, ms)
  const days = Math.floor(wall / 86_400_000)
  const midnight = days * 86_400_000
  return {
    // The epoch day was a Thursday, which is 3 with Monday 0.
    weekday: (((days + 3) % 7) + 7) % 7,
    minutes: Math.floor((wall - midnight) / MINUTE_MS),
    startMs: instantOf(zone, midnight),
    endMs: instantOf(zone, midnight + 86_400_000),
  }
}

function merge(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * The start times a Rep can be booked in `[from, to]`: inside their weekly windows read in their
 * own time zone, one `lengthMinutes` apart from each window's start, not before the notice or
 * `awayUntil`, and with the buffers around the slot clear of every busy range. Pure; at most
 * `limit` slots, earliest first. Cost is O(days x windows x slots per window + busy).
 */
export function computeSlots(input: SlotInput): { start: number; end: number }[] {
  const length = input.lengthMinutes * MINUTE_MS
  const before = input.bufferBeforeMinutes * MINUTE_MS
  const after = input.bufferAfterMinutes * MINUTE_MS
  const earliest = Math.max(
    input.from,
    input.now + input.minimumNoticeMinutes * MINUTE_MS,
    input.awayUntil ?? 0
  )
  const busy = merge(input.busy)
  const windows = [...input.windows].sort((a, b) => a.day - b.day || a.start - b.start)
  const slots: { start: number; end: number }[] = []
  let busyIndex = 0
  let lastStart = Number.NEGATIVE_INFINITY

  const firstDay = new Date(wallClockMs(input.timeZone, input.from))
  const dayMs = Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate())
  for (let offset = 0; slots.length < input.limit; offset++) {
    const day = dayMs + offset * 86_400_000
    const weekday = (new Date(day).getUTCDay() + 6) % 7
    for (const window of windows) {
      if (window.day !== weekday) {
        continue
      }
      const windowStart = instantOf(input.timeZone, day + window.start * MINUTE_MS)
      const windowEnd = Math.min(instantOf(input.timeZone, day + window.end * MINUTE_MS), input.to)
      if (windowStart > input.to) {
        return slots
      }
      const lowest = Math.max(earliest, lastStart + 1, windowStart)
      let start = windowStart + Math.ceil((lowest - windowStart) / length) * length
      for (; start + length <= windowEnd && slots.length < input.limit; start += length) {
        while (busy[busyIndex] && (busy[busyIndex]?.end ?? 0) <= start - before) {
          busyIndex++
        }
        const next = busy[busyIndex]
        if (next && next.start < start + length + after) {
          continue
        }
        slots.push({ start, end: start + length })
        lastStart = start
      }
    }
    if (dayMs + offset * 86_400_000 > input.to + 86_400_000) {
      return slots
    }
  }
  return slots
}

/** What the slots service needs from the container. */
export type SlotsDeps = Pick<Container, 'store' | 'clock'>

/** One bookable start, as a Rep's slots list it. */
export type RepSlot = { startsAt: string; endsAt: string; repMembershipId: MembershipId }

/**
 * The slots of one Rep for a Booking Type in `[from, to]` (at most {@link MAX_SLOT_RANGE_DAYS}
 * days; a longer range is cut). Reads the busy times already stored by the refresh job and never
 * calls the calendar. A retired or unknown Booking Type is `booking.type_not_found`; a Rep with no
 * hours has no slots.
 */
export async function slots(
  deps: SlotsDeps,
  organizationId: OrganizationId,
  request: { membershipId: MembershipId; bookingTypeId: BookingTypeId; from: Date; to: Date }
): Promise<RepSlot[]> {
  const now = deps.clock.now()
  // Busy times are loaded for the next MAX_SLOT_RANGE_DAYS days only; beyond that nothing is offered.
  const horizon = MAX_SLOT_RANGE_DAYS * 86_400_000
  const to = new Date(
    Math.min(request.to.getTime(), request.from.getTime() + horizon, now.getTime() + horizon)
  )
  if (to <= request.from) {
    return []
  }
  const read = await deps.store.withOrganization(organizationId, async (scope) => {
    const type = await scope.findBookingType(request.bookingTypeId)
    if (type?.state !== 'active') {
      throw domainError(BOOKING_ERRORS['booking.type_not_found'])
    }
    // Buffers reach past the range, so busy times are read that much wider.
    const margin = Math.max(type.bufferBeforeMinutes, type.bufferAfterMinutes) * MINUTE_MS
    return {
      type,
      hours: await scope.getWorkingHours(request.membershipId),
      busy: await scope.listBusyBlocks(
        request.membershipId,
        new Date(request.from.getTime() - margin),
        new Date(to.getTime() + margin)
      ),
    }
  })
  if (!read.hours) {
    return []
  }
  const toMs = (range: BusyRange) => ({
    start: range.startsAt.getTime(),
    end: range.endsAt.getTime(),
  })
  return computeSlots({
    timeZone: read.hours.timeZone,
    windows: read.hours.windows,
    lengthMinutes: read.type.lengthMinutes,
    bufferBeforeMinutes: read.type.bufferBeforeMinutes,
    bufferAfterMinutes: read.type.bufferAfterMinutes,
    minimumNoticeMinutes: read.type.minimumNoticeMinutes,
    now: now.getTime(),
    awayUntil: read.hours.awayUntil?.getTime() ?? null,
    from: request.from.getTime(),
    to: to.getTime(),
    busy: read.busy.map(toMs),
    limit: MAX_SLOTS,
  }).map((slot) => ({
    startsAt: new Date(slot.start).toISOString(),
    endsAt: new Date(slot.end).toISOString(),
    repMembershipId: request.membershipId,
  }))
}

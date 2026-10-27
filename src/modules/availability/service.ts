import {
  type Availability,
  BOOKING_ERRORS,
  ERRORS,
  type MembershipId,
  WEEKDAYS,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { StoredWindow, WorkingHoursRecord } from '~/ports/booking-store'

/** What the availability service needs from the container. */
export type AvailabilityDeps = Pick<Container, 'store' | 'clock'>

/** The most weekly windows a Rep may have. */
const MAX_WINDOWS = 28

/** What a Rep who never set their hours has: no windows, in UTC. */
const DEFAULT_TIME_ZONE = 'UTC'

const toMinutes = (time: string): number => {
  const [hours = '0', minutes = '0'] = time.split(':')
  return Number(hours) * 60 + Number(minutes)
}

const toTime = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** True when the runtime knows `zone` as an IANA time zone. */
function knowsTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The stored windows of the contract's days, Monday 0. */
function toWindows(hours: Availability['hours']): StoredWindow[] {
  return hours.flatMap((day) =>
    day.windows.map((window) => ({
      day: WEEKDAYS.indexOf(day.day),
      start: toMinutes(window.start),
      end: toMinutes(window.end),
    }))
  )
}

/** The contract's days from stored windows. */
function toHours(windows: StoredWindow[]): Availability['hours'] {
  return WEEKDAYS.flatMap((day, index) => {
    const own = windows
      .filter((window) => window.day === index)
      .sort((a, b) => a.start - b.start)
      .map((window) => ({ start: toTime(window.start), end: toTime(window.end) }))
    return own.length === 0 ? [] : [{ day, windows: own }]
  })
}

function toAvailability(record: WorkingHoursRecord | null): Availability {
  return {
    timeZone: record?.timeZone ?? DEFAULT_TIME_ZONE,
    hours: toHours(record?.windows ?? []),
    dailyCap: record?.dailyCap ?? null,
    awayUntil: record?.awayUntil?.toISOString() ?? null,
  }
}

/** The caller's own Membership id: working hours are never another member's to set. */
async function ownMembership(
  scope: Parameters<typeof openOrganization>[0],
  caller: Caller
): Promise<MembershipId> {
  const own = await scope.getMembershipByUser(caller.userId)
  if (!own) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return own.id
}

/** The caller's own working hours and time zone; UTC with no windows until they are set. Any role. */
export async function get(
  deps: Pick<AvailabilityDeps, 'store'>,
  caller: Caller
): Promise<Availability> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'availability.read')
    return toAvailability(await scope.getWorkingHours(await ownMembership(scope, caller)))
  })
}

/**
 * Replaces the caller's own working hours. An unknown time zone, or more than 28 windows, is
 * `calendar.hours_invalid`. Setting what is already set changes nothing. Any role, own hours only.
 */
export async function set(
  deps: AvailabilityDeps,
  caller: Caller,
  request: Availability
): Promise<Availability> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'availability.write')
    const windows = toWindows(request.hours)
    if (!knowsTimeZone(request.timeZone) || windows.length > MAX_WINDOWS) {
      throw domainError(BOOKING_ERRORS['calendar.hours_invalid'])
    }
    const stored = await scope.putWorkingHours(
      {
        membershipId: await ownMembership(scope, caller),
        timeZone: request.timeZone,
        windows,
        dailyCap: request.dailyCap,
        awayUntil: request.awayUntil === null ? null : new Date(request.awayUntil),
      },
      now
    )
    return toAvailability(stored)
  })
}

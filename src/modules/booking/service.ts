import { createHash } from 'node:crypto'
import {
  BOOKING_ERRORS,
  type Booking,
  type BookingId,
  type BookingOrigin,
  type BookingTypeId,
  type BookRequest,
  bookingCursorSchema,
  bookingSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListBookingsQuery,
  type ListSlotsQuery,
  MAX_ELIGIBLE_REPS,
  type MembershipId,
  type OrganizationId,
  type Page,
  type ProspectId,
  type PublicBookingConfirmation,
  type PublicBookRequest,
  type PublicManagedBooking,
  publicBookingConfirmationSchema,
  type publicListSlotsQuerySchema,
  publicManagedBookingSchema,
  publicSlotPageSchema,
  type RescheduleBookingRequest,
  type Role,
  type RoutingAttributes,
  type Slot,
} from 'tula-closeline-contract'
import { type CalendarConnection, CalendarError } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import { computeSlots, localDayOf, MAX_SLOT_RANGE_DAYS } from '~/modules/availability/slots'
import { hashLinkToken, manageTokenOf } from '~/modules/booking-type/schema'
import { openVendorConnection } from '~/modules/calendar/service'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  bookingCancelledEvent,
  bookingRescheduledEvent,
  createdEvent,
  enqueueEvents,
  newOutboxId,
} from '~/modules/prospect/events'
import { writeFields } from '~/modules/prospect/fields'
import { prospectNotFound, visibilityOf } from '~/modules/prospect/service'
import { bandOf } from '~/modules/routing/match'
import { pick } from '~/modules/routing/pick'
import {
  type BookingRecord,
  BookingSlotTakenError,
  type BookingTypeRecord,
} from '~/ports/booking-store'
import type { OrganizationScope, ProspectRecord } from '~/ports/core-store'

/** What the Booking service needs from the container. */
export type BookingDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'secretBox' | 'calendar'>

/** The most Slots one page returns. */
const MAX_SLOTS_PER_PAGE = 100
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** How long a `pending` Booking holds its time while its calendar write is in flight, in ms. */
const PENDING_HOLD_MS = 60_000
/** The longest a calendar call on the Booking path waits, in ms; the adapter retries inside it. */
const CALENDAR_TIMEOUT_MS = 3000
/** Reps a Manager sees Bookings of. */
const MANAGED_REPS = 1000

const slotCursor = z.strictObject({ startsAt: z.number().int() })

/** The answer to a write: the status the router sends and the Booking. */
export type BookingAnswer = { status: 200 | 201; body: Booking }

const taken = () => domainError(BOOKING_ERRORS['booking.slot_taken'])
const invalid = () => domainError(BOOKING_ERRORS['booking.slot_invalid'])
const unavailable = () => domainError(BOOKING_ERRORS['booking.calendar_unavailable'])
const notFound = () => domainError(BOOKING_ERRORS['booking.not_found'])
const typeNotFound = () => domainError(BOOKING_ERRORS['booking.type_not_found'])

/** The API shape of a Booking. */
function toBooking(record: BookingRecord): Booking {
  return bookingSchema.parse({
    id: record.id,
    bookingTypeId: record.bookingTypeId,
    repMembershipId: record.membershipId,
    prospectId: record.prospectId,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    mode: record.mode,
    state: record.state,
    origin: record.origin,
    joinUrl: record.mode === 'video' ? record.joinUrl : null,
    routingDecisionId: record.routingDecisionId,
    createdAt: record.createdAt.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
  })
}

/** The Booking Type, which must be active. */
async function activeType(scope: OrganizationScope, id: BookingTypeId): Promise<BookingTypeRecord> {
  const type = await scope.findBookingType(id)
  if (type?.state !== 'active') {
    throw typeNotFound()
  }
  return type
}

/** The Prospect, as the caller may see it. */
async function visibleProspect(
  scope: OrganizationScope,
  caller: Caller,
  id: ProspectId
): Promise<ProspectRecord> {
  const { visibility } = await visibilityOf(scope, caller)
  const prospect = await scope.getProspect(id, visibility)
  if (!prospect) {
    throw prospectNotFound()
  }
  return prospect
}

/** What routing matches a Prospect on. */
async function attributesOf(
  scope: OrganizationScope,
  prospect: ProspectRecord
): Promise<RoutingAttributes> {
  const fields = prospect.companyId
    ? ((await scope.listCurrentFields('company', [prospect.companyId])).get(prospect.companyId) ??
      [])
    : []
  const field = (name: string) => fields.find((row) => row.field === name)?.value ?? null
  return {
    country: null,
    region: field('region'),
    companySizeBand:
      field('employeeCount') === null ? null : bandOf(Number(field('employeeCount'))),
    accountOwnerMembershipId: prospect.ownerMembershipId,
    source: prospect.source,
  }
}

/**
 * The Reps who may take a Booking, in routing order. A Rep is out now (off shift, on leave, at
 * today's cap) is still eligible for a later time; one with no healthy calendar is not.
 */
async function eligibleReps(
  scope: OrganizationScope,
  attributes: RoutingAttributes,
  bookingTypeId: BookingTypeId,
  now: Date,
  /** The Prospect to store the routing decision for, or `null` to only read the order. */
  storeFor: ProspectId | null
): Promise<{ reps: MembershipId[]; decisionId: BookingRecord['routingDecisionId'] }> {
  const result = await pick(scope, {
    attributes,
    bookingTypeId,
    now,
    mode: { store: storeFor ? { prospectId: storeFor } : null },
  })
  const later = new Set(['off_shift', 'on_leave', 'daily_cap_reached'])
  const reps = [
    ...result.candidates.map((row) => row.membershipId),
    ...result.skipped.filter((row) => later.has(row.reason)).map((row) => row.membershipId),
  ].slice(0, MAX_ELIGIBLE_REPS)
  return { reps, decisionId: result.decisionId }
}

/** The blocked range a Booking of this type starting at `startMs` holds. */
function blockedOf(type: BookingTypeRecord, startMs: number, lengthMs: number) {
  return {
    from: startMs - type.bufferBeforeMinutes * MINUTE_MS,
    until: startMs + lengthMs + type.bufferAfterMinutes * MINUTE_MS,
  }
}

/** Counts a Rep's Bookings per local day, by the day's start. */
function perDay(zone: string, bookings: BookingRecord[]): Map<number, number> {
  const counts = new Map<number, number>()
  let day = { startMs: 0, endMs: 0 }
  for (const booking of [...bookings].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    const at = booking.startsAt.getTime()
    if (at < day.startMs || at >= day.endMs) {
      day = localDayOf(zone, at)
    }
    counts.set(day.startMs, (counts.get(day.startMs) ?? 0) + 1)
  }
  return counts
}

/** One Rep's free starts in `[from, to]`: hours, stored busy times, Bookings with buffers, daily cap. */
async function repStarts(
  scope: OrganizationScope,
  membershipId: MembershipId,
  type: BookingTypeRecord,
  range: { from: number; to: number; now: number },
  self?: BookingId
): Promise<{ start: number; end: number }[]> {
  const hours = await scope.getWorkingHours(membershipId)
  if (!hours) {
    return []
  }
  const margin = Math.max(type.bufferBeforeMinutes, type.bufferAfterMinutes) * MINUTE_MS
  const wideFrom = new Date(range.from - margin)
  const wideTo = new Date(range.to + margin)
  const [busy, held0] = await Promise.all([
    scope.listBusyBlocks(membershipId, wideFrom, wideTo),
    scope.listRepBookings(membershipId, wideFrom, wideTo, new Date(range.now - PENDING_HOLD_MS)),
  ])
  const bookings = held0.filter((row) => row.id !== self)
  const free = computeSlots({
    timeZone: hours.timeZone,
    windows: hours.windows,
    lengthMinutes: type.lengthMinutes,
    bufferBeforeMinutes: type.bufferBeforeMinutes,
    bufferAfterMinutes: type.bufferAfterMinutes,
    minimumNoticeMinutes: type.minimumNoticeMinutes,
    now: range.now,
    awayUntil: hours.awayUntil?.getTime() ?? null,
    from: range.from,
    to: range.to,
    busy: busy.map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime() })),
    limit: 500,
  })
  const held = bookings
    .map((row) => ({ from: row.blockedFrom.getTime(), until: row.blockedUntil.getTime() }))
    .sort((a, b) => a.from - b.from)
  const counts = hours.dailyCap === null ? null : perDay(hours.timeZone, bookings)
  let day = { startMs: 0, endMs: 0 }
  return free.filter((slot) => {
    const blocked = blockedOf(type, slot.start, slot.end - slot.start)
    if (held.some((row) => row.from < blocked.until && blocked.from < row.until)) {
      return false
    }
    if (counts && hours.dailyCap !== null) {
      if (slot.start < day.startMs || slot.start >= day.endMs) {
        day = localDayOf(hours.timeZone, slot.start)
      }
      return (counts.get(day.startMs) ?? 0) < hours.dailyCap
    }
    return true
  })
}

/**
 * The free times for a Booking Type and Prospect, merged across the routed Reps (at most 20) with
 * the Rep who would take each, earliest first. A time two Reps share goes to the first in routing
 * order. Reads stored busy times and Bookings only; the calendar is never called here. At most 100
 * per page, over at most 14 days. Cost is O(Reps x slots x held Bookings).
 */
export async function listSlots(
  deps: BookingDeps,
  caller: Caller,
  query: ListSlotsQuery
): Promise<Page<Slot>> {
  const after = slotAfter(query.cursor)
  const now = deps.clock.now().getTime()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'booking.read')
    const type = await activeType(scope, query.bookingTypeId)
    const prospect = await visibleProspect(scope, caller, query.prospectId)
    const attributes = await attributesOf(scope, prospect)
    return pageSlots(scope, type, attributes, query, after, now)
  })
}

/** The decoded slot cursor, or `request.invalid` for one that is not ours. */
function slotAfter(cursor: string | undefined): z.infer<typeof slotCursor> | undefined {
  const after = cursor === undefined ? undefined : decodeCursor(cursor, slotCursor)
  if (cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return after
}

/** One page of the merged free times of the Reps routed for these attributes. */
async function pageSlots(
  scope: OrganizationScope,
  type: BookingTypeRecord,
  attributes: RoutingAttributes,
  query: { from: string; to: string; limit: number },
  after: z.infer<typeof slotCursor> | undefined,
  now: number,
  /** A Booking being moved: only its own Rep is offered, and its own time does not block. */
  moving?: BookingRecord
): Promise<Page<Slot>> {
  const from = Math.max(
    Date.parse(query.from),
    after ? after.startsAt + 1 : Number.NEGATIVE_INFINITY
  )
  const to = Math.min(
    Date.parse(query.to),
    Date.parse(query.from) + MAX_SLOT_RANGE_DAYS * DAY_MS,
    now + MAX_SLOT_RANGE_DAYS * DAY_MS
  )
  const reps = moving
    ? [moving.membershipId]
    : (await eligibleReps(scope, attributes, type.id, new Date(now), null)).reps
  if (reps.length === 0) {
    throw domainError(BOOKING_ERRORS['booking.no_eligible_rep'])
  }
  if (to <= from) {
    return { items: [], nextCursor: null }
  }
  const merged = new Map<number, Slot>()
  for (const rep of reps) {
    for (const slot of await repStarts(scope, rep, type, { from, to, now }, moving?.id)) {
      if (!merged.has(slot.start)) {
        merged.set(slot.start, {
          startsAt: new Date(slot.start).toISOString(),
          endsAt: new Date(slot.end).toISOString(),
          repMembershipId: rep,
        })
      }
    }
  }
  const size = Math.min(query.limit, MAX_SLOTS_PER_PAGE)
  const ordered = [...merged.entries()].sort((a, b) => a[0] - b[0])
  const page = ordered.slice(0, size)
  const last = page.at(-1)
  return {
    items: page.map(([, slot]) => slot),
    nextCursor: ordered.length > size && last ? encodeCursor({ startsAt: last[0] }) : null,
  }
}

/** What routing matches a visitor on when nothing is known about them: every attribute unset. */
const ANONYMOUS: RoutingAttributes = {
  country: null,
  region: null,
  companySizeBand: null,
  accountOwnerMembershipId: null,
  source: null,
}

/**
 * The free times of a Booking Type for a public page: the pooled start and end of each, never a
 * Rep, plus the Booking Type's name, length and mode. The type must be active and its
 * Organization active, else `booking.type_not_found`. Same limits as {@link listSlots}.
 */
export async function listPublicSlots(
  deps: BookingDeps,
  where: { organizationId: OrganizationId; bookingTypeId: BookingTypeId },
  query: z.infer<typeof publicListSlotsQuerySchema>
): Promise<z.infer<typeof publicSlotPageSchema>> {
  const after = slotAfter(query.cursor)
  const now = deps.clock.now().getTime()
  return deps.store.withOrganization(where.organizationId, async (scope) => {
    const organization = await scope.getOrganization()
    if (organization?.status !== 'active') {
      throw typeNotFound()
    }
    const type = await activeType(scope, where.bookingTypeId)
    const page = await pageSlots(scope, type, ANONYMOUS, query, after, now)
    return publicSlotPageSchema.parse({
      items: page.items.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
      nextCursor: page.nextCursor,
      bookingType: { name: type.name, lengthMinutes: type.lengthMinutes, mode: type.mode },
    })
  })
}

/** How a start fares for one Rep: bookable, never offered, or offered but held. */
type Fit = 'ok' | 'invalid' | 'taken'

/** Checks one start for one Rep. `self` is a Booking being moved, which does not block itself. */
async function fitOf(
  scope: OrganizationScope,
  membershipId: MembershipId,
  type: BookingTypeRecord,
  startMs: number,
  lengthMs: number,
  now: number,
  self?: BookingRecord
): Promise<Fit> {
  const hours = await scope.getWorkingHours(membershipId)
  const endMs = startMs + lengthMs
  if (!hours || endMs > now + MAX_SLOT_RANGE_DAYS * DAY_MS) {
    return 'invalid'
  }
  const input = {
    timeZone: hours.timeZone,
    windows: hours.windows,
    lengthMinutes: lengthMs / MINUTE_MS,
    bufferBeforeMinutes: type.bufferBeforeMinutes,
    bufferAfterMinutes: type.bufferAfterMinutes,
    minimumNoticeMinutes: type.minimumNoticeMinutes,
    now,
    awayUntil: hours.awayUntil?.getTime() ?? null,
    from: startMs,
    to: endMs,
    limit: 1,
  }
  if (computeSlots({ ...input, busy: [] })[0]?.start !== startMs) {
    return 'invalid'
  }
  const blocked = blockedOf(type, startMs, lengthMs)
  const wide = { from: new Date(blocked.from), until: new Date(blocked.until) }
  const busy = await scope.listBusyBlocks(membershipId, wide.from, wide.until)
  const rows = busy.map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime() }))
  if (computeSlots({ ...input, busy: rows })[0]?.start !== startMs) {
    return 'taken'
  }
  const bookings = (
    await scope.listRepBookings(
      membershipId,
      wide.from,
      wide.until,
      new Date(now - PENDING_HOLD_MS)
    )
  ).filter((row) => row.id !== self?.id)
  if (bookings.length > 0) {
    return 'taken'
  }
  if (hours.dailyCap !== null) {
    const day = localDayOf(hours.timeZone, startMs)
    const same =
      self && self.startsAt.getTime() >= day.startMs && self.startsAt.getTime() < day.endMs
    const count = await scope.countActiveBookings(
      membershipId,
      new Date(day.startMs),
      new Date(day.endMs)
    )
    if (count - (same ? 1 : 0) >= hours.dailyCap) {
      return 'taken'
    }
  }
  return 'ok'
}

/** What the calendar writes of a Booking need, read inside the transaction. */
type CalendarTarget = { connectionId: string; sealed: Uint8Array } | null

async function calendarTargetOf(
  scope: OrganizationScope,
  membershipId: MembershipId
): Promise<CalendarTarget> {
  const connection = await scope.getCalendarConnection(membershipId)
  const sealed = connection ? await scope.getCalendarSealedCredential(membershipId) : null
  return connection && sealed ? { connectionId: connection.id, sealed } : null
}

/** Opens the vendor connection of a target; any failure is `booking.calendar_unavailable`. */
async function openTarget(
  deps: BookingDeps,
  caller: Pick<Caller, 'organizationId'>,
  target: CalendarTarget
): Promise<CalendarConnection> {
  if (!deps.calendar || !target) {
    throw unavailable()
  }
  try {
    const vendor = await openVendorConnection(
      deps,
      caller.organizationId,
      target.connectionId,
      target.sealed
    )
    if (vendor) {
      return vendor
    }
  } catch {
    // An unreadable credential is the same to the caller as an unreachable calendar.
  }
  throw unavailable()
}

/** Queues a busy-time refresh for the Rep, keyed by the Booking and the moment of the change. */
async function enqueueBusyRefresh(
  scope: OrganizationScope,
  caller: Pick<Caller, 'organizationId'>,
  membershipId: MembershipId,
  bookingId: BookingId,
  now: Date
): Promise<void> {
  const traceId = crypto.randomUUID()
  const job = jobRegistry.create({
    type: 'calendar.refresh_busy',
    payload: { membershipId },
    organizationId: caller.organizationId,
    traceId,
  })
  await scope.enqueueOutbox({
    id: newOutboxId(),
    topic: job.type,
    dedupeKey: `calendar.refresh_busy:booking:${bookingId}:${now.getTime()}`,
    payload: { eventId: job.id, occurredAt: job.occurredAt, traceId, payload: job.payload },
  })
}

/** Removes a Booking that never got its calendar event. */
async function dropPending(
  deps: BookingDeps,
  caller: Pick<Caller, 'organizationId'>,
  id: BookingId
): Promise<void> {
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await scope.lockOrganization()
    await scope.deletePendingBooking(id)
  })
}

const sameRequest = (record: BookingRecord, request: BookRequest) =>
  record.bookingTypeId === request.bookingTypeId &&
  record.prospectId === request.prospectId &&
  record.startsAt.getTime() === Date.parse(request.startsAt) &&
  (request.repMembershipId === undefined || record.membershipId === request.repMembershipId)

/** Who is booking and how: the member of a signed-in route, or a Prospect on the public page. */
type Booker = {
  organizationId: OrganizationId
  keyHash: string
  origin: BookingOrigin
  /** `BOOKING_LINK_KEY` when the Booking gets a manage link; its hash is stored with it. */
  manageKey?: string
  /** Locks and checks the Organization for a write, inside the transaction. */
  open(scope: OrganizationScope): Promise<void>
  /** Whether a stored Booking under the same key is this same request. */
  same(scope: OrganizationScope, record: BookingRecord): Promise<boolean>
  /** The Prospect booked and what routing matches on, inside the transaction. */
  prospect(
    scope: OrganizationScope,
    now: Date
  ): Promise<{ prospect: ProspectRecord; attributes: RoutingAttributes }>
}

/** The part of a request every booker shares. */
type BookingWish = {
  bookingTypeId: BookingTypeId
  startsAt: string
  repMembershipId?: MembershipId
}

/**
 * Books a time. The first transaction checks the time and stores the Booking as `pending`
 * (holding the Rep's time); the Rep's live calendar is read and the event written outside any
 * transaction; the second confirms it and publishes `booking.created`. A calendar failure removes
 * the pending Booking, so the same key succeeds on retry. The same key answers the Booking again.
 */
export async function book(
  deps: BookingDeps,
  caller: Caller,
  idempotencyKey: string,
  request: BookRequest
): Promise<BookingAnswer> {
  return bookAs(
    deps,
    {
      organizationId: caller.organizationId,
      keyHash: createHash('sha256').update(`${caller.userId}:${idempotencyKey}`).digest('hex'),
      origin: 'member',
      open: async (scope) => {
        await openOrganizationForWrite(scope, caller, 'booking.book')
      },
      same: async (_, record) => sameRequest(record, request),
      prospect: async (scope) => {
        const prospect = await visibleProspect(scope, caller, request.prospectId)
        return { prospect, attributes: await attributesOf(scope, prospect) }
      },
    },
    request
  )
}

/** The Prospect of a public booking: the one with this email, or a new one; a known one is never changed. */
async function upsertPublicProspect(
  scope: OrganizationScope,
  organizationId: OrganizationId,
  request: PublicBookRequest,
  now: Date
): Promise<ProspectRecord> {
  const known = await scope.findProspectByIdentity('email', request.email)
  const existing = known ? await scope.getProspect(known, { kind: 'all' }) : null
  if (existing) {
    return existing
  }
  const id = formatId('prs', crypto.randomUUID())
  const prospect = await scope.insertProspect({
    id,
    companyId: null,
    ownerMembershipId: null,
    source: 'form',
    tags: [],
    notes: null,
    now,
  })
  const [first, ...rest] = request.name.trim().split(/\s+/)
  const writes = [
    { field: 'firstName', value: first },
    { field: 'lastName', value: rest.join(' ') },
    { field: 'email', value: request.email },
  ]
    .filter((row): row is { field: string; value: string } => !!row.value)
    .map((row) => ({ ...row, source: 'form', sourceRef: 'public-booking' }))
  await writeFields(scope, 'prospect', id, writes, { userId: null, at: now })
  await enqueueEvents(scope, organizationId, crypto.randomUUID(), [
    createdEvent({ prospectId: id, companyId: null, ownerMembershipId: null, source: 'form' }),
  ])
  return prospect
}

/**
 * Books a time from a Booking Type's public link: upserts the Prospect by email, routes among the
 * Booking Type's Reps and books through the same flow as {@link book} with origin `public`.
 * The answer is the confirmation only, 201 the first time and 200 on a replay. The key counts
 * per Booking Type, and a replay with another time or email is `request.idempotency_key_reused`.
 */
export async function bookPublic(
  deps: BookingDeps,
  where: { organizationId: OrganizationId; bookingTypeId: BookingTypeId },
  idempotencyKey: string,
  request: PublicBookRequest,
  linkKey: string
): Promise<{ status: 200 | 201; body: PublicBookingConfirmation }> {
  const answer = await bookAs(
    deps,
    {
      organizationId: where.organizationId,
      keyHash: createHash('sha256')
        .update(`public:${where.bookingTypeId}:${idempotencyKey}`)
        .digest('hex'),
      origin: 'public',
      manageKey: linkKey,
      open: async (scope) => {
        const organization = await scope.lockOrganization()
        if (organization?.status !== 'active') {
          throw typeNotFound()
        }
      },
      same: async (scope, record) =>
        record.bookingTypeId === where.bookingTypeId &&
        record.startsAt.getTime() === Date.parse(request.startsAt) &&
        (await scope.getProspectIdentity(record.prospectId, 'email')) === request.email,
      prospect: async (scope, now) => ({
        prospect: await upsertPublicProspect(scope, where.organizationId, request, now),
        attributes: ANONYMOUS,
      }),
    },
    { bookingTypeId: where.bookingTypeId, startsAt: request.startsAt }
  )
  const { id, startsAt, endsAt, mode, joinUrl } = answer.body
  return {
    status: answer.status,
    body: publicBookingConfirmationSchema.parse({
      id,
      startsAt,
      endsAt,
      mode,
      joinUrl,
      manageToken: manageTokenOf(linkKey, id),
    }),
  }
}

/** The shared flow behind {@link book} and {@link bookPublic}. */
async function bookAs(
  deps: BookingDeps,
  booker: Booker,
  request: BookingWish
): Promise<BookingAnswer> {
  const { keyHash } = booker
  const caller = { organizationId: booker.organizationId }
  const startMs = Date.parse(request.startsAt)
  const now = deps.clock.now()
  const planned = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await booker.open(scope)
    const existing = await scope.findBookingByKeyHash(keyHash)
    if (existing) {
      if (!(await booker.same(scope, existing))) {
        throw domainError(ERRORS['request.idempotency_key_reused'])
      }
      if (existing.state !== 'pending') {
        return { kind: 'replay' as const, record: existing }
      }
      if (existing.createdAt.getTime() > now.getTime() - PENDING_HOLD_MS) {
        throw new RetryAfterError(ERRORS['request.idempotency_in_progress'], 1)
      }
      await scope.deletePendingBooking(existing.id)
    }
    const { prospect, attributes } = await booker.prospect(scope, now)
    const type = await activeType(scope, request.bookingTypeId)
    // shortcut: the Organization-wide lock serialises the slot check; use a per-Rep advisory lock if booking volume grows.
    const lengthMs = type.lengthMinutes * MINUTE_MS
    const eligible = await eligibleReps(
      scope,
      attributes,
      type.id,
      now,
      request.repMembershipId === undefined ? prospect.id : null
    )
    const candidates = request.repMembershipId ? [request.repMembershipId] : eligible.reps
    if (!eligible.reps.some((rep) => candidates.includes(rep))) {
      throw domainError(BOOKING_ERRORS['booking.no_eligible_rep'])
    }
    let chosen: MembershipId | null = null
    let refused: Fit = 'invalid'
    for (const rep of candidates) {
      if (!eligible.reps.includes(rep)) {
        throw domainError(BOOKING_ERRORS['booking.no_eligible_rep'])
      }
      const fit = await fitOf(scope, rep, type, startMs, lengthMs, now.getTime())
      if (fit === 'ok') {
        chosen = rep
        break
      }
      refused = fit === 'taken' ? 'taken' : refused
    }
    if (!chosen) {
      throw refused === 'taken' ? taken() : invalid()
    }
    const decisionId = eligible.decisionId ?? formatId('rdc', crypto.randomUUID())
    if (eligible.decisionId === null) {
      await scope.insertRoutingDecision({
        id: decisionId,
        purpose: 'booking',
        prospectId: prospect.id,
        bookingTypeId: type.id,
        ruleId: null,
        chosenMembershipId: chosen,
        candidates: [{ membershipId: chosen, reason: 'named_rep' }],
        skipped: [],
        reason: 'Rep named by the caller',
        now,
      })
    }
    const blocked = blockedOf(type, startMs, lengthMs)
    const bookingId = formatId('bkg', crypto.randomUUID()) as BookingId
    const record = await scope.insertBooking({
      id: bookingId,
      manageTokenHash: booker.manageKey
        ? hashLinkToken(manageTokenOf(booker.manageKey, bookingId))
        : undefined,
      bookingTypeId: type.id,
      membershipId: chosen,
      prospectId: prospect.id,
      mode: type.mode,
      origin: booker.origin,
      startsAt: new Date(startMs),
      endsAt: new Date(startMs + lengthMs),
      blockedFrom: new Date(blocked.from),
      blockedUntil: new Date(blocked.until),
      keyHash,
      routingDecisionId: decisionId,
      now,
    })
    return {
      kind: 'new' as const,
      record,
      title: type.name,
      email: await scope.getProspectIdentity(prospect.id, 'email'),
      target: await calendarTargetOf(scope, chosen),
    }
  })
  if (planned.kind === 'replay') {
    return { status: 200, body: toBooking(planned.record) }
  }
  const { record } = planned
  let created: { eventId: string; joinUrl: string | null }
  try {
    const vendor = await openTarget(deps, caller, planned.target)
    const port = deps.calendar?.port
    if (!port) {
      throw unavailable()
    }
    const live = await port.busy(
      {
        organizationId: caller.organizationId,
        connection: vendor,
        from: record.blockedFrom.toISOString(),
        to: record.blockedUntil.toISOString(),
      },
      { timeoutMs: CALENDAR_TIMEOUT_MS }
    )
    if (live.length > 0) {
      throw taken()
    }
    const event = await port.createEvent(
      {
        organizationId: caller.organizationId,
        connection: vendor,
        requestId: `book:${keyHash.slice(0, 32)}`,
        event: {
          title: planned.title,
          start: record.startsAt.toISOString(),
          end: record.endsAt.toISOString(),
          attendees: planned.email ? [{ email: planned.email }] : [],
          conferencing: record.mode === 'video' ? 'video' : 'none',
        },
      },
      { timeoutMs: CALENDAR_TIMEOUT_MS }
    )
    created = { eventId: event.eventId, joinUrl: event.joinUrl ?? null }
  } catch (error) {
    await dropPending(deps, caller, record.id)
    throw error instanceof CalendarError ? unavailable() : error
  }
  try {
    const confirmed = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      await scope.lockOrganization()
      const row = await scope.confirmBooking(
        record.id,
        {
          calendarEventId: created.eventId,
          joinUrl: record.mode === 'video' ? created.joinUrl : null,
        },
        deps.clock.now()
      )
      if (!row) {
        return null
      }
      const traceId = crypto.randomUUID()
      const job = jobRegistry.create({
        type: 'booking.created',
        payload: {
          bookingId: row.id,
          bookingTypeId: row.bookingTypeId,
          repMembershipId: row.membershipId,
          prospectId: row.prospectId,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          mode: row.mode,
          origin: row.origin,
          routingDecisionId: row.routingDecisionId,
        },
        organizationId: caller.organizationId,
        traceId,
      })
      await scope.enqueueOutbox({
        id: newOutboxId(),
        topic: job.type,
        dedupeKey: `booking.created:${row.id}`,
        payload: { eventId: job.id, occurredAt: job.occurredAt, traceId, payload: job.payload },
      })
      await enqueueBusyRefresh(scope, caller, row.membershipId, row.id, now)
      return row
    })
    if (!confirmed) {
      await undoEvent(deps, caller, planned.target, created.eventId, `book-undo:${record.id}`)
      throw unavailable()
    }
    return { status: 201, body: toBooking(confirmed) }
  } catch (error) {
    if (error instanceof BookingSlotTakenError) {
      await undoEvent(deps, caller, planned.target, created.eventId, `book-undo:${record.id}`)
      await dropPending(deps, caller, record.id)
      throw taken()
    }
    throw error
  }
}

/** Deletes a calendar event written for a change that did not commit; a failure is only logged. */
async function undoEvent(
  deps: BookingDeps,
  caller: Pick<Caller, 'organizationId'>,
  target: CalendarTarget,
  eventId: string,
  requestId: string
): Promise<void> {
  try {
    const vendor = await openTarget(deps, caller, target)
    await deps.calendar?.port.deleteEvent(
      { organizationId: caller.organizationId, connection: vendor, eventId, requestId },
      { timeoutMs: CALENDAR_TIMEOUT_MS }
    )
  } catch {
    deps.logger.warn('booking.event_cleanup_failed', { organizationId: caller.organizationId })
  }
}

/** The Memberships whose Bookings a role may see; `undefined` is all of them. */
async function visibleReps(
  scope: OrganizationScope,
  role: Role,
  membershipId: MembershipId
): Promise<MembershipId[] | undefined> {
  if (role === 'owner' || role === 'admin') {
    return undefined
  }
  if (role === 'manager') {
    return [membershipId, ...(await scope.listManagedReps(membershipId, MANAGED_REPS))]
  }
  return role === 'rep' ? [membershipId] : []
}

/** Reads the caller's own Membership and what it may see. */
async function visibilityOfBookings(
  scope: OrganizationScope,
  caller: Caller
): Promise<MembershipId[] | undefined> {
  const own = await scope.getMembershipByUser(caller.userId)
  return own ? visibleReps(scope, own.role, own.id) : []
}

/** One Booking the caller may see, or `booking.not_found`. */
async function visibleBooking(
  scope: OrganizationScope,
  id: BookingId,
  reps: MembershipId[] | undefined
): Promise<BookingRecord> {
  const record = await scope.findBooking(id)
  if (!record || (reps && !reps.includes(record.membershipId))) {
    throw notFound()
  }
  return record
}

/** Lists Bookings the caller may see, latest start first or (`order=asc`) soonest first, at most 100 a page. A filter never widens that. */
export async function list(
  deps: BookingDeps,
  caller: Caller,
  query: ListBookingsQuery
): Promise<Page<Booking>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, bookingCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  // A cursor is only valid for the order it was issued for.
  if (after && after.order !== query.order) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'booking.read')
    const visible = await visibilityOfBookings(scope, caller)
    const wanted = query.repMembershipId
    const reps = wanted ? (visible && !visible.includes(wanted) ? [] : [wanted]) : visible
    if (reps && reps.length === 0) {
      return { items: [], nextCursor: null }
    }
    const rows = await scope.listBookings({
      limit: query.limit + 1,
      order: query.order,
      ...(after ? { after: { startsAt: new Date(after.startsAt), id: after.id } } : {}),
      ...(query.state ? { state: query.state } : {}),
      ...(reps ? { membershipIds: reps } : {}),
      ...(query.prospectId ? { prospectId: query.prospectId } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toBooking),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({
              startsAt: last.startsAt.toISOString(),
              id: last.id,
              order: query.order,
            })
          : null,
    }
  })
}

/** Reads one Booking the caller may see. */
export async function get(deps: BookingDeps, caller: Caller, id: BookingId): Promise<Booking> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'booking.read')
    return toBooking(await visibleBooking(scope, id, await visibilityOfBookings(scope, caller)))
  })
}

/**
 * Moves a Booking to another start; the length stays. Idempotent by end state: the same time
 * changes nothing and publishes nothing. The calendar event moves first; if that fails the
 * Booking is unchanged. A cancelled Booking is `booking.not_active`.
 */
export async function reschedule(
  deps: BookingDeps,
  caller: Caller,
  id: BookingId,
  request: RescheduleBookingRequest
): Promise<Booking> {
  return rescheduleAs(deps, caller.organizationId, id, request, false, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'booking.change')
    return visibleBooking(scope, id, await visibleReps(scope, access.role, access.membershipId))
  })
}

/** How a write finds its Booking inside the transaction: the member's view or the manage link's. */
type LoadBooking = (scope: OrganizationScope) => Promise<BookingRecord>

/** The Booking a manage link opens: its Organization must be active, else `booking.not_found`. */
const managedBooking =
  (id: BookingId): LoadBooking =>
  async (scope) => {
    const record =
      (await scope.getOrganization())?.status === 'active' ? await scope.findBooking(id) : null
    if (!record) {
      throw notFound()
    }
    return record
  }

/** Throws `booking.already_started` once the Booking's start has passed. */
function assertNotStarted(record: BookingRecord, now: Date): void {
  if (record.startsAt.getTime() <= now.getTime()) {
    throw domainError(BOOKING_ERRORS['booking.already_started'])
  }
}

/** The shared core of {@link reschedule} and {@link reschedulePublic}. */
async function rescheduleAs(
  deps: BookingDeps,
  organizationId: OrganizationId,
  id: BookingId,
  request: RescheduleBookingRequest,
  requireNotStarted: boolean,
  load: LoadBooking
): Promise<Booking> {
  const caller = { organizationId }
  const startMs = Date.parse(request.startsAt)
  const now = deps.clock.now()
  const nonce = crypto.randomUUID()
  const planned = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const record = await load(scope)
    if (record.state !== 'confirmed') {
      throw domainError(BOOKING_ERRORS['booking.not_active'])
    }
    if (requireNotStarted) {
      assertNotStarted(record, now)
    }
    if (record.startsAt.getTime() === startMs) {
      return { kind: 'same' as const, record }
    }
    const type = await scope.findBookingType(record.bookingTypeId)
    if (!type) {
      throw typeNotFound()
    }
    const lengthMs = record.endsAt.getTime() - record.startsAt.getTime()
    const fit = await fitOf(
      scope,
      record.membershipId,
      type,
      startMs,
      lengthMs,
      now.getTime(),
      record
    )
    if (fit !== 'ok') {
      throw fit === 'taken' ? taken() : invalid()
    }
    return {
      kind: 'move' as const,
      record,
      type,
      lengthMs,
      target: await calendarTargetOf(scope, record.membershipId),
    }
  })
  if (planned.kind === 'same') {
    return toBooking(planned.record)
  }
  const { record, type, lengthMs, target } = planned
  const endMs = startMs + lengthMs
  const move = async (to: { start: number; end: number }, requestId: string) => {
    const vendor = await openTarget(deps, caller, target)
    if (!record.calendarEventId || !deps.calendar) {
      throw unavailable()
    }
    await deps.calendar.port.updateEvent(
      {
        organizationId: caller.organizationId,
        connection: vendor,
        eventId: record.calendarEventId,
        requestId,
        changes: { start: new Date(to.start).toISOString(), end: new Date(to.end).toISOString() },
      },
      { timeoutMs: CALENDAR_TIMEOUT_MS }
    )
  }
  try {
    await move({ start: startMs, end: endMs }, `resched:${id}:${startMs}:${nonce}`)
  } catch (error) {
    throw error instanceof CalendarError ? unavailable() : error
  }
  try {
    return await deps.store.withOrganization(caller.organizationId, async (scope) => {
      await scope.lockOrganization()
      const current = await scope.findBooking(id)
      if (!current || current.state === 'cancelled') {
        throw domainError(BOOKING_ERRORS['booking.not_active'])
      }
      if (current.startsAt.getTime() === startMs) {
        return toBooking(current)
      }
      const blocked = blockedOf(type, startMs, lengthMs)
      const moved = await scope.moveBooking(
        id,
        {
          startsAt: new Date(startMs),
          endsAt: new Date(endMs),
          blockedFrom: new Date(blocked.from),
          blockedUntil: new Date(blocked.until),
        },
        now
      )
      if (!moved) {
        throw notFound()
      }
      await enqueueEvents(scope, caller.organizationId, crypto.randomUUID(), [
        bookingRescheduledEvent(
          {
            bookingId: id,
            bookingTypeId: moved.bookingTypeId,
            repMembershipId: moved.membershipId,
            prospectId: moved.prospectId,
            previousStartsAt: current.startsAt.toISOString(),
            startsAt: moved.startsAt.toISOString(),
            endsAt: moved.endsAt.toISOString(),
          },
          nonce
        ),
      ])
      await enqueueBusyRefresh(scope, caller, moved.membershipId, id, now)
      return toBooking(moved)
    })
  } catch (error) {
    if (error instanceof BookingSlotTakenError) {
      try {
        await move(
          { start: record.startsAt.getTime(), end: record.endsAt.getTime() },
          `resched-undo:${id}:${startMs}:${nonce}`
        )
      } catch {
        deps.logger.warn('booking.event_cleanup_failed', { organizationId: caller.organizationId })
      }
      throw taken()
    }
    throw error
  }
}

/**
 * Cancels a Booking and deletes its calendar event. Idempotent by end state: a cancelled Booking
 * answers as it is and publishes nothing. A calendar failure leaves the Booking as it was.
 */
export async function cancel(deps: BookingDeps, caller: Caller, id: BookingId): Promise<Booking> {
  return cancelAs(deps, caller.organizationId, id, 'member', false, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'booking.change')
    return visibleBooking(scope, id, await visibleReps(scope, access.role, access.membershipId))
  })
}

/** The shared core of {@link cancel} and {@link cancelPublic}. */
async function cancelAs(
  deps: BookingDeps,
  organizationId: OrganizationId,
  id: BookingId,
  by: 'member' | 'prospect',
  requireNotStarted: boolean,
  load: LoadBooking
): Promise<Booking> {
  const caller = { organizationId }
  const now = deps.clock.now()
  const planned = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const record = await load(scope)
    if (record.state === 'pending') {
      throw domainError(BOOKING_ERRORS['booking.not_active'])
    }
    if (record.state === 'cancelled') {
      return { kind: 'done' as const, record }
    }
    if (requireNotStarted) {
      assertNotStarted(record, now)
    }
    return {
      kind: 'cancel' as const,
      record,
      target: await calendarTargetOf(scope, record.membershipId),
    }
  })
  if (planned.kind === 'done') {
    return toBooking(planned.record)
  }
  const { record, target } = planned
  if (record.calendarEventId) {
    try {
      const vendor = await openTarget(deps, caller, target)
      await deps.calendar?.port.deleteEvent(
        {
          organizationId: caller.organizationId,
          connection: vendor,
          eventId: record.calendarEventId,
          requestId: `cancel:${id}`,
        },
        { timeoutMs: CALENDAR_TIMEOUT_MS }
      )
    } catch {
      throw unavailable()
    }
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await scope.lockOrganization()
    const current = await scope.findBooking(id)
    if (!current) {
      throw notFound()
    }
    if (current.state === 'cancelled') {
      return toBooking(current)
    }
    const cancelled = await scope.cancelBooking(id, now)
    if (!cancelled) {
      throw notFound()
    }
    await enqueueEvents(scope, caller.organizationId, crypto.randomUUID(), [
      bookingCancelledEvent({
        bookingId: id,
        bookingTypeId: cancelled.bookingTypeId,
        repMembershipId: cancelled.membershipId,
        prospectId: cancelled.prospectId,
        startsAt: cancelled.startsAt.toISOString(),
        endsAt: cancelled.endsAt.toISOString(),
        cancelledBy: by,
        cancelledAt: (cancelled.cancelledAt ?? now).toISOString(),
      }),
    ])
    await enqueueBusyRefresh(scope, caller, cancelled.membershipId, id, now)
    return toBooking(cancelled)
  })
}

/** What a manage link opens: the Organization and Booking its token's hash found. */
export type ManagedLocation = { organizationId: OrganizationId; bookingId: BookingId }

/** The Booking a manage link shows, as the Prospect may see it: no Rep, Prospect or email. */
export async function getManaged(
  deps: BookingDeps,
  where: ManagedLocation
): Promise<PublicManagedBooking> {
  return deps.store.withOrganization(where.organizationId, async (scope) => {
    const record = await managedBooking(where.bookingId)(scope)
    const type = await scope.findBookingType(record.bookingTypeId)
    if (!type) {
      throw notFound()
    }
    return publicManagedBookingSchema.parse({
      id: record.id,
      startsAt: record.startsAt.toISOString(),
      endsAt: record.endsAt.toISOString(),
      mode: record.mode,
      joinUrl: record.mode === 'video' ? record.joinUrl : null,
      state: record.state,
      bookingType: { name: type.name, lengthMinutes: type.lengthMinutes, mode: type.mode },
    })
  })
}

/**
 * The free times a manage link may move its Booking to: the Booking's own Rep only, and its own
 * time does not block it. A cancelled Booking is `booking.not_active`, a started one
 * `booking.already_started`.
 */
export async function listManagedSlots(
  deps: BookingDeps,
  where: ManagedLocation,
  query: z.infer<typeof publicListSlotsQuerySchema>
): Promise<z.infer<typeof publicSlotPageSchema>> {
  const after = slotAfter(query.cursor)
  const now = deps.clock.now()
  return deps.store.withOrganization(where.organizationId, async (scope) => {
    const record = await managedBooking(where.bookingId)(scope)
    if (record.state !== 'confirmed') {
      throw domainError(BOOKING_ERRORS['booking.not_active'])
    }
    assertNotStarted(record, now)
    const type = await scope.findBookingType(record.bookingTypeId)
    if (!type) {
      throw notFound()
    }
    const page = await pageSlots(scope, type, ANONYMOUS, query, after, now.getTime(), record)
    return publicSlotPageSchema.parse({
      items: page.items.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
      nextCursor: page.nextCursor,
      bookingType: { name: type.name, lengthMinutes: type.lengthMinutes, mode: type.mode },
    })
  })
}

/** Moves the Booking of a manage link; {@link reschedule}'s flow, refused once it has started. */
export function reschedulePublic(
  deps: BookingDeps,
  where: ManagedLocation,
  request: RescheduleBookingRequest
): Promise<Booking> {
  return rescheduleAs(
    deps,
    where.organizationId,
    where.bookingId,
    request,
    true,
    managedBooking(where.bookingId)
  )
}

/** Cancels the Booking of a manage link; {@link cancel}'s flow, refused once it has started. */
export function cancelPublic(deps: BookingDeps, where: ManagedLocation): Promise<Booking> {
  return cancelAs(
    deps,
    where.organizationId,
    where.bookingId,
    'prospect',
    true,
    managedBooking(where.bookingId)
  )
}

import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, type SQL } from 'drizzle-orm'
import {
  bookingIdSchema,
  bookingTypeIdSchema,
  membershipIdSchema,
  type OrganizationId,
  prospectIdSchema,
  routingDecisionIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { bookings, bookingTypes, busyBlocks, workingHours } from 'tula-closeline-db/schema'
import {
  type BookingRecord,
  type BookingScope,
  type BookingTypeRecord,
  MAX_BUSY_RANGES,
  MAX_REP_BOOKINGS,
  type StoredWindow,
} from '~/ports/booking-store'
import { afterPosition } from './consent-store'

/** The Booking Type and working-hours methods of the Postgres scope. */
export type BookingStoreMethods = BookingScope

type TypeRow = typeof bookingTypes.$inferSelect

const toRecord = (row: TypeRow): BookingTypeRecord => ({
  id: bookingTypeIdSchema.parse(row.id),
  name: row.name,
  lengthMinutes: row.lengthMinutes,
  bufferBeforeMinutes: row.bufferBeforeMinutes,
  bufferAfterMinutes: row.bufferAfterMinutes,
  minimumNoticeMinutes: row.minNoticeMinutes,
  mode: row.mode,
  state: row.active ? 'active' : 'retired',
  publicTokenHash: row.publicTokenHash,
  createdAt: row.createdAt,
})

type BookingRow = typeof bookings.$inferSelect

const toBooking = (row: BookingRow): BookingRecord => ({
  id: bookingIdSchema.parse(row.id),
  bookingTypeId: bookingTypeIdSchema.parse(row.bookingTypeId),
  membershipId: membershipIdSchema.parse(row.membershipId),
  prospectId: prospectIdSchema.parse(row.prospectId),
  state: row.status,
  mode: row.mode,
  origin: row.origin,
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  blockedFrom: row.blockedFrom,
  blockedUntil: row.blockedUntil,
  keyHash: row.idempotencyKeyHash,
  routingDecisionId: row.routingDecisionId
    ? routingDecisionIdSchema.parse(row.routingDecisionId)
    : null,
  calendarEventId: row.calendarEventId,
  joinUrl: row.joinUrl,
  cancelledAt: row.cancelledAt,
  manageTokenHash: row.manageTokenHash,
  createdAt: row.createdAt,
})

/** Builds the Booking Type, working-hours and Booking methods over one transaction of `organizationId`. */
export function createBookingStore(
  tx: Transaction,
  organizationId: OrganizationId
): BookingStoreMethods {
  const own = (id: string): SQL | undefined =>
    and(eq(bookingTypes.organizationId, organizationId), eq(bookingTypes.id, id))

  return {
    insertBookingType: async (input) => {
      const rows = await tx
        .insert(bookingTypes)
        .values({
          id: input.id,
          organizationId,
          name: input.name,
          lengthMinutes: input.lengthMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          bufferAfterMinutes: input.bufferAfterMinutes,
          minNoticeMinutes: input.minimumNoticeMinutes,
          mode: input.mode,
          active: true,
          publicTokenHash: input.publicTokenHash,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The Booking Type was not stored')
      }
      return toRecord(row)
    },

    findBookingType: async (id) => {
      const row = (await tx.select().from(bookingTypes).where(own(id)).limit(1))[0]
      return row ? toRecord(row) : null
    },

    listBookingTypes: async ({ limit, after, state }) => {
      const rows = await tx
        .select()
        .from(bookingTypes)
        .where(
          and(
            eq(bookingTypes.organizationId, organizationId),
            state === undefined ? undefined : eq(bookingTypes.active, state === 'active'),
            afterPosition(bookingTypes.createdAt, bookingTypes.id, after)
          )
        )
        .orderBy(desc(bookingTypes.createdAt), desc(bookingTypes.id))
        .limit(limit)
      return rows.map(toRecord)
    },

    updateBookingType: async (id, changes, now) => {
      const { minimumNoticeMinutes, ...rest } = changes
      const rows = await tx
        .update(bookingTypes)
        .set({
          ...rest,
          ...(minimumNoticeMinutes === undefined ? {} : { minNoticeMinutes: minimumNoticeMinutes }),
          updatedAt: now,
        })
        .where(own(id))
        .returning()
      const row = rows[0]
      return row ? toRecord(row) : null
    },

    retireBookingType: async (id, now) => {
      const rows = await tx
        .update(bookingTypes)
        .set({ active: false, updatedAt: now })
        .where(own(id))
        .returning()
      const row = rows[0]
      return row ? toRecord(row) : null
    },

    getWorkingHours: async (membershipId) => {
      const row = (
        await tx
          .select()
          .from(workingHours)
          .where(
            and(
              eq(workingHours.organizationId, organizationId),
              eq(workingHours.membershipId, membershipId)
            )
          )
          .limit(1)
      )[0]
      return row
        ? {
            membershipId: membershipIdSchema.parse(row.membershipId),
            timeZone: row.timezone,
            // The service validated these on write and the table caps their number.
            windows: row.windows as StoredWindow[],
            dailyCap: row.dailyCap,
            awayUntil: row.onLeaveUntil,
          }
        : null
    },

    putWorkingHours: async (input, now) => {
      const values = {
        timezone: input.timeZone,
        windows: input.windows,
        dailyCap: input.dailyCap,
        onLeaveUntil: input.awayUntil,
        updatedAt: now,
      }
      await tx
        .insert(workingHours)
        .values({ organizationId, membershipId: input.membershipId, ...values })
        .onConflictDoUpdate({
          target: [workingHours.organizationId, workingHours.membershipId],
          set: values,
        })
      return { ...input, windows: input.windows.map((window) => ({ ...window })) }
    },

    replaceBusyBlocks: async (membershipId, { from, to }, blocks, now) => {
      await tx
        .delete(busyBlocks)
        .where(
          and(
            eq(busyBlocks.organizationId, organizationId),
            eq(busyBlocks.membershipId, membershipId),
            gt(busyBlocks.endsAt, from),
            lt(busyBlocks.startsAt, to)
          )
        )
      // Chunked so one statement stays under the driver's parameter limit.
      for (let i = 0; i < blocks.length; i += 1000) {
        await tx
          .insert(busyBlocks)
          .values(
            blocks.slice(i, i + 1000).map((block) => ({
              organizationId,
              membershipId,
              startsAt: block.startsAt,
              endsAt: block.endsAt,
              refreshedAt: now,
            }))
          )
          .onConflictDoNothing()
      }
    },

    listBusyBlocks: async (membershipId, from, to) => {
      const rows = await tx
        .select({ startsAt: busyBlocks.startsAt, endsAt: busyBlocks.endsAt })
        .from(busyBlocks)
        .where(
          and(
            eq(busyBlocks.organizationId, organizationId),
            eq(busyBlocks.membershipId, membershipId),
            gt(busyBlocks.endsAt, from),
            lt(busyBlocks.startsAt, to)
          )
        )
        .orderBy(asc(busyBlocks.startsAt))
        .limit(MAX_BUSY_RANGES)
      return rows
    },

    insertBooking: async (input) => {
      const [row] = await tx
        .insert(bookings)
        .values({
          id: input.id,
          organizationId,
          bookingTypeId: input.bookingTypeId,
          membershipId: input.membershipId,
          prospectId: input.prospectId,
          status: 'pending',
          mode: input.mode,
          origin: input.origin,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          blockedFrom: input.blockedFrom,
          blockedUntil: input.blockedUntil,
          idempotencyKeyHash: input.keyHash,
          manageTokenHash: input.manageTokenHash ?? null,
          routingDecisionId: input.routingDecisionId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      if (!row) {
        throw new Error('The Booking was not stored')
      }
      return toBooking(row)
    },

    findBooking: async (id) => {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.organizationId, organizationId), eq(bookings.id, id)))
      return row ? toBooking(row) : null
    },

    findBookingByKeyHash: async (keyHash) => {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(
          and(eq(bookings.organizationId, organizationId), eq(bookings.idempotencyKeyHash, keyHash))
        )
      return row ? toBooking(row) : null
    },

    listBookings: async ({
      limit,
      order = 'desc',
      after,
      state,
      membershipIds,
      prospectId,
      from,
      to,
    }) => {
      if (membershipIds?.length === 0) {
        return []
      }
      const rows = await tx
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.organizationId, organizationId),
            state === undefined ? undefined : eq(bookings.status, state),
            membershipIds === undefined ? undefined : inArray(bookings.membershipId, membershipIds),
            prospectId === undefined ? undefined : eq(bookings.prospectId, prospectId),
            from === undefined ? undefined : gte(bookings.startsAt, from),
            to === undefined ? undefined : lt(bookings.startsAt, to),
            after === undefined
              ? undefined
              : or(
                  (order === 'asc' ? gt : lt)(bookings.startsAt, after.startsAt),
                  and(
                    eq(bookings.startsAt, after.startsAt),
                    (order === 'asc' ? gt : lt)(bookings.id, after.id)
                  )
                )
          )
        )
        .orderBy(
          ...(order === 'asc'
            ? [asc(bookings.startsAt), asc(bookings.id)]
            : [desc(bookings.startsAt), desc(bookings.id)])
        )
        .limit(limit)
      return rows.map(toBooking)
    },

    listRepBookings: async (membershipId, from, to, pendingSince) => {
      const rows = await tx
        .select()
        .from(bookings)
        .where(
          and(
            eq(bookings.organizationId, organizationId),
            eq(bookings.membershipId, membershipId),
            ne(bookings.status, 'cancelled'),
            or(eq(bookings.status, 'confirmed'), gte(bookings.createdAt, pendingSince)),
            gt(bookings.blockedUntil, from),
            lt(bookings.blockedFrom, to)
          )
        )
        .orderBy(asc(bookings.blockedFrom))
        .limit(MAX_REP_BOOKINGS)
      return rows.map(toBooking)
    },

    confirmBooking: async (id, event, now) => {
      const [row] = await tx
        .update(bookings)
        .set({
          status: 'confirmed',
          calendarEventId: event.calendarEventId,
          joinUrl: event.joinUrl,
          updatedAt: now,
        })
        .where(
          and(
            eq(bookings.organizationId, organizationId),
            eq(bookings.id, id),
            eq(bookings.status, 'pending')
          )
        )
        .returning()
      return row ? toBooking(row) : null
    },

    moveBooking: async (id, time, now) => {
      const [row] = await tx
        .update(bookings)
        .set({ ...time, updatedAt: now })
        .where(and(eq(bookings.organizationId, organizationId), eq(bookings.id, id)))
        .returning()
      return row ? toBooking(row) : null
    },

    cancelBooking: async (id, now) => {
      const [row] = await tx
        .update(bookings)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(and(eq(bookings.organizationId, organizationId), eq(bookings.id, id)))
        .returning()
      return row ? toBooking(row) : null
    },

    deletePendingBooking: async (id) => {
      await tx
        .delete(bookings)
        .where(
          and(
            eq(bookings.organizationId, organizationId),
            eq(bookings.id, id),
            eq(bookings.status, 'pending')
          )
        )
    },
  }
}

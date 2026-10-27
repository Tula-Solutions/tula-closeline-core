import { and, asc, desc, eq, gt, lt, type SQL } from 'drizzle-orm'
import {
  bookingTypeIdSchema,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { bookingTypes, busyBlocks, workingHours } from 'tula-closeline-db/schema'
import {
  type BookingScope,
  type BookingTypeRecord,
  MAX_BUSY_RANGES,
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

/** Builds the Booking Type and working-hours methods over one transaction of `organizationId`. */
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
  }
}

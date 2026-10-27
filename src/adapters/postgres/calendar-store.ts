import { and, eq } from 'drizzle-orm'
import { membershipIdSchema, type OrganizationId } from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { calendarConnections } from 'tula-closeline-db/schema'
import type { CalendarConnectionRecord, OrganizationScope } from '~/ports/core-store'

/** The calendar connection methods of the Postgres scope. */
export type CalendarStoreMethods = Pick<
  OrganizationScope,
  | 'getCalendarConnection'
  | 'getCalendarSealedCredential'
  | 'upsertCalendarConnection'
  | 'setCalendarConnectionState'
  | 'deleteCalendarConnection'
>

/** The columns of a connection that are not a credential: what every read of metadata selects. */
const metadataColumns = {
  id: calendarConnections.id,
  membershipId: calendarConnections.membershipId,
  status: calendarConnections.status,
  createdAt: calendarConnections.createdAt,
  lastRefreshedAt: calendarConnections.lastRefreshedAt,
}

const toRecord = (
  row: Record<keyof typeof metadataColumns, unknown> & {
    id: string
    membershipId: string
    status: 'healthy' | 'needs_reconnect'
    createdAt: Date
    lastRefreshedAt: Date | null
  }
): CalendarConnectionRecord => ({
  id: row.id,
  membershipId: membershipIdSchema.parse(row.membershipId),
  provider: 'google',
  state: row.status,
  connectedAt: row.createdAt,
  lastCheckedAt: row.lastRefreshedAt,
})

// The table needs an account address and a calendar id, but the grant carries neither; the Rep's
// primary calendar is the one the Google adapter reads.
const PRIMARY = 'primary'

/** Builds the calendar connection methods over one transaction of `organizationId`. */
export function createCalendarStore(
  tx: Transaction,
  organizationId: OrganizationId
): CalendarStoreMethods {
  const forRep = (membershipId: string) =>
    and(
      eq(calendarConnections.organizationId, organizationId),
      eq(calendarConnections.membershipId, membershipId)
    )

  return {
    getCalendarConnection: async (membershipId) => {
      const row = (
        await tx
          .select(metadataColumns)
          .from(calendarConnections)
          .where(forRep(membershipId))
          .limit(1)
      )[0]
      return row ? toRecord(row) : null
    },

    getCalendarSealedCredential: async (membershipId) => {
      const row = (
        await tx
          .select({ sealed: calendarConnections.tokensCiphertext })
          .from(calendarConnections)
          .where(forRep(membershipId))
          .limit(1)
      )[0]
      return row ? row.sealed : null
    },

    upsertCalendarConnection: async (input) => {
      const grant = {
        id: input.id,
        provider: input.provider,
        status: 'healthy' as const,
        accountEmail: PRIMARY,
        calendarId: PRIMARY,
        tokensCiphertext: input.credentialSealed,
        lastRefreshedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const rows = await tx
        .insert(calendarConnections)
        .values({ organizationId, membershipId: input.membershipId, ...grant })
        .onConflictDoUpdate({
          target: [calendarConnections.organizationId, calendarConnections.membershipId],
          set: grant,
        })
        .returning(metadataColumns)
      const row = rows[0]
      if (!row) {
        throw new Error('The calendar connection was not stored')
      }
      return toRecord(row)
    },

    setCalendarConnectionState: async (membershipId, state, checkedAt) => {
      const rows = await tx
        .update(calendarConnections)
        .set({ status: state, lastRefreshedAt: checkedAt, updatedAt: checkedAt })
        .where(forRep(membershipId))
        .returning(metadataColumns)
      const row = rows[0]
      return row ? toRecord(row) : null
    },

    deleteCalendarConnection: async (membershipId) => {
      const rows = await tx
        .delete(calendarConnections)
        .where(forRep(membershipId))
        .returning(metadataColumns)
      const row = rows[0]
      return row ? toRecord(row) : null
    },
  }
}

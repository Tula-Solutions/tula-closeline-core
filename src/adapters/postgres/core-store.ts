import { and, asc, eq, gt, sql } from 'drizzle-orm'
import {
  membershipIdSchema,
  type OrganizationId,
  organizationIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import {
  type Database,
  organizationOfUser,
  type Transaction,
  withOrganization,
} from 'tula-closeline-db'
import { memberships, organizations } from 'tula-closeline-db/schema'
import {
  AlreadyMemberError,
  type CoreStore,
  LastOwnerError,
  LockTimeoutError,
  type MembershipRecord,
  type OrganizationRecord,
  type OrganizationScope,
} from '~/ports/core-store'
import { postgresErrorOf, type RetryOptions, retryTransaction } from './retry'

/** The unique constraint that holds "a user belongs to exactly one Organization". */
const ONE_ORGANIZATION_PER_USER = 'membership_directory_one_organization_per_user'

/** The unique constraint on a user's Membership inside one Organization. */
const ONE_MEMBERSHIP_PER_ORGANIZATION = 'memberships_organization_user_key'

/** The constraint name the Owner triggers raise under. */
const OWNER_REQUIRED = 'organizations_owner_required'

/** The message prefix that tells the last-Owner trigger from the other uses of that constraint. */
const LAST_OWNER_PREFIX = 'core.last_owner'

/** SQLSTATE of `lock_not_available`, which a lock timeout raises. */
const LOCK_NOT_AVAILABLE = '55P03'

/**
 * How long a write may wait for a row lock before giving up, in milliseconds. A write that queues
 * behind a slow lock holder (an operator's long transaction) would otherwise hold a pooled
 * connection for the 30 s statement timeout and starve the token hook that shares the pool.
 */
export const WRITE_LOCK_TIMEOUT_MS = 2000

type OrganizationRow = typeof organizations.$inferSelect
type MembershipRow = typeof memberships.$inferSelect

function toOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: organizationIdSchema.parse(row.organizationId),
    name: row.name,
    region: row.region,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toMembership(row: MembershipRow): MembershipRecord {
  return {
    id: membershipIdSchema.parse(row.id),
    organizationId: organizationIdSchema.parse(row.organizationId),
    userId: userIdSchema.parse(row.userId),
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function first<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null
}

/** Every statement names the Organization as well as relying on row-level security. */
function createScope(tx: Transaction, organizationId: OrganizationId): OrganizationScope {
  const inOrganization = eq(memberships.organizationId, organizationId)

  return {
    getOrganization: async () => {
      const rows = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.organizationId, organizationId))
      const row = first(rows)
      return row ? toOrganization(row) : null
    },

    lockOrganization: async () => {
      // Transaction-local, set only by a write: reads and the membership lookup never wait.
      await tx.execute(sql.raw(`set local lock_timeout = ${WRITE_LOCK_TIMEOUT_MS}`))
      const rows = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.organizationId, organizationId))
        .for('no key update')
      const row = first(rows)
      return row ? toOrganization(row) : null
    },

    insertOrganization: async (input) => {
      const rows = await tx
        .insert(organizations)
        .values({
          organizationId,
          name: input.name,
          region: input.region,
          status: 'active',
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = first(rows)
      if (!row) {
        throw new Error('The Organization insert returned no row')
      }
      return toOrganization(row)
    },

    renameOrganization: async (name, now) => {
      const rows = await tx
        .update(organizations)
        .set({ name, updatedAt: now })
        .where(eq(organizations.organizationId, organizationId))
        .returning()
      const row = first(rows)
      return row ? toOrganization(row) : null
    },

    getMembershipByUser: async (userId) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(inOrganization, eq(memberships.userId, userId)))
      const row = first(rows)
      return row ? toMembership(row) : null
    },

    getMembership: async (id) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(inOrganization, eq(memberships.id, id)))
      const row = first(rows)
      return row ? toMembership(row) : null
    },

    lockMembership: async (id) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(inOrganization, eq(memberships.id, id)))
        .for('update')
      const row = first(rows)
      return row ? toMembership(row) : null
    },

    listMembers: async ({ after, limit }) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(inOrganization, after === undefined ? undefined : gt(memberships.id, after)))
        .orderBy(asc(memberships.id))
        .limit(limit)
      return rows.map(toMembership)
    },

    insertMembership: async (input) => {
      const rows = await tx
        .insert(memberships)
        .values({
          id: input.id,
          organizationId,
          userId: input.userId,
          role: input.role,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = first(rows)
      if (!row) {
        throw new Error('The Membership insert returned no row')
      }
      return toMembership(row)
    },

    setRole: async (id, role, now) => {
      const rows = await tx
        .update(memberships)
        .set({ role, updatedAt: now })
        .where(and(inOrganization, eq(memberships.id, id)))
        .returning()
      const row = first(rows)
      return row ? toMembership(row) : null
    },

    deleteMembership: async (id) => {
      const rows = await tx
        .delete(memberships)
        .where(and(inOrganization, eq(memberships.id, id)))
        .returning({ id: memberships.id })
      return rows.length > 0
    },
  }
}

/**
 * Turns the database rules the service must answer by name, and a lock timeout, into the port's errors; every
 * other failure, including a serialization failure the retry has given up on, passes unchanged.
 */
function translate(error: unknown): unknown {
  const info = postgresErrorOf(error)
  if (!info) {
    return error
  }
  if (info.code === LOCK_NOT_AVAILABLE) {
    return new LockTimeoutError()
  }
  if (
    info.code === '23505' &&
    (info.constraint === ONE_ORGANIZATION_PER_USER ||
      info.constraint === ONE_MEMBERSHIP_PER_ORGANIZATION)
  ) {
    return new AlreadyMemberError()
  }
  if (
    info.code === '23514' &&
    info.constraint === OWNER_REQUIRED &&
    info.message.startsWith(LAST_OWNER_PREFIX)
  ) {
    return new LastOwnerError()
  }
  return error
}

/**
 * The Postgres {@link CoreStore}: every query runs inside `withOrganization` from the db library,
 * which sets the Organization row-level security compares against, and the whole transaction is
 * retried on a serialization failure or deadlock (three runs, jittered).
 */
export function createPostgresCoreStore(db: Database, retry: RetryOptions = {}): CoreStore {
  return {
    organizationOfUser: async (userId) => {
      const found = await organizationOfUser(db, userId)
      return found
        ? { organizationId: organizationIdSchema.parse(found.organizationId), status: found.status }
        : null
    },

    withOrganization: (organizationId, fn) =>
      retryTransaction(async () => {
        try {
          return await withOrganization(db, organizationId, (tx) =>
            fn(createScope(tx, organizationId))
          )
        } catch (error) {
          throw translate(error)
        }
      }, retry),
  }
}

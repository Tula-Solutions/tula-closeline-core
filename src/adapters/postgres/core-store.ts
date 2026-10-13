import { and, asc, desc, eq, gt, type SQL, sql } from 'drizzle-orm'
import {
  type InvitationState,
  invitationIdSchema,
  membershipIdSchema,
  type OrganizationId,
  organizationIdSchema,
  teamIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import {
  type Database,
  invitationForToken,
  organizationOfUser,
  type Transaction,
  withOrganization,
} from 'tula-closeline-db'
import {
  invitations,
  memberships,
  organizations,
  teamMembers,
  teams,
} from 'tula-closeline-db/schema'
import {
  AlreadyMemberError,
  type CoreStore,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  type InvitationPageRequest,
  type InvitationRecord,
  LastOwnerError,
  LockTimeoutError,
  type MembershipRecord,
  type OrganizationRecord,
  type OrganizationScope,
  type TeamMemberRecord,
  TeamNameTakenError,
  type TeamRecord,
} from '~/ports/core-store'
import { guardQueryDetail } from './driver-error'
import { postgresErrorOf, type RetryOptions, retryTransaction } from './retry'

/** The unique constraint that holds "a user belongs to exactly one Organization". */
const ONE_ORGANIZATION_PER_USER = 'membership_directory_one_organization_per_user'

/** The unique constraint on a user's Membership inside one Organization. */
const ONE_MEMBERSHIP_PER_ORGANIZATION = 'memberships_organization_user_key'

/** The constraint name the Owner triggers raise under. */
const OWNER_REQUIRED = 'organizations_owner_required'

/** The message prefix that tells the last-Owner trigger from the other uses of that constraint. */
const LAST_OWNER_PREFIX = 'core.last_owner'

/** The partial unique index that holds "one pending Invitation per email per Organization". */
const ONE_PENDING_INVITATION_PER_EMAIL = 'invitations_pending_email_key'

/** The unique constraint on a Team's folded name inside one Organization. */
const TEAM_NAME_PER_ORGANIZATION = 'teams_organization_name_key'

/** The constraints the accept guard raises when an Invitation is expired or its Organization is not active. */
const INVITATION_NOT_ACCEPTABLE: readonly string[] = [
  'invitations_not_expired',
  'invitations_organization_active',
]

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
type InvitationRow = typeof invitations.$inferSelect
type TeamRow = typeof teams.$inferSelect
type TeamMemberRow = typeof teamMembers.$inferSelect

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

function toInvitation(row: InvitationRow): InvitationRecord {
  return {
    id: invitationIdSchema.parse(row.id),
    organizationId: organizationIdSchema.parse(row.organizationId),
    email: row.email,
    role: row.role,
    teamId: row.teamId === null ? null : teamIdSchema.parse(row.teamId),
    state: row.state,
    invitedByUserId: userIdSchema.parse(row.invitedByUserId),
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toTeam(row: TeamRow): TeamRecord {
  return {
    id: teamIdSchema.parse(row.id),
    organizationId: organizationIdSchema.parse(row.organizationId),
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toTeamMember(row: TeamMemberRow): TeamMemberRecord {
  return {
    teamId: teamIdSchema.parse(row.teamId),
    membershipId: membershipIdSchema.parse(row.membershipId),
    createdAt: row.createdAt,
  }
}

function first<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null
}

/**
 * The statement behind `listInvitations`: one page of an Organization's Invitations in one state,
 * `created_at` then `id` both descending, so `invitations_state_list_idx` serves it backwards with
 * no sort. Exported so the integration suite can ask the database for its plan.
 */
export function invitationPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  { state, after, limit }: InvitationPageRequest
) {
  return tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.state, state),
        after === undefined
          ? undefined
          : sql`(${invitations.createdAt}, ${invitations.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id})`
      )
    )
    .orderBy(desc(invitations.createdAt), desc(invitations.id))
    .limit(limit)
}

/**
 * The statement behind `countInvitationsSince`: one sub-query per state, each a range scan of
 * `invitations_state_list_idx` in creation order that stops at `limit` rows, put together with
 * `union all`. The bound is in the statement, not in the planner's choice of index: at most
 * 3 x `limit` index entries are read, whatever the Organization's history. Each arm alone can
 * reach `limit`, so the total reaches it exactly when the true count does, and the oldest row of
 * all is always among the rows read. Exported so the integration suite can ask the database for
 * its plan.
 */
export function invitationsSinceQuery(
  organizationId: OrganizationId,
  since: Date,
  limit: number
): SQL {
  const arm = (state: InvitationState) => sql`(
    select created_at from core.invitations
    where organization_id = ${organizationId}
      and state = ${state}
      and created_at > ${since.toISOString()}::timestamptz
    order by created_at
    limit ${limit}
  )`
  return sql`
    select
      count(*)::int as total,
      (extract(epoch from min(created_at)) * 1000)::float8 as "oldestMs"
    from (
      ${arm('pending')} union all ${arm('accepted')} union all ${arm('revoked')}
    ) as counted
  `
}

/**
 * The ids `revokeExpiredInvitations` revokes: pending, expired by `now`, created at or before
 * `createdAtOrBefore`, oldest first, locked. The creation-time bound is a condition of the pending
 * index (`organization_id, created_at, id`), so the scan ends at the first Invitation too young to
 * have expired instead of reading every pending one. Exported so the integration suite can ask the
 * database for its plan.
 */
export function expiredInvitationIdsQuery(
  organizationId: OrganizationId,
  now: Date,
  createdAtOrBefore: Date,
  limit: number
): SQL {
  return sql`
    select id from core.invitations
    where organization_id = ${organizationId}
      and state = 'pending'
      and created_at <= ${createdAtOrBefore.toISOString()}::timestamptz
      and expires_at <= ${now.toISOString()}::timestamptz
    order by created_at, id
    limit ${limit}
    for update
  `
}

/** Every statement names the Organization as well as relying on row-level security. */
function createScope(tx: Transaction, organizationId: OrganizationId): OrganizationScope {
  const inOrganization = eq(memberships.organizationId, organizationId)
  const invitationInOrganization = eq(invitations.organizationId, organizationId)
  const teamInOrganization = eq(teams.organizationId, organizationId)

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

    insertInvitation: async (input) => {
      const rows = await tx
        .insert(invitations)
        .values({
          id: input.id,
          organizationId,
          email: input.email,
          role: input.role,
          teamId: input.teamId,
          invitedByUserId: input.invitedByUserId,
          tokenHash: input.tokenHash,
          state: 'pending',
          expiresAt: input.expiresAt,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = first(rows)
      if (!row) {
        throw new Error('The Invitation insert returned no row')
      }
      return toInvitation(row)
    },

    lockInvitation: async (id) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(and(invitationInOrganization, eq(invitations.id, id)))
        .for('update')
      const row = first(rows)
      return row ? toInvitation(row) : null
    },

    lockPendingInvitationByEmail: async (email) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(
          and(
            invitationInOrganization,
            eq(invitations.email, email),
            eq(invitations.state, 'pending')
          )
        )
        .for('update')
      const row = first(rows)
      return row ? toInvitation(row) : null
    },

    getInvitationByTokenHash: async (tokenHash) => {
      const rows = await tx
        .select()
        .from(invitations)
        .where(and(invitationInOrganization, eq(invitations.tokenHash, tokenHash)))
      const row = first(rows)
      return row ? toInvitation(row) : null
    },

    listInvitations: async (request) =>
      (await invitationPageQuery(tx, organizationId, request)).map(toInvitation),

    countInvitationsSince: async (since, limit) => {
      const result = await tx.execute<{ total: number; oldestMs: number | null }>(
        invitationsSinceQuery(organizationId, since, limit)
      )
      const found = result.rows[0]
      return {
        // Three arms of up to `limit` each: the port promises no more than `limit`.
        count: Math.min(limit, found?.total ?? 0),
        oldest: found?.oldestMs == null ? null : new Date(Number(found.oldestMs)),
      }
    },

    countPendingInvitations: async (limit) => {
      // The inner query stops at `limit` rows, so the count never reads more than that.
      const capped = tx
        .select({ one: sql<number>`1`.as('one') })
        .from(invitations)
        .where(and(invitationInOrganization, eq(invitations.state, 'pending')))
        .limit(limit)
        .as('capped')
      const rows = await tx.select({ total: sql<number>`count(*)::int` }).from(capped)
      return first(rows)?.total ?? 0
    },

    revokeExpiredInvitations: async (now, limit, createdAtOrBefore) => {
      // One statement, bounded by `limit`. The ids come from a materialized CTE walking the pending
      // index in creation order (the order expiry follows): inside `IN (select ... limit n for
      // update)` the planner may run the subquery again per row and revoke more than `limit`.
      const at = now.toISOString()
      const result = await tx.execute(sql`
        with expired as materialized (
          ${expiredInvitationIdsQuery(organizationId, now, createdAtOrBefore, limit)}
        )
        update core.invitations as target
        set state = 'revoked', revoked_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        from expired
        where target.organization_id = ${organizationId} and target.id = expired.id
        returning target.id
      `)
      return result.rows.length
    },

    revokeInvitation: async (id, now) => {
      const rows = await tx
        .update(invitations)
        .set({ state: 'revoked', revokedAt: now, updatedAt: now })
        .where(
          and(invitationInOrganization, eq(invitations.id, id), eq(invitations.state, 'pending'))
        )
        .returning()
      const row = first(rows)
      return row ? toInvitation(row) : null
    },

    acceptInvitation: async (id, now) => {
      const rows = await tx
        .update(invitations)
        .set({ state: 'accepted', acceptedAt: now, updatedAt: now })
        .where(
          and(invitationInOrganization, eq(invitations.id, id), eq(invitations.state, 'pending'))
        )
        .returning()
      const row = first(rows)
      return row ? toInvitation(row) : null
    },

    insertTeam: async (input) => {
      const rows = await tx
        .insert(teams)
        .values({
          id: input.id,
          organizationId,
          name: input.name,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = first(rows)
      if (!row) {
        throw new Error('The Team insert returned no row')
      }
      return toTeam(row)
    },

    lockTeam: async (id) => {
      const rows = await tx
        .select()
        .from(teams)
        .where(and(teamInOrganization, eq(teams.id, id)))
        .for('update')
      const row = first(rows)
      return row ? toTeam(row) : null
    },

    listTeams: async ({ after, limit }) => {
      const rows = await tx
        .select()
        .from(teams)
        .where(and(teamInOrganization, after === undefined ? undefined : gt(teams.id, after)))
        .orderBy(asc(teams.id))
        .limit(limit)
      return rows.map(toTeam)
    },

    renameTeam: async (id, name, now) => {
      const rows = await tx
        .update(teams)
        .set({ name, updatedAt: now })
        .where(and(teamInOrganization, eq(teams.id, id)))
        .returning()
      const row = first(rows)
      return row ? toTeam(row) : null
    },

    deleteTeam: async (id) => {
      const rows = await tx
        .delete(teams)
        .where(and(teamInOrganization, eq(teams.id, id)))
        .returning({ id: teams.id })
      return rows.length > 0
    },

    addTeamMember: async (teamId, membershipId, now) => {
      await tx
        .insert(teamMembers)
        .values({ organizationId, teamId, membershipId, createdAt: now })
        .onConflictDoNothing()
      const rows = await tx
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.organizationId, organizationId),
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.membershipId, membershipId)
          )
        )
      const row = first(rows)
      if (!row) {
        throw new Error('The Team place was neither inserted nor found')
      }
      return toTeamMember(row)
    },

    removeTeamMember: async (teamId, membershipId) => {
      const rows = await tx
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.organizationId, organizationId),
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.membershipId, membershipId)
          )
        )
        .returning({ teamId: teamMembers.teamId })
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
  if (info.code === '23505' && info.constraint === ONE_PENDING_INVITATION_PER_EMAIL) {
    return new InvitationAlreadyPendingError()
  }
  if (info.code === '23505' && info.constraint === TEAM_NAME_PER_ORGANIZATION) {
    return new TeamNameTakenError()
  }
  if (
    info.code === '23514' &&
    info.constraint !== undefined &&
    INVITATION_NOT_ACCEPTABLE.includes(info.constraint)
  ) {
    return new InvitationNotAcceptableError()
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
 * retried on a serialization failure or deadlock (three runs, jittered). A driver failure leaves
 * the store as a {@link DatabaseQueryError}: the query builder's own error holds the statement and
 * its parameters, which for the Invitation methods are token hashes and addresses.
 */
export function createPostgresCoreStore(db: Database, retry: RetryOptions = {}): CoreStore {
  return {
    organizationOfUser: async (userId) => {
      const found = await guardQueryDetail(() => organizationOfUser(db, userId))
      return found
        ? { organizationId: organizationIdSchema.parse(found.organizationId), status: found.status }
        : null
    },

    invitationForToken: async (tokenHash) => {
      const found = await guardQueryDetail(() => invitationForToken(db, tokenHash))
      return found
        ? {
            organizationId: organizationIdSchema.parse(found.organizationId),
            invitationId: invitationIdSchema.parse(found.invitationId),
          }
        : null
    },

    withOrganization: (organizationId, fn) =>
      guardQueryDetail(() =>
        retryTransaction(async () => {
          try {
            return await withOrganization(db, organizationId, (tx) =>
              fn(createScope(tx, organizationId))
            )
          } catch (error) {
            throw translate(error)
          }
        }, retry)
      ),
  }
}

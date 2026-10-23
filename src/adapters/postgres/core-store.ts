import { and, asc, desc, eq, gt, inArray, ne, or, type SQL, sql } from 'drizzle-orm'
import {
  consentFormIdSchema,
  consentWordingIdSchema,
  type InvitationState,
  invitationIdSchema,
  type MembershipId,
  membershipIdSchema,
  type OrganizationId,
  organizationIdSchema,
  type Role,
  type TeamId,
  teamIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import {
  consentFormForToken,
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
  ConsentWordingLockedError,
  ConsentWordingSupersededError,
  type CoreStore,
  IdempotencyInProgressError,
  type IdempotencyKeyRef,
  type IdempotencyLookup,
  type IdempotencyReservation,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  type InvitationPageRequest,
  type InvitationRecord,
  LastOwnerError,
  LockTimeoutError,
  type MembershipRecord,
  MissingOrganizationError,
  type OrganizationRecord,
  type OrganizationScope,
  type TeamMemberRecord,
  TeamNameTakenError,
  type TeamRecord,
} from '~/ports/core-store'
import { createAuditStore } from './audit-store'
import { createConsentStore } from './consent-store'
import { createCrmStore, translateCrmError } from './crm-store'
import { guardQueryDetail } from './driver-error'
import { createImportStore } from './import-store'
import { containsPattern } from './like'
import { createOutboxScope } from './outbox-store'
import { createProspectStore, translateProspectError } from './prospect-store'
import { postgresErrorOf, type RetryOptions, retryTransaction } from './retry'

/** The partial unique index that holds "a Consent Wording has at most one newer version". */
const ONE_VERSION_PER_WORDING = 'consent_wording_supersedes_key'

/** The unique constraint that holds "a user belongs to exactly one Organization". */
const ONE_ORGANIZATION_PER_USER = 'membership_directory_one_organization_per_user'

/** The unique constraint on a user's Membership inside one Organization. */
const ONE_MEMBERSHIP_PER_ORGANIZATION = 'memberships_organization_user_key'

/** The constraint name the Owner triggers raise under. */
const OWNER_REQUIRED = 'organizations_owner_required'

/** The message prefix that tells the last-Owner trigger from the other uses of that constraint. */
const LAST_OWNER_PREFIX = 'core.last_owner'
/** The message prefix of the `consent_wording_locked` trigger, which raises `restrict_violation`. */
const CONSENT_WORDING_LOCKED = 'core.consent_wording_locked'

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

/**
 * How long each wait of an idempotency reservation may last, in milliseconds: the wait for another
 * request that holds the same key, and the wait on an expired row being replaced. When one runs
 * out the request answers `request.idempotency_in_progress`. It mirrors
 * {@link WRITE_LOCK_TIMEOUT_MS}. It bounds a statement, not the whole reservation: that tries up to
 * {@link RESERVE_ATTEMPTS} times and each attempt can wait twice, so a request fighting heavy
 * churn on one key can hold its connection for up to six waits (about 12 s), only then answering.
 */
export const IDEMPOTENCY_WAIT_MS = 2000

/** The most times one reservation looks at a key that keeps changing under it, before it gives up as in progress. */
const RESERVE_ATTEMPTS = 3

/** SQLSTATE of `foreign_key_violation`, which claiming a key in an Organization that does not exist raises. */
const FOREIGN_KEY_VIOLATION = '23503'

/** What {@link createPostgresCoreStore} may be tuned with; tests shorten the wait. */
export type PostgresStoreOptions = {
  /** How long a request waits for a held idempotency key; defaults to {@link IDEMPOTENCY_WAIT_MS}. */
  idempotencyWaitMs?: number
  /** How long a write waits for a row lock; defaults to {@link WRITE_LOCK_TIMEOUT_MS}. */
  writeLockTimeoutMs?: number
}

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
    email: row.email,
    name: row.name,
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
 * `union all`. Each arm is one contiguous index range, and its `created_at > since` condition
 * keeps every plan on the rows inside the send window, which the send budget itself bounds; so
 * whichever index scan the planner picks (an index scan that stops at `limit`, an index-only scan
 * or a bitmap scan) reads only the window's rows, never the Organization's older history. Only a
 * sequential scan would break the bound, and an integration plan test guards that none is chosen
 * and that the buffers stay small. Each arm alone can
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

/**
 * The statement behind `purgeIdempotencyKeys`: one batch of an Organization's keys created before
 * `before`, oldest first, read from `idempotency_keys_purge_idx` with no sort. `for update skip
 * locked` makes the purge pass over a row another transaction holds instead of waiting for it, so
 * it can never be part of a wait. Exported so the integration suite can ask the database for its plan.
 */
export function purgeIdempotencyKeysQuery(
  organizationId: OrganizationId,
  before: Date,
  limit: number
): SQL {
  return sql`
    delete from core.idempotency_keys
    where ctid = any (array(
      select ctid from core.idempotency_keys
      where organization_id = ${organizationId} and created_at < ${before.toISOString()}::timestamptz
      order by created_at
      limit ${limit}
      for update skip locked
    ))
    returning 1 as removed
  `
}

/**
 * The query behind one page of members: this Organization's rows after `after`, in id order, at most
 * `limit`. It orders by (organization_id, id), Organization first, so the composite unique index
 * `memberships_organization_id_id_key` serves the order and bounds the scan to this Organization;
 * ordering by id alone lets the planner walk the primary key across every Organization's rows.
 * With `role`, only members holding it; with `ids` (at most 100, by the contract), only those
 * ids, of this Organization (the Organization predicate always applies, so a foreign id matches
 * nothing). Both combine with `q` and the cursor and are served by the same (organization_id, id)
 * index as a filter on the bounded scan.
 * With `q`, a member matches when its name or its email contains `q` (`ilike`, `%`, `_` and
 * `\` literal). The filter runs over this Organization's rows only: `ilike` is not leakproof, so
 * under row-level security `memberships_name_trgm_idx` is not used, and the scan is bounded by the
 * Organization's size, not by the page. A trigram index on email would need a db-library migration.
 * Exported so the integration suite can ask the database for its plan.
 */
export function memberPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  after: MembershipId | undefined,
  limit: number,
  q?: string,
  filters: { role?: Role | undefined; ids?: readonly MembershipId[] | undefined } = {}
) {
  return tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, organizationId),
        after === undefined ? undefined : gt(memberships.id, after),
        filters.role === undefined ? undefined : eq(memberships.role, filters.role),
        filters.ids === undefined ? undefined : inArray(memberships.id, [...filters.ids]),
        q === undefined
          ? undefined
          : or(
              sql`${memberships.name} ilike ${containsPattern(q)} escape '\\'`,
              sql`${memberships.email} ilike ${containsPattern(q)} escape '\\'`
            )
      )
    )
    .orderBy(asc(memberships.organizationId), asc(memberships.id))
    .limit(limit)
}

/**
 * The query behind one page of a Team's members: the Team's rows in `team_members` are a range of
 * its primary key `(organization_id, team_id, membership_id)`, already in Membership id order, and
 * each joins its Membership by `memberships_organization_id_id_key`. Exported so the integration
 * suite can ask the database for its plan.
 */
export function teamMemberPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  teamId: TeamId,
  after: MembershipId | undefined,
  limit: number
) {
  return tx
    .select({ membership: memberships })
    .from(teamMembers)
    .innerJoin(
      memberships,
      and(
        eq(memberships.organizationId, teamMembers.organizationId),
        eq(memberships.id, teamMembers.membershipId)
      )
    )
    .where(
      and(
        eq(teamMembers.organizationId, organizationId),
        eq(teamMembers.teamId, teamId),
        after === undefined ? undefined : gt(teamMembers.membershipId, after)
      )
    )
    .orderBy(asc(teamMembers.membershipId))
    .limit(limit)
}

/** The primary-key condition of one idempotency row. */
function idempotencyRow(organizationId: OrganizationId, ref: IdempotencyKeyRef): SQL {
  return sql`organization_id = ${organizationId} and user_id = ${ref.userId}
    and route = ${ref.route} and key = ${ref.key}`
}

/** Every statement names the Organization as well as relying on row-level security. */
function createScope(
  tx: Transaction,
  organizationId: OrganizationId,
  options: Required<PostgresStoreOptions>
): OrganizationScope {
  const inOrganization = eq(memberships.organizationId, organizationId)
  const invitationInOrganization = eq(invitations.organizationId, organizationId)
  const teamInOrganization = eq(teams.organizationId, organizationId)

  return {
    ...createConsentStore(tx, organizationId),
    ...createCrmStore(tx, organizationId),
    ...createProspectStore(tx, organizationId),
    ...createImportStore(tx, organizationId),
    ...createOutboxScope(tx, organizationId),
    ...createAuditStore(tx, organizationId),

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
      await tx.execute(sql.raw(`set local lock_timeout = ${options.writeLockTimeoutMs}`))
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

    hasOtherOwner: async (id) => {
      const rows = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(inOrganization, eq(memberships.role, 'owner'), ne(memberships.id, id)))
        .limit(1)
      return rows.length > 0
    },

    getMembershipByEmail: async (email) => {
      const rows = await tx
        .select()
        .from(memberships)
        .where(and(inOrganization, eq(memberships.email, email)))
        .limit(1)
      const row = first(rows)
      return row ? toMembership(row) : null
    },

    listTeamMembers: async ({ teamId, after, limit }) =>
      (await teamMemberPageQuery(tx, organizationId, teamId, after, limit)).map((row) =>
        toMembership(row.membership)
      ),

    listMembers: async ({ after, q, role, ids, limit }) =>
      (await memberPageQuery(tx, organizationId, after, limit, q, { role, ids })).map(toMembership),

    insertMembership: async (input) => {
      const rows = await tx
        .insert(memberships)
        .values({
          id: input.id,
          organizationId,
          userId: input.userId,
          email: input.email,
          name: input.name,
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

    abandonOrganization: async (userId, maxAgeHours, now) => {
      // One statement checks and marks: the Organization is active (a suspension is deliberate and
      // is never undone on an internal caller's word), its Memberships (read no
      // further than two) are exactly one and it is the user's, and its age is measured by the
      // database's clock. Then the one Membership goes, which a deleted Organization allows.
      const marked = await tx.execute(sql`
        update core.organizations as o
        set status = 'deleted', updated_at = ${now}::timestamptz
        where o.organization_id = ${organizationId}
          and o.status = 'active'
          and o.created_at > clock_timestamp() - make_interval(hours => ${maxAgeHours}::int)
          and (select count(*) from (
                 select 1 from core.memberships as m
                 where m.organization_id = o.organization_id limit 2) as two) = 1
          and exists (
                 select 1 from core.memberships as m
                 where m.organization_id = o.organization_id and m.user_id = ${userId})
        returning o.organization_id
      `)
      if (marked.rows.length === 0) {
        return false
      }
      await tx.delete(memberships).where(and(inOrganization, eq(memberships.userId, userId)))
      return true
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

    getTeam: async (id) => {
      const rows = await tx
        .select()
        .from(teams)
        .where(and(teamInOrganization, eq(teams.id, id)))
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

    reserveIdempotencyKey: async (request) => {
      const inProgress = () =>
        new IdempotencyInProgressError(Math.max(1, Math.ceil(options.idempotencyWaitMs / 1000)))
      // Bounds every wait of this call, the one for another request's key included. Transaction-local.
      await tx.execute(sql.raw(`set local lock_timeout = ${options.idempotencyWaitMs}`))
      try {
        for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
          // Waits, when the key is being inserted by an open transaction, until that one ends.
          const inserted = await tx.execute(sql`
            insert into core.idempotency_keys
              (organization_id, user_id, route, key, request_hash, created_at)
            values (${organizationId}, ${request.userId}, ${request.route}, ${request.key},
              decode(${request.requestHash}, 'hex'), ${request.now.toISOString()}::timestamptz)
            on conflict (organization_id, user_id, route, key) do nothing
            returning 1 as reserved
          `)
          if (inserted.rows.length > 0) {
            return { outcome: 'reserved' } satisfies IdempotencyReservation
          }
          const found = await tx.execute<{
            status: number | null
            response: unknown
            same: boolean
            expired: boolean
          }>(sql`
            select status, response,
              request_hash = decode(${request.requestHash}, 'hex') as same,
              created_at < ${request.expiredBefore.toISOString()}::timestamptz as expired
            from core.idempotency_keys
            where ${idempotencyRow(organizationId, request)}
          `)
          const row = found.rows[0]
          if (!row) {
            continue
          }
          if (row.expired) {
            // Counts as absent: take it out and claim the key. A concurrent replacer that got there
            // first leaves a live row, which the next pass reads.
            await tx.execute(sql`
              delete from core.idempotency_keys
              where ${idempotencyRow(organizationId, request)}
                and created_at < ${request.expiredBefore.toISOString()}::timestamptz
            `)
            continue
          }
          if (row.status === null) {
            // The service never commits an in-flight row; one seen here is not ours to answer from.
            break
          }
          return row.same
            ? ({ outcome: 'replay', status: row.status, response: row.response } as const)
            : ({ outcome: 'reused' } as const)
        }
      } catch (error) {
        const info = postgresErrorOf(error)
        if (info?.code === LOCK_NOT_AVAILABLE) {
          throw inProgress()
        }
        if (info?.code === FOREIGN_KEY_VIOLATION) {
          throw new MissingOrganizationError()
        }
        throw error
      }
      throw inProgress()
    },

    completeIdempotencyKey: async (ref, status, response) => {
      const done = await tx.execute(sql`
        update core.idempotency_keys
        set status = ${status}, response = ${JSON.stringify(response)}::jsonb
        where ${idempotencyRow(organizationId, ref)} and status is null
        returning 1 as completed
      `)
      if (done.rows.length === 0) {
        throw new Error('The idempotency key is not in flight')
      }
    },

    deleteIdempotencyKey: async (ref) => {
      const gone = await tx.execute(sql`
        delete from core.idempotency_keys
        where ${idempotencyRow(organizationId, ref)}
        returning 1 as removed
      `)
      return gone.rows.length > 0
    },

    findIdempotencyKey: async (request) => {
      const found = await tx.execute<{
        status: number | null
        response: unknown
        same: boolean
        expired: boolean
      }>(sql`
        select status, response,
          request_hash = decode(${request.requestHash}, 'hex') as same,
          created_at < ${request.expiredBefore.toISOString()}::timestamptz as expired
        from core.idempotency_keys
        where ${idempotencyRow(organizationId, request)}
      `)
      const row = found.rows[0]
      if (!row || row.expired || row.status === null) {
        return { outcome: 'free' } satisfies IdempotencyLookup
      }
      return row.same
        ? ({
            outcome: 'replay',
            status: row.status,
            response: row.response,
          } satisfies IdempotencyLookup)
        : ({ outcome: 'reused' } satisfies IdempotencyLookup)
    },

    purgeIdempotencyKeys: async (before, limit) => {
      // In a savepoint: a statement that fails must not abort the write it follows.
      const gone = await tx.transaction((savepoint) =>
        savepoint.execute(purgeIdempotencyKeysQuery(organizationId, before, limit))
      )
      return gone.rows.length
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
  if (info.code === '23505' && info.constraint === ONE_VERSION_PER_WORDING) {
    return new ConsentWordingSupersededError()
  }
  if (info.code === '23001' && info.message.startsWith(CONSENT_WORDING_LOCKED)) {
    return new ConsentWordingLockedError()
  }
  const prospectError = translateProspectError(info)
  if (prospectError !== undefined) {
    return prospectError
  }
  const crmError = translateCrmError(info)
  if (crmError !== undefined) {
    return crmError
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
export function createPostgresCoreStore(
  db: Database,
  retry: RetryOptions = {},
  storeOptions: PostgresStoreOptions = {}
): CoreStore {
  const options = {
    idempotencyWaitMs: storeOptions.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS,
    writeLockTimeoutMs: storeOptions.writeLockTimeoutMs ?? WRITE_LOCK_TIMEOUT_MS,
  }
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

    consentFormForToken: async (token) => {
      const found = await guardQueryDetail(() => consentFormForToken(db, token))
      return found
        ? {
            organizationId: organizationIdSchema.parse(found.organizationId),
            formId: consentFormIdSchema.parse(found.formId),
            wordingId: consentWordingIdSchema.parse(found.wordingId),
            state: found.state,
          }
        : null
    },

    withOrganization: (organizationId, fn) =>
      guardQueryDetail(() =>
        retryTransaction(async () => {
          try {
            return await withOrganization(db, organizationId, (tx) =>
              fn(createScope(tx, organizationId, options))
            )
          } catch (error) {
            throw translate(error)
          }
        }, retry)
      ),
  }
}

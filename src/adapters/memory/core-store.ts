import {
  foldAscii,
  type InvitationId,
  type MembershipId,
  type OrganizationId,
  type OrganizationStatus,
  type TeamId,
  type UserId,
} from 'tula-closeline-contract'
import {
  AlreadyMemberError,
  type CoreStore,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  type InvitationRecord,
  LastOwnerError,
  type MembershipRecord,
  type OrganizationOfUser,
  type OrganizationRecord,
  type OrganizationScope,
  type TeamMemberRecord,
  TeamNameTakenError,
  type TeamRecord,
} from '~/ports/core-store'

/** What the memory store reads from the outside world. */
export type MemoryCoreStoreOptions = {
  /** The time the store judges expiry by, as the database judges by its own clock; defaults to the real one. */
  now?: () => Date
}

/** The in-memory store, plus the hooks a test needs to set up what the service cannot. */
export interface MemoryCoreStore extends CoreStore {
  /** Sets an Organization's status directly, as an operator's tool would. */
  setOrganizationStatus(organizationId: OrganizationId, status: OrganizationStatus): void
  /** How many Organizations exist, whatever their members. */
  organizationCount(): number
  /** Makes the store judge expiry by `now` from here on, so it agrees with a test's clock. */
  useClock(now: () => Date): void
}

/** An Invitation with the hash of its token, which no read of the port returns. */
type StoredInvitation = InvitationRecord & { tokenHash: string }

/** A Team place is keyed by the Team and the Membership. */
const placeKey = (teamId: TeamId, membershipId: MembershipId): string => `${teamId}/${membershipId}`

type State = {
  organizations: Map<OrganizationId, OrganizationRecord>
  memberships: Map<MembershipId, MembershipRecord>
  invitations: Map<InvitationId, StoredInvitation>
  teams: Map<TeamId, TeamRecord>
  teamMembers: Map<string, TeamMemberRecord & { organizationId: OrganizationId }>
}

function copy(state: State): State {
  return {
    organizations: new Map(state.organizations),
    memberships: new Map(state.memberships),
    invitations: new Map(state.invitations),
    teams: new Map(state.teams),
    teamMembers: new Map(state.teamMembers),
  }
}

function publicInvitation(stored: StoredInvitation): InvitationRecord {
  const { tokenHash: _hash, ...record } = stored
  return record
}

/** Whether the instant `expiresAt` has been reached, which the database counts as expired. */
function hasExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime()
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

function ownersOf(state: State, organizationId: OrganizationId): number {
  let owners = 0
  for (const membership of state.memberships.values()) {
    if (membership.organizationId === organizationId && membership.role === 'owner') {
      owners += 1
    }
  }
  return owners
}

/**
 * The rule the database holds with a trigger: a change that leaves an active or suspended
 * Organization without an Owner is refused. A deleted Organization may be emptied.
 */
function refuseIfOwnerless(state: State, organizationId: OrganizationId): void {
  const organization = state.organizations.get(organizationId)
  if (organization && organization.status !== 'deleted' && ownersOf(state, organizationId) < 1) {
    throw new LastOwnerError()
  }
}

/** A transaction's view of the state: reads see the latest, the first write takes a private copy. */
type Staging = { read: () => State; write: () => State }

/**
 * Whether the transaction holds its Organization's row lock. Postgres takes the lock in a query;
 * here transactions already run one at a time, so the flag only checks the order every write
 * must follow: lock the Organization first.
 */
type LockState = { held: boolean }

function requireLock(lock: LockState): void {
  if (!lock.held) {
    throw new Error('Lock the Organization (lockOrganization) before any write: the lock order')
  }
}

function createScope(
  staging: Staging,
  organizationId: OrganizationId,
  created: Set<OrganizationId>,
  lock: LockState,
  now: () => Date
): OrganizationScope {
  const inScope = (membership: MembershipRecord | undefined): MembershipRecord | null =>
    membership && membership.organizationId === organizationId ? membership : null

  const { read, write } = staging

  const inOrganization = <T extends { organizationId: OrganizationId }>(
    row: T | undefined
  ): T | null => (row && row.organizationId === organizationId ? row : null)

  return {
    getOrganization: async () => read().organizations.get(organizationId) ?? null,

    lockOrganization: async () => {
      lock.held = true
      return read().organizations.get(organizationId) ?? null
    },

    insertOrganization: async (input) => {
      const state = write()
      if (state.organizations.has(organizationId)) {
        throw new Error('core.organizations_pkey: the Organization already exists')
      }
      const record: OrganizationRecord = {
        id: organizationId,
        name: input.name,
        region: input.region,
        status: 'active',
        createdAt: input.now,
        updatedAt: input.now,
      }
      state.organizations.set(organizationId, record)
      created.add(organizationId)
      lock.held = true
      return record
    },

    renameOrganization: async (name, now) => {
      requireLock(lock)
      const current = read().organizations.get(organizationId)
      if (!current) {
        return null
      }
      const state = write()
      const next = { ...current, name, updatedAt: now }
      state.organizations.set(organizationId, next)
      return next
    },

    getMembershipByUser: async (userId) => {
      for (const membership of read().memberships.values()) {
        if (membership.userId === userId) {
          return inScope(membership)
        }
      }
      return null
    },

    getMembership: async (id) => inScope(read().memberships.get(id)),

    lockMembership: async (id) => {
      requireLock(lock)
      return inScope(read().memberships.get(id))
    },

    listMembers: async ({ after, limit }) =>
      [...read().memberships.values()]
        .filter(
          (membership) =>
            membership.organizationId === organizationId &&
            (after === undefined || membership.id > after)
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit),

    insertMembership: async (input) => {
      requireLock(lock)
      const state = write()
      for (const membership of state.memberships.values()) {
        if (membership.userId === input.userId) {
          throw new AlreadyMemberError()
        }
      }
      const record: MembershipRecord = {
        id: input.id,
        organizationId,
        userId: input.userId,
        role: input.role,
        createdAt: input.now,
        updatedAt: input.now,
      }
      state.memberships.set(record.id, record)
      return record
    },

    setRole: async (id, role, now) => {
      requireLock(lock)
      const current = inScope(read().memberships.get(id))
      if (!current) {
        return null
      }
      const state = write()
      const next = { ...current, role, updatedAt: now }
      state.memberships.set(id, next)
      refuseIfOwnerless(state, organizationId)
      return next
    },

    deleteMembership: async (id) => {
      requireLock(lock)
      if (!inScope(read().memberships.get(id))) {
        return false
      }
      const state = write()
      state.memberships.delete(id)
      for (const [key, place] of state.teamMembers) {
        if (place.membershipId === id) {
          state.teamMembers.delete(key)
        }
      }
      refuseIfOwnerless(state, organizationId)
      return true
    },

    insertInvitation: async (input) => {
      requireLock(lock)
      const state = write()
      for (const invitation of state.invitations.values()) {
        if (
          invitation.organizationId === organizationId &&
          invitation.email === input.email &&
          invitation.state === 'pending'
        ) {
          throw new InvitationAlreadyPendingError()
        }
      }
      const stored: StoredInvitation = {
        id: input.id,
        organizationId,
        email: input.email,
        role: input.role,
        teamId: input.teamId,
        state: 'pending',
        invitedByUserId: input.invitedByUserId,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        revokedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
        tokenHash: input.tokenHash,
      }
      state.invitations.set(stored.id, stored)
      return publicInvitation(stored)
    },

    lockInvitation: async (id) => {
      requireLock(lock)
      const found = inOrganization(read().invitations.get(id))
      return found ? publicInvitation(found) : null
    },

    lockPendingInvitationByEmail: async (email) => {
      requireLock(lock)
      for (const invitation of read().invitations.values()) {
        if (
          invitation.organizationId === organizationId &&
          invitation.email === email &&
          invitation.state === 'pending'
        ) {
          return publicInvitation(invitation)
        }
      }
      return null
    },

    getInvitationByTokenHash: async (tokenHash) => {
      for (const invitation of read().invitations.values()) {
        if (invitation.tokenHash === tokenHash) {
          const found = inOrganization(invitation)
          return found ? publicInvitation(found) : null
        }
      }
      return null
    },

    listInvitations: async ({ state: wanted, after, limit }) =>
      [...read().invitations.values()]
        .filter((invitation) => invitation.organizationId === organizationId)
        .filter((invitation) => invitation.state === wanted)
        .filter(
          (invitation) =>
            after === undefined ||
            invitation.createdAt.getTime() > after.createdAt.getTime() ||
            (invitation.createdAt.getTime() === after.createdAt.getTime() &&
              invitation.id > after.id)
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byText(a.id, b.id))
        .slice(0, limit)
        .map(publicInvitation),

    countPendingInvitations: async (limit) =>
      Math.min(
        limit,
        [...read().invitations.values()].filter(
          (invitation) =>
            invitation.organizationId === organizationId && invitation.state === 'pending'
        ).length
      ),

    revokeInvitation: async (id, at) => {
      requireLock(lock)
      const current = inOrganization(read().invitations.get(id))
      if (current?.state !== 'pending') {
        return null
      }
      const next: StoredInvitation = {
        ...current,
        state: 'revoked',
        revokedAt: at,
        updatedAt: at,
      }
      write().invitations.set(id, next)
      return publicInvitation(next)
    },

    acceptInvitation: async (id, at) => {
      requireLock(lock)
      const current = inOrganization(read().invitations.get(id))
      if (current?.state !== 'pending') {
        return null
      }
      const organization = read().organizations.get(organizationId)
      if (hasExpired(current.expiresAt, now()) || organization?.status !== 'active') {
        throw new InvitationNotAcceptableError()
      }
      const next: StoredInvitation = {
        ...current,
        state: 'accepted',
        acceptedAt: at,
        updatedAt: at,
      }
      write().invitations.set(id, next)
      return publicInvitation(next)
    },

    insertTeam: async (input) => {
      requireLock(lock)
      const state = write()
      const key = foldAscii(input.name)
      for (const team of state.teams.values()) {
        if (team.organizationId === organizationId && foldAscii(team.name) === key) {
          throw new TeamNameTakenError()
        }
      }
      const record: TeamRecord = {
        id: input.id,
        organizationId,
        name: input.name,
        createdAt: input.now,
        updatedAt: input.now,
      }
      state.teams.set(record.id, record)
      return record
    },

    lockTeam: async (id) => {
      requireLock(lock)
      return inOrganization(read().teams.get(id))
    },

    listTeams: async ({ after, limit }) =>
      [...read().teams.values()]
        .filter((team) => team.organizationId === organizationId)
        .filter((team) => after === undefined || team.id > after)
        .sort((a, b) => byText(a.id, b.id))
        .slice(0, limit),

    renameTeam: async (id, name, at) => {
      requireLock(lock)
      const current = inOrganization(read().teams.get(id))
      if (!current) {
        return null
      }
      const state = write()
      const key = foldAscii(name)
      for (const team of state.teams.values()) {
        if (
          team.organizationId === organizationId &&
          team.id !== id &&
          foldAscii(team.name) === key
        ) {
          throw new TeamNameTakenError()
        }
      }
      const next = { ...current, name, updatedAt: at }
      state.teams.set(id, next)
      return next
    },

    deleteTeam: async (id) => {
      requireLock(lock)
      if (!inOrganization(read().teams.get(id))) {
        return false
      }
      const state = write()
      state.teams.delete(id)
      for (const [key, place] of state.teamMembers) {
        if (place.teamId === id) {
          state.teamMembers.delete(key)
        }
      }
      for (const [invitationId, invitation] of state.invitations) {
        if (invitation.teamId === id) {
          state.invitations.set(invitationId, { ...invitation, teamId: null })
        }
      }
      return true
    },

    addTeamMember: async (teamId, membershipId, at) => {
      requireLock(lock)
      if (
        !inOrganization(read().teams.get(teamId)) ||
        !inScope(read().memberships.get(membershipId))
      ) {
        throw new Error(
          'core.team_members_fk: the Team and the Membership must be in this Organization'
        )
      }
      const existing = read().teamMembers.get(placeKey(teamId, membershipId))
      if (existing) {
        return { teamId, membershipId, createdAt: existing.createdAt }
      }
      write().teamMembers.set(placeKey(teamId, membershipId), {
        teamId,
        membershipId,
        createdAt: at,
        organizationId,
      })
      return { teamId, membershipId, createdAt: at }
    },

    removeTeamMember: async (teamId, membershipId) => {
      requireLock(lock)
      const key = placeKey(teamId, membershipId)
      const place = read().teamMembers.get(key)
      if (!place || place.organizationId !== organizationId) {
        return false
      }
      write().teamMembers.delete(key)
      return true
    },
  }
}

/**
 * An in-memory {@link CoreStore} for tests. A transaction runs on a copy and replaces the state
 * only when it returns, and transactions run one at a time, which is stricter than Postgres but
 * keeps every rule the database holds (one Organization per user, the last Owner, an Organization
 * born with an Owner).
 */
export function createMemoryCoreStore(options: MemoryCoreStoreOptions = {}): MemoryCoreStore {
  let now = options.now ?? (() => new Date())
  let state: State = {
    organizations: new Map(),
    memberships: new Map(),
    invitations: new Map(),
    teams: new Map(),
    teamMembers: new Map(),
  }
  let tail: Promise<unknown> = Promise.resolve()

  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  return {
    organizationOfUser: async (userId: UserId): Promise<OrganizationOfUser | null> => {
      for (const membership of state.memberships.values()) {
        if (membership.userId === userId) {
          const organization = state.organizations.get(membership.organizationId)
          return organization
            ? { organizationId: organization.id, status: organization.status }
            : null
        }
      }
      return null
    },

    invitationForToken: async (tokenHash) => {
      for (const invitation of state.invitations.values()) {
        if (invitation.tokenHash === tokenHash) {
          const organization = state.organizations.get(invitation.organizationId)
          return invitation.state === 'pending' &&
            !hasExpired(invitation.expiresAt, now()) &&
            organization?.status === 'active'
            ? { organizationId: invitation.organizationId, invitationId: invitation.id }
            : null
        }
      }
      return null
    },

    withOrganization: (organizationId, fn) =>
      serialised(async () => {
        let staged: State | undefined
        const created = new Set<OrganizationId>()
        const result = await fn(
          createScope(
            {
              read: () => staged ?? state,
              write: () => {
                staged ??= copy(state)
                return staged
              },
            },
            organizationId,
            created,
            { held: false },
            () => now()
          )
        )
        for (const id of created) {
          if (staged && ownersOf(staged, id) < 1) {
            throw new Error(
              'core.owner_required: an Organization must be created with its first Owner'
            )
          }
        }
        if (staged) {
          state = staged
        }
        return result
      }),

    setOrganizationStatus: (organizationId, status) => {
      const current = state.organizations.get(organizationId)
      if (current) {
        state.organizations.set(organizationId, { ...current, status })
      }
    },

    organizationCount: () => state.organizations.size,

    useClock: (next) => {
      now = next
    },
  }
}

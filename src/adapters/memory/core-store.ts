import type {
  MembershipId,
  OrganizationId,
  OrganizationStatus,
  UserId,
} from 'tula-closeline-contract'
import {
  AlreadyMemberError,
  type CoreStore,
  LastOwnerError,
  type MembershipRecord,
  type OrganizationOfUser,
  type OrganizationRecord,
  type OrganizationScope,
} from '~/ports/core-store'

/** The in-memory store, plus the hooks a test needs to set up what the service cannot. */
export interface MemoryCoreStore extends CoreStore {
  /** Sets an Organization's status directly, as an operator's tool would. */
  setOrganizationStatus(organizationId: OrganizationId, status: OrganizationStatus): void
  /** How many Organizations exist, whatever their members. */
  organizationCount(): number
}

type State = {
  organizations: Map<OrganizationId, OrganizationRecord>
  memberships: Map<MembershipId, MembershipRecord>
}

function copy(state: State): State {
  return { organizations: new Map(state.organizations), memberships: new Map(state.memberships) }
}

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
  lock: LockState
): OrganizationScope {
  const inScope = (membership: MembershipRecord | undefined): MembershipRecord | null =>
    membership && membership.organizationId === organizationId ? membership : null

  const { read, write } = staging

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
      refuseIfOwnerless(state, organizationId)
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
export function createMemoryCoreStore(): MemoryCoreStore {
  let state: State = { organizations: new Map(), memberships: new Map() }
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
            { held: false }
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
  }
}

import {
  type ConsentChannel,
  type CrmProvider,
  foldAscii,
  type InvitationId,
  type MembershipId,
  type OrganizationId,
  type OrganizationStatus,
  type ProspectId,
  type TeamId,
  type UserId,
} from 'tula-closeline-contract'
import type { AuditEventRecord } from '~/ports/audit-store'
import {
  AlreadyMemberError,
  type ConsentEventKind,
  type ConsentWordingRecord,
  type CoreStore,
  type IdempotencyKeyRef,
  type IdempotencyLookup,
  type IdempotencyReservation,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  type InvitationRecord,
  LastOwnerError,
  type MembershipRecord,
  MissingOrganizationError,
  type OrganizationOfUser,
  type OrganizationRecord,
  type OrganizationScope,
  type TeamMemberRecord,
  TeamNameTakenError,
  type TeamRecord,
} from '~/ports/core-store'
import {
  type AuditState,
  copyAuditState,
  createAuditScope,
  emptyAuditState,
  tamperAuditEvent,
} from './audit-state'
import {
  type ConsentLedgerState,
  copyConsentLedgerState,
  createConsentLedgerScope,
  emptyConsentLedgerState,
  seedConsentEvent,
  seedConsentWording,
} from './consent-state'
import {
  type CrmState,
  copyCrmState,
  createCrmScope,
  emptyCrmState,
  sealedBytesOf,
} from './crm-state'
import {
  copyOutboxState,
  createMemoryOutbox,
  createOutboxScope,
  emptyOutboxState,
  type MemoryOutbox,
  type OutboxState,
} from './outbox-state'
import {
  copyProspectState,
  createProspectScope,
  emptyProspectState,
  type ProspectState,
  releaseOwnedProspects,
  type SeededProspect,
  seedProspectState,
} from './prospect-state'

/** What the memory store reads from the outside world. */
export type MemoryCoreStoreOptions = {
  /** The time the store judges expiry by, as the database judges by its own clock; defaults to the real one. */
  now?: () => Date
}

/** The in-memory store, plus the hooks a test needs to set up what the service cannot. */
export interface MemoryCoreStore extends CoreStore {
  /** The drain's side of the outbox over the committed state, with a read of every row. */
  outbox: MemoryOutbox
  /** Alters a stored audit event directly, as someone with the database owner's rights could, so a test can show the verify finding it. */
  tamperAuditEvent(
    organizationId: OrganizationId,
    sequence: number,
    patch: Partial<AuditEventRecord>
  ): void
  /** Sets an Organization's status directly, as an operator's tool would. */
  setOrganizationStatus(organizationId: OrganizationId, status: OrganizationStatus): void
  /** How many Organizations exist, whatever their members. */
  organizationCount(): number
  /** Makes the store judge expiry by `now` from here on, so it agrees with a test's clock. */
  useClock(now: () => Date): void
  /** Sets an Organization's creation time directly, so a test needs no sleeping to make one old. */
  setOrganizationCreatedAt(organizationId: OrganizationId, createdAt: Date): void
  /** Removes a Membership row but keeps its Team places, which the database's cascade never leaves, so a test can check a reader skips them. */
  dropMembershipKeepingPlaces(id: MembershipId): void
  /** Plants many Prospects at once, bypassing the service, so a benchmark can start from 100,000 rows. */
  seedProspects(organizationId: OrganizationId, seeds: readonly SeededProspect[]): void
  /** Records a Prospect's newest consent event kind on a channel, as the ledger's writer would. */
  seedConsentEvent(
    organizationId: OrganizationId,
    prospectId: ProspectId,
    channel: ConsentChannel,
    kind: ConsentEventKind
  ): void
  /** Stores a consent wording, which the wording routes of a later ticket will create. */
  seedConsentWording(
    organizationId: OrganizationId,
    wording: ConsentWordingRecord & { text?: string }
  ): void
  /** The sealed token bytes held for a CRM connection, so a test can show that nothing plain is stored. */
  storedCrmTokenBytes(organizationId: OrganizationId, provider: CrmProvider): Uint8Array[]
}

/** An Invitation with the hash of its token, which no read of the port returns. */
type StoredInvitation = InvitationRecord & { tokenHash: string }

/** An idempotency key's row: in flight while `status` is null. */
type StoredKey = {
  organizationId: OrganizationId
  requestHash: string
  status: number | null
  response: unknown
  createdAt: Date
}

/** The map key of an idempotency row: the primary key `(organization_id, user_id, route, key)`. */
const keyOf = (organizationId: OrganizationId, ref: IdempotencyKeyRef): string =>
  [organizationId, ref.userId, ref.route, ref.key].join('\u0000')

/** A Team place is keyed by the Team and the Membership. */
const placeKey = (teamId: TeamId, membershipId: MembershipId): string => `${teamId}/${membershipId}`

type State = {
  organizations: Map<OrganizationId, OrganizationRecord>
  memberships: Map<MembershipId, MembershipRecord>
  invitations: Map<InvitationId, StoredInvitation>
  teams: Map<TeamId, TeamRecord>
  teamMembers: Map<string, TeamMemberRecord & { organizationId: OrganizationId }>
  idempotency: Map<string, StoredKey>
} & ProspectState &
  ConsentLedgerState &
  CrmState &
  OutboxState &
  AuditState

function copy(state: State): State {
  return {
    ...copyProspectState(state),
    ...copyConsentLedgerState(state),
    ...copyCrmState(state),
    ...copyOutboxState(state),
    ...copyAuditState(state),
    organizations: new Map(state.organizations),
    memberships: new Map(state.memberships),
    invitations: new Map(state.invitations),
    teams: new Map(state.teams),
    teamMembers: new Map(state.teamMembers),
    idempotency: new Map(state.idempotency),
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

/** A copy made the way a JSON column stores a value, so a later change to the original cannot reach the row. */
const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

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
    ...createConsentLedgerScope({
      organizationId,
      read: () => read(),
      write: () => write(),
      requireLock: () => requireLock(lock),
    }),

    ...createOutboxScope({ organizationId, now, write: () => write() }),

    ...createAuditScope({
      organizationId,
      read: () => read(),
      write: () => write(),
      requireLock: () => requireLock(lock),
    }),

    ...createCrmScope({
      organizationId,
      read: () => read(),
      write: () => write(),
      requireLock: () => requireLock(lock),
    }),

    ...createProspectScope({
      organizationId,
      read: () => read(),
      write: () => write(),
      requireLock: () => requireLock(lock),
    }),

    eraseProspectRow: async (prospectId) => {
      requireLock(lock)
      const stored = read().prospects.get(prospectId)
      if (stored?.organizationId !== organizationId) {
        return false
      }
      const state = write()
      state.prospects.delete(prospectId)
      state.prospectOrder.set(
        organizationId,
        (state.prospectOrder.get(organizationId) ?? []).filter((key) => key.id !== prospectId)
      )
      for (const kind of ['email', 'phone', 'linkedin'] as const) {
        const reverse = `${organizationId}\u0000${prospectId}\u0000${kind}`
        const value = state.identityOf.get(reverse)
        if (value !== undefined) {
          state.identities.delete(`${organizationId}\u0000${kind}\u0000${value}`)
          state.identityOf.delete(reverse)
        }
      }
      state.fields.delete(`prospect\u0000${prospectId}`)
      state.consentEvents = state.consentEvents.filter(
        (event) => !(event.organizationId === organizationId && event.prospectId === prospectId)
      )
      for (const key of [...state.latestConsent.keys()]) {
        if (key.startsWith(`${organizationId}\u0000${prospectId}\u0000`)) {
          state.latestConsent.delete(key)
        }
      }
      return true
    },

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

    hasOtherOwner: async (id) =>
      [...read().memberships.values()].some(
        (membership) =>
          membership.organizationId === organizationId &&
          membership.role === 'owner' &&
          membership.id !== id
      ),

    getMembershipByEmail: async (email) =>
      [...read().memberships.values()].find(
        (membership) => membership.organizationId === organizationId && membership.email === email
      ) ?? null,

    listMembers: async ({ after, q, role, ids, limit }) =>
      [...read().memberships.values()]
        .filter(
          (membership) =>
            membership.organizationId === organizationId &&
            (after === undefined || membership.id > after) &&
            (role === undefined || membership.role === role) &&
            (ids === undefined || ids.includes(membership.id)) &&
            (q === undefined ||
              (membership.name ?? '').toLowerCase().includes(q.toLowerCase()) ||
              membership.email.toLowerCase().includes(q.toLowerCase()))
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
        email: input.email,
        name: input.name,
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

    abandonOrganization: async (userId, maxAgeHours, at) => {
      requireLock(lock)
      const organization = read().organizations.get(organizationId)
      if (organization?.status !== 'active') {
        return false
      }
      // The age is judged by the store's clock, as the database judges it by its own.
      const young = now().getTime() - organization.createdAt.getTime() < maxAgeHours * 3_600_000
      const members = [...read().memberships.values()].filter(
        (membership) => membership.organizationId === organizationId
      )
      const only = members[0]
      if (!young || members.length !== 1 || only?.userId !== userId) {
        return false
      }
      const state = write()
      state.organizations.set(organizationId, { ...organization, status: 'deleted', updatedAt: at })
      state.memberships.delete(only.id)
      for (const [key, place] of state.teamMembers) {
        if (place.membershipId === only.id) {
          state.teamMembers.delete(key)
        }
      }
      return true
    },

    deleteMembership: async (id) => {
      requireLock(lock)
      if (!inScope(read().memberships.get(id))) {
        return false
      }
      const state = write()
      state.memberships.delete(id)
      releaseOwnedProspects(state, organizationId, id)
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
            invitation.createdAt.getTime() < after.createdAt.getTime() ||
            (invitation.createdAt.getTime() === after.createdAt.getTime() &&
              invitation.id < after.id)
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byText(b.id, a.id))
        .slice(0, limit)
        .map(publicInvitation),

    countInvitationsSince: async (since, limit) => {
      // The oldest `limit` of them: the same rows, whatever order a real database reads them in.
      const counted = [...read().invitations.values()]
        .filter(
          (invitation) =>
            invitation.organizationId === organizationId &&
            invitation.createdAt.getTime() > since.getTime()
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit)
      return { count: counted.length, oldest: counted[0]?.createdAt ?? null }
    },

    countPendingInvitations: async (limit) =>
      Math.min(
        limit,
        [...read().invitations.values()].filter(
          (invitation) =>
            invitation.organizationId === organizationId && invitation.state === 'pending'
        ).length
      ),

    revokeExpiredInvitations: async (at, limit, createdAtOrBefore) => {
      requireLock(lock)
      const expired = [...read().invitations.values()]
        .filter(
          (invitation) =>
            invitation.organizationId === organizationId &&
            invitation.state === 'pending' &&
            invitation.createdAt.getTime() <= createdAtOrBefore.getTime() &&
            hasExpired(invitation.expiresAt, at)
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byText(a.id, b.id))
        .slice(0, limit)
      if (expired.length > 0) {
        const state = write()
        for (const invitation of expired) {
          state.invitations.set(invitation.id, {
            ...invitation,
            state: 'revoked',
            revokedAt: at,
            updatedAt: at,
          })
        }
      }
      return expired.length
    },

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

    getTeam: async (id) => inOrganization(read().teams.get(id)),

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

    listTeamMembers: async ({ teamId, after, limit }) =>
      [...read().teamMembers.values()]
        .filter(
          (place) =>
            place.organizationId === organizationId &&
            place.teamId === teamId &&
            (after === undefined || place.membershipId > after)
        )
        .sort((a, b) => byText(a.membershipId, b.membershipId))
        // Skip a place with no Membership before the page is cut, as the database's inner join does.
        .flatMap((place) => inScope(read().memberships.get(place.membershipId)) ?? [])
        .slice(0, limit),

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
        return { teamId, membershipId, createdAt: existing.createdAt, created: false }
      }
      write().teamMembers.set(placeKey(teamId, membershipId), {
        teamId,
        membershipId,
        createdAt: at,
        organizationId,
      })
      return { teamId, membershipId, createdAt: at, created: true }
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

    reserveIdempotencyKey: async (request) => {
      if (lock.held) {
        throw new Error(
          'Reserve the idempotency key before locking the Organization: the lock order'
        )
      }
      if (!read().organizations.has(organizationId)) {
        throw new MissingOrganizationError()
      }
      const at = keyOf(organizationId, request)
      const existing = read().idempotency.get(at)
      if (existing && existing.createdAt.getTime() >= request.expiredBefore.getTime()) {
        if (existing.status === null) {
          throw new Error('The idempotency key is already reserved in this transaction')
        }
        const found: IdempotencyReservation =
          existing.requestHash === request.requestHash
            ? { outcome: 'replay', status: existing.status, response: clone(existing.response) }
            : { outcome: 'reused' }
        return found
      }
      write().idempotency.set(at, {
        organizationId,
        requestHash: request.requestHash,
        status: null,
        response: null,
        createdAt: request.now,
      })
      return { outcome: 'reserved' }
    },

    findIdempotencyKey: async (request) => {
      const existing = read().idempotency.get(keyOf(organizationId, request))
      if (
        !existing ||
        existing.status === null ||
        existing.createdAt.getTime() < request.expiredBefore.getTime()
      ) {
        return { outcome: 'free' } satisfies IdempotencyLookup
      }
      return existing.requestHash === request.requestHash
        ? ({
            outcome: 'replay',
            status: existing.status,
            response: clone(existing.response),
          } satisfies IdempotencyLookup)
        : ({ outcome: 'reused' } satisfies IdempotencyLookup)
    },

    completeIdempotencyKey: async (ref, status, response) => {
      const at = keyOf(organizationId, ref)
      const existing = read().idempotency.get(at)
      if (!existing || existing.status !== null) {
        throw new Error('The idempotency key is not in flight')
      }
      write().idempotency.set(at, { ...existing, status, response: clone(response) })
    },

    deleteIdempotencyKey: async (ref) => {
      const at = keyOf(organizationId, ref)
      if (!read().idempotency.has(at)) {
        return false
      }
      write().idempotency.delete(at)
      return true
    },

    purgeIdempotencyKeys: async (before, limit) => {
      const expired = [...read().idempotency.entries()]
        .filter(
          ([, row]) =>
            row.organizationId === organizationId && row.createdAt.getTime() < before.getTime()
        )
        .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
        .slice(0, limit)
      for (const [at] of expired) {
        write().idempotency.delete(at)
      }
      return expired.length
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
    ...emptyProspectState(),
    ...emptyConsentLedgerState(),
    ...emptyCrmState(),
    ...emptyOutboxState(),
    ...emptyAuditState(),
    organizations: new Map(),
    memberships: new Map(),
    invitations: new Map(),
    teams: new Map(),
    teamMembers: new Map(),
    idempotency: new Map(),
  }
  let tail: Promise<unknown> = Promise.resolve()

  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  const outbox = createMemoryOutbox({ state: () => state, now: () => now(), serialised })

  return {
    outbox,

    tamperAuditEvent: (organizationId, sequence, patch) => {
      state = { ...state, ...tamperAuditEvent(state, organizationId, sequence, patch) }
    },

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

    consentFormForToken: async (token) => {
      for (const form of state.forms.values()) {
        if (form.token !== null && form.token === token && form.state !== 'draft') {
          const organization = state.organizations.get(form.organizationId)
          return organization?.status === 'active'
            ? {
                organizationId: form.organizationId,
                formId: form.id,
                wordingId: form.wordingId,
                state: form.state,
              }
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

    dropMembershipKeepingPlaces: (id) => {
      state.memberships.delete(id)
    },

    setOrganizationCreatedAt: (organizationId, createdAt) => {
      const current = state.organizations.get(organizationId)
      if (current) {
        state.organizations.set(organizationId, { ...current, createdAt })
      }
    },

    useClock: (next) => {
      now = next
    },

    seedProspects: (organizationId, seeds) => {
      seedProspectState(state, organizationId, seeds)
    },

    seedConsentEvent: (organizationId, prospectId, channel, kind) => {
      seedConsentEvent(state, organizationId, prospectId, channel, kind)
    },

    seedConsentWording: (organizationId, wording) => {
      seedConsentWording(state, organizationId, wording)
    },

    storedCrmTokenBytes: (organizationId, provider) =>
      sealedBytesOf(state, organizationId, provider),
  }
}

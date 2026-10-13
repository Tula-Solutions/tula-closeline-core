import type {
  InvitableRole,
  InvitationId,
  InvitationState,
  MembershipId,
  OrganizationId,
  OrganizationStatus,
  Region,
  Role,
  TeamId,
  UserId,
} from 'tula-closeline-contract'

/** An Organization as the store holds it; the API shape is the contract's `Organization`. */
export type OrganizationRecord = {
  id: OrganizationId
  name: string
  region: Region
  status: OrganizationStatus
  createdAt: Date
  updatedAt: Date
}

/** A Membership as the store holds it; the API shape is the contract's `Member`. */
export type MembershipRecord = {
  id: MembershipId
  organizationId: OrganizationId
  userId: UserId
  role: Role
  createdAt: Date
  updatedAt: Date
}

/** Which Organization a user belongs to and its status, as the directory lookup answers. */
export type OrganizationOfUser = {
  organizationId: OrganizationId
  status: OrganizationStatus
}

/** The values of a new Organization; its id is the one the scope was opened for. */
export type NewOrganization = {
  name: string
  region: Region
  now: Date
}

/** The values of a new Membership in the scope's Organization. */
export type NewMembership = {
  id: MembershipId
  userId: UserId
  role: Role
  now: Date
}

/** An Invitation as the store holds it; the API shape is the contract's `Invitation`. The token hash is never read back. */
export type InvitationRecord = {
  id: InvitationId
  organizationId: OrganizationId
  /** Folded, in ASCII (A-label) form. */
  email: string
  role: InvitableRole
  /** The Team the invitee joins on accepting; cleared by the database when that Team is deleted. */
  teamId: TeamId | null
  state: InvitationState
  invitedByUserId: UserId
  expiresAt: Date
  acceptedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** The values of a new pending Invitation in the scope's Organization. */
export type NewInvitation = {
  id: InvitationId
  email: string
  role: InvitableRole
  teamId: TeamId | null
  invitedByUserId: UserId
  /** The SHA-256 of the token as 64 lowercase hex characters; the token itself never reaches the store. */
  tokenHash: string
  expiresAt: Date
  now: Date
}

/** Where an Invitation's token hash points: the answer of the directory lookup. */
export type InvitationLocation = {
  organizationId: OrganizationId
  invitationId: InvitationId
}

/** A keyset position over Invitations, which are listed newest first: by creation time, then id, both descending. */
export type InvitationPosition = { createdAt: Date; id: InvitationId }

/** A keyset page request over Invitations in one state. */
export type InvitationPageRequest = {
  state: InvitationState
  /** Return only Invitations that come after this position in the list, that is older (or, at the same time, a smaller id). */
  after?: InvitationPosition
  /** The most Invitations to return. */
  limit: number
}

/** What {@link OrganizationScope.countInvitationsSince} found. */
export type InvitationsSince = { count: number; oldest: Date | null }

/** A Team as the store holds it; the API shape is the contract's `Team`. */
export type TeamRecord = {
  id: TeamId
  organizationId: OrganizationId
  name: string
  createdAt: Date
  updatedAt: Date
}

/** The values of a new Team in the scope's Organization. */
export type NewTeam = {
  id: TeamId
  name: string
  now: Date
}

/** A keyset page request over Teams, ordered by Team id. */
export type TeamPageRequest = {
  /** Return only Teams whose id sorts after this one. */
  after?: TeamId
  /** The most Teams to return. */
  limit: number
}

/** A member's place in a Team as the store holds it; the API shape is the contract's `TeamMember`. */
export type TeamMemberRecord = {
  teamId: TeamId
  membershipId: MembershipId
  createdAt: Date
}

/** A keyset page request over members, ordered by Membership id. */
export type MemberPageRequest = {
  /** Return only members whose id sorts after this one. */
  after?: MembershipId
  /** The most members to return. */
  limit: number
}

/**
 * Everything one transaction may do inside one Organization. Every method sees only that
 * Organization's rows, whatever it is asked: a Membership of another Organization is `null`.
 */
export interface OrganizationScope {
  /** The Organization itself, or `null` when none exists with this id. Takes no lock. */
  getOrganization(): Promise<OrganizationRecord | null>
  /**
   * The Organization, read under a write lock on its row (`FOR NO KEY UPDATE`) that is held to the
   * end of the transaction, or `null`. Every write starts here: it is the lock the database's Owner
   * trigger takes and the first in the db library's lock order, so writes to one Organization queue
   * and each decides on committed data. It also bounds every later lock wait of the transaction
   * (the adapter's write lock timeout), failing with {@link LockTimeoutError} so a write queued
   * behind a slow lock holder gives its connection back.
   */
  lockOrganization(): Promise<OrganizationRecord | null>
  /** Creates the Organization (status `active`); it must be given its first Owner before commit. */
  insertOrganization(input: NewOrganization): Promise<OrganizationRecord>
  /** Sets the name, returning the Organization, or `null` when it does not exist. */
  renameOrganization(name: string, now: Date): Promise<OrganizationRecord | null>
  /** The Membership of one user in this Organization, or `null`. */
  getMembershipByUser(userId: UserId): Promise<MembershipRecord | null>
  /** One Membership by id, or `null`. Takes no lock. */
  getMembership(id: MembershipId): Promise<MembershipRecord | null>
  /**
   * One Membership by id, read under a row lock (`FOR UPDATE`) held to the end of the transaction,
   * or `null`. Call it only after {@link lockOrganization}, which keeps the lock order.
   */
  lockMembership(id: MembershipId): Promise<MembershipRecord | null>
  /** One page of members in id order. */
  listMembers(request: MemberPageRequest): Promise<MembershipRecord[]>
  /** Adds a Membership; throws {@link AlreadyMemberError} when the user belongs to any Organization. */
  insertMembership(input: NewMembership): Promise<MembershipRecord>
  /** Changes a role; throws {@link LastOwnerError} when it would demote the last Owner. */
  setRole(id: MembershipId, role: Role, now: Date): Promise<MembershipRecord | null>
  /** Removes a Membership; throws {@link LastOwnerError} when it is the last Owner's. Returns whether one was removed. */
  deleteMembership(id: MembershipId): Promise<boolean>

  /**
   * Adds a pending Invitation. Throws {@link InvitationAlreadyPendingError} when the email already
   * has one in this Organization. Call it only after {@link lockOrganization}.
   */
  insertInvitation(input: NewInvitation): Promise<InvitationRecord>
  /** One Invitation by id, under a row lock (`FOR UPDATE`) held to the end of the transaction, or `null`. */
  lockInvitation(id: InvitationId): Promise<InvitationRecord | null>
  /** The pending Invitation of an email, under a row lock (`FOR UPDATE`), or `null`. */
  lockPendingInvitationByEmail(email: string): Promise<InvitationRecord | null>
  /** The Invitation a token hash belongs to in any state, without a lock, or `null`. */
  getInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | null>
  /** One page of Invitations in one state, newest first: `created_at` then `id`, both descending. */
  listInvitations(request: InvitationPageRequest): Promise<InvitationRecord[]>
  /** How many Invitations are pending, counted no further than `limit` so the query stays bounded. */
  countPendingInvitations(limit: number): Promise<number>
  /**
   * How many Invitations this Organization created after `since`, in any state (revoked ones
   * included), counted no further than `limit` so the query stays bounded, and the creation time
   * of the oldest of those counted (`null` when none). When the count is below `limit` that is the
   * oldest of all of them.
   */
  countInvitationsSince(since: Date, limit: number): Promise<InvitationsSince>
  /**
   * Revokes pending Invitations of this Organization that had expired by `now`, the oldest first,
   * at most `limit` of them, in one statement. Returns how many were revoked. Only Invitations
   * created at or before `createdAtOrBefore` are looked at: the caller passes `now` minus the
   * lifetime it gives every Invitation, so the scan over creation time stops at the first live
   * one instead of reading all of them. Call it only after {@link lockOrganization}.
   */
  revokeExpiredInvitations(now: Date, limit: number, createdAtOrBefore: Date): Promise<number>
  /** Revokes a pending Invitation. Returns `null` when it is not pending (accepted and revoked are final). */
  revokeInvitation(id: InvitationId, now: Date): Promise<InvitationRecord | null>
  /**
   * Marks a pending Invitation accepted. Returns `null` when it is not pending, and throws
   * {@link InvitationNotAcceptableError} when it has expired or the Organization is not active.
   */
  acceptInvitation(id: InvitationId, now: Date): Promise<InvitationRecord | null>

  /** Adds a Team. Throws {@link TeamNameTakenError} when its name, folded, is in use in this Organization. */
  insertTeam(input: NewTeam): Promise<TeamRecord>
  /** One Team by id, under a row lock (`FOR UPDATE`) held to the end of the transaction, or `null`. */
  lockTeam(id: TeamId): Promise<TeamRecord | null>
  /** One page of Teams in id order. */
  listTeams(request: TeamPageRequest): Promise<TeamRecord[]>
  /** Renames a Team, throwing {@link TeamNameTakenError} on a clash. Returns `null` when it does not exist. */
  renameTeam(id: TeamId, name: string, now: Date): Promise<TeamRecord | null>
  /**
   * Deletes a Team. The database removes its places and clears the Team from pending Invitations,
   * so no member is read here. Returns whether one was removed.
   */
  deleteTeam(id: TeamId): Promise<boolean>
  /** Puts a Membership in a Team; adding one who is already in it returns the existing place. */
  addTeamMember(teamId: TeamId, membershipId: MembershipId, now: Date): Promise<TeamMemberRecord>
  /** Takes a Membership out of a Team. Returns whether it was in it. */
  removeTeamMember(teamId: TeamId, membershipId: MembershipId): Promise<boolean>
}

/** The store of Organizations and Memberships, whichever database stands behind it. */
export interface CoreStore {
  /**
   * The directory lookup made before any Organization is known: the Organization a user belongs
   * to and its status, or `null`. One indexed read, whatever the size of any Organization.
   */
  organizationOfUser(userId: UserId): Promise<OrganizationOfUser | null>
  /**
   * The directory lookup made before any Organization is known when an Invitation is accepted: the
   * Organization and Invitation a token hash opens, only while that Invitation is pending, unexpired
   * and its Organization is active. An unknown, used, revoked or expired token and one of an
   * inactive Organization all answer `null`.
   */
  invitationForToken(tokenHash: string): Promise<InvitationLocation | null>
  /**
   * Runs `fn` in one transaction scoped to `organizationId` and commits when it returns. The
   * adapter retries the whole of `fn` on a serialization failure or deadlock, so `fn` must do
   * nothing but use its scope.
   */
  withOrganization<T>(
    organizationId: OrganizationId,
    fn: (scope: OrganizationScope) => Promise<T>
  ): Promise<T>
}

/** The user already belongs to an Organization, and one user belongs to exactly one (ADR 0011). */
export class AlreadyMemberError extends Error {
  constructor() {
    super('The user already belongs to an Organization')
    this.name = 'AlreadyMemberError'
  }
}

/** The change would leave an active or suspended Organization with no Owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('An Organization must keep at least one Owner')
    this.name = 'LastOwnerError'
  }
}

/** A write waited longer than the lock timeout for a row lock; nothing changed and it may be tried again. */
export class LockTimeoutError extends Error {
  constructor() {
    super('A lock was not available in time')
    this.name = 'LockTimeoutError'
  }
}

/** The email already has a pending Invitation in this Organization. */
export class InvitationAlreadyPendingError extends Error {
  constructor() {
    super('A pending Invitation already exists for this email')
    this.name = 'InvitationAlreadyPendingError'
  }
}

/** The Invitation cannot be accepted now: it has expired or its Organization is not active. */
export class InvitationNotAcceptableError extends Error {
  constructor() {
    super('The Invitation cannot be accepted')
    this.name = 'InvitationNotAcceptableError'
  }
}

/** Another Team in this Organization already has the name, ignoring ASCII case. */
export class TeamNameTakenError extends Error {
  constructor() {
    super('A Team with that name already exists')
    this.name = 'TeamNameTakenError'
  }
}

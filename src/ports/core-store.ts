import type {
  MembershipId,
  OrganizationId,
  OrganizationStatus,
  Region,
  Role,
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
  /** The Organization itself, or `null` when none exists with this id. */
  getOrganization(): Promise<OrganizationRecord | null>
  /** Creates the Organization (status `active`); it must be given its first Owner before commit. */
  insertOrganization(input: NewOrganization): Promise<OrganizationRecord>
  /** Sets the name, returning the Organization, or `null` when it does not exist. */
  renameOrganization(name: string, now: Date): Promise<OrganizationRecord | null>
  /** The Membership of one user in this Organization, or `null`. */
  getMembershipByUser(userId: UserId): Promise<MembershipRecord | null>
  /** One Membership by id, or `null`. */
  getMembership(id: MembershipId): Promise<MembershipRecord | null>
  /** One page of members in id order. */
  listMembers(request: MemberPageRequest): Promise<MembershipRecord[]>
  /** Adds a Membership; throws {@link AlreadyMemberError} when the user belongs to any Organization. */
  insertMembership(input: NewMembership): Promise<MembershipRecord>
  /** Changes a role; throws {@link LastOwnerError} when it would demote the last Owner. */
  setRole(id: MembershipId, role: Role, now: Date): Promise<MembershipRecord | null>
  /** Removes a Membership; throws {@link LastOwnerError} when it is the last Owner's. Returns whether one was removed. */
  deleteMembership(id: MembershipId): Promise<boolean>
}

/** The store of Organizations and Memberships, whichever database stands behind it. */
export interface CoreStore {
  /**
   * The directory lookup made before any Organization is known: the Organization a user belongs
   * to and its status, or `null`. One indexed read, whatever the size of any Organization.
   */
  organizationOfUser(userId: UserId): Promise<OrganizationOfUser | null>
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

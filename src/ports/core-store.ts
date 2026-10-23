import type {
  CallId,
  ConsentChannel,
  ConsentEvent,
  ConsentEventId,
  ConsentSource,
  ConsentWordingId,
  ContactCheckId,
  ContactCheckLogEntry,
  ContactPurpose,
  InvitableRole,
  InvitationId,
  InvitationState,
  MembershipId,
  OrganizationId,
  OrganizationStatus,
  ProspectCompanyId,
  ProspectId,
  ProspectStatus,
  Region,
  Role,
  SuppressionEntryId,
  SuppressionReason,
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
  /** Core's copy of the person's address, folded, in ASCII form (ADR 0015). */
  email: string
  /** Core's copy of the person's display name, or `null` when they gave none. */
  name: string | null
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
  /** The person's address, folded, in ASCII form; a Membership cannot exist without one. */
  email: string
  /** The person's display name, or `null` when they gave none. */
  name: string | null
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

/** A keyset page request over the members of one Team, ordered by Membership id. */
export type TeamMemberPageRequest = MemberPageRequest & {
  /** The Team whose members are listed. */
  teamId: TeamId
}

/** A Prospect as the store holds it; its field values and identities are read through the field methods. */
export type ProspectRecord = {
  id: ProspectId
  companyId: ProspectCompanyId | null
  /** The owner Rep's Membership; `null` while unassigned, and cleared by the database when that Membership is removed. */
  ownerMembershipId: MembershipId | null
  status: ProspectStatus
  /** The Source kind that created the Prospect. */
  source: string
  tags: string[]
  notes: string | null
  createdAt: Date
  updatedAt: Date
}

/** The values of a new Prospect in the scope's Organization. */
export type NewProspect = {
  id: ProspectId
  companyId: ProspectCompanyId | null
  ownerMembershipId: MembershipId | null
  source: string
  tags: string[]
  notes: string | null
  now: Date
}

/** The most Prospects one `reassignProspects` call may be given. */
export const REASSIGN_MAX_IDS = 500

/** The columns of a Prospect that change in place; a missing key is left as it is. */
export type ProspectPatch = {
  companyId?: ProspectCompanyId | null
  status?: ProspectStatus
  tags?: string[]
  notes?: string | null
  ownerMembershipId?: MembershipId | null
}

/**
 * Which Prospects a caller may see: all of them (Owner, Admin), those a Membership owns (Rep), or
 * those a Manager owns plus those owned by the Reps who share a Team with that Manager.
 */
export type ProspectVisibility =
  | { kind: 'all' }
  | { kind: 'owner'; membershipId: MembershipId }
  | { kind: 'team'; managerMembershipId: MembershipId }

/** A keyset position over Prospects or Prospect Companies, newest first: creation time then id, both descending. */
export type CreatedPosition<Id extends string> = { createdAt: Date; id: Id }

/** A keyset page request over Prospects. Filters only narrow what the visibility allows. */
export type ProspectPageRequest = {
  visibility: ProspectVisibility
  ownerMembershipId?: MembershipId
  source?: string
  companyId?: ProspectCompanyId
  status?: ProspectStatus
  /** Matches, ignoring ASCII case, part of a current first name, last name or email, or of the company's name. */
  q?: string
  after?: CreatedPosition<ProspectId>
  /** The most Prospects to return. */
  limit: number
}

/** A Prospect Company as the store holds it. */
export type ProspectCompanyRecord = {
  id: ProspectCompanyId
  name: string
  /** The normalised domain, unique in the Organization, or `null`. */
  domain: string | null
  createdAt: Date
  updatedAt: Date
}

/** The values of a new Prospect Company. */
export type NewProspectCompany = {
  id: ProspectCompanyId
  name: string
  domain: string | null
  now: Date
}

/** The columns of a Prospect Company that change in place; a missing key is left as it is. */
export type ProspectCompanyPatch = { name?: string; domain?: string | null }

/** A keyset page request over Prospect Companies. */
export type ProspectCompanyPageRequest = {
  /** Matches, ignoring ASCII case, part of the name or the domain. */
  q?: string
  after?: CreatedPosition<ProspectCompanyId>
  limit: number
}

/** The fields of a Prospect that carry a Source and a history (ADR 0020). */
export type ProspectFieldName =
  | 'firstName'
  | 'lastName'
  | 'jobTitle'
  | 'email'
  | 'phone'
  | 'linkedinUrl'

/** The fields of a Prospect Company that carry a Source and a history. */
export type CompanyFieldName = 'name' | 'domain'

/** Whose fields a field method reads or writes. */
export type FieldOwnerKind = 'prospect' | 'company'

/** The current value of one field, with where it came from, when, and who set it. */
export type FieldRecord = {
  field: string
  value: string
  /** `manual`, `import`, `crm:hubspot`, `crm:salesforce`, `form` or `enrichment:<provider>`. */
  source: string
  /** Names the import or record the value came from; `null` for `manual`. */
  sourceRef: string | null
  setAt: Date
  setByUserId: UserId | null
}

/** The Source and time a new field value carries. */
export type FieldStamp = Omit<FieldRecord, 'field' | 'value'>

/** One change to the history of a field, decided by the precedence rules before the store sees it. */
export type FieldChange =
  | {
      /** Makes this the current value; the previous current value becomes history. */
      action: 'set'
      field: string
      value: string
      source: string
      sourceRef: string | null
      setByUserId: UserId | null
      at: Date
    }
  | {
      /** Removes the current value from view, keeping it in history. */
      action: 'clear'
      field: string
      at: Date
    }
  | {
      /** Keeps a value in history without making it current: an older one, or an enrichment suggestion. */
      action: 'record'
      field: string
      state: 'superseded' | 'suggested'
      value: string
      source: string
      sourceRef: string | null
      setByUserId: UserId | null
      at: Date
    }

/** The kinds of identity that make a Prospect the same person (ADR 0011). */
export type ProspectIdentityKind = 'email' | 'phone' | 'linkedin'

/** Names one stored answer: the caller, the route's short name and the client's `Idempotency-Key`. */
export type IdempotencyKeyRef = {
  userId: UserId
  /** A fixed short name per route, such as `invitations.create`: 1 to 64 of `a-z`, `0-9`, `.`, `_`. */
  route: string
  key: string
}

/** What {@link OrganizationScope.reserveIdempotencyKey} needs to claim a key. */
export type IdempotencyReservationRequest = IdempotencyKeyRef & {
  /** The SHA-256 of the canonical request as 64 lowercase hex characters; the request itself is never stored. */
  requestHash: string
  now: Date
  /** A stored answer created before this has expired and counts as absent. */
  expiredBefore: Date
}

/** What claiming an idempotency key found. */
export type IdempotencyReservation =
  /** The key was free: the row is in this transaction, in flight, and must be completed or released before commit. */
  | { outcome: 'reserved' }
  /** The same request was answered before: the stored status and body. */
  | { outcome: 'replay'; status: number; response: unknown }
  /** The key was used for a different request. */
  | { outcome: 'reused' }

/** What looking at an idempotency key without claiming it found. */
export type IdempotencyLookup =
  /** No live row: the key is free (or its row has expired). */
  { outcome: 'free' } | Exclude<IdempotencyReservation, { outcome: 'reserved' }>

/** The kinds of address a Suppression entry hashes (ADR 0021). */
export type SuppressionAddressKind = 'email' | 'phone' | 'linkedin'

/** A Suppression entry as the store holds it; the API shape is the contract's `SuppressionEntry`. */
export type SuppressionRecord = {
  id: SuppressionEntryId
  addressKind: SuppressionAddressKind
  /** For display; `null` exactly when the reason is `erased`. */
  maskedAddress: string | null
  reason: SuppressionReason
  channel: ConsentChannel | null
  sourceRef: string | null
  addedByUserId: UserId | null
  removable: boolean
  createdAt: Date
  removedAt: Date | null
  removedByUserId: UserId | null
  removalReason: string | null
}

/** The values of a new Suppression entry in the scope's Organization. */
export type NewSuppressionEntry = {
  id: SuppressionEntryId
  addressKind: SuppressionAddressKind
  /** The 32-octet salted hash; the address itself is never kept. */
  addressHash: Uint8Array
  maskedAddress: string | null
  reason: SuppressionReason
  channel: ConsentChannel | null
  sourceRef: string | null
  addedByUserId: UserId | null
  now: Date
}

/** A keyset position in a Suppression list: the sort time and the id. */
export type SuppressionCursorPosition = { at: Date; id: SuppressionEntryId }

/**
 * One page of Suppression entries, newest first. Live entries order by creation, removed ones by
 * removal time. `limit` is the number of rows to return.
 */
export type SuppressionPageRequest = {
  limit: number
  after?: SuppressionCursorPosition
  state: 'active' | 'removed'
  reason?: SuppressionReason
  addressKind?: SuppressionAddressKind
}

/** The newest consent event kind of a Prospect on a channel, as the ledger holds it. */
export type ConsentEventKind = 'granted' | 'withdrawn'

/** A consent wording as core reads it to check a grant: the channels it covers. */
export type ConsentWordingRecord = {
  id: ConsentWordingId
  version: number
  channels: ConsentChannel[]
}

/** One consent event to append; the store assigns the sequence and `recordedAt`. */
export type ConsentEventInput = {
  id: ConsentEventId
  prospectId: ProspectId
  channel: ConsentChannel
  kind: ConsentEventKind
  source: ConsentSource
  wordingId: ConsentWordingId | null
  evidenceRef: string | null
  callId: CallId | null
  formId: ConsentEvent['formId']
  /** Required exactly when `source` is `hosted_form`; never returned by the API. */
  ipAddress: string | null
  /** Required exactly when `source` is `hosted_form`; never returned by the API. */
  userAgent: string | null
  stopAll: boolean
  recordedByUserId: UserId | null
  occurredAt: Date
}

/** One answered Contact Check as the audit log keeps it; it never holds an address. */
export type ContactCheckRecord = {
  id: ContactCheckId
  prospectId: ProspectId | null
  channel: ConsentChannel
  purpose: ContactPurpose
  caller: string
  allowed: boolean
  code: Exclude<ContactCheckLogEntry['code'], 'consent.unavailable' | null> | null
  basis: ContactCheckLogEntry['basis']
  checkedAt: Date
}

/** A keyset position in the Contact Check log: the check time and the id. */
export type ContactCheckCursorPosition = { at: Date; id: ContactCheckId }

/** One page of the Contact Check log, newest first, narrowed by the optional filters. */
export type ContactCheckPageRequest = {
  limit: number
  after?: ContactCheckCursorPosition
  channel?: ConsentChannel
  purpose?: ContactPurpose
  allowed?: boolean
  prospectId?: ProspectId
  code?: NonNullable<ContactCheckRecord['code']>
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
  /**
   * The Membership with this address in this Organization, or `null`. The address is the folded,
   * ASCII form a Membership stores. One indexed read (`memberships_organization_email_idx`), no lock.
   */
  getMembershipByEmail(email: string): Promise<MembershipRecord | null>
  /** One Membership by id, or `null`. Takes no lock. */
  getMembership(id: MembershipId): Promise<MembershipRecord | null>
  /**
   * One Membership by id, read under a row lock (`FOR UPDATE`) held to the end of the transaction,
   * or `null`. Call it only after {@link lockOrganization}, which keeps the lock order.
   */
  lockMembership(id: MembershipId): Promise<MembershipRecord | null>
  /**
   * Whether this Organization has an Owner other than the Membership `id`: one bounded read
   * (limit 1). Call it only after {@link lockOrganization}, so the answer holds until commit.
   */
  hasOtherOwner(id: MembershipId): Promise<boolean>
  /** One page of members in id order. */
  listMembers(request: MemberPageRequest): Promise<MembershipRecord[]>
  /** Adds a Membership; throws {@link AlreadyMemberError} when the user belongs to any Organization. */
  insertMembership(input: NewMembership): Promise<MembershipRecord>
  /** Changes a role; throws {@link LastOwnerError} when it would demote the last Owner. */
  setRole(id: MembershipId, role: Role, now: Date): Promise<MembershipRecord | null>
  /**
   * Abandons the Organization in one statement-sized step, or does nothing: when it is
   * `active` (a suspended one is never abandoned), has exactly one Membership, that Membership is `userId`'s, and it was created less
   * than `maxAgeHours` before the database's own clock, it is set `deleted` and that one
   * Membership is removed, so the user id is free at once. Returns whether it did. Nothing else
   * is touched: Teams, Invitations and stored answers are left for the deletion job. Call it only
   * after {@link lockOrganization}, which keeps a concurrent accept or abandon out between the check
   * and the change.
   */
  abandonOrganization(userId: UserId, maxAgeHours: number, now: Date): Promise<boolean>
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
  /** One Team by id, without a lock, or `null` (also for a Team of another Organization). */
  getTeam(id: TeamId): Promise<TeamRecord | null>
  /** One page of Teams in id order. */
  listTeams(request: TeamPageRequest): Promise<TeamRecord[]>
  /** Renames a Team, throwing {@link TeamNameTakenError} on a clash. Returns `null` when it does not exist. */
  renameTeam(id: TeamId, name: string, now: Date): Promise<TeamRecord | null>
  /**
   * Deletes a Team. The database removes its places and clears the Team from pending Invitations,
   * so no member is read here. Returns whether one was removed.
   */
  deleteTeam(id: TeamId): Promise<boolean>
  /**
   * One page of the members of a Team in Membership id order: the primary key of `team_members`
   * serves the range and the join to `memberships` is by its unique key, so a page costs the page
   * size whatever the size of the Team. A Team of another Organization has no rows.
   */
  listTeamMembers(request: TeamMemberPageRequest): Promise<MembershipRecord[]>
  /** Puts a Membership in a Team; adding one who is already in it returns the existing place. */
  addTeamMember(teamId: TeamId, membershipId: MembershipId, now: Date): Promise<TeamMemberRecord>
  /** Takes a Membership out of a Team. Returns whether it was in it. */
  removeTeamMember(teamId: TeamId, membershipId: MembershipId): Promise<boolean>

  /**
   * Adds a Prospect. Throws {@link MissingReferenceError} when a named Prospect Company or owner is not in this
   * Organization. Call it only after {@link lockOrganization}.
   */
  insertProspect(input: NewProspect): Promise<ProspectRecord>
  /** One Prospect by id if the visibility allows it, else `null` (also for a Prospect of another Organization). No lock. */
  getProspect(id: ProspectId, visibility: ProspectVisibility): Promise<ProspectRecord | null>
  /** Like {@link getProspect}, under a row lock (`FOR UPDATE`) held to the end of the transaction. */
  lockProspect(id: ProspectId, visibility: ProspectVisibility): Promise<ProspectRecord | null>
  /** Changes columns and sets `updated_at`. Returns `null` when the Prospect does not exist. */
  updateProspect(id: ProspectId, patch: ProspectPatch, now: Date): Promise<ProspectRecord | null>
  /**
   * Makes `owner` the owner of the Prospects with these ids (at most {@link REASSIGN_MAX_IDS}) that
   * exist in this Organization, whoever may see them. Ids that do not exist here are not counted.
   * Only a Prospect whose owner differs is written (`updated_at` set); `found` counts every id that
   * exists, `changed` lists those written. One statement, so it is O(ids). Needs the Organization
   * lock. Throws {@link MissingReferenceError} when `owner` is not a Membership of this Organization.
   */
  reassignProspects(
    ids: readonly ProspectId[],
    owner: MembershipId,
    now: Date
  ): Promise<{ found: number; changed: ProspectId[] }>
  /**
   * One page of the Prospects the visibility allows, newest first (`created_at` then `id`, both
   * descending), narrowed by the request's filters. Served by the list indexes when only the
   * visibility, the owner, the status, the company or the Source is given; `q` filters the
   * candidates in that order, so it reads on until the page is full.
   */
  listProspects(request: ProspectPageRequest): Promise<ProspectRecord[]>

  /** One Prospect Company by id, or `null`. No lock. */
  getProspectCompany(id: ProspectCompanyId): Promise<ProspectCompanyRecord | null>
  /** One Prospect Company by id under a row lock held to the end of the transaction, or `null`. */
  lockProspectCompany(id: ProspectCompanyId): Promise<ProspectCompanyRecord | null>
  /** Adds a Prospect Company. Throws {@link CompanyDomainTakenError} when another one has the domain. */
  insertProspectCompany(input: NewProspectCompany): Promise<ProspectCompanyRecord>
  /** Changes name and domain columns. Throws {@link CompanyDomainTakenError} on a clash; `null` when it does not exist. */
  updateProspectCompany(
    id: ProspectCompanyId,
    patch: ProspectCompanyPatch,
    now: Date
  ): Promise<ProspectCompanyRecord | null>
  /** One page of Prospect Companies, newest first. */
  listProspectCompanies(request: ProspectCompanyPageRequest): Promise<ProspectCompanyRecord[]>
  /** The Prospect Companies with these ids that exist in this Organization (at most 100 ids). */
  getProspectCompanies(ids: ProspectCompanyId[]): Promise<ProspectCompanyRecord[]>

  /**
   * The current field values of up to 100 Prospects or Prospect Companies, by owner id. An owner
   * with no value for any field has no entry.
   */
  listCurrentFields(kind: FieldOwnerKind, ids: string[]): Promise<Map<string, FieldRecord[]>>
  /**
   * Applies decided changes to one owner's field history. The adapter writes them in field-name
   * order (the lock order that keeps two writers from deadlocking) and keeps each field's history
   * at 50 entries by dropping the oldest entries that are not current.
   */
  applyFieldChanges(kind: FieldOwnerKind, ownerId: string, changes: FieldChange[]): Promise<void>
  /** The Prospect that holds an identity in this Organization, or `null`. One primary-key read. */
  findProspectByIdentity(kind: ProspectIdentityKind, value: string): Promise<ProspectId | null>
  /**
   * Gives a Prospect the identity `value` of that kind, replacing the one it had, or removes it
   * with `null`. Throws {@link ProspectIdentityTakenError} when another Prospect holds the value.
   */
  setProspectIdentity(
    prospectId: ProspectId,
    kind: ProspectIdentityKind,
    value: string | null,
    now: Date
  ): Promise<void>

  /**
   * Claims an idempotency key for this transaction: inserts the row in flight (no status, no
   * response). Call it first, before {@link lockOrganization}; the memory store refuses it after.
   * Where the key already has a stored answer that has not expired, nothing is inserted and the
   * answer is returned: `replay` for the same request, `reused` for a different one. A stored
   * answer that has expired is replaced. While another transaction holds the key this waits for it,
   * no longer than the adapter's idempotency wait, then throws {@link IdempotencyInProgressError};
   * when that transaction commits the answer is its stored one, and when it rolls back the key is
   * free. Throws {@link MissingOrganizationError} when the Organization does not exist.
   */
  reserveIdempotencyKey(request: IdempotencyReservationRequest): Promise<IdempotencyReservation>
  /**
   * Looks at an idempotency key without claiming it, waiting for nobody: the stored answer of a
   * committed, unexpired row (`replay` for the same request hash, `reused` for another), else
   * `free`. For a route that stores its key in a transaction of its own, after its side effect.
   */
  findIdempotencyKey(
    request: Omit<IdempotencyReservationRequest, 'now'>
  ): Promise<IdempotencyLookup>
  /**
   * Completes the in-flight row this transaction reserved with the answer, in the same
   * transaction as the write. Throws when the key is not in flight (a bug in the caller).
   */
  completeIdempotencyKey(ref: IdempotencyKeyRef, status: number, response: unknown): Promise<void>
  /**
   * Removes a key, whether this transaction reserved it or it was completed earlier, so the same
   * key can be used again. Returns whether a row was removed.
   */
  deleteIdempotencyKey(ref: IdempotencyKeyRef): Promise<boolean>
  /**
   * Removes at most `limit` of this Organization's keys created before `before`, oldest first, in
   * one statement, and returns how many went. A row another transaction holds is skipped, never
   * waited for, so one call may remove fewer than `limit` although more are expired. If it throws,
   * the transaction is still usable: the failed statement is undone on its own.
   */
  purgeIdempotencyKeys(before: Date, limit: number): Promise<number>

  /**
   * The value of a Prospect's identity of that kind (an email, a phone or a LinkedIn address),
   * or `null`. One indexed read.
   */
  getProspectIdentity(prospectId: ProspectId, kind: ProspectIdentityKind): Promise<string | null>

  /**
   * The live (not removed) Suppression entries of this Organization with this address kind and
   * any of these hashes (at most {@link SUPPRESSION_LOOKUP_MAX_HASHES}). One indexed read per
   * hash, by `suppression_entry_live_key`, whatever the size of the list.
   */
  findLiveSuppression(
    kind: SuppressionAddressKind,
    hashes: readonly Uint8Array[]
  ): Promise<SuppressionRecord[]>
  /** One Suppression entry by id, live or removed, or `null` (also for one of another Organization). */
  getSuppressionEntry(id: SuppressionEntryId): Promise<SuppressionRecord | null>
  /**
   * Adds a Suppression entry unless a live one exists for the address, and answers the live one
   * either way: `created` says whether this call wrote it. Needs the Organization lock.
   */
  insertSuppressionEntry(
    input: NewSuppressionEntry
  ): Promise<{ entry: SuppressionRecord; created: boolean }>
  /**
   * Marks a live, removable entry removed and answers it, or answers `null` when the entry does
   * not exist, is already removed or is not removable. Needs the Organization lock.
   */
  removeSuppressionEntry(
    id: SuppressionEntryId,
    input: { userId: UserId; reason: string; now: Date }
  ): Promise<SuppressionRecord | null>
  /** One page of Suppression entries, newest first; served by the list indexes. */
  listSuppressionEntries(request: SuppressionPageRequest): Promise<SuppressionRecord[]>

  /**
   * The kind of the newest consent event (by sequence) of a Prospect on a channel, or `null`
   * when the ledger holds none. One read of `contact_consent_events_channel_idx`.
   */
  latestConsentKind(
    prospectId: ProspectId,
    channel: ConsentChannel
  ): Promise<ConsentEventKind | null>
  /** A consent wording of this Organization, or `null` when it does not exist. */
  getConsentWording(id: ConsentWordingId): Promise<ConsentWordingRecord | null>
  /**
   * Appends events to the append-only consent ledger, in order, and answers them as stored.
   * Needs the Organization lock.
   */
  appendConsentEvents(events: ConsentEventInput[]): Promise<ConsentEvent[]>
  /**
   * The newest event (by sequence) of a Prospect on each channel that has one: at most one
   * indexed read per channel, so never more than five rows.
   */
  latestConsentEvents(prospectId: ProspectId): Promise<ConsentEvent[]>
  /**
   * Writes the audit row of an answered Contact Check. It takes no Organization lock, so checks
   * never serialise on one another.
   */
  insertContactCheck(input: ContactCheckRecord): Promise<void>
  /** One page of the Contact Check log, newest first. */
  listContactChecks(request: ContactCheckPageRequest): Promise<ContactCheckRecord[]>
  /**
   * Removes at most `limit` of this Organization's log rows checked before `before`, oldest
   * first, in one statement, and returns how many went (the retention purge, ADR 0021).
   */
  purgeContactChecks(before: Date, limit: number): Promise<number>
}

/** The most hashes one {@link OrganizationScope.findLiveSuppression} call takes. */
export const SUPPRESSION_LOOKUP_MAX_HASHES = 20

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

/** A row named a record (a Prospect Company or a Membership) that is not in this Organization. */
export class MissingReferenceError extends Error {
  constructor(what: string) {
    super(`${what} is not in this Organization`)
    this.name = 'MissingReferenceError'
  }
}

/** Another Prospect Company in this Organization already has the domain. */
export class CompanyDomainTakenError extends Error {
  constructor() {
    super('A Prospect Company with that domain already exists')
    this.name = 'CompanyDomainTakenError'
  }
}

/** Another Prospect of this Organization already holds the identity. */
export class ProspectIdentityTakenError extends Error {
  readonly kind: ProspectIdentityKind
  /** The Prospect that holds it, when the adapter could read it; the service decides whether the caller may be told. */
  readonly holder: ProspectId | null

  constructor(kind: ProspectIdentityKind, holder: ProspectId | null) {
    super(`Another Prospect already has this ${kind}`)
    this.name = 'ProspectIdentityTakenError'
    this.kind = kind
    this.holder = holder
  }
}

/**
 * The idempotency key is held by another transaction that has neither committed nor rolled back
 * within the wait. Nothing changed; the client tries again after `retryAfterSeconds`.
 */
export class IdempotencyInProgressError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('An earlier request with this idempotency key is still running')
    this.name = 'IdempotencyInProgressError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** The Organization a key was claimed in does not exist. */
export class MissingOrganizationError extends Error {
  constructor() {
    super('The Organization does not exist')
    this.name = 'MissingOrganizationError'
  }
}

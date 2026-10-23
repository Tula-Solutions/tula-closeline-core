import {
  ABANDON_MAX_AGE_HOURS,
  CORE_ERRORS,
  ERRORS,
  formatId,
  type InternalAbandonOrganizationRequest,
  type InternalAbandonOrganizationResponse,
  type InternalAcceptInvitationRequest,
  type InternalAcceptInvitationResponse,
  type InternalCreateOrganizationRequest,
  type InternalCreateOrganizationResponse,
  type InternalMembershipResponse,
  internalAbandonOrganizationResponseSchema,
  internalAcceptInvitationResponseSchema,
  internalCreateOrganizationResponseSchema,
  internalMembershipResponseSchema,
  type OrganizationId,
  type UserId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import { hashToken, membershipIdFor } from '~/modules/invitation/token'
import {
  AlreadyMemberError,
  InvitationNotAcceptableError,
  type InvitationRecord,
  type MembershipRecord,
} from '~/ports/core-store'

/** What the internal calls need from the container. */
export type InternalDeps = Pick<Container, 'store' | 'clock' | 'env' | 'logger'>

/**
 * The answer for a user who already belongs to an Organization when sign-up asks to create one:
 * the same answer again if they own it (the retry of a call that did succeed), otherwise they
 * are already a member in some other way.
 */
async function answerForExisting(
  deps: InternalDeps,
  userId: UserId,
  organizationId: OrganizationId
): Promise<InternalCreateOrganizationResponse> {
  const membership = await deps.store.withOrganization(organizationId, (scope) =>
    scope.getMembershipByUser(userId)
  )
  if (membership?.role !== 'owner') {
    throw domainError(CORE_ERRORS['membership.already_member'])
  }
  return internalCreateOrganizationResponseSchema.parse({ organizationId, role: 'owner' })
}

/**
 * Creates an Organization for a user signing up, with the user as its Owner, in one transaction.
 * The auth service fixes the user id per sign-up attempt, so the call is idempotent on it: a user
 * who already owns an Organization gets that Organization back, whatever the key or the name, and
 * nothing is created. Two calls racing for one user create one Organization: the database's
 * one-Organization-per-user constraint refuses the loser's transaction, which then answers as a
 * replay. A user who belongs to an Organization they do not own is `membership.already_member`.
 *
 * The Membership keeps a copy of the person's address and name (ADR 0015). The contract leaves
 * `email` optional only so core can deploy before auth sends it, but a Membership cannot exist
 * without one, so a request without it is `request.invalid` and nothing is written (the check is
 * first, so it holds for a retry as well). A missing or null `name` is stored as null. A replay
 * writes nothing, so it never changes a stored copy; only the profile change does.
 */
export async function createOrganization(
  deps: InternalDeps,
  input: InternalCreateOrganizationRequest
): Promise<InternalCreateOrganizationResponse> {
  const { email } = input
  if (email === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const existing = await deps.store.organizationOfUser(input.userId)
  if (existing) {
    return answerForExisting(deps, input.userId, existing.organizationId)
  }

  const organizationId = formatId('org', crypto.randomUUID())
  const membershipId = formatId('mem', crypto.randomUUID())
  const now = deps.clock.now()
  try {
    await deps.store.withOrganization(organizationId, async (scope) => {
      await scope.insertOrganization({ name: input.organizationName, region: deps.env.REGION, now })
      await scope.insertMembership({
        id: membershipId,
        userId: input.userId,
        email,
        name: input.name ?? null,
        role: 'owner',
        now,
      })
    })
  } catch (error) {
    if (!(error instanceof AlreadyMemberError)) {
      throw error
    }
    const winner = await deps.store.organizationOfUser(input.userId)
    if (!winner) {
      // The winner was deleted and emptied between the refusal and this read.
      throw domainError(CORE_ERRORS['membership.already_member'])
    }
    return answerForExisting(deps, input.userId, winner.organizationId)
  }
  return internalCreateOrganizationResponseSchema.parse({ organizationId, role: 'owner' })
}

/**
 * The membership of one user, for the token hook that runs on every sign-in and refresh. It is
 * the hot path of the service: O(1) in every size, two indexed reads. The first is the directory
 * lookup (`core.organization_of_user`, an exact key on the unique index of `user_id`, joined to
 * the Organization's one status row); the second is the Membership under that Organization
 * (`memberships_organization_user_key`). Nothing is listed, counted or written. A user with none
 * is `found: false`; a user in a suspended or deleted Organization is found, with its status.
 */
export async function lookupMembership(
  deps: Pick<Container, 'store'>,
  userId: UserId
): Promise<InternalMembershipResponse> {
  const found = await deps.store.organizationOfUser(userId)
  if (!found) {
    return internalMembershipResponseSchema.parse({ found: false })
  }
  const membership = await deps.store.withOrganization(found.organizationId, (scope) =>
    scope.getMembershipByUser(userId)
  )
  if (!membership) {
    return internalMembershipResponseSchema.parse({ found: false })
  }
  return internalMembershipResponseSchema.parse({
    found: true,
    organizationId: found.organizationId,
    role: membership.role,
    organizationStatus: found.status,
  })
}

/** An Organization id that cannot exist (the nil UUID is never generated), for a transaction that must find nothing. */
const NO_ORGANIZATION = formatId('org', '00000000-0000-0000-0000-000000000000')

/** An Invitation id that cannot exist, for the same purpose. */
const NO_INVITATION = formatId('inv', '00000000-0000-0000-0000-000000000000')

/**
 * Does the work of a refused accept that opened a transaction (lock the Organization row, lock the
 * Invitation row) against rows that cannot exist, so a refusal that found no usable Invitation
 * costs the same store calls as one that found a real Invitation and then saw the wrong address.
 */
async function transactionFindingNothing(deps: Pick<Container, 'store'>): Promise<void> {
  await deps.store.withOrganization(NO_ORGANIZATION, async (scope) => {
    await scope.lockOrganization()
    await scope.lockInvitation(NO_INVITATION)
  })
}

/** The one refusal for every way an Invitation cannot be used: the same status and body whatever the cause. */
function invalidInvitation() {
  return domainError(CORE_ERRORS['invitation.invalid'])
}

/**
 * Whether `membership` is the one accepting `invitation` created for `userId`: the Invitation was
 * accepted, was offered to this address, and the user's Membership has the id derived from the
 * Invitation's (see {@link membershipIdFor}). Nothing else makes a retry look like the first call.
 */
function isAcceptanceBy(
  invitation: InvitationRecord,
  membership: MembershipRecord | null,
  email: string
): boolean {
  return (
    invitation.state === 'accepted' &&
    invitation.email === email &&
    membership !== null &&
    membership.id === membershipIdFor(invitation.id)
  )
}

function acceptedAnswer(invitation: InvitationRecord): InternalAcceptInvitationResponse {
  return internalAcceptInvitationResponseSchema.parse({
    organizationId: invitation.organizationId,
    role: invitation.role,
  })
}

/**
 * The answer when the token opens no pending Invitation: the retry of an accept that succeeded
 * (the Invitation is accepted, by this user, with this address) answers as the first call did;
 * everything else, including a user with no Membership at all, is `invitation.invalid`. Only the
 * user's own Organization is looked in, so the call confirms nothing about any other. A user with
 * no active Organization, the case at sign-up, still does a transaction (on rows that cannot
 * exist), so that refusal costs what a refusal of a real Invitation costs.
 */
async function replayOrInvalid(
  deps: Pick<Container, 'store'>,
  request: InternalAcceptInvitationRequest,
  tokenHash: string
): Promise<InternalAcceptInvitationResponse> {
  const home = await deps.store.organizationOfUser(request.userId)
  if (home?.status !== 'active') {
    await transactionFindingNothing(deps)
    throw invalidInvitation()
  }
  const accepted = await deps.store.withOrganization(home.organizationId, async (scope) => {
    const invitation = await scope.getInvitationByTokenHash(tokenHash)
    if (!invitation) {
      return null
    }
    const membership = await scope.getMembershipByUser(request.userId)
    return isAcceptanceBy(invitation, membership, request.email) ? invitation : null
  })
  if (!accepted) {
    throw invalidInvitation()
  }
  return acceptedAnswer(accepted)
}

/**
 * Accepts an Invitation for a user who has just signed up, with the token and the verified
 * address. The token is hashed, the directory function finds the Organization of a pending,
 * unexpired Invitation in an active Organization, and one transaction does the rest in the db
 * library's lock order (the Organization row first, then the Invitation row, then the rows the
 * accept writes): the address, folded, must equal the Invitation's; the Membership is created
 * with the offered role and the id derived from the Invitation's; the member joins the
 * Invitation's Team if it names one; the Invitation is marked accepted.
 *
 * The only codes are `invitation.invalid` (unknown, expired, revoked, used, a different address, an
 * Organization that is not active, all with the same status and body) and
 * `membership.already_member` (the user belongs to an Organization). A retry by the user the
 * Invitation was accepted for answers as the first call did; a different user is `invitation.invalid`.
 * Two accepts at once by different users leave one Membership: the loser reads the Invitation as
 * accepted under the Organization lock.
 */
export async function acceptInvitation(
  deps: Pick<Container, 'store' | 'clock'>,
  request: InternalAcceptInvitationRequest
): Promise<InternalAcceptInvitationResponse> {
  const tokenHash = hashToken(request.invitationToken)
  const located = await deps.store.invitationForToken(tokenHash)
  if (!located) {
    return replayOrInvalid(deps, request, tokenHash)
  }
  // Read and not used: a refusal that found no Invitation reads the user's home before it looks
  // for a replay, and this keeps the two the same number of store calls.
  await deps.store.organizationOfUser(request.userId)
  const now = deps.clock.now()
  try {
    return await deps.store.withOrganization(located.organizationId, async (scope) => {
      const organization = await scope.lockOrganization()
      if (organization?.status !== 'active') {
        throw invalidInvitation()
      }
      const invitation = await scope.lockInvitation(located.invitationId)
      if (!invitation || invitation.email !== request.email) {
        throw invalidInvitation()
      }
      if (invitation.state === 'accepted') {
        const membership = await scope.getMembershipByUser(request.userId)
        if (isAcceptanceBy(invitation, membership, request.email)) {
          return acceptedAnswer(invitation)
        }
        throw invalidInvitation()
      }
      if (invitation.state !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
        throw invalidInvitation()
      }
      await scope.insertMembership({
        id: membershipIdFor(invitation.id),
        userId: request.userId,
        // The request's address, which the check above made equal to the Invitation's.
        email: request.email,
        name: request.name ?? null,
        role: invitation.role,
        now,
      })
      if (invitation.teamId !== null && (await scope.lockTeam(invitation.teamId))) {
        await scope.addTeamMember(invitation.teamId, membershipIdFor(invitation.id), now)
      }
      const accepted = await scope.acceptInvitation(invitation.id, now)
      if (!accepted) {
        throw invalidInvitation()
      }
      await Audit.recordIn(scope, located.organizationId, {
        occurredAt: now,
        actor: { kind: 'member', membershipId: membershipIdFor(invitation.id) },
        action: 'invitation.accepted',
        subject: { type: 'invitation', id: invitation.id },
        metadata: { role: invitation.role },
      })
      return acceptedAnswer(accepted)
    })
  } catch (error) {
    if (error instanceof AlreadyMemberError) {
      throw domainError(CORE_ERRORS['membership.already_member'])
    }
    if (error instanceof InvitationNotAcceptableError) {
      throw invalidInvitation()
    }
    throw error
  }
}

/**
 * Abandons an Organization whose Owner never got an account, answering by the end state: success
 * whenever no live Organization with this id exists when the call returns (abandoned by this
 * call, deleted or abandoned earlier, or never created); `organization.not_abandonable` when a
 * live one fails the guard (another member, a sole member who is not `userId`, or created
 * `ABANDON_MAX_AGE_HOURS` hours ago or more), leaving it untouched.
 *
 * One transaction: lock the Organization row (`FOR NO KEY UPDATE`, bounded by the write lock
 * timeout, a miss being a retryable 503), then check and delete in one statement, so a concurrent
 * accept either committed first (the guard then sees two members) or waits and finds the
 * Organization deleted. The deletion is the one ADR 0011 describes: the status is set `deleted`
 * (a one-row change) and the work proportional to the Organization's size is left to the deletion
 * job. The one Membership is removed here, so the user id is free when the call returns; that is
 * one row, its directory row and the member's Team places, whatever else the Organization holds.
 */
export async function abandonOrganization(
  deps: Pick<Container, 'store' | 'clock' | 'logger'>,
  organizationId: OrganizationId,
  request: InternalAbandonOrganizationRequest
): Promise<InternalAbandonOrganizationResponse> {
  const now = deps.clock.now()
  const outcome = await deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'already_gone' as const
    }
    const abandoned = await scope.abandonOrganization(request.userId, ABANDON_MAX_AGE_HOURS, now)
    return abandoned ? ('abandoned' as const) : ('refused' as const)
  })
  deps.logger.info('abandon organization', { organizationId, outcome })
  if (outcome === 'refused') {
    throw domainError(CORE_ERRORS['organization.not_abandonable'])
  }
  return internalAbandonOrganizationResponseSchema.parse({ organizationId, status: 'deleted' })
}

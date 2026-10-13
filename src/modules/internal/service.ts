import {
  CORE_ERRORS,
  formatId,
  type InternalCreateOrganizationRequest,
  type InternalCreateOrganizationResponse,
  type InternalMembershipResponse,
  internalCreateOrganizationResponseSchema,
  internalMembershipResponseSchema,
  type OrganizationId,
  type UserId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { AlreadyMemberError } from '~/ports/core-store'

/** What the internal calls need from the container. */
export type InternalDeps = Pick<Container, 'store' | 'clock' | 'env'>

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
 */
export async function createOrganization(
  deps: InternalDeps,
  input: InternalCreateOrganizationRequest
): Promise<InternalCreateOrganizationResponse> {
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
      await scope.insertMembership({ id: membershipId, userId: input.userId, role: 'owner', now })
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

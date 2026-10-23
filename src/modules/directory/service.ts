import {
  type InternalDirectoryMembershipRequest,
  type InternalDirectoryMembershipResponse,
  type InternalDirectoryRepCheckRequest,
  type InternalDirectoryRepCheckResponse,
  type InternalDirectoryTeamCheckRequest,
  type InternalDirectoryTeamCheckResponse,
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryTeamCheckResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'

/** What the directory lookups need from the container. */
export type DirectoryDeps = Pick<Container, 'store'>

/**
 * The Membership of a user in a named Organization, with that Organization's status, or
 * `found: false`. Two indexed reads in one tenant-scoped transaction, O(1); a user of another
 * Organization is not found.
 */
export async function lookupMembership(
  deps: DirectoryDeps,
  input: InternalDirectoryMembershipRequest
): Promise<InternalDirectoryMembershipResponse> {
  const found = await deps.store.withOrganization(input.organizationId, async (scope) => {
    const membership = await scope.getMembershipByUser(input.userId)
    if (!membership) {
      return null
    }
    const organization = await scope.getOrganization()
    return organization ? { membership, status: organization.status } : null
  })
  if (!found) {
    return internalDirectoryMembershipResponseSchema.parse({ found: false })
  }
  return internalDirectoryMembershipResponseSchema.parse({
    found: true,
    membershipId: found.membership.id,
    role: found.membership.role,
    organizationStatus: found.status,
  })
}

/** Whether the Membership exists in the Organization and holds the Rep role. One primary-key read. */
export async function repCheck(
  deps: DirectoryDeps,
  input: InternalDirectoryRepCheckRequest
): Promise<InternalDirectoryRepCheckResponse> {
  const membership = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.getMembership(input.membershipId)
  )
  return internalDirectoryRepCheckResponseSchema.parse({ isRep: membership?.role === 'rep' })
}

/** Whether the Team exists in the Organization. One primary-key read. */
export async function teamCheck(
  deps: DirectoryDeps,
  input: InternalDirectoryTeamCheckRequest
): Promise<InternalDirectoryTeamCheckResponse> {
  const team = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.getTeam(input.teamId)
  )
  return internalDirectoryTeamCheckResponseSchema.parse({ exists: team !== null })
}

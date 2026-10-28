import {
  type InternalDirectoryMemberCheckRequest,
  type InternalDirectoryMemberCheckResponse,
  type InternalDirectoryMembershipRequest,
  type InternalDirectoryMembershipResponse,
  type InternalDirectoryRepCheckRequest,
  type InternalDirectoryRepCheckResponse,
  type InternalDirectoryRoleMembersRequest,
  type InternalDirectoryRoleMembersResponse,
  type InternalDirectoryTeamCheckRequest,
  type InternalDirectoryTeamCheckResponse,
  type InternalDirectoryTeamRepsRequest,
  type InternalDirectoryTeamRepsResponse,
  type InternalDirectoryTeamRingMembersRequest,
  type InternalDirectoryTeamRingMembersResponse,
  type InternalDirectoryTeamsOfRequest,
  type InternalDirectoryTeamsOfResponse,
  internalDirectoryMemberCheckResponseSchema,
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryRoleMembersResponseSchema,
  internalDirectoryTeamCheckResponseSchema,
  internalDirectoryTeamRepsResponseSchema,
  internalDirectoryTeamRingMembersResponseSchema,
  internalDirectoryTeamsOfResponseSchema,
  MAX_DIRECTORY_ROLE_MEMBERS,
  MAX_DIRECTORY_TEAM_REPS,
  MAX_DIRECTORY_TEAM_RING_MEMBERS,
  MAX_DIRECTORY_TEAMS_OF,
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

/**
 * The Rep Memberships on every Team the Manager is on, once each, in id order, at most
 * `MAX_DIRECTORY_TEAM_REPS`. Empty for a non-Manager, an unknown Membership or one of another
 * Organization. One bounded statement in a tenant-scoped transaction.
 */
export async function teamReps(
  deps: DirectoryDeps,
  input: InternalDirectoryTeamRepsRequest
): Promise<InternalDirectoryTeamRepsResponse> {
  const membershipIds = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.listManagedReps(input.membershipId, MAX_DIRECTORY_TEAM_REPS)
  )
  return internalDirectoryTeamRepsResponseSchema.parse({ membershipIds })
}

/**
 * The Membership ids of the Team's members who are Reps, in id order, at most
 * `MAX_DIRECTORY_TEAM_RING_MEMBERS`. Empty for an unknown Team or one of another Organization.
 * One bounded statement in a tenant-scoped transaction.
 */
export async function teamRingMembers(
  deps: DirectoryDeps,
  input: InternalDirectoryTeamRingMembersRequest
): Promise<InternalDirectoryTeamRingMembersResponse> {
  const membershipIds = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.listTeamReps(input.teamId, MAX_DIRECTORY_TEAM_RING_MEMBERS)
  )
  return internalDirectoryTeamRingMembersResponseSchema.parse({ membershipIds })
}

/** Whether the Membership exists in the Organization, whatever its role. One primary-key read. */
export async function memberCheck(
  deps: DirectoryDeps,
  input: InternalDirectoryMemberCheckRequest
): Promise<InternalDirectoryMemberCheckResponse> {
  const membership = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.getMembership(input.membershipId)
  )
  return internalDirectoryMemberCheckResponseSchema.parse({ isMember: membership !== null })
}

/**
 * One page of the Memberships holding the role, in id order, at most `MAX_DIRECTORY_ROLE_MEMBERS`;
 * `next` is the last id when more follow. One keyset statement that reads the page size plus one.
 */
export async function roleMembers(
  deps: DirectoryDeps,
  input: InternalDirectoryRoleMembersRequest
): Promise<InternalDirectoryRoleMembersResponse> {
  const rows = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.listMembers({
      role: input.role,
      after: input.after,
      limit: MAX_DIRECTORY_ROLE_MEMBERS + 1,
    })
  )
  const page = rows.slice(0, MAX_DIRECTORY_ROLE_MEMBERS).map((member) => member.id)
  return internalDirectoryRoleMembersResponseSchema.parse({
    membershipIds: page,
    next: rows.length > MAX_DIRECTORY_ROLE_MEMBERS ? (page.at(-1) ?? null) : null,
  })
}

/**
 * The ids of the Teams the Membership is on, in id order, at most `MAX_DIRECTORY_TEAMS_OF`. Empty
 * for an unknown Membership or one of another Organization. One bounded indexed statement.
 */
export async function teamsOf(
  deps: DirectoryDeps,
  input: InternalDirectoryTeamsOfRequest
): Promise<InternalDirectoryTeamsOfResponse> {
  const teamIds = await deps.store.withOrganization(input.organizationId, (scope) =>
    scope.listTeamIdsOf(input.membershipId, MAX_DIRECTORY_TEAMS_OF)
  )
  return internalDirectoryTeamsOfResponseSchema.parse({ teamIds })
}

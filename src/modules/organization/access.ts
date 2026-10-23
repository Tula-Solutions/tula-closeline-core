import type { MembershipId, Role } from 'tula-closeline-contract'
import { CORE_ERRORS, ERRORS } from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type Action, isWrite, mayAttempt } from '~/modules/member/permission'
import type { OrganizationRecord, OrganizationScope } from '~/ports/core-store'

/** What a write is decided on: the locked Organization and the caller's role right now. */
export type WriteAccess = {
  organization: OrganizationRecord
  /** The caller's role in the database, which may differ from the one in their token. */
  role: Role
  /** The caller's own Membership id, read in the same step as the role. */
  membershipId: MembershipId
}

/**
 * Opens the caller's Organization for a read, refusing in a fixed order: no such Organization, a
 * deleted one (everything is refused) and a role that may never do the action. The Organization
 * is the one in the verified token and so is the role: a read takes no lock and no extra query,
 * and a stale role exposes only what the caller could see a moment ago. Use
 * {@link openOrganizationForWrite} for any action that changes something.
 */
export async function openOrganization(
  scope: OrganizationScope,
  caller: Pick<Caller, 'role'>,
  action: Action
): Promise<OrganizationRecord> {
  const organization = await scope.getOrganization()
  if (!organization) {
    throw domainError(CORE_ERRORS['organization.not_found'])
  }
  if (organization.status === 'deleted') {
    throw domainError(CORE_ERRORS['organization.deleted'])
  }
  if (!mayAttempt(caller.role, action)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return organization
}

/**
 * Opens the caller's Organization for a write, on current data and not on the token: it locks the
 * Organization row first (the first lock in the db library's order), then reads the caller's own
 * Membership and uses its role. Refusals, in order: no such Organization, a deleted one, a caller
 * with no Membership or a role that may never do the action, and a suspended Organization.
 */
export async function openOrganizationForWrite(
  scope: OrganizationScope,
  caller: Pick<Caller, 'userId'>,
  action: Action
): Promise<WriteAccess> {
  const organization = await scope.lockOrganization()
  if (!organization) {
    throw domainError(CORE_ERRORS['organization.not_found'])
  }
  if (organization.status === 'deleted') {
    throw domainError(CORE_ERRORS['organization.deleted'])
  }
  const own = await scope.getMembershipByUser(caller.userId)
  if (!own || !mayAttempt(own.role, action)) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  if (isWrite(action) && organization.status === 'suspended') {
    throw domainError(CORE_ERRORS['organization.suspended'])
  }
  return { organization, role: own.role, membershipId: own.id }
}

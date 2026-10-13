import { CORE_ERRORS, ERRORS } from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type Action, isWrite, mayAttempt } from '~/modules/member/permission'
import type { OrganizationRecord, OrganizationScope } from '~/ports/core-store'

/**
 * Opens the caller's Organization for an action, refusing in a fixed order: no such Organization,
 * a deleted one (everything is refused), a role that may never do the action, and a write to a
 * suspended one (reads are allowed). The Organization is the one in the verified token.
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
  if (isWrite(action) && organization.status === 'suspended') {
    throw domainError(CORE_ERRORS['organization.suspended'])
  }
  return organization
}

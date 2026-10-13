import type { Organization } from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from './access'
import { toOrganizationResponse } from './schema'

/** What the Organization service needs from the container. */
export type OrganizationDeps = Pick<Container, 'store' | 'clock'>

/** Reads the caller's Organization. Any role may; a suspended Organization still reads. */
export async function read(deps: OrganizationDeps, caller: Caller): Promise<Organization> {
  return deps.store.withOrganization(caller.organizationId, async (scope) =>
    toOrganizationResponse(await openOrganization(scope, caller, 'organization.read'))
  )
}

/** Renames the caller's Organization. Owner and Admin only; a suspended Organization refuses. */
export async function rename(
  deps: OrganizationDeps,
  caller: Caller,
  name: string
): Promise<Organization> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'organization.rename')
    const renamed = await scope.renameOrganization(name, now)
    if (!renamed) {
      throw new Error('The Organization vanished inside its own transaction')
    }
    return toOrganizationResponse(renamed)
  })
}

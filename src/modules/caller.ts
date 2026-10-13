import type { OrganizationId, Role, UserId } from 'tula-closeline-contract'

/** Who is calling a public route, taken from the verified access token and nothing else. */
export type Caller = {
  userId: UserId
  organizationId: OrganizationId
  role: Role
}

import { type Organization, organizationSchema } from 'tula-closeline-contract'
import type { OrganizationRecord } from '~/ports/core-store'

/** The API shape of an Organization: the contract's schema applied to the record, never the row. */
export function toOrganizationResponse(record: OrganizationRecord): Organization {
  return organizationSchema.parse({
    id: record.id,
    name: record.name,
    region: record.region,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  })
}

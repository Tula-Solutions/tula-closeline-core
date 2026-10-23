import {
  type Prospect,
  type ProspectCompany,
  type ProspectCompanyId,
  prospectCompanyCursorSchema,
  prospectCompanySchema,
  prospectCursorSchema,
  prospectSchema,
} from 'tula-closeline-contract'
import type { FieldRecord, ProspectCompanyRecord, ProspectRecord } from '~/ports/core-store'

/** The cursor of a Prospect list: the creation time and id of the last item. */
export { prospectCompanyCursorSchema, prospectCursorSchema }

/** The prospect fields the API shows, in the order they are listed. */
const PROSPECT_FIELDS = ['firstName', 'lastName', 'jobTitle', 'email', 'phone', 'linkedinUrl']

/** The API shape of one stored field value. */
function toFieldValue(record: FieldRecord) {
  return {
    value: record.value,
    source: record.source,
    sourceRef: record.sourceRef,
    setAt: record.setAt.toISOString(),
    setByUserId: record.setByUserId,
  }
}

/** The API shape of a Prospect: the record with its current field values, through the contract's schema. */
export function toProspectResponse(
  record: ProspectRecord,
  fields: readonly FieldRecord[]
): Prospect {
  const shown: Record<string, ReturnType<typeof toFieldValue>> = {}
  for (const name of PROSPECT_FIELDS) {
    const field = fields.find((candidate) => candidate.field === name)
    if (field) {
      shown[name] = toFieldValue(field)
    }
  }
  return prospectSchema.parse({
    id: record.id,
    companyId: record.companyId,
    ownerMembershipId: record.ownerMembershipId,
    status: record.status,
    source: record.source,
    tags: record.tags,
    notes: record.notes,
    fields: shown,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  })
}

/** The API shape of a Prospect Company: the record with its current name and domain. */
export function toCompanyResponse(
  record: ProspectCompanyRecord,
  fields: readonly FieldRecord[]
): ProspectCompany {
  const name = fields.find((field) => field.field === 'name')
  const optional = (field: string) => {
    const found = fields.find((candidate) => candidate.field === field)
    return found ? { [field]: toFieldValue(found) } : {}
  }
  return prospectCompanySchema.parse({
    id: record.id,
    fields: {
      name: name
        ? toFieldValue(name)
        : {
            value: record.name,
            source: 'manual',
            sourceRef: null,
            setAt: record.createdAt.toISOString(),
            setByUserId: null,
          },
      ...optional('domain'),
      ...optional('industry'),
      ...optional('region'),
      ...optional('employeeCount'),
      ...optional('technologies'),
    },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  })
}

/** The ids of a list of Prospect Companies, for one field read. */
export function companyIds(records: readonly ProspectCompanyRecord[]): ProspectCompanyId[] {
  return records.map((record) => record.id)
}

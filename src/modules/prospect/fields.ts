import type { ProspectCompanyId, ProspectId, UserId } from 'tula-closeline-contract'
import type {
  FieldChange,
  FieldOwnerKind,
  FieldRecord,
  OrganizationScope,
  ProspectCompanyPatch,
  ProspectIdentityKind,
} from '~/ports/core-store'
import { decideFieldWrite, type FieldWrite } from './provenance'

/** The Prospect fields that identify a person, and the identity kind each one holds (ADR 0011). */
const IDENTITY_OF_FIELD: Readonly<Record<string, ProspectIdentityKind>> = {
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin',
}

/**
 * The company column change for an enrichment field's new value (`null` when the field was
 * cleared), or `undefined` for a field with no column. `employeeCount` is stored as a decimal
 * string and `technologies` as JSON text of a list; the columns hold a number and a list.
 */
function companyColumnPatch(field: string, value: string | null): ProspectCompanyPatch | undefined {
  switch (field) {
    case 'industry':
      return { industry: value }
    case 'region':
      return { region: value }
    case 'employeeCount':
      return { employeeCount: value === null ? null : Number(value) }
    case 'technologies':
      return { technologies: value === null ? null : (JSON.parse(value) as string[]) }
    default:
      return undefined
  }
}

/** Who and when a batch of field writes is made by. */
export type FieldWriteContext = { userId: UserId | null; at: Date }

/** What {@link writeFields} did: the fields whose current value changed or was cleared. */
export type FieldWriteResult = { changedFields: string[] }

/**
 * Applies writes to the fields of one Prospect or Prospect Company under the Source precedence
 * rules, keeps the identities of a Prospect and the columns of a Prospect Company in step with
 * their current values, and reports which fields changed. The caller must hold the Organization
 * lock and, for an existing owner, its row lock. The import and CRM tickets reuse this: they pass
 * their own `source` and `sourceRef`. A taken identity throws `ProspectIdentityTakenError`, which
 * rolls the whole transaction back.
 */
export async function writeFields(
  scope: OrganizationScope,
  kind: FieldOwnerKind,
  ownerId: string,
  writes: readonly FieldWrite[],
  context: FieldWriteContext
): Promise<FieldWriteResult> {
  if (writes.length === 0) {
    return { changedFields: [] }
  }
  const stored = await scope.listCurrentFields(kind, [ownerId])
  const current = new Map<string, FieldRecord>((stored.get(ownerId) ?? []).map((r) => [r.field, r]))
  const changes: FieldChange[] = []
  const changedFields: string[] = []
  for (const write of writes) {
    const decision = decideFieldWrite(current.get(write.field), write)
    if (decision.kind === 'unchanged') {
      continue
    }
    if (decision.kind === 'clear') {
      changes.push({ action: 'clear', field: write.field, at: context.at })
      changedFields.push(write.field)
      continue
    }
    if (write.value === null) {
      continue
    }
    const stamp = {
      field: write.field,
      value: write.value,
      source: write.source,
      sourceRef: write.source === 'manual' ? null : write.sourceRef,
      setByUserId: context.userId,
      at: write.at && write.at < context.at ? write.at : context.at,
    }
    if (decision.kind === 'set') {
      changes.push({ action: 'set', ...stamp })
      changedFields.push(write.field)
    } else {
      changes.push({ action: 'record', state: decision.state, ...stamp })
    }
  }
  if (changes.length === 0) {
    return { changedFields }
  }
  await scope.applyFieldChanges(kind, ownerId, changes)
  for (const change of changes) {
    if (change.action === 'record') {
      continue
    }
    const value = change.action === 'set' ? change.value : null
    if (kind === 'prospect') {
      const identity = IDENTITY_OF_FIELD[change.field]
      if (identity) {
        await scope.setProspectIdentity(ownerId as ProspectId, identity, value, context.at)
      }
    } else if (change.field === 'name' && value !== null) {
      await scope.updateProspectCompany(ownerId as ProspectCompanyId, { name: value }, context.at)
    } else if (change.field === 'domain') {
      await scope.updateProspectCompany(ownerId as ProspectCompanyId, { domain: value }, context.at)
    } else {
      const patch = companyColumnPatch(change.field, value)
      if (patch) {
        await scope.updateProspectCompany(ownerId as ProspectCompanyId, patch, context.at)
      }
    }
  }
  return { changedFields }
}

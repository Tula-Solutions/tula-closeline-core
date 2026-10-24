import {
  ENRICHMENT_ERRORS,
  type EnrichedFieldName,
  type EnrichedFieldWrite,
  type EnrichmentInputResponse,
  enrichmentInputResponseSchema,
  type OrganizationId,
  type ProspectId,
  userIdSchema,
  type WriteEnrichedFieldsRequest,
  type WriteEnrichedFieldsResponse,
  writeEnrichedFieldsResponseSchema,
} from 'tula-closeline-contract'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { idempotent } from '~/modules/idempotency/service'
import { writeFields as writeOwnerFields } from '~/modules/prospect/fields'
import { normaliseLinkedin } from '~/modules/prospect/normalise'
import { decideFieldWrite, type FieldWrite } from '~/modules/prospect/provenance'
import type { FieldOwnerKind, FieldRecord, OrganizationScope } from '~/ports/core-store'

/** What enrichment needs from the container. */
export type EnrichmentDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** The route name an enriched-fields write is stored under in the idempotency table. */
const WRITE_ROUTE = 'enrichment.write_fields'

/** Where an enrichable field lives: on the Prospect or on its Prospect Company, and under which stored name. */
const LOCATION: Readonly<Record<EnrichedFieldName, { kind: FieldOwnerKind; stored: string }>> = {
  firstName: { kind: 'prospect', stored: 'firstName' },
  lastName: { kind: 'prospect', stored: 'lastName' },
  jobTitle: { kind: 'prospect', stored: 'jobTitle' },
  linkedinUrl: { kind: 'prospect', stored: 'linkedinUrl' },
  email: { kind: 'prospect', stored: 'email' },
  companyName: { kind: 'company', stored: 'name' },
  companyDomain: { kind: 'company', stored: 'domain' },
  industry: { kind: 'company', stored: 'industry' },
  employeeCount: { kind: 'company', stored: 'employeeCount' },
  region: { kind: 'company', stored: 'region' },
  technologies: { kind: 'company', stored: 'technologies' },
}

const notFound = () => domainError(ENRICHMENT_ERRORS['enrichment.prospect_not_found'])

/** The Prospect, or `enrichment.prospect_not_found` for one that is missing, of another Organization or in a deleted one. */
async function openProspect(scope: OrganizationScope, prospectId: ProspectId, lock: boolean) {
  // A read must not take the Organization lock: it would queue behind every write.
  const organization = lock ? await scope.lockOrganization() : await scope.getOrganization()
  if (!organization || organization.status === 'deleted') {
    throw notFound()
  }
  const prospect = await scope.getProspect(prospectId, { kind: 'all' })
  if (!prospect) {
    throw notFound()
  }
  return prospect
}

/** The current field records of a Prospect and of its company, by stored name. */
async function currentFields(
  scope: OrganizationScope,
  prospectId: ProspectId,
  companyId: string | null
) {
  const prospect = (await scope.listCurrentFields('prospect', [prospectId])).get(prospectId)
  const company = companyId
    ? (await scope.listCurrentFields('company', [companyId])).get(companyId)
    : undefined
  return {
    prospect: new Map<string, FieldRecord>((prospect ?? []).map((r) => [r.field, r])),
    company: new Map<string, FieldRecord>((company ?? []).map((r) => [r.field, r])),
  }
}

/**
 * What core holds that outbound needs to look a Prospect up, and which enrichable fields already
 * have a value. The Organization is the caller's; a Prospect outside it is
 * `enrichment.prospect_not_found`.
 */
export async function getInput(
  deps: EnrichmentDeps,
  organizationId: OrganizationId,
  prospectId: ProspectId
): Promise<EnrichmentInputResponse> {
  return deps.store.withOrganization(organizationId, async (scope) => {
    const prospect = await openProspect(scope, prospectId, false)
    const fields = await currentFields(scope, prospectId, prospect.companyId)
    const heldValue = (name: EnrichedFieldName): string | null => {
      const where = LOCATION[name]
      return (
        (where.kind === 'prospect' ? fields.prospect : fields.company).get(where.stored)?.value ??
        null
      )
    }
    const names = Object.keys(LOCATION) as EnrichedFieldName[]
    return enrichmentInputResponseSchema.parse({
      prospectId,
      email: heldValue('email'),
      firstName: heldValue('firstName'),
      lastName: heldValue('lastName'),
      jobTitle: heldValue('jobTitle'),
      companyName: heldValue('companyName'),
      companyDomain: heldValue('companyDomain'),
      presentFields: names.filter((name) => heldValue(name) !== null),
    })
  })
}

/**
 * The text a field is stored as, or `undefined` when the provider's value cannot be stored for it
 * (it is then only suggested). Email and domain are lower-cased, a LinkedIn address is
 * normalised, a head count is a whole number and technologies are a JSON list of strings.
 */
function storable(field: EnrichedFieldName, raw: string): string | undefined {
  const text = raw.trim()
  if (text === '') {
    return undefined
  }
  switch (field) {
    case 'email':
      return text.toLowerCase()
    case 'companyDomain':
      return text.toLowerCase()
    case 'linkedinUrl':
      return normaliseLinkedin(text)
    case 'employeeCount':
      return /^\d{1,9}$/.test(text) ? String(Number(text)) : undefined
    case 'technologies': {
      const list = text.startsWith('[')
        ? safeList(text)
        : text.split(',').map((item) => item.trim())
      return list && list.length > 0 && list.every((item) => item !== '')
        ? JSON.stringify(list)
        : undefined
    }
    default:
      return text
  }
}

function safeList(text: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? (parsed as string[])
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Writes what an enrichment run found, under the Source `enrichment:<provider>` and ADR 0020's
 * precedence: a field that is empty or held by an earlier enrichment is `written`; one held by a
 * manual edit, an import, a CRM or a form is kept as `suggested` and the current value stays. A
 * value that cannot be stored (a company field on a Prospect with no company, an unusable value,
 * an email, LinkedIn address or domain another record holds) is `suggested` and not stored. All
 * writes are one transaction, idempotent on the Prospect and the run: a replay stores nothing and
 * returns the original results, whatever its body, for as long as the idempotency row lives (24 hours).
 */
export async function writeFields(
  deps: EnrichmentDeps,
  organizationId: OrganizationId,
  prospectId: ProspectId,
  request: WriteEnrichedFieldsRequest
): Promise<WriteEnrichedFieldsResponse> {
  const caller = { userId: userIdSchema.parse(INTERNAL_CALL_USER_ID), organizationId }
  return deps.store.withOrganization(organizationId, async (scope) => {
    // The key is reserved before the Organization is locked (the lock order); a Prospect that
    // is not found throws inside the work, which rolls the reservation back.
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: `${prospectId}:${request.runId}`,
        route: WRITE_ROUTE,
        request: { prospectId },
        status: 200,
        response: writeEnrichedFieldsResponseSchema,
      },
      async () => {
        const prospect = await openProspect(scope, prospectId, true)
        const now = deps.clock.now()
        const fields = await currentFields(scope, prospectId, prospect.companyId)
        const batches: Record<FieldOwnerKind, FieldWrite[]> = { prospect: [], company: [] }
        const results: WriteEnrichedFieldsResponse['results'] = []
        for (const item of request.fields) {
          const application = await plan(scope, prospect.companyId, fields, item, batches)
          results.push({ field: item.field, application })
        }
        const context = { userId: null, at: now }
        if (batches.prospect.length > 0) {
          await writeOwnerFields(scope, 'prospect', prospectId, batches.prospect, context)
        }
        if (batches.company.length > 0 && prospect.companyId) {
          await scope.lockProspectCompany(prospect.companyId)
          await writeOwnerFields(scope, 'company', prospect.companyId, batches.company, context)
        }
        return writeEnrichedFieldsResponseSchema.parse({ results })
      }
    )
    return answer.body
  })
}

/** Decides one field: queues its write when it can be applied and says what happened to it. */
async function plan(
  scope: OrganizationScope,
  companyId: string | null,
  fields: Awaited<ReturnType<typeof currentFields>>,
  item: EnrichedFieldWrite,
  batches: Record<FieldOwnerKind, FieldWrite[]>
): Promise<'written' | 'suggested'> {
  const where = LOCATION[item.field]
  const value = storable(item.field, item.value)
  if (value === undefined || (where.kind === 'company' && !companyId)) {
    return 'suggested'
  }
  const current = (where.kind === 'prospect' ? fields.prospect : fields.company).get(where.stored)
  const write: FieldWrite = {
    field: where.stored,
    value,
    source: `enrichment:${item.provider}`,
    sourceRef: null,
    at: new Date(item.obtainedAt),
  }
  const decision = decideFieldWrite(current, write)
  if (decision.kind === 'record') {
    batches[where.kind].push(write)
    return 'suggested'
  }
  if (decision.kind === 'unchanged') {
    return 'written'
  }
  if (await identityTaken(scope, item.field, value, companyId)) {
    return 'suggested'
  }
  batches[where.kind].push(write)
  return 'written'
}

/** Whether another record already holds an email, LinkedIn address or company domain. */
async function identityTaken(
  scope: OrganizationScope,
  field: EnrichedFieldName,
  value: string,
  companyId: string | null
): Promise<boolean> {
  if (field === 'email' || field === 'linkedinUrl') {
    const holder = await scope.findProspectByIdentity(
      field === 'email' ? 'email' : 'linkedin',
      value
    )
    return holder !== null
  }
  if (field === 'companyDomain') {
    const holder = await scope.findProspectCompany({ domain: value })
    return holder !== null && holder.id !== companyId
  }
  return false
}

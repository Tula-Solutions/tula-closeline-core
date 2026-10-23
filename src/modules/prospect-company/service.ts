import {
  type CreateProspectCompanyRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListProspectCompaniesQuery,
  type ListProspectCompaniesResponse,
  MAX_PROSPECT_FIELD_VALUE_LENGTH,
  PROSPECT_ERRORS,
  type ProspectCompany,
  type ProspectCompanyId,
  prospectCompanySchema,
  type UpdateProspectCompanyRequest,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { writeFields } from '~/modules/prospect/fields'
import type { FieldWrite } from '~/modules/prospect/provenance'
import { prospectCompanyCursorSchema, toCompanyResponse } from '~/modules/prospect/schema'
import { CompanyDomainTakenError } from '~/ports/core-store'

/** What the Prospect Company service needs from the container. */
export type CompanyDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** What a route that can be retried is given besides its request: the validated `Idempotency-Key`, if sent. */
export type CompanyCallOptions = { idempotencyKey?: string | undefined }

/** The Source of every company field these routes write (ADR 0020). */
const MANUAL = 'manual'

/**
 * The field writes for the enrichment fields of a request, each as `manual`: `industry`, `region`,
 * `employeeCount` (a decimal string) and `technologies` (JSON text). A field left out is not
 * written; `null` clears it. A technologies list whose JSON is over the limit is `request.invalid`,
 * so the database's check is never what refuses it.
 */
function enrichmentWrites(
  request: Pick<
    UpdateProspectCompanyRequest,
    'industry' | 'region' | 'employeeCount' | 'technologies'
  >
): FieldWrite[] {
  const writes: FieldWrite[] = []
  const add = (field: string, value: string | null) =>
    writes.push({ field, value, source: MANUAL, sourceRef: null })
  if (request.industry !== undefined) {
    add('industry', request.industry)
  }
  if (request.region !== undefined) {
    add('region', request.region)
  }
  if (request.employeeCount !== undefined) {
    add('employeeCount', request.employeeCount === null ? null : String(request.employeeCount))
  }
  if (request.technologies !== undefined) {
    const json = request.technologies === null ? null : JSON.stringify(request.technologies)
    if (json !== null && json.length > MAX_PROSPECT_FIELD_VALUE_LENGTH) {
      throw domainError(ERRORS['request.invalid'])
    }
    add('technologies', json)
  }
  return writes
}

/**
 * Maps the store's rule errors to the contract's codes. A domain another Prospect Company already
 * has is `request.invalid` for now: the contract has no code of its own for it.
 */
function asDomainError(error: unknown): unknown {
  return error instanceof CompanyDomainTakenError ? domainError(ERRORS['request.invalid']) : error
}

/** The company not-found answer: the same for a missing company and one in another Organization. */
function companyNotFound() {
  return domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'company' })
}

/**
 * Creates a Prospect Company with the Source `manual`. Any role. A domain another Prospect Company
 * already has is refused. With an `Idempotency-Key` the same request again returns the first
 * company (200) and creates nothing.
 */
export async function create(
  deps: CompanyDeps,
  caller: Caller,
  request: CreateProspectCompanyRequest,
  options: CompanyCallOptions = {}
): Promise<IdempotentAnswer<200 | 201, ProspectCompany>> {
  const now = deps.clock.now()
  try {
    const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'prospect_companies.create',
          request: { body: request },
          status: 201,
          response: prospectCompanySchema,
        },
        async () => {
          await openOrganizationForWrite(scope, caller, 'prospect_company.create')
          const enrichment = enrichmentWrites(request)
          const id = formatId('pco', crypto.randomUUID())
          const record = await scope.insertProspectCompany({
            id,
            name: request.name,
            domain: request.domain ?? null,
            industry: request.industry ?? null,
            region: request.region ?? null,
            employeeCount: request.employeeCount ?? null,
            technologies: request.technologies ?? null,
            now,
          })
          const writes: FieldWrite[] = [
            { field: 'name', value: request.name, source: MANUAL, sourceRef: null },
          ]
          if (request.domain !== undefined) {
            writes.push({ field: 'domain', value: request.domain, source: MANUAL, sourceRef: null })
          }
          writes.push(...enrichment)
          await writeFields(scope, 'company', id, writes, { userId: caller.userId, at: now })
          const fields = (await scope.listCurrentFields('company', [id])).get(id) ?? []
          return toCompanyResponse(record, fields)
        }
      )
    )
    return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
  } catch (error) {
    throw asDomainError(error)
  }
}

/** Reads one Prospect Company; one that does not exist or is in another Organization is `prospect.not_found`. Any role. */
export async function get(
  deps: Pick<CompanyDeps, 'store'>,
  caller: Caller,
  companyId: ProspectCompanyId
): Promise<ProspectCompany> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect_company.read')
    const record = await scope.getProspectCompany(companyId)
    if (!record) {
      throw companyNotFound()
    }
    const fields = (await scope.listCurrentFields('company', [record.id])).get(record.id) ?? []
    return toCompanyResponse(record, fields)
  })
}

/** Lists Prospect Companies, newest first, one page at a time (at most 100), optionally narrowed by `q` on name and domain. Any role. */
export async function list(
  deps: Pick<CompanyDeps, 'store'>,
  caller: Caller,
  query: ListProspectCompaniesQuery
): Promise<ListProspectCompaniesResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, prospectCompanyCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect_company.list')
    const rows = await scope.listProspectCompanies({
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.ids === undefined ? {} : { ids: query.ids }),
      ...(after === undefined
        ? {}
        : { after: { createdAt: new Date(after.createdAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const fields = await scope.listCurrentFields(
      'company',
      page.map((record) => record.id)
    )
    const last = page.at(-1)
    return {
      items: page.map((record) => toCompanyResponse(record, fields.get(record.id) ?? [])),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/**
 * Edits a Prospect Company; each field sent is written as `manual`, and `domain: null` clears the
 * domain. Any role. A request that changes nothing changes nothing, not even `updatedAt`.
 */
export async function update(
  deps: CompanyDeps,
  caller: Caller,
  companyId: ProspectCompanyId,
  request: UpdateProspectCompanyRequest
): Promise<ProspectCompany> {
  const now = deps.clock.now()
  try {
    return await deps.store.withOrganization(caller.organizationId, async (scope) => {
      await openOrganizationForWrite(scope, caller, 'prospect_company.update')
      const before = await scope.lockProspectCompany(companyId)
      if (!before) {
        throw companyNotFound()
      }
      const writes: FieldWrite[] = []
      if (request.name !== undefined) {
        writes.push({ field: 'name', value: request.name, source: MANUAL, sourceRef: null })
      }
      if (request.domain !== undefined) {
        writes.push({ field: 'domain', value: request.domain, source: MANUAL, sourceRef: null })
      }
      writes.push(...enrichmentWrites(request))
      const { changedFields } = await writeFields(scope, 'company', companyId, writes, {
        userId: caller.userId,
        at: now,
      })
      const record =
        changedFields.length > 0
          ? ((await scope.updateProspectCompany(companyId, {}, now)) ?? before)
          : before
      const fields = (await scope.listCurrentFields('company', [companyId])).get(companyId) ?? []
      return toCompanyResponse(record, fields)
    })
  } catch (error) {
    throw asDomainError(error)
  }
}

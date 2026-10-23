import {
  type CreateProspectRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListProspectsQuery,
  type ListProspectsResponse,
  type MembershipId,
  PROSPECT_ERRORS,
  type Prospect,
  type ProspectId,
  prospectSchema,
  type UpdateProspectRequest,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  CompanyDomainTakenError,
  MissingReferenceError,
  type OrganizationScope,
  type ProspectIdentityKind,
  ProspectIdentityTakenError,
  type ProspectPatch,
  type ProspectVisibility,
} from '~/ports/core-store'
import { createdEvent, enqueueEvents, type PendingEvent, updatedEvent } from './events'
import { writeFields } from './fields'
import { normaliseLinkedin, normalisePhone } from './normalise'
import type { FieldWrite } from './provenance'
import { prospectCursorSchema, toProspectResponse } from './schema'

/** What the Prospect service needs from the container. */
export type ProspectDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events'>

/** What a call is given besides its request: the request id the events carry, and the validated `Idempotency-Key`, if sent. */
export type ProspectCallOptions = { traceId: string; idempotencyKey?: string | undefined }

/** The Source of every field and Prospect these routes write (ADR 0020). */
const MANUAL = 'manual'

/** The fields a request may set, with the identity each one holds. */
const FIELD_NAMES = ['firstName', 'lastName', 'jobTitle', 'email', 'phone', 'linkedinUrl'] as const

/** The identity kind of each field that identifies a person (ADR 0011). */
const IDENTITY_OF: Readonly<Record<string, ProspectIdentityKind>> = {
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin',
}

/** Maps the store's rule errors to the contract's codes; any other error passes unchanged. */
function asDomainError(error: unknown): unknown {
  if (error instanceof MissingReferenceError) {
    return domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'company' })
  }
  if (error instanceof CompanyDomainTakenError) {
    return domainError(ERRORS['request.invalid'])
  }
  if (error instanceof ProspectIdentityTakenError) {
    return domainError(PROSPECT_ERRORS['prospect.duplicate_identity'], {
      identityKind: error.kind,
    })
  }
  return error
}

/**
 * What the caller may see, decided on the Membership and role in the database right now (not the
 * token): Owner and Admin see every Prospect, a Manager those they own and those of the Reps who
 * share a Team with them, a Rep their own. A caller with no Membership is refused.
 */
export async function visibilityOf(
  scope: OrganizationScope,
  caller: Pick<Caller, 'userId'>
): Promise<{ visibility: ProspectVisibility; membershipId: MembershipId }> {
  const own = await scope.getMembershipByUser(caller.userId)
  if (!own) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return { visibility: visibilityForRole(own.role, own.id), membershipId: own.id }
}

/** The visibility of a role for the Membership that holds it; shared by every module that acts on a Prospect. */
export function visibilityForRole(role: string, membershipId: MembershipId): ProspectVisibility {
  if (role === 'owner' || role === 'admin') {
    return { kind: 'all' }
  }
  if (role === 'manager') {
    return { kind: 'team', managerMembershipId: membershipId }
  }
  return { kind: 'owner', membershipId }
}

/** The not-found answer for a Prospect (shared): the same for one that does not exist, is not visible or is in another Organization. */
export function prospectNotFound() {
  return domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'prospect' })
}

/**
 * Turns the fields of a request into manual writes, normalising identities. `null` clears a field.
 * A value that cannot be normalised (a phone without a country code, a LinkedIn address that is
 * not one) is `request.invalid`.
 */
function toWrites(
  request: Partial<Record<(typeof FIELD_NAMES)[number], string | null | undefined>>
): FieldWrite[] {
  const writes: FieldWrite[] = []
  for (const field of FIELD_NAMES) {
    const raw = request[field]
    if (raw === undefined) {
      continue
    }
    let value: string | null | undefined = raw
    if (raw !== null) {
      if (field === 'email') {
        value = raw.trim().toLowerCase()
      } else if (field === 'phone') {
        value = normalisePhone(raw)
      } else if (field === 'linkedinUrl') {
        value = normaliseLinkedin(raw)
      }
    }
    if (value === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    writes.push({ field, value, source: MANUAL, sourceRef: null })
  }
  return writes
}

/**
 * Refuses a value another Prospect already holds as its email, phone or LinkedIn address. The
 * other Prospect's id is told only when the caller may see it. The Organization lock is held, so
 * nobody can take the value between this check and the write.
 */
async function assertIdentitiesFree(
  scope: OrganizationScope,
  writes: readonly FieldWrite[],
  visibility: ProspectVisibility,
  self: ProspectId | null
): Promise<void> {
  for (const write of writes) {
    const kind = IDENTITY_OF[write.field]
    if (!kind || write.value === null) {
      continue
    }
    const holder = await scope.findProspectByIdentity(kind, write.value)
    if (!holder || holder === self) {
      continue
    }
    const visible = await scope.getProspect(holder, visibility)
    throw domainError(PROSPECT_ERRORS['prospect.duplicate_identity'], {
      identityKind: kind,
      ...(visible ? { prospectId: holder } : {}),
    })
  }
}

/** Decides the owner of a new Prospect from the request and the caller's role (see {@link create}). */
async function chooseOwner(
  scope: OrganizationScope,
  role: string,
  own: MembershipId,
  named: MembershipId | undefined
): Promise<MembershipId | null> {
  if (role === 'rep' || role === 'manager') {
    if (named !== undefined && named !== own) {
      throw domainError(PROSPECT_ERRORS['prospect.forbidden_owner'])
    }
    return own
  }
  if (named === undefined) {
    return null
  }
  const member = await scope.lockMembership(named)
  if (!member || (member.role !== 'rep' && member.role !== 'manager')) {
    throw domainError(PROSPECT_ERRORS['prospect.forbidden_owner'])
  }
  return named
}

/**
 * Creates a Prospect with the Source `manual`. A Rep or Manager owns what they create and may not
 * name anyone else; Owner and Admin may name a Rep or Manager, or leave it unowned. Email, phone
 * and LinkedIn are normalised and must not belong to another Prospect (`prospect.duplicate_identity`).
 * With an `Idempotency-Key` the same request again returns the first Prospect (200) and creates
 * and publishes nothing. Publishes `prospect.created` once, through the outbox.
 */
export async function create(
  deps: ProspectDeps,
  caller: Caller,
  request: CreateProspectRequest,
  options: ProspectCallOptions
): Promise<IdempotentAnswer<200 | 201, Prospect>> {
  const now = deps.clock.now()
  let result: { answer: IdempotentAnswer<201, Prospect> }
  try {
    result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      // Created inside the callback: the store may run it again after a deadlock.
      const events: PendingEvent[] = []
      const answer = await idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'prospects.create',
          request: { body: request },
          status: 201,
          response: prospectSchema,
        },
        async () => {
          const access = await openOrganizationForWrite(scope, caller, 'prospect.create')
          const ownerMembershipId = await chooseOwner(
            scope,
            access.role,
            access.membershipId,
            request.ownerMembershipId
          )
          if (request.companyId && !(await scope.getProspectCompany(request.companyId))) {
            throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'company' })
          }
          const writes = toWrites(request)
          const visibility = visibilityForRole(access.role, access.membershipId)
          await assertIdentitiesFree(scope, writes, visibility, null)
          const id = formatId('prs', crypto.randomUUID())
          const record = await scope.insertProspect({
            id,
            companyId: request.companyId ?? null,
            ownerMembershipId,
            source: MANUAL,
            tags: request.tags ?? [],
            notes: request.notes ?? null,
            now,
          })
          await writeFields(scope, 'prospect', id, writes, { userId: caller.userId, at: now })
          const fields = (await scope.listCurrentFields('prospect', [id])).get(id) ?? []
          events.push(
            createdEvent({
              prospectId: id,
              companyId: record.companyId,
              ownerMembershipId: record.ownerMembershipId,
              source: MANUAL,
            })
          )
          return toProspectResponse(record, fields)
        }
      )
      if (!answer.replayed) {
        await enqueueEvents(scope, caller.organizationId, options.traceId, events)
      }
      return { answer }
    })
  } catch (error) {
    throw asDomainError(error)
  }
  const { answer } = result
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/** Reads one Prospect the caller may see; any other is `prospect.not_found`. Any role. */
export async function get(
  deps: Pick<ProspectDeps, 'store'>,
  caller: Caller,
  prospectId: ProspectId
): Promise<Prospect> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect.read')
    const { visibility } = await visibilityOf(scope, caller)
    const record = await scope.getProspect(prospectId, visibility)
    if (!record) {
      throw prospectNotFound()
    }
    const fields = (await scope.listCurrentFields('prospect', [record.id])).get(record.id) ?? []
    return toProspectResponse(record, fields)
  })
}

/**
 * Lists the Prospects the caller may see, newest first (in id order when `q` is set), one page at a
 * time (at most 100). Filters
 * narrow what the caller may see and never widen it. One extra row says whether another page
 * follows, and the current fields of the whole page come in one read. A `q` page may hold fewer
 * than `limit` items while `nextCursor` is present: the search reads a bounded number of windows.
 */
export async function list(
  deps: Pick<ProspectDeps, 'store'>,
  caller: Caller,
  query: ListProspectsQuery
): Promise<ListProspectsResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, prospectCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect.list')
    const { visibility } = await visibilityOf(scope, caller)
    const request = {
      visibility,
      ...(query.ownerMembershipId === undefined
        ? {}
        : { ownerMembershipId: query.ownerMembershipId }),
      ...(query.source === undefined ? {} : { source: query.source }),
      ...(query.companyId === undefined ? {} : { companyId: query.companyId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(after === undefined
        ? {}
        : { after: { createdAt: new Date(after.createdAt), id: after.id } }),
      limit: query.limit + 1,
    }
    // A `q` search reads a bounded number of windows, so its page can be short while more follow.
    const searched =
      query.q === undefined ? undefined : await scope.searchProspects({ ...request, q: query.q })
    const rows = searched ? searched.rows : await scope.listProspects(request)
    const page = rows.slice(0, query.limit)
    const fields = await scope.listCurrentFields(
      'prospect',
      page.map((record) => record.id)
    )
    const last = page.at(-1)
    const resumeAfter = rows.length > query.limit ? null : (searched?.resumeAfter ?? null)
    return {
      items: page.map((record) => toProspectResponse(record, fields.get(record.id) ?? [])),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : resumeAfter
            ? encodeCursor({ createdAt: new Date(0).toISOString(), id: resumeAfter })
            : null,
    }
  })
}

/**
 * Edits a Prospect the caller may see; every field written is `manual`, so a later import, CRM
 * sync or enrichment cannot overwrite it. A request that changes nothing changes nothing, not even
 * `updatedAt`, and publishes nothing; one that changes something publishes `prospect.updated` once.
 */
export async function update(
  deps: ProspectDeps,
  caller: Caller,
  prospectId: ProspectId,
  request: UpdateProspectRequest,
  options: ProspectCallOptions
): Promise<Prospect> {
  const now = deps.clock.now()
  let result: { body: Prospect }
  try {
    result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const events: PendingEvent[] = []
      const access = await openOrganizationForWrite(scope, caller, 'prospect.update')
      const visibility = visibilityForRole(access.role, access.membershipId)
      const before = await scope.lockProspect(prospectId, visibility)
      if (!before) {
        throw prospectNotFound()
      }
      const patch: ProspectPatch = {}
      if (request.companyId !== undefined && request.companyId !== before.companyId) {
        if (request.companyId !== null && !(await scope.getProspectCompany(request.companyId))) {
          throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'company' })
        }
        patch.companyId = request.companyId
      }
      if (request.status !== undefined && request.status !== before.status) {
        patch.status = request.status
      }
      if (
        request.tags !== undefined &&
        (request.tags.length !== before.tags.length ||
          request.tags.some((tag, index) => tag !== before.tags[index]))
      ) {
        patch.tags = request.tags
      }
      if (request.notes !== undefined && request.notes !== before.notes) {
        patch.notes = request.notes
      }
      const writes = toWrites(request)
      await assertIdentitiesFree(scope, writes, visibility, prospectId)
      const { changedFields } = await writeFields(scope, 'prospect', prospectId, writes, {
        userId: caller.userId,
        at: now,
      })
      const columnsChanged = Object.keys(patch).length > 0
      const record =
        columnsChanged || changedFields.length > 0
          ? ((await scope.updateProspect(prospectId, patch, now)) ?? before)
          : before
      if (columnsChanged || changedFields.length > 0) {
        events.push(
          updatedEvent({
            prospectId,
            changedFields: changedFields as (
              | 'email'
              | 'firstName'
              | 'jobTitle'
              | 'lastName'
              | 'linkedinUrl'
              | 'phone'
            )[],
            ownerChanged: false,
            companyChanged: patch.companyId !== undefined,
            statusChanged: patch.status !== undefined,
            source: MANUAL,
          })
        )
      }
      const fields = (await scope.listCurrentFields('prospect', [prospectId])).get(prospectId) ?? []
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
      return { body: toProspectResponse(record, fields) }
    })
  } catch (error) {
    throw asDomainError(error)
  }
  return result.body
}

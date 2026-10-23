import {
  CONSENT_ERRORS,
  type ConsentWording,
  type ConsentWordingId,
  type CreateConsentWordingRequest,
  consentWordingSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listConsentWordingsQuerySchema,
  type Page,
  type UpdateConsentWordingRequest,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { ConsentWordingLockedError, type OrganizationScope } from '~/ports/core-store'
import { consentWordingCursorSchema, toWordingResponse } from './schema'

/** What the wording service needs from the container. */
export type ConsentWordingDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** The query of a list of wordings. */
type ListQuery = z.infer<typeof listConsentWordingsQuerySchema>

/** What a write call is given besides its request: the validated `Idempotency-Key`, if sent. */
export type ConsentWordingCallOptions = { idempotencyKey?: string | undefined }

/** The `consent.not_found` of a wording the Organization does not have. */
function wordingNotFound() {
  return domainError(CONSENT_ERRORS['consent.not_found'], { resource: 'consent_wording' })
}

/** The wording `id`, or `consent.not_found`. */
async function requireWording(scope: OrganizationScope, id: ConsentWordingId) {
  const found = await scope.findConsentWording(id)
  if (!found) {
    throw wordingNotFound()
  }
  return found
}

/**
 * Writes a new Consent Wording, version 1, for the channels it covers. Owner and Admin only. With
 * an `Idempotency-Key` the same request again returns the first wording (200) and writes nothing.
 */
export async function create(
  deps: ConsentWordingDeps,
  caller: Caller,
  request: CreateConsentWordingRequest,
  options: ConsentWordingCallOptions
): Promise<IdempotentAnswer<200 | 201, ConsentWording>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'consent_wordings.create',
        request: { body: request },
        status: 201,
        response: consentWordingSchema,
      },
      async () => {
        await openOrganizationForWrite(scope, caller, 'consent_wording.create')
        const record = await scope.insertConsentWording({
          id: formatId('cwd', crypto.randomUUID()),
          version: 1,
          text: request.text,
          channels: request.channels,
          supersedesId: null,
          createdByUserId: caller.userId,
          now,
        })
        return toWordingResponse(record)
      }
    )
  )
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/**
 * Writes the next version of a wording: `version + 1`, naming the one it replaces. The old version
 * stays as it was. A wording a newer version already replaces is `request.conflict` (a lineage is
 * a line, not a tree); one that does not exist is `consent.not_found`. Owner and Admin only.
 */
export async function createVersion(
  deps: ConsentWordingDeps,
  caller: Caller,
  wordingId: ConsentWordingId,
  request: CreateConsentWordingRequest,
  options: ConsentWordingCallOptions
): Promise<IdempotentAnswer<200 | 201, ConsentWording>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'consent_wordings.version',
        request: { params: { wordingId }, body: request },
        status: 201,
        response: consentWordingSchema,
      },
      async () => {
        await openOrganizationForWrite(scope, caller, 'consent_wording.create')
        const parent = await requireWording(scope, wordingId)
        if (parent.superseded) {
          throw domainError(ERRORS['request.conflict'])
        }
        const record = await scope.insertConsentWording({
          id: formatId('cwd', crypto.randomUUID()),
          version: parent.version + 1,
          text: request.text,
          channels: request.channels,
          supersedesId: parent.id,
          createdByUserId: caller.userId,
          now,
        })
        return toWordingResponse(record)
      }
    )
  )
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/**
 * Edits a wording nothing references yet. Once a ledger event or a published form uses it, the
 * answer is `consent.wording_locked` (409) and the change is a new version. A wording that does
 * not exist is `consent.not_found`. Owner and Admin only.
 */
export async function update(
  deps: ConsentWordingDeps,
  caller: Caller,
  wordingId: ConsentWordingId,
  request: UpdateConsentWordingRequest
): Promise<ConsentWording> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'consent_wording.update')
    const current = await requireWording(scope, wordingId)
    if (current.locked) {
      throw domainError(CONSENT_ERRORS['consent.wording_locked'])
    }
    try {
      const changed = await scope.updateConsentWording(wordingId, {
        ...(request.text === undefined ? {} : { text: request.text }),
        ...(request.channels === undefined ? {} : { channels: request.channels }),
      })
      if (!changed) {
        throw wordingNotFound()
      }
      return toWordingResponse(changed)
    } catch (error) {
      // The database trigger is the backstop for a lock that fell between the read and the write.
      if (error instanceof ConsentWordingLockedError) {
        throw domainError(CONSENT_ERRORS['consent.wording_locked'])
      }
      throw error
    }
  })
}

/** Reads one wording with its version and whether it is locked. Any role. */
export async function get(
  deps: Pick<ConsentWordingDeps, 'store'>,
  caller: Caller,
  wordingId: ConsentWordingId
): Promise<ConsentWording> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent_wording.read')
    return toWordingResponse(await requireWording(scope, wordingId))
  })
}

/** Lists the wordings, newest first, one page at a time (at most 100). Any role. */
export async function list(
  deps: Pick<ConsentWordingDeps, 'store'>,
  caller: Caller,
  query: ListQuery
): Promise<Page<ConsentWording>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, consentWordingCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent_wording.read')
    const rows = await scope.listConsentWordings({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after: { at: new Date(after.at), id: after.id } }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toWordingResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

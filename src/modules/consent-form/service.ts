import {
  CONSENT_ERRORS,
  type ConsentForm,
  type ConsentFormId,
  type CreateConsentFormRequest,
  consentFormSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listConsentFormsQuerySchema,
  type Page,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { OrganizationScope } from '~/ports/core-store'
import { consentFormCursorSchema, toFormResponse } from './schema'

/** What the form service needs from the container. */
export type ConsentFormDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** The query of a list of forms. */
type ListQuery = z.infer<typeof listConsentFormsQuerySchema>

/** What a write call is given besides its request: the validated `Idempotency-Key`, if sent. */
export type ConsentFormCallOptions = { idempotencyKey?: string | undefined }

/** The bytes of randomness in a link token: 256 bits, 43 characters in base64url. */
const TOKEN_BYTES = 32

/** A new unguessable link token. */
function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))).toString('base64url')
}

/** The form `id`, or `consent.not_found`. */
async function requireForm(scope: OrganizationScope, id: ConsentFormId) {
  const found = await scope.findConsentForm(id)
  if (!found) {
    throw domainError(CONSENT_ERRORS['consent.not_found'], { resource: 'consent_form' })
  }
  return found
}

/** The wording `id`, or `consent.not_found`; the form's channels must be ones it covers. */
async function requireCoveringWording(
  scope: OrganizationScope,
  wordingId: CreateConsentFormRequest['wordingId'],
  channels: CreateConsentFormRequest['channels']
) {
  const wording = await scope.findConsentWording(wordingId)
  if (!wording) {
    throw domainError(CONSENT_ERRORS['consent.not_found'], { resource: 'consent_wording' })
  }
  if (!channels.every((channel) => wording.channels.includes(channel))) {
    throw domainError(ERRORS['request.invalid'], { field: 'channels' })
  }
  return wording
}

/**
 * Creates a draft hosted consent form from a wording and the channels it offers (a subset of the
 * wording's). Owner and Admin only. With an `Idempotency-Key` the same request again returns the
 * first form (200).
 */
export async function create(
  deps: ConsentFormDeps,
  caller: Caller,
  request: CreateConsentFormRequest,
  options: ConsentFormCallOptions
): Promise<IdempotentAnswer<200 | 201, ConsentForm>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'consent_forms.create',
        request: { body: request },
        status: 201,
        response: consentFormSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'consent_form.create')
        await requireCoveringWording(scope, request.wordingId, request.channels)
        const record = await scope.insertConsentForm({
          id: formatId('cfm', crypto.randomUUID()),
          wordingId: request.wordingId,
          name: request.name,
          channels: request.channels,
          createdByUserId: caller.userId,
          now,
        })
        return toFormResponse(record, access.role)
      }
    )
  )
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/**
 * Publishes a draft: it gets its link token and its wording locks. Anything but a draft is
 * `request.conflict`. Owner and Admin only.
 */
export async function publish(
  deps: ConsentFormDeps,
  caller: Caller,
  formId: ConsentFormId
): Promise<ConsentForm> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'consent_form.publish')
    const form = await requireForm(scope, formId)
    if (form.state !== 'draft') {
      throw domainError(ERRORS['request.conflict'])
    }
    await requireCoveringWording(scope, form.wordingId, form.channels)
    const published = await scope.publishConsentForm(formId, { token: newToken(), now })
    if (!published) {
      throw domainError(ERRORS['request.conflict'])
    }
    return toFormResponse(published, access.role)
  })
}

/** Closes a published form: its link stops accepting submissions. Anything else is `request.conflict`. */
export async function close(
  deps: ConsentFormDeps,
  caller: Caller,
  formId: ConsentFormId
): Promise<ConsentForm> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'consent_form.close')
    const form = await requireForm(scope, formId)
    if (form.state !== 'published') {
      throw domainError(ERRORS['request.conflict'])
    }
    const closed = await scope.closeConsentForm(formId, now)
    if (!closed) {
      throw domainError(ERRORS['request.conflict'])
    }
    return toFormResponse(closed, access.role)
  })
}

/** Reads one form. Any role; the link token is shown to Owner and Admin only. */
export async function get(
  deps: Pick<ConsentFormDeps, 'store'>,
  caller: Caller,
  formId: ConsentFormId
): Promise<ConsentForm> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent_form.read')
    return toFormResponse(await requireForm(scope, formId), caller.role)
  })
}

/** Lists the forms, newest first, one page at a time (at most 100), optionally of one state. */
export async function list(
  deps: Pick<ConsentFormDeps, 'store'>,
  caller: Caller,
  query: ListQuery
): Promise<Page<ConsentForm>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, consentFormCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent_form.read')
    const rows = await scope.listConsentForms({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after: { at: new Date(after.at), id: after.id } }),
      ...(query.state === undefined ? {} : { state: query.state }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => toFormResponse(row, caller.role)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

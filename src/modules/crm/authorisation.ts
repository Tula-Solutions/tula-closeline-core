import {
  CRM_ERRORS,
  type CrmProvider,
  organizationIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { packSealed, unpackSealed } from '~/modules/calendar/schema'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { SecretContext } from '~/ports/secret-box'
import * as Crm from './service'

/** What the authorisation flow needs from the container. */
export type CrmAuthorisationDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'secretBox' | 'crmProviders' | 'env'
>

/** How long a consent may take between the start and the callback. */
const STATE_TTL_MS = 10 * 60 * 1000

/** The answer of the start route: where to send the Admin, and until when the state works. */
const authorisationAnswer = z.strictObject({ authorisationUrl: z.string(), expiresAt: z.string() })

/** The sealed part of a `state`. */
const statePayload = z.strictObject({
  provider: z.string(),
  expiresAt: z.number(),
  nonce: z.string(),
})

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

const stateContext = (organizationId: Caller['organizationId'], userId: string): SecretContext => ({
  organizationId,
  connectionId: userId,
  purpose: 'crm_state',
})

/** Core's own callback address for a provider, or `null` when `CORE_PUBLIC_URL` is not set. */
export function redirectUriOf(env: Container['env'], provider: CrmProvider): string | null {
  return env.CORE_PUBLIC_URL
    ? new URL(`/v1/public/crm/${provider}/callback`, env.CORE_PUBLIC_URL).toString()
    : null
}

/**
 * Starts the OAuth flow: answers the CRM's sign-in address with a `state` sealed to this Admin and
 * this Organization that expires in ten minutes. Read scopes only unless `writeBack`. Nothing is
 * stored: the CRM's single-use code is what stops a replay. A provider that is not configured is
 * `crm.authorisation_failed`. The same `Idempotency-Key` answers the same address. Owner and Admin.
 */
export async function start(
  deps: CrmAuthorisationDeps,
  caller: Caller,
  provider: CrmProvider,
  request: { writeBack: boolean },
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<201, z.infer<typeof authorisationAnswer>>> {
  const crm = deps.crmProviders[provider]
  const redirectUri = redirectUriOf(deps.env, provider)
  if (!crm || !redirectUri || !deps.secretBox.configured) {
    throw domainError(CRM_ERRORS['crm.authorisation_failed'])
  }
  // A caller who may not connect is refused before a KMS call is made for them.
  await deps.store.withOrganization(caller.organizationId, (scope) =>
    openOrganization(scope, caller, 'crm.connect')
  )
  const expiresAt = deps.clock.now().getTime() + STATE_TTL_MS
  const sealed = await deps.secretBox.seal(
    JSON.stringify({ provider, expiresAt, nonce: crypto.randomUUID() }),
    stateContext(caller.organizationId, caller.userId)
  )
  const prefix = base64url(new TextEncoder().encode(`${caller.organizationId} ${caller.userId}`))
  const state = `${prefix}.${base64url(packSealed(sealed))}`
  const body = {
    authorisationUrl: crm.authorisationUrl({
      redirectUri,
      state,
      scopeLevel: request.writeBack ? 'read_write' : 'read',
    }),
    expiresAt: new Date(expiresAt).toISOString(),
  }
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'crm.authorise',
        request: { provider, writeBack: request.writeBack },
        status: 201,
        response: authorisationAnswer,
      },
      async () => {
        await openOrganizationForWrite(scope, caller, 'crm.connect')
        return body
      }
    )
  )
}

const MAX_STATE_LENGTH = 1024

/** The Admin and Organization a `state` names, once it opens, is unexpired and is for this provider. */
async function openState(
  deps: CrmAuthorisationDeps,
  provider: CrmProvider,
  state: string
): Promise<{ organizationId: Caller['organizationId']; userId: Caller['userId'] } | null> {
  const [prefix, sealedPart, ...rest] = state.split('.')
  // A real state is about 300 characters; an oversized one never reaches the key service.
  if (!prefix || !sealedPart || rest.length > 0 || state.length > MAX_STATE_LENGTH) {
    return null
  }
  const names = Buffer.from(prefix, 'base64url').toString('utf8').split(' ')
  const organizationId = organizationIdSchema.safeParse(names[0])
  const userId = userIdSchema.safeParse(names[1])
  const unsealed = unpackSealed(new Uint8Array(Buffer.from(sealedPart, 'base64url')))
  if (names.length !== 2 || !organizationId.success || !userId.success || !unsealed) {
    return null
  }
  try {
    // The names are bound into the seal, so a state spliced onto another Organization or Admin does not open.
    const opened = await deps.secretBox.open(
      unsealed,
      stateContext(organizationId.data, userId.data)
    )
    const payload = statePayload.parse(JSON.parse(opened))
    if (payload.provider !== provider || payload.expiresAt <= deps.clock.now().getTime()) {
      return null
    }
    return { organizationId: organizationId.data, userId: userId.data }
  } catch {
    return null
  }
}

/** What the browser is sent back to the portal with. */
export type CallbackOutcome = 'connected' | 'denied'

/**
 * Finishes the OAuth flow. A `state` that is tampered with, expired, for another provider,
 * Organization or Admin, or whose Admin no longer may connect, is one generic
 * `crm.authorisation_failed`, as is a refused code or a CRM account another Organization holds.
 * A denied consent with a valid state is `denied`, not an error. Neither code nor state is logged.
 */
export async function callback(
  deps: CrmAuthorisationDeps,
  provider: CrmProvider,
  query: { code?: string | undefined; state: string; error?: string | undefined },
  options: { traceId: string }
): Promise<CallbackOutcome> {
  const failed = () => domainError(CRM_ERRORS['crm.authorisation_failed'])
  const who = await openState(deps, provider, query.state)
  const redirectUri = redirectUriOf(deps.env, provider)
  if (!who || !redirectUri) {
    throw failed()
  }
  if (query.code === undefined) {
    return 'denied'
  }
  const membership = await deps.store.withOrganization(who.organizationId, (scope) =>
    scope.getMembershipByUser(who.userId)
  )
  if (!membership) {
    throw failed()
  }
  try {
    await Crm.connect(
      deps,
      { userId: who.userId, organizationId: who.organizationId, role: membership.role },
      { provider, code: query.code, redirectUri },
      options
    )
  } catch (error) {
    // A public route says one thing for every refusal; only a bug or an outage is left to surface.
    throw error instanceof AppError && error.status < 500 ? failed() : error
  }
  return 'connected'
}

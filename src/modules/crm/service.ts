import {
  CORE_ERRORS,
  CRM_ERRORS,
  type CrmConnectionStatus,
  type CrmProvider,
  type crmConnectionIdSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listCrmConnectionsQuerySchema,
  type listCrmConnectionsResponseSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  crmConnectedEvent,
  crmDisconnectedEvent,
  enqueueEvents,
  type PendingEvent,
} from '~/modules/prospect/events'
import { CrmAccountTakenError } from '~/ports/core-store'
import { MAX_CRM_SEALED_TOKEN_BYTES } from '~/ports/secret-box'
import { crmCursorSchema, toCrmConnectionResponse, toCrmStatusResponse } from './schema'

/** The query of the list route. */
type ListCrmConnectionsQuery = z.infer<typeof listCrmConnectionsQuerySchema>

/** The answer of the list route. */
type CrmConnectionPage = z.infer<typeof listCrmConnectionsResponseSchema>

/** What the CRM service needs from the container. */
export type CrmDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'secretBox' | 'crmProviders'
>

/** What a call is given besides its request: the request id the events carry, and the validated `Idempotency-Key`. */
export type CrmCallOptions = { traceId: string; idempotencyKey?: string | undefined }

/** The id of a connection, as the type the store takes. */
type CrmConnectionId = z.infer<typeof crmConnectionIdSchema>

/** The time the CRM call that exchanges a code may take. */
const EXCHANGE_TIMEOUT_MS = 10_000

/** Lists the Organization's CRM connections, one page at a time. Owner, Admin and Manager. */
export async function list(
  deps: Pick<CrmDeps, 'store'>,
  caller: Caller,
  query: ListCrmConnectionsQuery
): Promise<CrmConnectionPage> {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, crmCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.read')
    const rows = await scope.listCrmConnections({
      ...(after === undefined ? {} : { afterId: after.id }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toCrmConnectionResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor({ id: last.id }) : null,
    }
  })
}

/**
 * Reads the status of one provider. A provider the Organization never connected is the state
 * `not_connected`, an answer and not an error. No token is read: only the metadata columns.
 * Owner, Admin and Manager.
 */
export async function status(
  deps: Pick<CrmDeps, 'store'>,
  caller: Caller,
  provider: CrmProvider
): Promise<CrmConnectionStatus> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'crm.read')
    return toCrmStatusResponse(provider, await scope.getCrmConnection(provider))
  })
}

/**
 * Disconnects a provider: the stored tokens are deleted with the connection, in one statement,
 * and `crm.disconnected` is written to the outbox once, in the same transaction. A provider with no connection is
 * `crm.not_connected`. A repeat with the same `Idempotency-Key` answers 204 again and publishes
 * nothing. Owner and Admin. Nothing is revoked at the CRM yet, since nothing calls a CRM yet.
 */
export async function disconnect(
  deps: CrmDeps,
  caller: Caller,
  provider: CrmProvider,
  options: CrmCallOptions
): Promise<IdempotentAnswer<204, Record<string, never>>> {
  const now = deps.clock.now()
  const result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    const events: PendingEvent[] = []
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'crm.disconnect',
        request: { provider },
        status: 204,
        response: z.strictObject({}),
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'crm.disconnect')
        const removed = await scope.deleteCrmConnection(provider)
        if (!removed) {
          throw domainError(CRM_ERRORS['crm.not_connected'])
        }
        events.push(
          crmDisconnectedEvent({
            connectionId: removed.id,
            provider: removed.provider,
            disconnectedByMembershipId: access.membershipId,
            disconnectedAt: now.toISOString(),
          })
        )
        return {}
      }
    )
    if (!answer.replayed) {
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    }
    return { answer }
  })
  return result.answer
}

/** What the OAuth callback hands the service once the user approved the connection. */
export type ConnectRequest = {
  provider: CrmProvider
  code: string
  redirectUri: string
}

/**
 * Connects a provider with the code its callback returned: exchanges it at the CRM, seals the
 * access and refresh tokens (bound to the Organization, the connection and the purpose) and stores
 * only the sealed bytes. Connecting again to the same CRM account replaces the grant and keeps the connection's id; a different account deletes the old connection and starts a new one. A
 * provider that is not configured, a refused code and a CRM account another Organization already
 * holds are all `crm.authorisation_failed`. Publishes `crm.connected`, and first `crm.disconnected` for the old id when the account is replaced. Owner and Admin. There is no
 * public route for it yet: the authorisation start and callback arrive with the next ticket.
 */
export async function connect(
  deps: CrmDeps,
  caller: Caller,
  request: ConnectRequest,
  options: Pick<CrmCallOptions, 'traceId'>
): Promise<CrmConnectionStatus> {
  const failed = () => domainError(CRM_ERRORS['crm.authorisation_failed'])
  const crm = deps.crmProviders[request.provider]
  // Neither a missing provider nor a SecretBox with no key service may spend the single-use code.
  if (!crm || !deps.secretBox.configured) {
    throw failed()
  }
  // A caller who may not connect, or an Organization that may not change, is refused before the
  // single-use code is spent at the CRM. This read takes no lock; the write re-checks on current data.
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const organization = await openOrganization(scope, caller, 'crm.connect')
    if (organization.status === 'suspended') {
      throw domainError(CORE_ERRORS['organization.suspended'])
    }
  })
  // The exchange is a call to a third party: it runs before the transaction, so no lock or
  // connection is held while it waits, and the role is checked again inside.
  const grant = await crm
    .exchangeCode(request.code, request.redirectUri, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS))
    .catch(() => {
      throw failed()
    })
  const now = deps.clock.now()
  // A Postgres store reports the taken account when the transaction ends, so the catch is out here.
  const result = await deps.store
    .withOrganization(caller.organizationId, async (scope) => {
      const events: PendingEvent[] = []
      const access = await openOrganizationForWrite(scope, caller, 'crm.connect')
      const existing = await scope.getCrmConnection(request.provider)
      // A different CRM account is a new connection: its mapping, runs and sync position belong to
      // the old account, so they are deleted with it (by the foreign keys) and the id is new.
      const sameAccount = existing?.externalAccountId === grant.externalAccountId
      if (existing && !sameAccount) {
        const removed = await scope.deleteCrmConnection(request.provider)
        if (removed) {
          // Consumers keyed on the old id hear it is gone, before they hear of the new one.
          events.push(
            crmDisconnectedEvent({
              connectionId: removed.id,
              provider: removed.provider,
              disconnectedByMembershipId: access.membershipId,
              disconnectedAt: now.toISOString(),
            })
          )
        }
      }
      const connectionId: CrmConnectionId =
        existing && sameAccount ? existing.id : formatId('crn', crypto.randomUUID())
      const context = { organizationId: caller.organizationId, connectionId }
      const sealedAccess = await deps.secretBox.seal(grant.accessToken, {
        ...context,
        purpose: 'access_token',
      })
      const sealedRefresh =
        grant.refreshToken === null
          ? null
          : await deps.secretBox.seal(grant.refreshToken, { ...context, purpose: 'refresh_token' })
      // The database holds one key id for both tokens, so both must have been sealed under it.
      if (sealedRefresh !== null && sealedRefresh.keyId !== sealedAccess.keyId) {
        throw new Error('the SecretBox sealed the two tokens under different keys')
      }
      if (
        sealedAccess.ciphertext.byteLength > MAX_CRM_SEALED_TOKEN_BYTES ||
        (sealedRefresh !== null && sealedRefresh.ciphertext.byteLength > MAX_CRM_SEALED_TOKEN_BYTES)
      ) {
        throw failed()
      }
      const record = await scope.upsertCrmConnection({
        id: connectionId,
        provider: request.provider,
        externalAccountId: grant.externalAccountId,
        accountLabel: grant.accountLabel,
        scopeLevel: grant.scopeLevel,
        connectedByMembershipId: access.membershipId,
        accessTokenSealed: sealedAccess.ciphertext,
        refreshTokenSealed: sealedRefresh?.ciphertext ?? null,
        tokenKeyId: sealedAccess.keyId,
        accessTokenExpiresAt: grant.accessTokenExpiresAt,
        now,
      })
      events.push(
        crmConnectedEvent({
          connectionId: record.id,
          provider: record.provider,
          connectedByMembershipId: record.connectedByMembershipId,
          connectedAt: record.connectedAt.toISOString(),
        })
      )
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
      return { body: toCrmStatusResponse(request.provider, record) }
    })
    .catch((error: unknown) => {
      throw error instanceof CrmAccountTakenError ? failed() : error
    })
  return result.body
}

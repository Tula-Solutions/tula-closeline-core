import {
  APIKEY_ERRORS,
  type ApiKey,
  apiKeySchema,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
  createApiKeyResponseSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listApiKeysQuerySchema,
  type listApiKeysResponseSchema,
  type Role,
  type verifyApiKeyRequestSchema,
  verifyApiKeyResponseSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { apiKeyCursorSchema, toApiKeyCursor, toApiKeyResponse } from './schema'
import {
  API_KEY_RATE_LIMIT,
  API_KEY_RATE_WINDOW_SECONDS,
  displayPrefix,
  generateSecret,
  hashesEqual,
  hashSecret,
} from './secret'

/** What the API key service needs from the container. */
export type ApiKeyDeps = Pick<Container, 'store' | 'clock' | 'logger'>

type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>
type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>
type VerifyApiKeyRequest = z.infer<typeof verifyApiKeyRequestSchema>
type VerifyApiKeyResponse = z.infer<typeof verifyApiKeyResponseSchema>

/** The call a mutating API key route is given besides its request: the required key. */
export type ApiKeyCallOptions = { idempotencyKey?: string | undefined }

/** A higher number is a more powerful role. */
const ROLE_RANK: Readonly<Record<Role, number>> = { rep: 0, manager: 1, admin: 2, owner: 3 }

/**
 * Creates a key. Owner and Admin only; the role ceiling may not be above the creator's own role
 * (`apikey.scope_not_allowed`), and an expiry must be in the future. The secret is made here,
 * only its SHA-256 and display prefix are stored, and it is in this answer alone: the stored
 * (replayed) answer holds `secret: null`, so a replay is a 200 with no secret.
 */
export async function create(
  deps: ApiKeyDeps,
  caller: Caller,
  request: CreateApiKeyRequest,
  options: ApiKeyCallOptions
): Promise<IdempotentAnswer<200 | 201, CreateApiKeyResponse>> {
  const now = deps.clock.now()
  const secret = generateSecret()
  const expiresAt = request.expiresAt === null ? null : new Date(request.expiresAt)
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent<201, CreateApiKeyResponse>(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'apikeys.create',
        request: { body: request },
        status: 201,
        response: createApiKeyResponseSchema,
      },
      async () => {
        const { role, membershipId } = await openOrganizationForWrite(
          scope,
          caller,
          'api_key.create'
        )
        if (ROLE_RANK[request.roleCeiling] > ROLE_RANK[role]) {
          throw domainError(APIKEY_ERRORS['apikey.scope_not_allowed'])
        }
        if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
          throw domainError(ERRORS['request.invalid'])
        }
        const record = await scope.insertApiKey({
          id: formatId('akey', crypto.randomUUID()),
          name: request.name,
          prefix: displayPrefix(secret),
          secretHash: hashSecret(secret),
          scopes: request.scopes,
          roleCeiling: request.roleCeiling,
          expiresAt,
          createdByMembershipId: membershipId,
          createdAt: now,
        })
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId },
          action: 'api_key.created',
          subject: { type: 'api_key', id: record.id },
          metadata: { role_ceiling: record.roleCeiling, scope_count: record.scopes.length },
        })
        return { ...toApiKeyResponse(record), secret: null }
      }
    )
  )
  return answer.replayed
    ? { status: 200, body: answer.body, replayed: true }
    : { status: 201, body: { ...answer.body, secret }, replayed: false }
}

/** One page of the Organization's keys, newest first. Owner and Admin. Never holds a secret. */
export async function list(
  deps: Pick<ApiKeyDeps, 'store'>,
  caller: Caller,
  query: ListApiKeysQuery
): Promise<ListApiKeysResponse> {
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, apiKeyCursorSchema)
  if (query.cursor !== undefined && cursor === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'api_key.list')
    // One extra row says whether another page follows without a count.
    const rows = await scope.listApiKeys({
      includeRevoked: query.includeRevoked === true,
      ...(cursor === undefined
        ? {}
        : { after: { createdAt: new Date(cursor.createdAt), id: cursor.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toApiKeyResponse),
      nextCursor: rows.length > query.limit && last ? encodeCursor(toApiKeyCursor(last)) : null,
    }
  })
}

/**
 * Revokes a key. Owner and Admin. A key of another Organization is `apikey.not_found`; a key that
 * is already revoked answers 200 with the same key and its first revocation time.
 */
export async function revoke(
  deps: ApiKeyDeps,
  caller: Caller,
  apiKeyId: ApiKey['id'],
  options: ApiKeyCallOptions
): Promise<IdempotentAnswer<200, ApiKey>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'apikeys.revoke',
        request: { params: { apiKeyId } },
        status: 200,
        response: apiKeySchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(scope, caller, 'api_key.revoke')
        const existing = await scope.getApiKey(apiKeyId)
        if (!existing) {
          throw domainError(APIKEY_ERRORS['apikey.not_found'])
        }
        if (existing.revokedAt !== null) {
          return toApiKeyResponse(existing)
        }
        const revoked = await scope.revokeApiKey(apiKeyId, now)
        if (!revoked) {
          throw domainError(APIKEY_ERRORS['apikey.not_found'])
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId },
          action: 'api_key.revoked',
          subject: { type: 'api_key', id: revoked.id },
          metadata: { role_ceiling: revoked.roleCeiling, scope_count: revoked.scopes.length },
        })
        return toApiKeyResponse(revoked)
      }
    )
  )
}

/** The seconds until the current fixed rate window ends, at least 1. */
function secondsToNextWindow(now: Date): number {
  const windowMs = API_KEY_RATE_WINDOW_SECONDS * 1000
  return Math.max(1, Math.ceil((windowMs - (now.getTime() % windowMs)) / 1000))
}

/**
 * Checks a presented secret for auth's token exchange (internal). The hash finds the key before
 * any Organization is known; inside that Organization the stored hash is compared again in
 * constant time. An unknown or malformed secret is `apikey.invalid`; a revoked or expired key, or
 * one of an Organization that is not active, is `apikey.revoked`. A good use is counted against the
 * key (and stamps `lastUsedAt`); past the limit the answer is `apikey.rate_limited`, thrown after
 * the transaction commits so the count stays. The Organization is the key's, never the caller's,
 * and the secret is neither logged nor returned.
 */
export async function verify(
  deps: ApiKeyDeps,
  request: VerifyApiKeyRequest
): Promise<VerifyApiKeyResponse> {
  const now = deps.clock.now()
  const presented = hashSecret(request.secret)
  const location = await deps.store.apiKeyForHash(presented)
  if (!location) {
    throw domainError(APIKEY_ERRORS['apikey.invalid'])
  }
  const outcome = await deps.store.withOrganization(location.organizationId, async (scope) => {
    const key = await scope.getApiKeyWithHash(location.apiKeyId)
    if (!key || !hashesEqual(key.secretHash, presented)) {
      return { kind: 'invalid' } as const
    }
    const organization = await scope.getOrganization()
    if (
      key.revokedAt !== null ||
      (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) ||
      organization?.status !== 'active'
    ) {
      return { kind: 'revoked' } as const
    }
    const allowed = await scope.hitApiKeyUsage({
      apiKeyId: key.id,
      now,
      windowSeconds: API_KEY_RATE_WINDOW_SECONDS,
      limit: API_KEY_RATE_LIMIT,
    })
    return allowed ? ({ kind: 'ok', key } as const) : ({ kind: 'limited' } as const)
  })
  switch (outcome.kind) {
    case 'invalid':
      throw domainError(APIKEY_ERRORS['apikey.invalid'])
    case 'revoked':
      throw domainError(APIKEY_ERRORS['apikey.revoked'])
    case 'limited':
      throw new RetryAfterError(APIKEY_ERRORS['apikey.rate_limited'], secondsToNextWindow(now))
    case 'ok':
      return verifyApiKeyResponseSchema.parse({
        apiKeyId: outcome.key.id,
        organizationId: location.organizationId,
        scopes: outcome.key.scopes,
        roleCeiling: outcome.key.roleCeiling,
        expiresAt: outcome.key.expiresAt?.toISOString() ?? null,
      })
  }
}

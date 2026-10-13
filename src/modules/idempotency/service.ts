import { createHash } from 'node:crypto'
import { CORE_ERRORS, ERRORS } from 'tula-closeline-contract'
import { IDEMPOTENCY_RESPONSE_MAX_BYTES } from 'tula-closeline-db/schema'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import {
  IdempotencyInProgressError,
  type IdempotencyKeyRef,
  MissingOrganizationError,
  type OrganizationScope,
} from '~/ports/core-store'

/** How long a stored answer is kept: a retry after this is a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/** The most expired keys one keyed request removes, from its own Organization, after its write. One batch, never a loop. */
export const IDEMPOTENCY_PURGE_BATCH = 100

/** What the idempotency wrapper needs from the container. */
export type IdempotencyDeps = Pick<Container, 'clock' | 'logger'>

/** The request a key belongs to and the answer it stores. */
export type IdempotentCall<S extends number, T> = {
  /** The `Idempotency-Key` header, already validated; absent means the route behaves as it always did. */
  key: string | undefined
  /** A fixed short name per route, such as `invitations.create`. */
  route: string
  /** Everything the answer depends on besides the caller: the validated body and the path parameters. */
  request: unknown
  /** The one success status the route answers with, which is the status stored. */
  status: S
  /** The shape of the answer; a stored answer is read back through it. */
  response: z.ZodType<T>
}

/** What a route answers: the status, the body and whether it came from a stored answer. */
export type IdempotentAnswer<S extends number, T> = { status: S; body: T; replayed: boolean }

/**
 * The canonical text of a value: JSON with every object's keys in code-point order, no extra
 * whitespace, and no key whose value is `undefined`. Two requests that mean the same thing give
 * the same text however their keys were ordered.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`
}

/** The SHA-256, as 64 lowercase hex characters, of the route's name and the canonical form of its request. */
export function requestHash(route: string, request: unknown): string {
  return createHash('sha256').update(canonicalJson({ route, request })).digest('hex')
}

/**
 * The size in bytes of a value's text form once stored as `jsonb`, which writes a space after each
 * `:` and `,` (the database bounds `octet_length(response::text)`). `Infinity` for a value
 * `jsonb` cannot hold, a string with a NUL character, so it is never stored.
 */
export function storedResponseBytes(value: unknown): number {
  let storable = true
  const text = (item: unknown): string => {
    if (item === null || typeof item !== 'object') {
      const plain = JSON.stringify(item) ?? 'null'
      if (typeof item === 'string' && item.includes('\u0000')) {
        storable = false
      }
      return plain
    }
    if (Array.isArray(item)) {
      return `[${item.map(text).join(', ')}]`
    }
    const entries = Object.entries(item as Record<string, unknown>).filter(
      ([, inner]) => inner !== undefined
    )
    return `{${entries.map(([name, inner]) => `${text(name)}: ${text(inner)}`).join(', ')}}`
  }
  const bytes = Buffer.byteLength(text(value), 'utf8')
  return storable ? bytes : Number.POSITIVE_INFINITY
}

/**
 * Turns the store's idempotency errors into the contract's answers: a key still held is
 * `request.idempotency_in_progress` (409) with `Retry-After` and `details.retryAfter`, and a
 * missing Organization is `organization.not_found`. Anything else passes unchanged.
 */
function asDomainError(error: unknown): unknown {
  if (error instanceof IdempotencyInProgressError) {
    return new RetryAfterError(ERRORS['request.idempotency_in_progress'], error.retryAfterSeconds, {
      retryAfter: error.retryAfterSeconds,
    })
  }
  if (error instanceof MissingOrganizationError) {
    return domainError(CORE_ERRORS['organization.not_found'])
  }
  return error
}

/**
 * Runs `work`, a write to the caller's Organization, once per `Idempotency-Key`. Call it inside
 * `withOrganization`, as the first thing: with a key it reserves the key's row before `work` locks
 * the Organization (the order is the idempotency row, then the Organization), `work` writes, and
 * the row is completed with the answer and the expired rows of this Organization are purged, all in
 * the one transaction. Any failure rolls the row back with the write, so only a committed answer
 * is ever stored and a failed request can be tried again with the same key.
 *
 * The same key and request again returns the stored answer and does not call `work`
 * (`replayed: true`); the same key with another request is `request.idempotency_key_reused`.
 * `work` must return only what may be stored and replayed to the client: never a secret. An answer
 * over the table's bound is not stored (the key is released, the route and ids are logged) and is
 * returned as it is. Without a key this is just `work`.
 */
export async function idempotent<S extends number, T>(
  deps: IdempotencyDeps,
  scope: OrganizationScope,
  caller: Pick<Caller, 'userId' | 'organizationId'>,
  call: IdempotentCall<S, T>,
  work: () => Promise<T>
): Promise<IdempotentAnswer<S, T>> {
  if (call.key === undefined) {
    return { status: call.status, body: await work(), replayed: false }
  }
  const ref: IdempotencyKeyRef = { userId: caller.userId, route: call.route, key: call.key }
  const now = deps.clock.now()
  const expiredBefore = new Date(now.getTime() - IDEMPOTENCY_TTL_MS)

  let reservation: Awaited<ReturnType<OrganizationScope['reserveIdempotencyKey']>>
  try {
    reservation = await scope.reserveIdempotencyKey({
      ...ref,
      requestHash: requestHash(call.route, call.request),
      now,
      expiredBefore,
    })
  } catch (error) {
    throw asDomainError(error)
  }
  if (reservation.outcome === 'reused') {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  if (reservation.outcome === 'replay') {
    if (reservation.status !== call.status) {
      throw new Error('A stored idempotent answer has a status the route does not answer with')
    }
    return { status: call.status, body: call.response.parse(reservation.response), replayed: true }
  }

  const body = await work()
  if (storedResponseBytes(body) > IDEMPOTENCY_RESPONSE_MAX_BYTES) {
    // Too large (or not storable) for the table: the request still succeeded, but its key is not kept.
    await scope.deleteIdempotencyKey(ref)
    deps.logger.warn('an idempotent answer is too large to store; its key was released', {
      route: call.route,
      organizationId: caller.organizationId,
      userId: caller.userId,
    })
  } else {
    await scope.completeIdempotencyKey(ref, call.status, body)
  }
  await scope.purgeIdempotencyKeys(expiredBefore, IDEMPOTENCY_PURGE_BATCH)
  return { status: call.status, body, replayed: false }
}

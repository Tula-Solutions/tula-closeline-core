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

/** What storing an answer in a transaction of its own needs: also the store. */
export type IdempotencyStoreDeps = Pick<Container, 'clock' | 'logger' | 'store'>

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

type CallerIds = Pick<Caller, 'userId' | 'organizationId'>

/** Logs, with the route and ids only, never a body, a key or an error message. */
function logKey(
  deps: IdempotencyDeps,
  message: string,
  caller: CallerIds,
  call: { route: string },
  error?: unknown
): void {
  deps.logger.warn(message, {
    route: call.route,
    organizationId: caller.organizationId,
    userId: caller.userId,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.name : 'unknown' }),
  })
}

/**
 * Reads a stored answer back through the route's response schema. A body that no longer parses
 * (a deploy tightened the schema) or a status the route no longer answers with is not an error the
 * client can cure: it is logged and `undefined` is returned, and the caller drops the row.
 */
function readStored<S extends number, T>(
  deps: IdempotencyDeps,
  caller: CallerIds,
  call: IdempotentCall<S, T>,
  stored: { status: number; response: unknown }
): IdempotentAnswer<S, T> | undefined {
  const parsed = call.response.safeParse(stored.response)
  if (stored.status !== call.status || !parsed.success) {
    logKey(
      deps,
      'a stored idempotent answer can no longer be read; its key was dropped',
      caller,
      call
    )
    return undefined
  }
  return { status: call.status, body: parsed.data, replayed: true }
}

/** Completes the reserved row with the answer, or, when the answer cannot be stored, releases it; then purges. */
async function finish<S extends number, T>(
  deps: IdempotencyDeps,
  scope: OrganizationScope,
  caller: CallerIds,
  call: IdempotentCall<S, T>,
  ref: IdempotencyKeyRef,
  body: T,
  expiredBefore: Date
): Promise<void> {
  if (storedResponseBytes(body) > IDEMPOTENCY_RESPONSE_MAX_BYTES) {
    // Too large (or not storable) for the table: the request still succeeded, but its key is not kept.
    await scope.deleteIdempotencyKey(ref)
    logKey(deps, 'an idempotent answer is too large to store; its key was released', caller, call)
  } else {
    await scope.completeIdempotencyKey(ref, call.status, body)
  }
  try {
    await scope.purgeIdempotencyKeys(expiredBefore, IDEMPOTENCY_PURGE_BATCH)
  } catch (error) {
    // Housekeeping must not fail the request; the store undoes the failed statement on its own.
    logKey(deps, 'the purge of expired idempotency keys failed', caller, call, error)
  }
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
 * (`replayed: true`); the same key with another request is `request.idempotency_key_reused`. A
 * stored answer that can no longer be read is dropped and the request runs as if the key were new.
 * `work` must return only what may be stored and replayed to the client: never a secret. An answer
 * over the table's bound is not stored (the key is released, the route and ids are logged) and is
 * returned as it is. A purge that fails is logged and does not fail the request. Without a key this
 * is just `work`.
 */
export async function idempotent<S extends number, T>(
  deps: IdempotencyDeps,
  scope: OrganizationScope,
  caller: CallerIds,
  call: IdempotentCall<S, T>,
  work: () => Promise<T>
): Promise<IdempotentAnswer<S, T>> {
  if (call.key === undefined) {
    return { status: call.status, body: await work(), replayed: false }
  }
  const ref: IdempotencyKeyRef = { userId: caller.userId, route: call.route, key: call.key }
  const now = deps.clock.now()
  const expiredBefore = new Date(now.getTime() - IDEMPOTENCY_TTL_MS)
  const reserve = async () => {
    try {
      return await scope.reserveIdempotencyKey({
        ...ref,
        requestHash: requestHash(call.route, call.request),
        now,
        expiredBefore,
      })
    } catch (error) {
      throw asDomainError(error)
    }
  }

  let reservation = await reserve()
  if (reservation.outcome === 'reused') {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  if (reservation.outcome === 'replay') {
    const answer = readStored(deps, caller, call, reservation)
    if (answer) {
      return answer
    }
    await scope.deleteIdempotencyKey(ref)
    reservation = await reserve()
    if (reservation.outcome !== 'reserved') {
      throw new Error(
        'An idempotency key could not be claimed after its unreadable row was dropped'
      )
    }
  }

  const body = await work()
  await finish(deps, scope, caller, call, ref, body, expiredBefore)
  return { status: call.status, body, replayed: false }
}

/**
 * For a route that stores its key after its side effect, in a transaction of its own (see
 * {@link recordAnswer}): the stored answer if the same request was answered before, else
 * `undefined`. Claims nothing and waits for nobody, so a request that arrives while another with
 * the same key is still working is not told anything and runs as it would without a key. The same
 * key with another request is `request.idempotency_key_reused`; an unreadable stored answer is
 * dropped. Call it inside `withOrganization`.
 */
export async function findAnswer<S extends number, T>(
  deps: IdempotencyDeps,
  scope: OrganizationScope,
  caller: CallerIds,
  call: IdempotentCall<S, T>
): Promise<IdempotentAnswer<S, T> | undefined> {
  if (call.key === undefined) {
    return undefined
  }
  const ref: IdempotencyKeyRef = { userId: caller.userId, route: call.route, key: call.key }
  const found = await scope.findIdempotencyKey({
    ...ref,
    requestHash: requestHash(call.route, call.request),
    expiredBefore: new Date(deps.clock.now().getTime() - IDEMPOTENCY_TTL_MS),
  })
  if (found.outcome === 'reused') {
    throw domainError(ERRORS['request.idempotency_key_reused'])
  }
  if (found.outcome === 'free') {
    return undefined
  }
  const answer = readStored(deps, caller, call, found)
  if (!answer) {
    await scope.deleteIdempotencyKey(ref)
  }
  return answer
}

/**
 * Stores the 201 of a route whose side effect has already happened and been confirmed (an email
 * handed over): one short transaction that reserves the key, completes it and purges. The side
 * effect cannot be undone, so nothing here may fail the request: any failure, or a key that
 * another request claimed in the meantime, is logged with the route and ids and swallowed. The
 * client then has its answer, and a retry meets the effect itself (for an Invitation,
 * `invitation.already_pending`).
 */
export async function recordAnswer<S extends number, T>(
  deps: IdempotencyStoreDeps,
  caller: CallerIds,
  call: IdempotentCall<S, T>,
  body: T
): Promise<void> {
  if (call.key === undefined) {
    return
  }
  const ref: IdempotencyKeyRef = { userId: caller.userId, route: call.route, key: call.key }
  const now = deps.clock.now()
  const expiredBefore = new Date(now.getTime() - IDEMPOTENCY_TTL_MS)
  try {
    await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const reservation = await scope.reserveIdempotencyKey({
        ...ref,
        requestHash: requestHash(call.route, call.request),
        now,
        expiredBefore,
      })
      if (reservation.outcome !== 'reserved') {
        // Another request stored this key while this one delivered; leave its answer alone.
        throw new Error('the key was claimed by another request')
      }
      await finish(deps, scope, caller, call, ref, body, expiredBefore)
    })
  } catch (error) {
    logKey(deps, 'could not store the idempotency key after the side effect', caller, call, error)
  }
}

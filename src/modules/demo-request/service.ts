import {
  type CreateDemoRequestRequest,
  type DemoRequestId,
  demoRequestIdSchema,
  ERRORS,
  formatId,
  MARKETING_ERRORS,
} from 'tula-closeline-contract'
import { DemoRequestRefusedError } from 'tula-closeline-db'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'

/** The most Demo Requests one client address may make in one window. */
export const RATE_LIMIT = 10

/** The length of the rate-limit window, in seconds (one hour). */
export const RATE_WINDOW_SECONDS = 3_600

/** What the Demo Request service needs from the container. */
export type DemoRequestDeps = Pick<Container, 'demoRequests' | 'demoRateLimiter'>

/** What a submission came to. */
export type Submitted = {
  /** The Demo Request's id; a fresh one that nothing stored when the honeypot was filled. */
  id: DemoRequestId
  /** True when the idempotency key had been used with this same request before. */
  replayed: boolean
}

/**
 * Takes one Demo Request from a Visitor. The client address, already hashed, is counted first, so
 * a refused request still costs the sender a try; a filled honeypot is then answered like a real
 * request with a fresh id and stores nothing; otherwise the request is stored and its team notice
 * queued in one step. The same key with the same request returns the first id. Errors:
 * `marketing.rate_limited` (with the wait), `request.idempotency_key_reused`, and
 * `marketing.invalid_request` when the database refuses a field.
 */
export async function submit(
  deps: DemoRequestDeps,
  input: { request: CreateDemoRequestRequest; idempotencyKey: string; addressHash: Uint8Array }
): Promise<Submitted> {
  const allowed = await deps.demoRateLimiter.hit(input.addressHash, {
    windowSeconds: RATE_WINDOW_SECONDS,
    limit: RATE_LIMIT,
  })
  if (!allowed) {
    // Only the whole window is known here, so that is what the client is told to wait.
    throw new RetryAfterError(MARKETING_ERRORS['marketing.rate_limited'], RATE_WINDOW_SECONDS, {
      retryAfter: RATE_WINDOW_SECONDS,
    })
  }

  const id = formatId('dreq', crypto.randomUUID())
  if (input.request.website !== '') {
    return { id, replayed: false }
  }

  try {
    const stored = await deps.demoRequests.submit({
      id,
      name: input.request.name,
      workEmail: input.request.workEmail,
      companyName: input.request.companyName,
      message: input.request.message ?? null,
      sourcePage: input.request.sourcePage,
      idempotencyKey: input.idempotencyKey,
    })
    if (!stored.sameFields) {
      throw domainError(ERRORS['request.idempotency_key_reused'])
    }
    return { id: demoRequestIdSchema.parse(stored.id), replayed: stored.replayed }
  } catch (error) {
    // The database's own error is dropped: it names a constraint, never a Visitor field, but the
    // client has no use for it either. The db package wraps every failure of the call, so only a
    // data-exception or integrity-violation SQLSTATE (class 22 or 23) is a refused field; a lost
    // connection, timeout or deadlock is a server error that must reach the reporter.
    if (error instanceof DemoRequestRefusedError && /^2[23]/.test(error.code ?? '')) {
      throw domainError(MARKETING_ERRORS['marketing.invalid_request'])
    }
    throw error
  }
}

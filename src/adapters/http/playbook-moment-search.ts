import { searchMomentsResponseSchema } from 'tula-closeline-contract'
import { type BackoffSteps, backoffDelayMs, rest, type Sleep } from '~/backoff'
import type { MomentSearch } from '~/ports/moment-search'

/** How the Playbook is reached and retried; tests shorten the numbers. */
export type PlaybookMomentSearchOptions = {
  /** The Playbook's internal base URL. */
  baseUrl: string
  /** The shared secret (ADR 0013) the Playbook expects as a bearer token. Never logged. */
  token: string
  /** One attempt's limit in ms; default 3 000. */
  timeoutMs?: number
  /** Attempts in all; default 2. */
  attempts?: number
  /** The wait between attempts; default 100 ms to 1 s, jittered. */
  backoff?: BackoffSteps
  sleep?: Sleep
  random?: () => number
}

const MAX_BODY_CHARS = 1_000_000

class Retryable extends Error {}

/**
 * A {@link MomentSearch} over the Playbook's internal Moment search route. A 503 or a timeout is
 * retried a bounded number of times with jitter; anything else (401, 400, a malformed answer, a
 * refused connection) fails at once. Moment text is never logged and no error carries the token or
 * the body. The Playbook has no internal route that resolves Source references yet, so
 * `passagesFor` refuses.
 */
export function createPlaybookMomentSearch(options: PlaybookMomentSearchOptions): MomentSearch {
  const timeoutMs = options.timeoutMs ?? 3_000
  const attempts = options.attempts ?? 2
  const backoff = options.backoff ?? { baseMs: 100, capMs: 1_000 }
  const sleep = options.sleep ?? rest
  const random = options.random ?? Math.random
  const url = `${options.baseUrl.replace(/\/+$/, '')}/internal/v1/playbook/search/moments`

  return {
    searchWonMoments: async (input, signal) => {
      const body = JSON.stringify({
        turns: [{ role: 'prospect', text: input.query }],
        limit: input.limit,
      })
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.token}`,
              'x-organization-id': input.organizationId,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body,
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          })
          if (response.status === 503) {
            await response.body?.cancel().catch(() => {})
            throw new Retryable('the Playbook is unavailable')
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            throw new Error(`the Playbook answered ${response.status}`)
          }
          const text = await response.text()
          if (text.length > MAX_BODY_CHARS) {
            throw new Error('the Playbook answered with too large a body')
          }
          const parsed = searchMomentsResponseSchema.safeParse(JSON.parse(text))
          if (!parsed.success) {
            throw new Error('the Playbook answered with a body of the wrong shape')
          }
          return {
            moments: parsed.data.items.map((item) => ({
              callId: item.callId,
              dealRecordId: item.dealRecordId,
              momentIndex: item.momentIndex ?? null,
              prospect: item.prospect,
              repNext: item.repNext,
            })),
            evidence: parsed.data.evidence,
          }
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
          if (
            signal.aborted ||
            (!timedOut && !(error instanceof Retryable)) ||
            attempt >= attempts
          ) {
            throw new Error(
              timedOut ? 'the Playbook did not answer in time' : 'the Playbook search failed'
            )
          }
          await sleep(backoffDelayMs(attempt, backoff, random), signal)
        }
      }
    },
    passagesFor: async () => {
      throw new Error('The Playbook has no internal route for Source passages')
    },
  }
}

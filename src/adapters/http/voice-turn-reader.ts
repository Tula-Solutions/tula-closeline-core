import { callTurnsResponseSchema } from 'tula-closeline-contract'
import { type BackoffSteps, backoffDelayMs, rest, type Sleep } from '~/backoff'
import { TranscriptTimeout, type TurnReader } from '~/ports/turn-reader'

/** How the voice reader is reached and retried; tests shorten the numbers. */
export type VoiceTurnReaderOptions = {
  /** Voice's internal base URL. */
  baseUrl: string
  /** The shared secret voice expects as a bearer token. Never logged. */
  token: string
  /** One attempt's limit in ms; default 3 000. */
  timeoutMs?: number
  /** Attempts in all; default 3. */
  attempts?: number
  /** The wait between attempts; default 100 ms to 1 s, jittered. */
  backoff?: BackoffSteps
  sleep?: Sleep
  random?: () => number
}

const MAX_BODY_CHARS = 1_000_000

class Retryable extends Error {}

/**
 * The window read of a {@link TurnReader} over voice's internal turns route. A 503 or a timeout is
 * retried a bounded number of times with jitter; a 404 is `null`; anything else (401, 400, a
 * malformed answer, a refused connection) fails at once. The text it returns is never logged, and
 * no error message carries the token or the body. `read` is not served by voice (no source text
 * there), so it refuses.
 */
export function createVoiceTurnReader(options: VoiceTurnReaderOptions): TurnReader {
  const timeoutMs = options.timeoutMs ?? 3_000
  const attempts = options.attempts ?? 3
  const backoff = options.backoff ?? { baseMs: 100, capMs: 1_000 }
  const sleep = options.sleep ?? rest
  const random = options.random ?? Math.random
  const base = options.baseUrl.replace(/\/+$/, '')

  return {
    read: async () => {
      throw new Error('The voice route does not carry the cited sources')
    },
    window: async (input, signal) => {
      const url = `${base}/internal/v1/calls/${encodeURIComponent(input.callId)}/turns?around=${input.turnIndex}&window=${input.window}`
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetch(url, {
            headers: {
              authorization: `Bearer ${options.token}`,
              'x-organization-id': input.organizationId,
              accept: 'application/json',
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
          })
          if (response.status === 404) {
            return null
          }
          if (response.status === 503) {
            throw new Retryable('voice is unavailable')
          }
          if (!response.ok) {
            throw new Error(`voice answered ${response.status}`)
          }
          const body = await response.text()
          if (body.length > MAX_BODY_CHARS) {
            throw new Error('voice answered with too large a body')
          }
          const parsed = callTurnsResponseSchema.safeParse(JSON.parse(body))
          if (!parsed.success) {
            throw new Error('voice answered with a body of the wrong shape')
          }
          return parsed.data
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
          if (signal.aborted) {
            throw new TranscriptTimeout('the read was cut short')
          }
          if ((!timedOut && !(error instanceof Retryable)) || attempt >= attempts) {
            throw timedOut
              ? new TranscriptTimeout('voice did not answer in time')
              : new Error(error instanceof Retryable ? 'voice is unavailable' : 'voice read failed')
          }
          await sleep(backoffDelayMs(attempt, backoff, random), signal)
        }
      }
    },
  }
}

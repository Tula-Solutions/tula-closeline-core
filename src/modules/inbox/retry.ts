import { type BackoffSteps, backoffDelayMs, rest, type Sleep } from '~/backoff'

/** How an outside call is retried; every field has a default, tests shorten them. */
export type RetryOptions = {
  /** How many times the call is tried before it gives up. */
  attempts?: number
  /** The wait between attempts. */
  backoff?: BackoffSteps
  /** Rests between attempts. */
  sleep?: Sleep
  /** A random number in [0, 1) for the jitter. */
  random?: () => number
}

/** {@link RetryOptions} with every default filled in. */
export type ResolvedRetry = Required<RetryOptions>

/** Fills the defaults: three attempts, a 200 ms to 2 s jittered backoff. */
export function resolveRetry(options: RetryOptions): ResolvedRetry {
  return {
    attempts: options.attempts ?? 3,
    backoff: options.backoff ?? { baseMs: 200, capMs: 2_000 },
    sleep: options.sleep ?? rest,
    random: options.random ?? Math.random,
  }
}

/** Why an outside call gave up. */
export class CallFailed extends Error {}

/**
 * Calls `call` up to `attempts` times, each under its own timeout, resting a jittered, growing
 * while between failures. Throws {@link CallFailed} when every attempt failed or timed out.
 */
export async function withRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  options: ResolvedRetry
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      return await Promise.race([
        call(signal),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      ])
    } catch {
      if (attempt >= options.attempts) {
        throw new CallFailed('The call failed on every attempt')
      }
      await options.sleep(
        backoffDelayMs(attempt, options.backoff, options.random),
        new AbortController().signal
      )
    }
  }
}

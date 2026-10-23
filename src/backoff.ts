/** The first step and the longest step of an exponential backoff, in ms. */
export type BackoffSteps = { baseMs: number; capMs: number }

/** Rests `ms`, or less when `signal` aborts; resolves either way. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

/**
 * How long to wait after the `failures`-th failure in a row: `baseMs` doubled per earlier failure,
 * capped at `capMs`, then jittered into the upper half so instances do not retry in step. `random`
 * is in [0, 1). The result is a whole number of ms, at most `capMs`.
 */
export function backoffDelayMs(
  failures: number,
  { baseMs, capMs }: BackoffSteps,
  random: () => number = Math.random
): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 30)
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent)
  return Math.floor(ceiling / 2 + random() * (ceiling / 2))
}

/** Waits `ms`, or less when `signal` aborts; resolves either way. */
export const rest: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

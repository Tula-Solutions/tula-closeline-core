/** The part of a running server that shutdown needs; `Bun.serve`'s return value satisfies it. */
export type Stoppable = {
  /** Stops accepting connections; `force` also closes in-flight ones. Resolves once stopped. */
  stop: (force?: boolean) => Promise<void>
}

/** How a drain ended: every request finished, or the timeout closed the rest. */
export type DrainResult = 'drained' | 'forced'

/**
 * Stops accepting new connections, waits for in-flight requests, and after `timeoutMs` closes
 * whatever is left, so a stuck request can never keep the process alive.
 */
export async function drain(server: Stoppable, timeoutMs: number): Promise<DrainResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'forced'>((resolve) => {
    timer = setTimeout(() => resolve('forced'), timeoutMs)
  })

  try {
    const result = await Promise.race([server.stop().then(() => 'drained' as const), timeout])
    if (result === 'forced') {
      await server.stop(true)
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

import { describeError } from '~/describe-error'

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

/** What {@link shutdown} needs; kept to plain values so a test can supply doubles. */
export type ShutdownOptions = {
  signal: string
  server: Stoppable
  /** The container's flag; `/readyz` reads it. */
  lifecycle: { draining: boolean }
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void
    error: (message: string, fields?: Record<string, unknown>) => void
  }
  /** How long to keep serving `/readyz` as 503 before the server stops accepting. */
  graceMs: number
  /** How long to wait for in-flight requests once stopped, before closing them. */
  timeoutMs: number
  /** Ends the process; called once when shutdown ends, or at once with 1 on a second signal. */
  exit: (code: number) => void
}

/** Runs a logging call that must never be able to change how shutdown ends. */
function safely(log: () => void): void {
  try {
    log()
  } catch {
    // A broken log destination (closed stdout) is no reason to leave the process hanging.
  }
}

/**
 * Graceful shutdown: readiness turns 503 first, a grace period lets the load balancer notice, and
 * only then the server stops accepting and drains. It always ends by calling `exit`, with code 1
 * if stopping failed, and nothing in it, a throwing logger included, can prevent that. A second
 * signal while it runs exits at once with code 1, for a person who will not wait.
 */
export async function shutdown(options: ShutdownOptions): Promise<void> {
  const { server, lifecycle, logger } = options
  if (lifecycle.draining) {
    options.exit(1)
    return
  }
  lifecycle.draining = true

  let code = 0
  try {
    safely(() => logger.info('shutting down', { signal: options.signal, graceMs: options.graceMs }))
    await new Promise<void>((resolve) => setTimeout(resolve, options.graceMs))
    const result = await drain(server, options.timeoutMs)
    safely(() => logger.info('stopped', { result }))
  } catch (error) {
    code = 1
    safely(() => logger.error('shutdown failed', { error: describeError(error) }))
  } finally {
    options.exit(code)
  }
}

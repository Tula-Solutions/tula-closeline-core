import { PACKAGE as CONTRACT } from 'tula-closeline-contract'
import { PACKAGE as DB } from 'tula-closeline-db'
import { PACKAGE as KIT } from 'tula-closeline-kit'
import type { Container, ReadinessCheck } from '~/container'
import { SERVICE } from '~/info'
import type { CheckResult, Liveness, Readiness } from './schema'

/** What the health service needs from the container. */
export type HealthDeps = Pick<Container, 'env' | 'logger' | 'readinessChecks'>

/** Liveness: the process is up. It touches no dependency, so it cannot fail because of one. */
export function liveness(): Liveness {
  return { status: 'ok', service: SERVICE, libraries: [CONTRACT, DB, KIT] }
}

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<CheckResult['status']> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })

  try {
    return await Promise.race([
      check.run(controller.signal).then(
        () => 'ok' as const,
        () => 'failed' as const
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Readiness: runs every check at once, each with its own timeout; ready only if all pass. */
export async function readiness(deps: HealthDeps): Promise<Readiness> {
  const checks = await Promise.all(
    deps.readinessChecks.map(
      async (check): Promise<CheckResult> => ({
        name: check.name,
        status: await runCheck(check, deps.env.READINESS_TIMEOUT_MS),
      })
    )
  )

  for (const check of checks) {
    if (check.status !== 'ok') {
      deps.logger.warn('readiness check did not pass', { check: check.name, status: check.status })
    }
  }

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ready' : 'unavailable',
    checks,
  }
}

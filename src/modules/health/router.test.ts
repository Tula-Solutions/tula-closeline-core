import { describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import type { ReadinessCheck } from '~/container'
import { SERVICE } from '~/info'
import { createTestDeps } from '~/testing'

const healthy: ReadinessCheck = { name: 'healthy', run: async () => {} }
const broken: ReadinessCheck = {
  name: 'broken',
  run: async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
  },
}
const stalled: ReadinessCheck = {
  name: 'stalled',
  run: (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
}

function appWith(checks: readonly ReadinessCheck[]) {
  const deps = createTestDeps({ readinessChecks: checks, env: { READINESS_TIMEOUT_MS: '20' } })
  return { app: createApp(deps), deps }
}

describe('/healthz', () => {
  test('names the service and the shared libraries it resolved', async () => {
    const { app } = appWith([])

    const response = await app.request('/healthz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      service: SERVICE,
      libraries: ['tula-closeline-contract', 'tula-closeline-db', 'tula-closeline-kit'],
    })
  })

  test('stays 200 while a readiness check is failing', async () => {
    const { app } = appWith([broken])

    expect((await app.request('/healthz')).status).toBe(200)
  })
})

describe('/readyz', () => {
  test('is 503 when a check fails, naming it without the reason', async () => {
    const { app, deps } = appWith([healthy, broken])

    const response = await app.request('/readyz')

    expect(response.status).toBe(503)
    const text = await response.text()
    expect(text).not.toContain('ECONNREFUSED')
    expect(JSON.parse(text)).toEqual({
      status: 'unavailable',
      checks: [
        { name: 'healthy', status: 'ok' },
        { name: 'broken', status: 'failed' },
      ],
    })
    expect(deps.logLines.some((line) => line.includes('"check":"broken"'))).toBe(true)
  })

  test('is 503 when a check outlasts its timeout, and the check is aborted', async () => {
    const { app } = appWith([stalled])
    const started = performance.now()

    const response = await app.request('/readyz')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: [{ name: 'stalled', status: 'timeout' }],
    })
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('runs checks concurrently, so slow ones do not add up', async () => {
    const slow = (name: string): ReadinessCheck => ({
      name,
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const deps = createTestDeps({
      readinessChecks: [slow('a'), slow('b'), slow('c'), slow('d')],
      env: { READINESS_TIMEOUT_MS: '100' },
    })
    const started = performance.now()

    await createApp(deps).request('/readyz')

    expect(performance.now() - started).toBeLessThan(100 * 4)
  })

  test('is 200 when every check passes', async () => {
    const { app } = appWith([healthy])

    const response = await app.request('/readyz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ready',
      checks: [{ name: 'healthy', status: 'ok' }],
    })
  })

  test('is 200 with no checks, as in this service today', async () => {
    const { app } = appWith([])

    const response = await app.request('/readyz')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready', checks: [] })
  })
})

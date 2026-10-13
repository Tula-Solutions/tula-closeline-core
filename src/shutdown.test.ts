import { expect, test } from 'bun:test'
import { createApp } from './app'
import { drain, type Stoppable, shutdown } from './shutdown'
import { createTestDeps } from './testing'

function fakeServer(finishesAfterMs: number | null) {
  const calls: (boolean | undefined)[] = []
  return {
    calls,
    stop: (force?: boolean) => {
      calls.push(force)
      if (force || finishesAfterMs === 0) {
        return Promise.resolve()
      }
      // A stuck request: graceful stop never settles unless it is allowed to finish.
      return finishesAfterMs === null
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => setTimeout(resolve, finishesAfterMs))
    },
  }
}

test('drain waits for in-flight requests and does not force-close when they finish in time', async () => {
  const server = fakeServer(10)

  expect(await drain(server, 1_000)).toBe('drained')
  expect(server.calls).toEqual([undefined])
})

test('drain force-closes what is still running after the timeout', async () => {
  const server = fakeServer(null)

  expect(await drain(server, 20)).toBe('forced')
  expect(server.calls).toEqual([undefined, true])
})

function harness(options: { graceMs: number; stop: Stoppable['stop'] }) {
  const lifecycle = { draining: false }
  const exits: number[] = []
  const logs: string[] = []
  const run = () =>
    shutdown({
      signal: 'SIGTERM',
      server: { stop: options.stop },
      lifecycle,
      logger: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
      graceMs: options.graceMs,
      timeoutMs: 50,
      exit: (code) => exits.push(code),
    })
  return { lifecycle, exits, logs, run }
}

test('on shutdown /readyz turns 503 first, and the server stops only after the grace period', async () => {
  const stops: number[] = []
  const started = performance.now()
  const { lifecycle, exits, run } = harness({
    graceMs: 60,
    stop: () => {
      stops.push(performance.now() - started)
      return Promise.resolve()
    },
  })
  const app = createApp({ ...createTestDeps(), lifecycle })

  expect((await app.request('/readyz')).status).toBe(200)
  const done = run()

  expect((await app.request('/readyz')).status).toBe(503)
  expect(stops).toEqual([])
  await done
  expect(stops).toHaveLength(1)
  expect(stops[0]).toBeGreaterThanOrEqual(55)
  expect(exits).toEqual([0])
})

test('shutdown still exits, with code 1, when stopping rejects', async () => {
  const { exits, logs, run } = harness({
    graceMs: 0,
    stop: () => Promise.reject(new Error('socket already closed')),
  })

  await run()

  expect(exits).toEqual([1])
  expect(logs).toContain('shutdown failed')
})

test('a second signal while shutting down does nothing', async () => {
  const { exits, run } = harness({ graceMs: 10, stop: () => Promise.resolve() })

  await Promise.all([run(), run()])

  expect(exits).toEqual([0])
})

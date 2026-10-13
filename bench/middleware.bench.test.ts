import { expect, test } from 'bun:test'
import { AppError } from 'tula-closeline-kit'
import { createBaseApp } from '../src/http/base'
import { createTestDeps } from '../src/testing'

// The cost every request pays before a module's code runs: request id middleware, the error
// guard, the body limit, the router and the error handler. Complexity is O(1) per request; the
// inputs are fixed. Each budget is about five times the measured time, so a shared CI runner
// does not flake but a regression of a few hundred microseconds per request fails.
const REQUESTS = 2_000
const WARMUP = 200
// Measured about 0.017 ms per request, so about 34 ms for 2000. Budget: 5x, rounded up.
const SUCCESS_BUDGET_MS = 170
// Measured about 0.0185 ms per request, so about 37 ms for 2000. Budget: 5x, rounded up.
const ERROR_BUDGET_MS = 190

function build() {
  const app = createBaseApp(createTestDeps())
  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/fail', () => {
    throw new AppError({ code: 'bench.failed', status: 409, message: 'Failed.' })
  })
  return app
}

test(`${REQUESTS} requests through the middleware stack complete within ${SUCCESS_BUDGET_MS} ms`, async () => {
  const app = build()
  const inbound = { 'x-request-id': `req_${'a'.repeat(32)}` }
  const request = (index: number) =>
    app.request('/ok', index % 2 === 0 ? { headers: inbound } : undefined)
  for (let index = 0; index < WARMUP; index++) {
    await request(index)
  }
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await request(index)
  }

  const elapsed = performance.now() - started
  console.log(`middleware (success): ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(SUCCESS_BUDGET_MS)
})

test(`${REQUESTS} requests that fail through the error handler complete within ${ERROR_BUDGET_MS} ms`, async () => {
  const app = build()
  for (let index = 0; index < WARMUP; index++) {
    await app.request('/fail')
  }
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await app.request('/fail')
  }

  const elapsed = performance.now() - started
  console.log(`middleware (error): ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(ERROR_BUDGET_MS)
})

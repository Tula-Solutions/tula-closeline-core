import { expect, test } from 'bun:test'
import { AppError } from 'tula-closeline-kit'
import { createBaseApp } from '../src/http/base'
import { createTestDeps } from '../src/testing'

// The cost every request pays before a module's code runs: request id middleware, the router and
// the error handler. Complexity is O(1) per request; the inputs are fixed.
const REQUESTS = 2_000
const BUDGET_MS = 1_000

function build() {
  const app = createBaseApp(createTestDeps())
  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/fail', () => {
    throw new AppError({ code: 'bench.failed', status: 409, message: 'Failed.' })
  })
  return app
}

test(`${REQUESTS} requests through the middleware stack complete within ${BUDGET_MS} ms`, async () => {
  const app = build()
  const inbound = { 'x-request-id': `req_${'a'.repeat(32)}` }
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await app.request('/ok', index % 2 === 0 ? { headers: inbound } : undefined)
  }

  const elapsed = performance.now() - started
  console.log(`middleware (success): ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

test(`${REQUESTS} requests that fail through the error handler complete within ${BUDGET_MS} ms`, async () => {
  const app = build()
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await app.request('/fail')
  }

  const elapsed = performance.now() - started
  console.log(`middleware (error): ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

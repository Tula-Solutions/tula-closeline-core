import { expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { createTestDeps } from '../src/testing'

// The pattern every benchmark follows: one operation, a stated input size, an asserted budget.
// The budget is about five times the slowest of five runs: loose enough to absorb a noisy shared
// CI runner, tight enough that a real regression (a stray await, a per-request allocation) fails.
const REQUESTS = 2_000
const WARMUP = 200
// Slowest of five runs: 23.4 ms for 2000 requests (about 0.012 ms each). Budget: 5x, rounded up.
const BUDGET_MS = 120

test(`${REQUESTS} health requests complete within ${BUDGET_MS} ms`, async () => {
  const app = createApp(createTestDeps())
  for (let index = 0; index < WARMUP; index++) {
    await app.request('/healthz')
  }
  const started = performance.now()

  for (let index = 0; index < REQUESTS; index++) {
    await app.request('/healthz')
  }

  const elapsed = performance.now() - started
  console.log(`healthz: ${(elapsed / REQUESTS).toFixed(4)} ms per request`)
  expect(elapsed).toBeLessThan(BUDGET_MS)
})

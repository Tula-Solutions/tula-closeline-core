import { expect, test } from 'bun:test'
import { computeSlots, MAX_SLOTS } from '../src/modules/availability/slots'
import { measure, summary } from './measure'

// The hot path: Rep slots, asked on every booking page view and by routing. The CPU part is pure:
// `computeSlots` reads no database or calendar (the busy times are stored by the refresh job).
// Complexity: O(days x windows x slots per window + busy), all bounded: 15 days, 28 windows a
// week, 5,000 busy ranges, 500 slots. Input: a Rep in America/New_York (a DST change inside the
// range) with two windows a day on five days, 15-minute slots, buffers, and 600 busy ranges over
// the 14 days (the stored horizon), so a hidden per-slot scan of the busy list would show.
// Typical best batch of 500 calls: 57 ms on the dev laptop (median 58 ms); the CI runner is not yet measured (other benches run
// about 5x slower there). The budget is about 3x that CI guess, so it catches a per-slot scan of the
// busy list or a formatter built per call, not noise.
const BUDGET_MS = 1000

const day = 86_400_000
const from = Date.parse('2026-03-02T00:00:00Z')
const busy = Array.from({ length: 600 }, (_, i) => {
  const start = from + Math.floor(i / 43) * day + (i % 43) * 15 * 60_000 * 1.2 + 5 * 3_600_000
  return { start, end: start + 20 * 60_000 }
}).sort((a, b) => a.start - b.start)
const windows = [0, 1, 2, 3, 4].flatMap((d) => [
  { day: d, start: 9 * 60, end: 12 * 60 },
  { day: d, start: 13 * 60, end: 17 * 60 },
])

test('slots for a busy Rep stay within budget', () => {
  const result = measure(() =>
    computeSlots({
      timeZone: 'America/New_York',
      windows,
      lengthMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
      minimumNoticeMinutes: 60,
      now: from,
      awayUntil: null,
      from,
      to: from + 14 * day,
      busy,
      limit: MAX_SLOTS,
    })
  )
  return result.then((m) => {
    console.log(summary('slots', m))
    expect(m.bestMs).toBeLessThan(BUDGET_MS)
  })
})

// The pooled hot path: `GET /v1/booking-slots` over 20 routed Reps and 14 days, on the memory
// adapter through the HTTP router (auth, routing, per-Rep slots from stored busy times, the
// merge and the page). It reads no calendar. Complexity: O(reps x days x slots per day) with
// reps <= 20, days <= 14, and only the first page of 100 returned. The path costs far more than
// one Rep, so a few timed batches stand in for `measure`. The gate is the fastest batch's mean
// per call, so a stalled batch does not fail it; the p95 target of the ticket is 800 ms.
// Typical best batch mean: 2.0 ms per call on the dev laptop (3 ms worst batch); the CI runner is
// about 5x slower, so the budget is 25 ms, 12x the laptop figure and far under the 800 ms target.
const POOLED_BUDGET_MS = 25
const POOLED_BATCHES = 5
const POOLED_CALLS = 4

test('pooled slots over 20 Reps and 14 days stay within budget', async () => {
  const { createMemoryCoreStore } = await import('../src/adapters/memory/core-store')
  const { seedTeam } = await import('../src/modules/routing/fixtures')
  const { createTestApp, publicCaller, seedOrganization } = await import('../src/testing')
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const roles = ['admin', ...Array.from({ length: 20 }, () => 'rep' as const)] as const
  const org = await seedOrganization(memory, [...roles])
  const admin = org.members[0]
  const reps = org.members.filter((m) => m.role === 'rep')
  if (!admin) {
    throw new Error('no admin seeded')
  }
  const api = publicCaller(harness)
  const call = (method: string, path: string, body?: unknown) =>
    api(admin, org.organizationId, method, path, body)
  const teamId = await seedTeam(
    memory,
    org.organizationId,
    reps.map((m) => m.id)
  )
  await call('POST', '/routing-rules', {
    name: 'Everyone',
    conditions: {},
    isDefault: true,
    target: { kind: 'team', teamId },
  })
  const type = await call('POST', '/booking-types', {
    name: 'Intro',
    lengthMinutes: 30,
    bufferBeforeMinutes: 5,
    bufferAfterMinutes: 5,
    minimumNoticeMinutes: 60,
    mode: 'phone',
  })
  const prospect = await call('POST', '/prospects', {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  })
  const start = harness.deps.clock.now().getTime()
  const query = `bookingTypeId=${type.body.id}&prospectId=${prospect.body.id}&from=${new Date(start).toISOString()}&to=${new Date(start + 14 * day).toISOString()}&limit=100`
  const once = async () => {
    const res = await call('GET', `/booking-slots?${query}`)
    expect(res.status).toBe(200)
    expect((res.body.items as unknown[]).length).toBe(100)
  }
  for (let i = 0; i < 3; i++) {
    await once()
  }
  const batches: number[] = []
  for (let b = 0; b < POOLED_BATCHES; b++) {
    const started = performance.now()
    for (let i = 0; i < POOLED_CALLS; i++) {
      await once()
    }
    batches.push((performance.now() - started) / POOLED_CALLS)
  }
  const best = Math.min(...batches)
  console.log(
    `pooled slots: best ${best.toFixed(1)} ms per call (${batches.map((x) => x.toFixed(0)).join(', ')})`
  )
  expect(best).toBeLessThan(POOLED_BUDGET_MS)
})

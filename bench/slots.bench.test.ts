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

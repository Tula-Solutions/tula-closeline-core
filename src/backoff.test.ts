import { describe, expect, test } from 'bun:test'
import { backoffDelayMs, rest } from './backoff'

const steps = { baseMs: 5_000, capMs: 60_000 }

describe('backoffDelayMs', () => {
  test('doubles from the base, in the upper half of each step, up to the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelayMs(n, steps, () => 0))).toEqual([
      2_500, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ])
  })

  test('stays between half the step and the step, and never passes the cap, for any random', () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999999999999]) {
      for (let failures = -2; failures <= 100; failures++) {
        const ceiling = Math.min(
          steps.capMs,
          steps.baseMs * 2 ** Math.min(Math.max(failures, 1) - 1, 30)
        )
        const delay = backoffDelayMs(failures, steps, () => random)
        expect(Number.isInteger(delay)).toBe(true)
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2)
        expect(delay).toBeLessThanOrEqual(ceiling)
        expect(delay).toBeLessThanOrEqual(steps.capMs)
      }
    }
    expect(backoffDelayMs(50, steps, () => 0.999999999999)).toBe(59_999)
  })

  test('uses Math.random when no source is given', () => {
    const delay = backoffDelayMs(3, steps)
    expect(delay).toBeGreaterThanOrEqual(10_000)
    expect(delay).toBeLessThanOrEqual(20_000)
  })
})

describe('rest', () => {
  test('resolves at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await rest(60_000, controller.signal)
  })

  test('resolves when the signal aborts during a long wait', async () => {
    const controller = new AbortController()
    const waiting = rest(60_000, controller.signal)
    controller.abort()
    await waiting
  })
})

import type { Clock } from 'tula-closeline-kit'
import type { DemoRateLimiter } from '~/ports/demo-rate-limiter'

/** The in-memory limiter: counters per address hash and fixed window, for tests. */
export function createMemoryDemoRateLimiter(clock: Pick<Clock, 'now'>): DemoRateLimiter {
  /** Counts by `hex(hash):windowIndex`, with the end of each window. */
  const counters = new Map<string, { count: number; endsAt: number }>()
  return {
    hit: async (addressHash, window) => {
      const now = clock.now().getTime()
      const index = Math.floor(now / (window.windowSeconds * 1000))
      const key = `${Buffer.from(addressHash).toString('hex')}:${index}`
      const entry = counters.get(key) ?? {
        count: 0,
        endsAt: (index + 1) * window.windowSeconds * 1000,
      }
      entry.count += 1
      counters.set(key, entry)
      return entry.count <= window.limit
    },
    purge: async (limit) => {
      const now = clock.now().getTime()
      let removed = 0
      for (const [key, entry] of counters) {
        if (removed >= limit) {
          break
        }
        if (entry.endsAt <= now) {
          counters.delete(key)
          removed += 1
        }
      }
      return removed
    },
  }
}

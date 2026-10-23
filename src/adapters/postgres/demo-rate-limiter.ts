import { type Database, hitDemoRateLimit, purgeDemoRateCounters } from 'tula-closeline-db'
import type { DemoRateLimiter } from '~/ports/demo-rate-limiter'

/**
 * The Demo Request rate limiter over Postgres: one shared counter per address hash and window, so
 * every instance counts together. Only the keyed hash reaches the database.
 */
export function createPostgresDemoRateLimiter(db: Pick<Database, 'execute'>): DemoRateLimiter {
  return {
    hit: (addressHash, window) =>
      hitDemoRateLimit(db, {
        addressHash,
        windowSeconds: window.windowSeconds,
        limit: window.limit,
      }),
    purge: (limit) => purgeDemoRateCounters(db, limit),
  }
}

/** How many requests one client address may make, and over how long. */
export type DemoRateWindow = {
  /** The length of the window, in whole seconds. */
  windowSeconds: number
  /** The most requests allowed in one window. */
  limit: number
}

/**
 * Counts Demo Request submissions per client address. The address is never given to it: only a
 * keyed hash of it (32 bytes), so a stored counter cannot be turned back into an address.
 */
export interface DemoRateLimiter {
  /** Counts one request; true when it is within the limit, false when the limit is spent. */
  hit(addressHash: Uint8Array, window: DemoRateWindow): Promise<boolean>
  /** Deletes at most `limit` counters of windows that have ended; returns how many went. */
  purge(limit: number): Promise<number>
}

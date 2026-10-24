import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { API_KEY_DISPLAY_PREFIX_LENGTH, API_KEY_SECRET_PREFIX } from 'tula-closeline-contract'

/** Calls one key may make in one rate window. */
export const API_KEY_RATE_LIMIT = 600

/** The length, in seconds, of the fixed window the rate limit counts in. */
export const API_KEY_RATE_WINDOW_SECONDS = 60

/** A new secret: `clk_` and 43 URL-safe characters from 32 random bytes (256 bits). */
export function generateSecret(): string {
  return `${API_KEY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** The part of a secret that is stored in clear and shown in lists. */
export function displayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH)
}

/** The SHA-256 of a secret as 64 lowercase hex characters, the only form core stores. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Whether two 64-character hex hashes are equal, in constant time. */
export function hashesEqual(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, 'hex')
  const b = Buffer.from(presented, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

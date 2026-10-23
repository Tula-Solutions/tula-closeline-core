/** The E.164 shape the database accepts: `+`, then 7 to 15 digits, the first not zero. */
const E164 = /^\+[1-9][0-9]{6,14}$/

/** The shape the database accepts for a LinkedIn address (see `IDENTITY_VALUE_PATTERNS` in db). */
const LINKEDIN = /^linkedin\.com(\/[a-z0-9%._~-]+)+$/

/** The longest normalised LinkedIn address the database accepts, in characters. */
const MAX_LINKEDIN_LENGTH = 300

/**
 * Turns a typed phone number into E.164 (ADR 0011), or `undefined` when it cannot. Spaces,
 * parentheses, dots and dashes are dropped. A number must start with `+` and its country code:
 * guessing a country from the Organization would store a wrong number, so a national number is
 * refused instead.
 */
export function normalisePhone(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('+')) {
    return undefined
  }
  const digits = trimmed.slice(1).replace(/[\s().-]/g, '')
  if (!/^[0-9]+$/.test(digits)) {
    return undefined
  }
  const phone = `+${digits}`
  return E164.test(phone) ? phone : undefined
}

/**
 * Turns a typed LinkedIn profile address into its stored form (ADR 0011): lower case, no scheme,
 * no `www.` or other subdomain of `linkedin.com`, no query or fragment, no trailing slash. Returns
 * `undefined` for anything that is not a `linkedin.com` path.
 */
export function normaliseLinkedin(raw: string): string | undefined {
  let text = raw.trim().toLowerCase()
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const cut = text.search(/[?#]/)
  if (cut >= 0) {
    text = text.slice(0, cut)
  }
  const slash = text.indexOf('/')
  if (slash < 0) {
    return undefined
  }
  const host = text.slice(0, slash)
  if (host !== 'linkedin.com' && !/^[a-z0-9-]+\.linkedin\.com$/.test(host)) {
    return undefined
  }
  const path = text.slice(slash).replace(/\/+$/, '')
  const normalised = `linkedin.com${path}`
  return normalised.length <= MAX_LINKEDIN_LENGTH && LINKEDIN.test(normalised)
    ? normalised
    : undefined
}

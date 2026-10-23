import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type OrganizationId,
  organizationIdSchema,
  type ProspectId,
  prospectIdSchema,
} from 'tula-closeline-contract'

/** The channel an unsubscribe link covers; only email has a link. */
export const UNSUBSCRIBE_CHANNEL = 'email'

/** How long an unsubscribe link works: long enough for an old email, short enough to end. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000

/** Separates the signed fields; no id or number contains it. */
const SEPARATOR = '|'

/** The format and purpose of the signature, so a MAC made for another use never verifies here. */
const CONTEXT = 'closeline-unsubscribe-v1'

/** The length of an HMAC-SHA256 tag, in bytes. */
const MAC_BYTES = 32

/** What an unsubscribe link says: whose email, in which Organization, until when. Never an address. */
export type UnsubscribeClaims = {
  organizationId: OrganizationId
  prospectId: ProspectId
  channel: typeof UNSUBSCRIBE_CHANNEL
  expiresAt: Date
}

function sign(key: string, payload: Buffer): Buffer {
  return createHmac('sha256', key).update(CONTEXT).update('\0').update(payload).digest()
}

/**
 * Makes the token of an unsubscribe link: the Organization, the Prospect, the channel and the
 * expiry (whole seconds), signed with HMAC-SHA256 under `key`, as one base64url string. It holds
 * no address; the address is read from the Prospect when the link is used.
 */
export function mintUnsubscribeToken(key: string, claims: UnsubscribeClaims): string {
  const payload = Buffer.from(
    [
      claims.organizationId,
      claims.prospectId,
      claims.channel,
      String(Math.floor(claims.expiresAt.getTime() / 1000)),
    ].join(SEPARATOR),
    'utf8'
  )
  return Buffer.concat([payload, sign(key, payload)]).toString('base64url')
}

/**
 * The claims of a token if its signature holds, else `undefined`. The signature is compared in
 * constant time and checked before the payload is read. Expiry is not judged here.
 */
export function readUnsubscribeToken(key: string, token: string): UnsubscribeClaims | undefined {
  const raw = Buffer.from(token, 'base64url')
  if (raw.length <= MAC_BYTES) {
    return undefined
  }
  const payload = raw.subarray(0, raw.length - MAC_BYTES)
  const presented = raw.subarray(raw.length - MAC_BYTES)
  if (!timingSafeEqual(presented, sign(key, payload))) {
    return undefined
  }
  const [organizationId, prospectId, channel, expires, ...rest] = payload
    .toString('utf8')
    .split(SEPARATOR)
  const org = organizationIdSchema.safeParse(organizationId)
  const prospect = prospectIdSchema.safeParse(prospectId)
  const seconds = Number(expires)
  if (
    rest.length > 0 ||
    channel !== UNSUBSCRIBE_CHANNEL ||
    !org.success ||
    !prospect.success ||
    !Number.isSafeInteger(seconds)
  ) {
    return undefined
  }
  return {
    organizationId: org.data,
    prospectId: prospect.data,
    channel: UNSUBSCRIBE_CHANNEL,
    expiresAt: new Date(seconds * 1000),
  }
}

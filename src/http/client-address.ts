import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

/** The one bucket every request without a usable address shares, so a missing address is limited, not free. */
export const UNKNOWN_ADDRESS = 'unknown'

/** Expands an IPv6 address (already known to be valid) to its eight groups of 16 bits. */
function ipv6Groups(address: string): number[] {
  let text = address.split('%')[0] ?? address
  const embedded = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (embedded) {
    const [, a, b, c, d] = embedded.map(Number)
    text = `${text.slice(0, embedded.index)}${(((a ?? 0) << 8) | (b ?? 0)).toString(16)}:${(((c ?? 0) << 8) | (d ?? 0)).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const front = head === '' ? [] : head.split(':')
  const back = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? [] : new Array<string>(8 - front.length - back.length).fill('0')
  return [...front, ...fill, ...back].map((group) => Number.parseInt(group, 16))
}

/**
 * The canonical form of a client address: an IPv4 address as is, an IPv4-mapped IPv6 address as its
 * IPv4 address, and any other IPv6 address cut to its /64 network (a client owns a whole /64, so
 * counting single addresses would let it step around the limit). `undefined` when `value` is not
 * an IP address.
 */
export function canonicalAddress(value: string): string | undefined {
  const text = value.trim()
  const version = isIP(text)
  if (version === 4) {
    return text
  }
  if (version !== 6) {
    return undefined
  }
  const groups = ipv6Groups(text)
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
  if (mapped) {
    const high = groups[6] ?? 0
    const low = groups[7] ?? 0
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

/**
 * The address of the client that made a request. With `trustedProxyHops` at 0 it is the socket
 * address, and `X-Forwarded-For` is ignored whatever it says. At N above 0 it is the Nth entry from
 * the right of `X-Forwarded-For`: the entries the N trusted proxies appended are the only ones that
 * can be believed, so anything a client put to the left of them is never read. Fewer entries than
 * hops, or an entry that is not an IP address, gives {@link UNKNOWN_ADDRESS}.
 */
export function resolveClientAddress(input: {
  socketAddress: string | undefined
  forwardedFor: string | undefined
  trustedProxyHops: number
}): string {
  if (input.trustedProxyHops === 0) {
    return (input.socketAddress && canonicalAddress(input.socketAddress)) || UNKNOWN_ADDRESS
  }
  const entries = (input.forwardedFor ?? '').split(',')
  const entry = entries[entries.length - input.trustedProxyHops]
  if (entries.length < input.trustedProxyHops || entry === undefined) {
    return UNKNOWN_ADDRESS
  }
  return canonicalAddress(entry) ?? UNKNOWN_ADDRESS
}

/** The keyed hash of a client address: HMAC-SHA256 under `key`, 32 bytes. The address is not kept. */
export function hashClientAddress(address: string, key: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(address).digest())
}

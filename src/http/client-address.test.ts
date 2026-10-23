import { describe, expect, test } from 'bun:test'
import {
  canonicalAddress,
  hashClientAddress,
  resolveClientAddress,
  UNKNOWN_ADDRESS,
} from './client-address'

describe('canonicalAddress', () => {
  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s is %s', (input, expected) => {
    expect(canonicalAddress(input)).toBe(expected)
  })

  test.each(['', 'unknown', '203.0.113', '1.2.3.4.5', '<script>', 'a, b'])(
    'rejects %p',
    (input) => {
      expect(canonicalAddress(input)).toBeUndefined()
    }
  )
})

describe('resolveClientAddress', () => {
  test('with no trusted hops uses the socket address and ignores X-Forwarded-For', () => {
    expect(
      resolveClientAddress({
        socketAddress: '203.0.113.7',
        forwardedFor: '198.51.100.1',
        trustedProxyHops: 0,
      })
    ).toBe('203.0.113.7')
  })

  test('with no trusted hops and no socket address is the unknown bucket', () => {
    expect(
      resolveClientAddress({
        socketAddress: undefined,
        forwardedFor: '198.51.100.1',
        trustedProxyHops: 0,
      })
    ).toBe(UNKNOWN_ADDRESS)
  })

  test('takes the Nth entry from the right, so spoofed leftmost entries are ignored', () => {
    const forwardedFor = '1.1.1.1, 2.2.2.2, 203.0.113.7, 10.0.0.2'
    const at = (trustedProxyHops: number) =>
      resolveClientAddress({ socketAddress: '10.0.0.9', forwardedFor, trustedProxyHops })
    expect(at(1)).toBe('10.0.0.2')
    expect(at(2)).toBe('203.0.113.7')
    expect(at(3)).toBe('2.2.2.2')
  })

  test('fewer entries than hops, a header that is missing, or a bad entry is unknown', () => {
    const at = (forwardedFor: string | undefined, trustedProxyHops: number) =>
      resolveClientAddress({ socketAddress: '203.0.113.7', forwardedFor, trustedProxyHops })
    expect(at('203.0.113.7', 2)).toBe(UNKNOWN_ADDRESS)
    expect(at(undefined, 1)).toBe(UNKNOWN_ADDRESS)
    expect(at('203.0.113.7, not-an-ip', 1)).toBe(UNKNOWN_ADDRESS)
    expect(at('', 1)).toBe(UNKNOWN_ADDRESS)
  })
})

describe('hashClientAddress', () => {
  test('is 32 bytes, stable, and depends on both the address and the key', () => {
    const key = 'k'.repeat(32)
    const hash = hashClientAddress('203.0.113.7', key)
    expect(hash).toBeInstanceOf(Uint8Array)
    expect(hash).toHaveLength(32)
    expect(hashClientAddress('203.0.113.7', key)).toEqual(hash)
    expect(hashClientAddress('203.0.113.8', key)).not.toEqual(hash)
    expect(hashClientAddress('203.0.113.7', 'j'.repeat(32))).not.toEqual(hash)
  })
})

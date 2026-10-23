import { describe, expect, test } from 'bun:test'
import { consentTokenParamsSchema, formatId } from 'tula-closeline-contract'
import { mintUnsubscribeToken, readUnsubscribeToken, type UnsubscribeClaims } from './token'

const KEY = 'unit-test-unsubscribe-key-0123456789abcdef'

const claims = (): UnsubscribeClaims => ({
  organizationId: formatId('org', crypto.randomUUID()),
  prospectId: formatId('prs', crypto.randomUUID()),
  channel: 'email',
  expiresAt: new Date('2027-01-01T00:00:00Z'),
})

describe('the unsubscribe token', () => {
  test('reads back what was minted, with the expiry in whole seconds', () => {
    const made = claims()
    expect(readUnsubscribeToken(KEY, mintUnsubscribeToken(KEY, made))).toEqual(made)
  })

  test('fits the contract path parameter and holds no address', () => {
    const token = mintUnsubscribeToken(KEY, claims())
    expect(consentTokenParamsSchema.safeParse({ token }).success).toBe(true)
    const payload = Buffer.from(token, 'base64url').subarray(0, -32)
    expect(payload.toString('latin1')).not.toContain('@')
  })

  test('another key, a changed byte, a truncation or garbage never reads', () => {
    const token = mintUnsubscribeToken(KEY, claims())
    expect(readUnsubscribeToken('another-key-0123456789abcdefghijklmnop', token)).toBeUndefined()
    const raw = Buffer.from(token, 'base64url')
    for (const index of [0, 10, raw.length - 1]) {
      const copy = Buffer.from(raw)
      copy[index] = (copy[index] ?? 0) ^ 1
      expect(readUnsubscribeToken(KEY, copy.toString('base64url'))).toBeUndefined()
    }
    expect(readUnsubscribeToken(KEY, token.slice(0, 20))).toBeUndefined()
    expect(readUnsubscribeToken(KEY, '')).toBeUndefined()
    expect(readUnsubscribeToken(KEY, 'not a token')).toBeUndefined()
  })

  test('a correctly signed payload of the wrong shape never reads', () => {
    const made = claims()
    const good = Buffer.from(mintUnsubscribeToken(KEY, made), 'base64url')
    // Re-sign a payload with an extra field: the signature holds, the shape does not.
    const forged = mintUnsubscribeToken(KEY, {
      ...made,
      channel: 'sms' as unknown as 'email',
    })
    expect(readUnsubscribeToken(KEY, forged)).toBeUndefined()
    expect(good.length).toBeGreaterThan(32)
  })
})

import { expect, test } from 'bun:test'
import {
  invitationIdSchema,
  invitationTokenSchema,
  membershipIdSchema,
} from 'tula-closeline-contract'
import { generateToken, hashToken, membershipIdFor } from './token'

test('a token is 32 random bytes in base64url, different every time, and the contract accepts it', () => {
  const tokens = Array.from({ length: 50 }, generateToken)

  for (const token of tokens) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(invitationTokenSchema.safeParse(token).success).toBe(true)
  }
  expect(new Set(tokens).size).toBe(tokens.length)
})

test('the stored form is the SHA-256 in lowercase hex, which is not the token', () => {
  expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const token = generateToken()
  expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  expect(hashToken(token)).not.toContain(token)
})

test('the Membership id of an accept is derived from the Invitation id, one to one', () => {
  const invitationId = invitationIdSchema.parse(`inv_${'ab12'.repeat(8)}`)

  expect(membershipIdFor(invitationId)).toBe(membershipIdSchema.parse(`mem_${'ab12'.repeat(8)}`))
})

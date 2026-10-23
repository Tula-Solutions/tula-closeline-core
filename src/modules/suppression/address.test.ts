import { expect, test } from 'bun:test'
import { newOrganizationId } from '~/testing'
import { hashAddress, maskAddress, normaliseAddress } from './address'

const orgA = newOrganizationId()
const orgB = newOrganizationId()
const KEY = 'test-consent-hash-key-0123456789abcdef-A'

test.each([
  ['email', '  Ana@Example.COM ', 'ana@example.com'],
  ['email', 'ana@bücher.example', 'ana@xn--bcher-kva.example'],
  ['phone', '+1 (415) 555-0100', '+14155550100'],
  ['linkedin', 'https://www.linkedin.com/in/Ana-Lee/?x=1', 'linkedin.com/in/ana-lee'],
] as const)('normalises a %s address', (kind, raw, expected) => {
  expect(normaliseAddress(kind, raw)).toBe(expected)
})

test.each([
  ['email', 'not an email'],
  ['email', 'a@b@c.example'],
  ['phone', '415 555 0100'],
  ['linkedin', 'https://example.com/in/ana'],
] as const)('refuses an invalid %s address', (kind, raw) => {
  expect(normaliseAddress(kind, raw)).toBeUndefined()
})

test('the hash is 32 bytes, stable, and different per Organization, kind and address', () => {
  const base = hashAddress(KEY, orgA, 'email', 'ana@example.com')

  expect(base.length).toBe(32)
  expect(hashAddress(KEY, orgA, 'email', 'ana@example.com')).toEqual(base)
  expect(hashAddress(KEY, orgB, 'email', 'ana@example.com')).not.toEqual(base)
  expect(hashAddress(KEY, orgA, 'phone', 'ana@example.com')).not.toEqual(base)
  expect(hashAddress(KEY, orgA, 'email', 'bob@example.com')).not.toEqual(base)
  expect(hashAddress(`${KEY}x`, orgA, 'email', 'ana@example.com')).not.toEqual(base)
})

test.each([
  ['email', 'ana@example.com', 'a***@example.com'],
  ['phone', '+14155550100', '+*******0100'],
  ['linkedin', 'linkedin.com/in/ana-lee', 'linkedin.com/in/a***'],
] as const)('masks a %s address without revealing it', (kind, value, expected) => {
  expect(maskAddress(kind, value)).toBe(expected)
})

test('a mask never exceeds 100 characters', () => {
  const long = `${'a'.repeat(60)}@${'b'.repeat(120)}.example`

  expect(maskAddress('email', long).length).toBe(100)
})

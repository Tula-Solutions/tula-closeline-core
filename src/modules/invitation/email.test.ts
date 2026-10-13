import { expect, test } from 'bun:test'
import { requestEmailSchema, toAsciiDomain } from './email'

test.each([
  ['user@bücher.example', 'user@xn--bcher-kva.example'],
  ['User@BÜCHER.Example', 'User@xn--bcher-kva.example'],
  ['user@example.com', 'user@example.com'],
  ['user@EXAMPLE.com', 'user@EXAMPLE.com'],
  ['no-at-sign', 'no-at-sign'],
])('the domain of %s becomes %s', (input, expected) => {
  expect(toAsciiDomain(input)).toBe(expected)
})

test('an address with an internationalised domain is converted, then folded and validated', () => {
  expect(requestEmailSchema.parse('Ana@Bücher.Example')).toBe('ana@xn--bcher-kva.example')
})

test.each([
  ['a non-ASCII local part', 'bücher@example.com'],
  ['a space', 'a b@example.com'],
  ['two @', 'a@b@example.com'],
  ['a fullwidth @', 'a＠example.com'],
  ['no domain', 'a@'],
  ['a domain that cannot be converted', 'a@\u0000é'],
  ['a zero-width space in the local part', 'a\u200bb@example.com'],
])('%s is refused', (_name, input) => {
  expect(requestEmailSchema.safeParse(input).success).toBe(false)
})

test('a zero-width space in the domain is dropped by the conversion, so the stored address is plain ASCII', () => {
  expect(requestEmailSchema.parse('a@exam\u200bple.com')).toBe('a@example.com')
})

test('an address is folded the way the contract folds it: ASCII letters only', () => {
  expect(requestEmailSchema.parse('EA@Example.com')).toBe('ea@example.com')
})

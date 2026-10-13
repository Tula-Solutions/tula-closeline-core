import { expect, test } from 'bun:test'
import { requestEmailSchema, toAsciiDomain } from './email'
import { acceptInvitationBodySchema, createInvitationBodySchema } from './schema'

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

/** Inputs the URL parser would read as something other than the domain they were typed as. */
const SMUGGLED = [
  ['a path after an ASCII host', 'bob@gmail.com/é'],
  ['a fragment after an ASCII host', 'bob@gmail.com#é'],
  ['a query after an internationalised host', 'bob@é.com?x=1'],
  ['a percent escape', 'bob@é.com%41'],
  ['a backslash', 'bob@é.com\\x'],
  ['a port', 'bob@é.com:80'],
  ['a bracketed host', 'bob@[é].com'],
  ['a closing bracket', 'bob@é.com]'],
  ['a space', 'bob@é .com'],
  ['a tab', 'bob@é\t.com'],
  ['a line feed', 'bob@é\n.com'],
  ['a control character', 'bob@é\u0001.com'],
  ['a zero-width space', 'a@exam\u200bple.com'],
  ['a soft hyphen', 'a@exam\u00adple.com'],
  ['a fullwidth letter', 'a@\uff45xample.com'],
] as const

const USER_ID = 'usr_00000000000040008000000000000001'
const TOKEN = 'a'.repeat(43)

test.each(SMUGGLED)('%s is refused by the create and the accept schemas', (_name, input) => {
  expect(requestEmailSchema.safeParse(input).success).toBe(false)
  expect(createInvitationBodySchema.safeParse({ email: input, role: 'rep' }).success).toBe(false)
  expect(
    acceptInvitationBodySchema.safeParse({
      userId: USER_ID,
      email: input,
      invitationToken: TOKEN,
    }).success
  ).toBe(false)
})

test.each([
  ['ana@bücher.example', 'ana@xn--bcher-kva.example'],
  ['Ana@BÜCHER.Example', 'ana@xn--bcher-kva.example'],
  ['x@münchen.de', 'x@xn--mnchen-3ya.de'],
  ['x@straße.de', 'x@xn--strae-oqa.de'],
  ['x@例え.jp', 'x@xn--r8jz45g.jp'],
  ['x@ПРИМЕР.рф', 'x@xn--e1afmkfd.xn--p1ai'],
  ['x@sub.bücher.example', 'x@sub.xn--bcher-kva.example'],
])('the legitimate internationalised address %s still passes on both schemas', (input, stored) => {
  expect(requestEmailSchema.parse(input)).toBe(stored)
  expect(createInvitationBodySchema.parse({ email: input, role: 'rep' }).email).toBe(stored)
  expect(
    acceptInvitationBodySchema.parse({ userId: USER_ID, email: input, invitationToken: TOKEN })
      .email
  ).toBe(stored)
})

test('an address is folded the way the contract folds it: ASCII letters only', () => {
  expect(requestEmailSchema.parse('EA@Example.com')).toBe('ea@example.com')
})

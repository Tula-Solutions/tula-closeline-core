import { expect, test } from 'bun:test'
import { invitationLink } from './link'

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abc'

test('the token is in the fragment of the sign-up page, and nowhere else', () => {
  const url = new URL(invitationLink('https://app.example.com', TOKEN))

  expect(url.origin).toBe('https://app.example.com')
  expect(url.pathname).toBe('/sign-up')
  expect(url.search).toBe('')
  expect(url.hash).toBe(`#invitation=${TOKEN}`)
  expect(url.pathname + url.search).not.toContain(TOKEN)
})

test.each([
  ['https://app.example.com/', 'https://app.example.com/sign-up#invitation='],
  ['https://app.example.com/portal', 'https://app.example.com/portal/sign-up#invitation='],
  ['https://app.example.com/portal/', 'https://app.example.com/portal/sign-up#invitation='],
  ['http://127.0.0.1:3002', 'http://127.0.0.1:3002/sign-up#invitation='],
])('a base of %s gives %s and the token', (base, prefix) => {
  expect(invitationLink(base, TOKEN)).toBe(`${prefix}${TOKEN}`)
})

test('a token with a character outside the URL-safe set is encoded, not injected', () => {
  const url = new URL(invitationLink('https://app.example.com', 'a#b&c=d'))

  expect(url.hash).toBe('#invitation=a%23b%26c%3Dd')
})

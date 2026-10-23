import { expect, test } from 'bun:test'
import { normaliseLinkedin, normalisePhone } from './normalise'

test.each([
  ['+1 (415) 555-0100', '+14155550100'],
  ['+44 20.7946.0958', '+442079460958'],
  ['  +49-30-901820 ', '+4930901820'],
])('the phone %s becomes %s', (raw, expected) => {
  expect(normalisePhone(raw)).toBe(expected)
})

test.each([
  ['a national number with no country code', '(415) 555-0100'],
  ['a number with a leading zero country code', '+0123456789'],
  ['too short', '+12345'],
  ['too long', '+1234567890123456'],
  ['a plus inside', '+1415+5550100'],
  ['letters', '+1415555ABCD'],
])('a phone that is %s is refused', (_name, raw) => {
  expect(normalisePhone(raw)).toBeUndefined()
})

test.each([
  ['https://www.linkedin.com/in/Jane-Doe/', 'linkedin.com/in/jane-doe'],
  ['http://linkedin.com/in/jane-doe?utm_source=x#top', 'linkedin.com/in/jane-doe'],
  ['LinkedIn.com/in/jane-doe///', 'linkedin.com/in/jane-doe'],
  ['https://uk.linkedin.com/in/jane-doe', 'linkedin.com/in/jane-doe'],
  ['linkedin.com/company/acme%20inc', 'linkedin.com/company/acme%20inc'],
])('the LinkedIn address %s becomes %s', (raw, expected) => {
  expect(normaliseLinkedin(raw)).toBe(expected)
})

test.each([
  ['another host', 'https://notlinkedin.com/in/jane'],
  ['a host that only ends in the name', 'https://evil-linkedin.com/in/jane'],
  ['the host name inside the path', 'https://example.com/linkedin.com/in/jane'],
  ['no path', 'https://linkedin.com'],
  ['a bare slash', 'https://linkedin.com/'],
  ['a space in the path', 'https://linkedin.com/in/jane doe'],
  ['a path past the length limit', `linkedin.com/in/${'a'.repeat(300)}`],
])('a LinkedIn address with %s is refused', (_name, raw) => {
  expect(normaliseLinkedin(raw)).toBeUndefined()
})

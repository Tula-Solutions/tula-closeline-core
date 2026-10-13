import { describe, expect, test } from 'bun:test'
import type { InvitationMessage } from '~/ports/invitation-mailer'
import { renderInvitationEmail } from './invitation-email'

const BASE: InvitationMessage = {
  email: 'a@example.com',
  role: 'rep',
  organizationName: 'Acme',
  token: 'tok',
  link: 'https://app.test/sign-up#invitation=tok',
  expiresAt: new Date('2026-02-01T00:00:00Z'),
}

/** The character with the given code point, so an invisible one is readable in the table. */
const U = (hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))

const render = (organizationName: string, link = BASE.link) =>
  renderInvitationEmail({ ...BASE, organizationName, link })

/** Whether `text` holds a surrogate that is not half of a pair. */
function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
}

describe('the subject', () => {
  test('quotes the Organization name', () => {
    expect(render('Acme').subject).toBe('You are invited to join "Acme" on Closeline')
  })

  test.each([
    ['a right-to-left override U+202E', `ab${U('202E')}cd`, 'abcd'],
    ['U+202A to U+202D', `a${U('202A')}b${U('202B')}c${U('202C')}d${U('202D')}e`, 'abcde'],
    [
      'the isolates U+2066 to U+2069',
      `a${U('2066')}b${U('2067')}c${U('2068')}d${U('2069')}e`,
      'abcde',
    ],
    ['a zero-width space U+200B', `a${U('200B')}b`, 'ab'],
    ['a zero-width joiner and non-joiner', `a${U('200C')}b${U('200D')}c`, 'abc'],
    ['the directional marks U+200E and U+200F', `a${U('200E')}b${U('200F')}c`, 'abc'],
    ['a byte order mark U+FEFF', `${U('FEFF')}Acme`, 'Acme'],
    ['a word joiner U+2060', `a${U('2060')}b`, 'ab'],
    ['a soft hyphen U+00AD', `a${U('00AD')}b`, 'ab'],
    ['a line separator U+2028', `a${U('2028')}b`, 'a b'],
    ['a paragraph separator U+2029', `a${U('2029')}b`, 'a b'],
    ['a C1 control U+0085', 'a\u0085b', 'a b'],
    ['the last C1 control U+009F', 'a\u009Fb', 'a b'],
    ['a carriage return and line feed', 'a\r\nBcc: x@evil.test', 'a Bcc: x@evil.test'],
    ['a tab, a vertical tab and a form feed', 'a\tb\vc\fd', 'a b c d'],
    ['a NUL', 'a\u0000b', 'a b'],
    ['a run of spaces and controls at the ends', ' \n Acme \r ', 'Acme'],
  ])('flattens %s', (_name, name, expected) => {
    const email = render(name)

    expect(email.subject).toBe(`You are invited to join "${expected}" on Closeline`)
    expect(email.text).toContain(`join ${expected} on Closeline`)
    expect(email.html).toContain(`<bdi>${expected}</bdi>`)
    expect(email.subject).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u)
  })

  test.each([
    ['nothing', ''],
    ['only U+200B', `${U('200B')}`],
    ['only a bidi override and an isolate', `${U('202E')}${U('2066')}`],
    ['only controls and spaces', ` \r\n\t${U('2028')} `],
  ])('uses a neutral phrase for a name that is %s', (_name, name) => {
    const email = render(name)

    expect(email.subject).toBe('You are invited to join an Organization on Closeline')
    expect(email.text).toContain('join an Organization on Closeline as rep')
    expect(email.html).toContain('<strong>an Organization</strong>')
    expect(email.subject).not.toContain('  ')
  })

  test('cuts a long name by code point, never leaving half of an emoji', () => {
    const name = `${'x'.repeat(79)}\u{1F600}tail`

    const { subject } = render(name)

    expect(hasLoneSurrogate(subject)).toBe(false)
    expect(subject).toBe(`You are invited to join "${'x'.repeat(79)}\u{1F600}..." on Closeline`)
  })

  test('keeps a name of exactly 80 code points whole', () => {
    const name = `${'x'.repeat(79)}\u{1F600}`

    expect(render(name).subject).toBe(`You are invited to join "${name}" on Closeline`)
  })

  test('does not reach 80 code points by counting UTF-16 units', () => {
    const name = '\u{1F600}'.repeat(80)

    expect(render(name).subject).toBe(`You are invited to join "${name}" on Closeline`)
  })
})

describe('the HTML', () => {
  test('escapes the name, wraps it in <bdi> and escapes the apostrophe', () => {
    const { html } = render(`O'Neil <b>&</b> "Co"`)

    expect(html).toContain(
      '<strong><bdi>O&#39;Neil &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;</bdi></strong>'
    )
    expect(html).not.toContain('<b>')
  })

  test('a link with quotes and an ampersand stays inside the attribute', () => {
    const { html } = render('Acme', `https://app.test/sign-up?a=1&b="x"'y'#invitation=t`)

    expect(html).toContain(
      'href="https://app.test/sign-up?a=1&amp;b=&quot;x&quot;&#39;y&#39;#invitation=t"'
    )
    expect(html.match(/href="/g)).toHaveLength(1)
  })
})

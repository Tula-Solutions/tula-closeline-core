import { describe, expect, test } from 'bun:test'
import type { TeamNotice } from '~/ports/team-notice-mailer'
import { renderTeamNoticeEmail } from './team-notice-email'

const BASE: TeamNotice = {
  to: 'team@closeline.test',
  id: 'dreq_0190a7e0-0000-7000-8000-000000000000',
  name: 'Ada Visitor',
  workEmail: 'ada@example.test',
  companyName: 'Acme',
  message: 'Please call us.',
  sourcePage: '/pricing',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
}

const render = (changes: Partial<TeamNotice>) => renderTeamNoticeEmail({ ...BASE, ...changes })

describe('renderTeamNoticeEmail', () => {
  test('names the company in the subject and every field in the bodies', () => {
    const email = render({})
    expect(email.subject).toBe('Demo Request from Acme')
    for (const part of ['Ada Visitor', 'ada@example.test', 'Acme', '/pricing', 'Please call us.']) {
      expect(email.text).toContain(part)
      expect(email.html).toContain(part)
    }
    expect(email.text).toContain('2026-01-01T00:00:00.000Z')
  })

  test('escapes every Visitor field in the HTML, so markup stays text', () => {
    const attack = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&'
    const email = render({
      name: attack,
      workEmail: attack,
      companyName: attack,
      message: attack,
      sourcePage: attack,
    })
    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('<img')
    expect(email.html).toContain('&lt;script&gt;')
    expect(email.html.match(/&lt;img/g)?.length).toBe(5)
  })

  test('keeps the subject to one line of at most 80 code points of the company', () => {
    const email = render({ companyName: `Bad\r\nBcc: x@evil.test ${'é'.repeat(200)}` })
    expect(email.subject).not.toMatch(/[\r\n]/)
    expect(Array.from(email.subject).length).toBeLessThanOrEqual(
      'Demo Request from '.length + 80 + 3
    )
  })

  test('strips direction overrides and invisible characters from the message', () => {
    const email = render({ message: 'a‮b​c\r\nd\u0007e' })
    expect(email.text).toContain('abc\nd e')
    expect(email.html).not.toContain('‮')
  })

  test('says so when there is no message, and neutrally when the company is blank', () => {
    const email = render({ message: null, companyName: '​ ' })
    expect(email.text).toContain('(none)')
    expect(email.html).toContain('(none)')
    expect(email.subject).toBe('Demo Request from a new company')
  })
})

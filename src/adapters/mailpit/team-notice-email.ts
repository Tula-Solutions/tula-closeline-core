import type { TeamNotice } from '~/ports/team-notice-mailer'
import { cleanName, escapeHtml } from './invitation-email'

/** The most code points of the company name put into the subject; the rest is cut. */
const MAX_COMPANY_IN_SUBJECT = 80

/** What the subject says when the company name has nothing printable in it. */
const NEUTRAL_COMPANY = 'a new company'

/**
 * Makes an untrusted multi-line text safe to show: format characters (the bidirectional
 * overrides, zero-width characters) are removed, controls other than a line feed or a tab become
 * a space (a carriage return first becomes a line feed).
 */
function cleanMessage(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) =>
      character === '\n' || character === '\t' ? character : ' '
    )
    .trim()
}

/** The subject, text and HTML of a team notice. The bodies hold the Visitor's fields: never log them. */
export type TeamNoticeEmail = { subject: string; text: string; html: string }

/**
 * Renders the mail that tells the team about a Demo Request. Every Visitor field is untrusted
 * text: the subject is one cleaned line, cut by code point; the text body is plain; the HTML
 * escapes every field and shows the message in a `<pre>`. Nothing in it is a link the Visitor
 * chose, and nothing is treated as an instruction.
 */
export function renderTeamNoticeEmail(notice: TeamNotice): TeamNoticeEmail {
  const company = cleanName(notice.companyName)
  const points = Array.from(company)
  const shortCompany =
    points.length > MAX_COMPANY_IN_SUBJECT
      ? `${points.slice(0, MAX_COMPANY_IN_SUBJECT).join('')}...`
      : company
  const name = cleanName(notice.name)
  const email = cleanName(notice.workEmail)
  const page = cleanName(notice.sourcePage)
  const message = notice.message === null ? '' : cleanMessage(notice.message)
  const received = notice.submittedAt.toISOString()

  const text = [
    `A Demo Request came in (${notice.id}).`,
    '',
    `Name: ${name}`,
    `Work email: ${email}`,
    `Company: ${company}`,
    `Page: ${page}`,
    `Received: ${received}`,
    '',
    'Message:',
    message === '' ? '(none)' : message,
  ].join('\n')

  const row = (label: string, value: string) =>
    `<tr><th align="left">${label}</th><td>${escapeHtml(value)}</td></tr>`
  const html =
    `<p>A Demo Request came in (${escapeHtml(notice.id)}).</p>` +
    `<table>${row('Name', name)}${row('Work email', email)}${row('Company', company)}` +
    `${row('Page', page)}${row('Received', received)}</table>` +
    `<p>Message:</p><pre>${message === '' ? '(none)' : escapeHtml(message)}</pre>`

  return {
    subject: `Demo Request from ${shortCompany === '' ? NEUTRAL_COMPANY : shortCompany}`,
    text,
    html,
  }
}

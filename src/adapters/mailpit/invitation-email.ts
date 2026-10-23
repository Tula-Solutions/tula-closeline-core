import type { InvitationMessage } from '~/ports/invitation-mailer'

/** The most code points of an Organization name put into the subject; the rest is cut. */
const MAX_NAME_IN_SUBJECT = 80

/** What the email says when the name is empty once its invisible characters are gone. */
const NEUTRAL_NAME = 'an Organization'

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Makes an untrusted name safe to show on one line. Format characters (`Cf`: the bidirectional
 * overrides and isolates U+202A to U+202E and U+2066 to U+2069, zero-width characters, U+FEFF, the
 * soft hyphen) are removed, since they print nothing but can reorder or hide the text around them.
 * Controls (`Cc`, so CR, LF and the C1 range) and the line and paragraph separators (`Zl`, `Zp`) are
 * replaced by a space, then runs of spaces collapse. The result is empty when nothing printable is
 * left.
 */
export function cleanName(value: string): string {
  return value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** The first {@link MAX_NAME_IN_SUBJECT} code points of `name`, with `...` when it was cut. */
function cutForSubject(name: string): string {
  const points = Array.from(name)
  return points.length > MAX_NAME_IN_SUBJECT
    ? `${points.slice(0, MAX_NAME_IN_SUBJECT).join('')}...`
    : name
}

/** The subject, text and HTML of an Invitation email. Both bodies hold the link, a secret: never log them. */
export type InvitationEmail = { subject: string; text: string; html: string }

/**
 * Renders the email that invites someone to an Organization. The Organization's name is untrusted
 * text: it is cleaned by {@link cleanName} (a name with nothing printable left becomes "an
 * Organization"), quoted and cut by code point in the subject, and escaped and wrapped in `<bdi>`
 * in the HTML. Encoding the subject for the wire (RFC 2047 for non-ASCII text) is the provider
 * adapter's job, not this renderer's.
 */
export function renderInvitationEmail(message: InvitationMessage): InvitationEmail {
  const name = cleanName(message.organizationName)
  const expires = message.expiresAt.toISOString()
  const text =
    `You have been invited to join ${name || NEUTRAL_NAME} on Closeline as ${message.role}.\n\n` +
    `Accept the invitation: ${message.link}\n\n` +
    `The invitation expires at ${expires}. If you did not expect it, ignore this email.`
  const shownName = name === '' ? NEUTRAL_NAME : `<bdi>${escapeHtml(name)}</bdi>`
  const html =
    `<p>You have been invited to join <strong>${shownName}</strong> on Closeline as ${escapeHtml(message.role)}.</p>` +
    `<p><a href="${escapeHtml(message.link)}">Accept the invitation</a></p>` +
    `<p>The invitation expires at ${escapeHtml(expires)}. If you did not expect it, ignore this email.</p>`
  const subjectName = name === '' ? NEUTRAL_NAME : `"${cutForSubject(name)}"`
  return { subject: `You are invited to join ${subjectName} on Closeline`, text, html }
}

import type { InvitationMessage } from '~/ports/invitation-mailer'

/** The longest Organization name put into a subject line; the rest is cut. */
const MAX_NAME_IN_SUBJECT = 80

/** Escapes text for HTML element content and double-quoted attributes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Whether `code` is a control character or a Unicode line or paragraph separator. */
function isBreaking(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

/** Replaces control characters and line breaks, so an untrusted name cannot split a header. */
function singleLine(value: string): string {
  let out = ''
  for (const character of value) {
    out += isBreaking(character.codePointAt(0) ?? 0) ? ' ' : character
  }
  return out.replace(/ {2,}/g, ' ').trim()
}

/** The subject, text and HTML of an Invitation email. Both bodies hold the link, a secret: never log them. */
export type InvitationEmail = { subject: string; text: string; html: string }

/**
 * Renders the email that invites someone to an Organization. The Organization's name is untrusted
 * text: it is flattened to one line in the subject and escaped in the HTML.
 */
export function renderInvitationEmail(message: InvitationMessage): InvitationEmail {
  const name = singleLine(message.organizationName)
  const subjectName =
    name.length > MAX_NAME_IN_SUBJECT ? `${name.slice(0, MAX_NAME_IN_SUBJECT)}...` : name
  const expires = message.expiresAt.toISOString()
  const text =
    `You have been invited to join ${name} on Closeline as ${message.role}.\n\n` +
    `Accept the invitation: ${message.link}\n\n` +
    `The invitation expires at ${expires}. If you did not expect it, ignore this email.`
  const html =
    `<p>You have been invited to join <strong>${escapeHtml(name)}</strong> on Closeline as ${escapeHtml(message.role)}.</p>` +
    `<p><a href="${escapeHtml(message.link)}">Accept the invitation</a></p>` +
    `<p>The invitation expires at ${escapeHtml(expires)}. If you did not expect it, ignore this email.</p>`
  return { subject: `You are invited to join ${subjectName} on Closeline`, text, html }
}

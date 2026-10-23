import type { InvitationMailer, InvitationMessage } from '~/ports/invitation-mailer'
import { renderInvitationEmail } from './invitation-email'
import { createMailpitSender, type MailpitSenderOptions } from './sender'

export {
  attemptTimeoutFor,
  MAIL_ATTEMPT_TIMEOUT_MS,
  MAIL_MAX_ATTEMPTS,
  MAIL_RETRY_DELAY_MAX_MS,
  MailDeliveryFailed,
} from './sender'

/** The sender address of a local deployment: under the reserved `.test` domain (RFC 6761). */
export const DEFAULT_LOCAL_MAIL_FROM = 'no-reply@closeline.test'

/** Options for {@link createMailpitInvitationMailer}. */
export type MailpitInvitationMailerOptions = MailpitSenderOptions & {
  /** The `From` address of every message. */
  from: string
}

/**
 * An Invitation mailer for local development: renders the Invitation email and hands it to a
 * Mailpit mailbox over its HTTP send API (`POST /api/v1/send`, a JSON body of `From`, `To`,
 * `Subject`, `Text` and `HTML`). The mailbox catches mail and never delivers it, so nothing leaves
 * the machine. Timeout, retry and logging rules are those of {@link createMailpitSender}.
 */
export function createMailpitInvitationMailer(
  options: MailpitInvitationMailerOptions
): InvitationMailer {
  const send = createMailpitSender(options)
  return {
    async deliver(message: InvitationMessage, signal: AbortSignal): Promise<void> {
      const email = renderInvitationEmail(message)
      await send(
        JSON.stringify({
          From: { Email: options.from },
          To: [{ Email: message.email }],
          Subject: email.subject,
          Text: email.text,
          HTML: email.html,
        }),
        signal
      )
    },
  }
}

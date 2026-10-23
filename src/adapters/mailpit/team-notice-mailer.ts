import type { TeamNotice, TeamNoticeMailer } from '~/ports/team-notice-mailer'
import { createMailpitSender, type MailpitSenderOptions } from './sender'
import { renderTeamNoticeEmail } from './team-notice-email'

/** Options for {@link createMailpitTeamNoticeMailer}. */
export type MailpitTeamNoticeMailerOptions = MailpitSenderOptions & {
  /** The `From` address of every notice. */
  from: string
}

/**
 * A team notice mailer for local development: renders the notice and hands it to a Mailpit mailbox,
 * with the timeout, bounded jittered retry and no-logging rules of {@link createMailpitSender}.
 */
export function createMailpitTeamNoticeMailer(
  options: MailpitTeamNoticeMailerOptions
): TeamNoticeMailer {
  const send = createMailpitSender(options)
  return {
    async deliver(notice: TeamNotice, signal: AbortSignal): Promise<void> {
      const email = renderTeamNoticeEmail(notice)
      await send(
        JSON.stringify({
          From: { Email: options.from },
          To: [{ Email: notice.to }],
          Subject: email.subject,
          Text: email.text,
          HTML: email.html,
        }),
        signal
      )
    },
  }
}

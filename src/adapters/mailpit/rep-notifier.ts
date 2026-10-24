import type { RepNotice, RepNotifier } from '~/ports/rep-notifier'
import { createMailpitSender, type MailpitSenderOptions } from './sender'

/** Options for {@link createMailpitRepNotifier}. */
export type MailpitRepNotifierOptions = MailpitSenderOptions & {
  /** The `From` address of every notice. */
  from: string
  /** Handles the notices that are not emails, such as a reply during a takeover. */
  fallback: RepNotifier
}

/** The subject of an escalation email: fixed, so it never carries a Message. */
export const ESCALATION_EMAIL_SUBJECT = 'A conversation needs your attention'

/**
 * A Rep notifier for local development: an escalation goes to the Rep's address through a Mailpit
 * mailbox with the timeout, bounded jittered retry and no-logging rules of
 * {@link createMailpitSender}; every other notice goes to the fallback. The mail holds core's fixed
 * sentence and no Message body.
 */
export function createMailpitRepNotifier(options: MailpitRepNotifierOptions): RepNotifier {
  const send = createMailpitSender(options)
  return {
    async notify(notice: RepNotice, signal: AbortSignal): Promise<void> {
      if (notice.kind !== 'conversation_escalated') {
        return options.fallback.notify(notice, signal)
      }
      await send(
        JSON.stringify({
          From: { Email: options.from },
          To: [{ Email: notice.email }],
          Subject: ESCALATION_EMAIL_SUBJECT,
          Text: notice.text,
        }),
        signal
      )
    },
  }
}

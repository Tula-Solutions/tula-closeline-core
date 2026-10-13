import type { InvitationMailer, InvitationMessage } from '~/ports/invitation-mailer'

/** Invitation mailer that keeps messages in memory so tests can read what was "sent". */
export type MemoryInvitationMailer = InvitationMailer & {
  /** Every message handed over, oldest first. */
  outbox: InvitationMessage[]
  /** Simulates the mail system being down: `deliver` rejects while true. */
  failing: boolean
  /** Simulates a mail system that never answers: `deliver` waits for the abort signal. */
  hanging: boolean
  /** The most recent message; throws when nothing was sent. */
  last(): InvitationMessage
}

/** Builds the in-memory invitation mailer. */
export function createMemoryInvitationMailer(): MemoryInvitationMailer {
  const mailer: MemoryInvitationMailer = {
    outbox: [],
    failing: false,
    hanging: false,
    deliver: async (message, signal) => {
      if (mailer.hanging) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (mailer.failing) {
        throw new Error('mail system unavailable')
      }
      mailer.outbox.push(message)
    },
    last: () => {
      const message = mailer.outbox.at(-1)
      if (!message) {
        throw new Error('no invitation was sent')
      }
      return message
    },
  }
  return mailer
}

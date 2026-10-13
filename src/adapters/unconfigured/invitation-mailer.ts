import type { InvitationMailer } from '~/ports/invitation-mailer'

/** Thrown by the invitation mailer of a deployment with no mail provider configured. */
export class InvitationMailerNotConfigured extends Error {
  constructor() {
    super('no mail provider is configured')
    this.name = 'InvitationMailerNotConfigured'
  }
}

/** An invitation mailer that refuses to send; the runtime default until a provider is chosen (as in the auth service). */
export function createUnconfiguredInvitationMailer(): InvitationMailer {
  return {
    async deliver() {
      throw new InvitationMailerNotConfigured()
    },
  }
}

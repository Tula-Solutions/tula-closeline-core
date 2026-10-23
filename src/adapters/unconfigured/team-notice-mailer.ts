import type { TeamNoticeMailer } from '~/ports/team-notice-mailer'

/** Thrown by the team notice mailer of a deployment with no mail provider configured. */
export class TeamNoticeMailerNotConfigured extends Error {
  constructor() {
    super('no mail provider is configured')
    this.name = 'TeamNoticeMailerNotConfigured'
  }
}

/** A team notice mailer that refuses to send; the runtime default until a provider is chosen. */
export function createUnconfiguredTeamNoticeMailer(): TeamNoticeMailer {
  return {
    async deliver() {
      throw new TeamNoticeMailerNotConfigured()
    },
  }
}

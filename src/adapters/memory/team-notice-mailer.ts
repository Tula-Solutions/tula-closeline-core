import type { TeamNotice, TeamNoticeMailer } from '~/ports/team-notice-mailer'

/** Team notice mailer that keeps notices in memory so tests can read what was "sent". */
export type MemoryTeamNoticeMailer = TeamNoticeMailer & {
  /** Every notice handed over, oldest first. */
  outbox: TeamNotice[]
  /** Simulates the mail system being down: `deliver` rejects while true. */
  failing: boolean
}

/** Builds the in-memory team notice mailer. */
export function createMemoryTeamNoticeMailer(): MemoryTeamNoticeMailer {
  const mailer: MemoryTeamNoticeMailer = {
    outbox: [],
    failing: false,
    deliver: async (notice) => {
      if (mailer.failing) {
        throw new Error('mail system unavailable')
      }
      mailer.outbox.push(notice)
    },
  }
  return mailer
}

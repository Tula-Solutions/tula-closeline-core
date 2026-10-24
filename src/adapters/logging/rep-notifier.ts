import type { Logger } from 'tula-closeline-kit'
import type { RepNotifier } from '~/ports/rep-notifier'

/**
 * Rep notifier that writes the notice, ids only, to the log. It stands in until the Rep's email
 * goes out through the mail port (the Rep's address is not held by core yet).
 */
export function createLoggingRepNotifier(logger: Pick<Logger, 'info'>): RepNotifier {
  return {
    notify: async (notice) => {
      logger.info('rep.notice', {
        kind: notice.kind,
        organizationId: notice.organizationId,
        membershipId: notice.membershipId,
        conversationId: notice.conversationId,
        messageId: notice.messageId,
      })
    },
  }
}

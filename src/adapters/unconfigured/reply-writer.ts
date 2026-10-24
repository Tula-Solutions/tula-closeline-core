import type { ReplyWriter } from '~/ports/reply-writer'

/** A writer for an environment with no model wired in: it always throws, so the Conversation is escalated and nothing is invented. */
export function createUnconfiguredReplyWriter(): ReplyWriter {
  return {
    write: async () => {
      throw new Error('No reply writer is configured for this environment')
    },
  }
}

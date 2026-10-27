import type { ConversationSummarizer } from '~/ports/conversation-summarizer'

/** A summarizer for an environment with no model wired in: it always throws, so no summary is stored and nothing is invented. */
export function createUnconfiguredConversationSummarizer(): ConversationSummarizer {
  return {
    summarize: async () => {
      throw new Error('No conversation summarizer is configured for this environment')
    },
  }
}

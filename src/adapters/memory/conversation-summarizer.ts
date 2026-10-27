import type { ConversationSummarizer } from '~/ports/conversation-summarizer'

/** A deterministic summarizer for local runs and tests: it counts the Messages and labels the Conversation `open`. */
export function createMemoryConversationSummarizer(): ConversationSummarizer {
  return {
    summarize: async (input) => ({
      summary: `A Conversation of ${input.fencedMessages.length} Message(s).`,
      outcomeLabel: 'open',
    }),
  }
}

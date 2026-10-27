/** What the summarizer is given: the Conversation's Messages, oldest first, each body already fenced as untrusted data. */
export type ConversationToSummarize = {
  /** One fenced block per Message (see `fenceUntrusted`), prefixed by who wrote it. */
  fencedMessages: string[]
}

/**
 * Writes a short summary and an Outcome label for a Conversation. It returns whatever the model
 * said, untrusted: the caller narrows it to a bounded text and one label from a closed set. It
 * throws when the model is unreachable or `signal` aborts.
 */
export interface ConversationSummarizer {
  /** Summarizes a Conversation; aborts when `signal` does. */
  summarize(input: ConversationToSummarize, signal: AbortSignal): Promise<unknown>
}

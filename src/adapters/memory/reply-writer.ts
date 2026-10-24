import type { ReplyWriter } from '~/ports/reply-writer'

/** A deterministic writer for local runs and tests: it answers from the first moment it is given and cites it. */
export function createMemoryReplyWriter(): ReplyWriter {
  return {
    write: async (input) => {
      const first = input.moments[0]
      return {
        body: first
          ? 'Thanks for raising that. Here is how we have handled it before.'
          : 'Thanks for raising that. Let me find the best way to answer it.',
        strategy: `Answer the ${input.label} the way won Deals did.`,
        confidence: first ? 0.8 : 0.3,
        citedIds: first ? [first.id] : [],
      }
    },
  }
}

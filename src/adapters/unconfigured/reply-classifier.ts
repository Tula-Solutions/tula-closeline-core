import type { ReplyClassifier } from '~/ports/reply-classifier'

/** A classifier for an environment with no model wired in: it always throws, so the job is retried and nothing is mislabelled. */
export function createUnconfiguredReplyClassifier(): ReplyClassifier {
  return {
    classify: async () => {
      throw new Error('No reply classifier is configured for this environment')
    },
  }
}

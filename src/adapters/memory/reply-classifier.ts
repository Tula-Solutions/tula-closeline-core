import type { ReplyClassifier } from '~/ports/reply-classifier'

const RULES: readonly (readonly [RegExp, string])[] = [
  [/unsubscribe|stop emailing|remove me/i, 'unsubscribe'],
  [/undeliverable|delivery failed|mailer-daemon/i, 'bounce'],
  [/out of office|on vacation|auto-?reply/i, 'out_of_office'],
  [/wrong person/i, 'wrong_person'],
  [/not interested|no thanks/i, 'negative'],
  [/not now|next quarter|maybe later/i, 'not_now'],
  [/\?/, 'question'],
  [/interested|sounds (good|great)|let'?s talk|tell me more/i, 'positive'],
  [/concern|too expensive|already (have|use)/i, 'objection'],
]

/** A deterministic keyword classifier for local runs and tests; anything it does not know is `other`. */
export function createMemoryReplyClassifier(): ReplyClassifier {
  return {
    classify: async (reply) => {
      const hit = RULES.find(([pattern]) => pattern.test(reply.body))
      return { label: hit?.[1] ?? 'other', confidence: hit ? 0.9 : 0.5 }
    },
  }
}

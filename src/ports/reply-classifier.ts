/** What the classifier is shown: one inbound reply and the channel it came on. */
export type ReplyToClassify = {
  body: string
  channel: 'email' | 'linkedin' | 'chat'
}

/**
 * Labels one reply. It returns whatever the model said, untrusted: the caller narrows it to the
 * closed set of labels, so an unknown or malformed answer can never become anything else. It may
 * add `signals` (`asks_for_person`, `pricing_or_legal`); unknown names are dropped. It
 * throws when the model is unreachable, and the job is then retried.
 */
export interface ReplyClassifier {
  /** Classifies a reply; aborts when `signal` does. */
  classify(reply: ReplyToClassify, signal: AbortSignal): Promise<unknown>
}

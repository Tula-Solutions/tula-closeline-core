/**
 * What the team is told about a new Demo Request. Every field but `id` and `submittedAt` is a
 * Visitor's, and `message` is untrusted text: an adapter escapes it wherever it is interpolated,
 * never logs any field and never keeps one beyond the send.
 */
export type TeamNotice = {
  /** Where to send it: the team's inbox. */
  to: string
  /** The Demo Request id. */
  id: string
  /** The Visitor's name. */
  name: string
  /** The Visitor's work email. */
  workEmail: string
  /** The Visitor's company name. */
  companyName: string
  /** What the Visitor wrote, if anything. */
  message: string | null
  /** The page the form was on. */
  sourcePage: string
  /** When the Demo Request arrived. */
  submittedAt: Date
}

/** Hands a team notice to whatever delivers email. */
export interface TeamNoticeMailer {
  /**
   * Hands one notice over. Resolves once the mail system has accepted it; rejects when it did not.
   * `signal` aborts when the caller's time has run out. An adapter that retries does so a bounded
   * number of times with jitter, inside that time, and never sends twice once a send succeeded.
   */
  deliver(notice: TeamNotice, signal: AbortSignal): Promise<void>
}

import type { FindingCategory, FindingSeverity } from 'tula-closeline-contract'
import type { InboxChannel } from './inbox-store'

/** One Source the Draft may rest on; its text arrives fenced as untrusted data. */
export type JudgeSource = { id: string; fencedText: string }

/** What the judge is given to assess one Draft before release. */
export type JudgeRequest = {
  channel: InboxChannel | 'phone'
  /** The Prospect's Message, fenced as untrusted data (see `fenceUntrusted`). */
  fencedInboundMessage: string
  /** The Draft body being assessed, fenced as untrusted data. */
  fencedDraft: string
  /** The only Sources the Draft may rely on. */
  sources: JudgeSource[]
}

/** One problem the judge found: a span of the Draft body, a category, a severity and a note. */
export type JudgedFinding = {
  category: FindingCategory
  severity: FindingSeverity
  /** Offsets into the Draft body: `start` inclusive, `end` exclusive. */
  span: { start: number; end: number }
  explanation: string
}

/**
 * Assesses a Draft against its Sources. It returns whatever the model said, untrusted: the caller
 * narrows it to a verdict and findings and treats anything else as a failure to judge. It throws
 * when the model is unreachable or `signal` aborts.
 */
export interface Judge {
  /** Assesses a Draft; aborts when `signal` does. */
  assess(input: JudgeRequest, signal: AbortSignal): Promise<unknown>
}

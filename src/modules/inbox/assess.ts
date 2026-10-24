import {
  type AssessmentVerdict,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  MAX_FINDING_EXPLANATION_LENGTH,
  MAX_FINDINGS,
} from 'tula-closeline-contract'
import type { InboxChannel } from '~/ports/inbox-store'
import type { Judge, JudgedFinding } from '~/ports/judge'
import { fenceUntrusted } from './fence'
import { type RetryOptions, resolveRetry, withRetry } from './retry'

/** What assessing a Draft needs from the container. */
export type AssessDeps = { judge: Judge }

/** What the judge is asked about: the Draft, the Message it answers and the Sources it cites. */
export type AssessInput = {
  channel: InboxChannel
  /** The Prospect's Message, raw; it is fenced before the judge sees it. */
  inboundBody: string
  /** The Draft body, raw; it is fenced before the judge sees it. */
  draftBody: string
  /** The Playbook moments the Draft cites, raw; each is fenced before the judge sees it. */
  sources: { id: string; prospect: string; repNext: string }[]
}

/** How the judge is called; the retry fields default as for the writer. */
export type AssessOptions = RetryOptions & {
  /** How long one judge attempt may take, in ms. */
  judgeTimeoutMs?: number
}

/** What assessing a Draft came to: a verdict, or the judge could not give a usable one. */
export type Assessment =
  | { status: 'judged'; verdict: AssessmentVerdict; findings: JudgedFinding[] }
  | { status: 'unavailable' }
  | { status: 'invalid' }

const JUDGE_TIMEOUT_MS = 20_000

const VERDICTS: readonly string[] = ['pass', 'warn', 'fail']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const narrowFinding = (raw: unknown, textLength: number): JudgedFinding | null => {
  if (!isRecord(raw) || !isRecord(raw.span)) {
    return null
  }
  const { category, severity, span, explanation } = raw
  const { start, end } = span
  if (
    typeof category !== 'string' ||
    !(FINDING_CATEGORIES as readonly string[]).includes(category) ||
    typeof severity !== 'string' ||
    !(FINDING_SEVERITIES as readonly string[]).includes(severity) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    start < 0 ||
    end <= start ||
    end > textLength ||
    typeof explanation !== 'string' ||
    explanation.trim().length === 0 ||
    explanation.length > MAX_FINDING_EXPLANATION_LENGTH
  ) {
    return null
  }
  return {
    category: category as JudgedFinding['category'],
    severity: severity as JudgedFinding['severity'],
    span: { start, end },
    explanation,
  }
}

/**
 * Reduces the judge's answer to a verdict and findings, or `null` when anything is off: an unknown
 * verdict or category, a span outside the Draft, a pass with findings or a fail without one. Extra
 * fields are dropped, so the model can never set anything but what it is asked for.
 */
export function narrowJudgement(
  raw: unknown,
  textLength: number
): { verdict: AssessmentVerdict; findings: JudgedFinding[] } | null {
  if (!isRecord(raw) || typeof raw.verdict !== 'string' || !VERDICTS.includes(raw.verdict)) {
    return null
  }
  if (!Array.isArray(raw.findings) || raw.findings.length > MAX_FINDINGS) {
    return null
  }
  const findings: JudgedFinding[] = []
  for (const item of raw.findings) {
    const finding = narrowFinding(item, textLength)
    if (!finding) {
      return null
    }
    findings.push(finding)
  }
  const verdict = raw.verdict as AssessmentVerdict
  if (
    (verdict === 'pass' && findings.length > 0) ||
    (verdict === 'fail' && findings.length === 0)
  ) {
    return null
  }
  return { verdict, findings }
}

/**
 * Asks the judge to assess a Draft. Everything it reads is fenced as untrusted data. A throw or a
 * timeout is retried a bounded number of times with jitter; an unusable answer is not retried.
 */
export async function assessDraft(
  deps: AssessDeps,
  input: AssessInput,
  options: AssessOptions = {}
): Promise<Assessment> {
  const retry = resolveRetry(options)
  let raw: unknown
  try {
    raw = await withRetry(
      (signal) =>
        deps.judge.assess(
          {
            channel: input.channel,
            fencedInboundMessage: fenceUntrusted(input.inboundBody),
            fencedDraft: fenceUntrusted(input.draftBody),
            sources: input.sources.map((source) => ({
              id: source.id,
              fencedText: fenceUntrusted(`${source.prospect}\n${source.repNext}`),
            })),
          },
          signal
        ),
      options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS,
      retry
    )
  } catch {
    return { status: 'unavailable' }
  }
  const narrowed = narrowJudgement(raw, input.draftBody.length)
  return narrowed ? { status: 'judged', ...narrowed } : { status: 'invalid' }
}

/** True when the Draft must wait for a person: the judge failed it or could not be relied on. */
export function holdsRelease(assessment: Assessment): boolean {
  return assessment.status !== 'judged' || assessment.verdict === 'fail'
}

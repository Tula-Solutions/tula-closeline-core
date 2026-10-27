import {
  CONVERSATION_OUTCOME_LABELS,
  type ConversationId,
  type ConversationSummary,
  ERRORS,
  MAX_SUMMARY_LENGTH,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import type { Caller } from '~/modules/caller'
import { fenceUntrusted } from '~/modules/inbox/fence'
import { type RetryOptions, resolveRetry, withRetry } from '~/modules/inbox/retry'
import { openOrganization } from '~/modules/organization/access'
import { visibilityOf } from '~/modules/prospect/service'
import type { ConversationSummaryRecord } from '~/ports/inbox-store'

/** What summarizing needs from the container. */
export type SummaryDeps = Pick<Container, 'store' | 'clock' | 'summarizer' | 'logger' | 'jobs'>

/** How a summary job calls the model and when a Conversation counts as quiet; tests shorten them. */
export type SummaryOptions = RetryOptions & {
  /** How long one call of the summarizer may take, in ms. */
  timeoutMs?: number
  /** How long without a Message makes a Conversation quiet, in ms. */
  quietAfterMs?: number
}

/** The most Messages one summary reads, newest ones, shown oldest first; a longer Conversation is summarized from its ending. */
export const MAX_SUMMARIZED_MESSAGES = 40

/** The most characters of one Message body the summarizer is shown. */
export const MAX_SUMMARIZED_BODY = 1_000

/** How long a Conversation must be silent before the sweep summarizes it: seven days. */
export const QUIET_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** The most Conversations one sweep page queues. */
export const SWEEP_PAGE_SIZE = 50

const TIMEOUT_MS = 20_000

/**
 * What the job came to: `summarized` (a summary was stored), `current` (the Conversation is not
 * ready or already has a summary at least as new as its last Message), `unsummarized` (the model
 * was unreachable or gave an unusable answer, so nothing is stored) or `skipped` (the Organization
 * or Conversation is gone).
 */
export type SummaryOutcome = 'summarized' | 'current' | 'unsummarized' | 'skipped'

/**
 * Narrows what the model said to a trimmed summary of at most {@link MAX_SUMMARY_LENGTH}
 * characters and one Outcome label of the closed set, or `null` when either is missing or
 * wrong. An over-long summary is refused, never cut: a cut sentence could read as a different one.
 */
export function narrowSummary(
  raw: unknown
): Pick<ConversationSummaryRecord, 'summary' | 'outcomeLabel'> | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const { summary, outcomeLabel } = raw as { summary?: unknown; outcomeLabel?: unknown }
  const label = CONVERSATION_OUTCOME_LABELS.find((known) => known === outcomeLabel)
  if (typeof summary !== 'string' || label === undefined) {
    return null
  }
  const text = summary.trim()
  return text.length >= 1 && text.length <= MAX_SUMMARY_LENGTH
    ? { summary: text, outcomeLabel: label }
    : null
}

/**
 * Summarizes one closed or quiet Conversation and labels its Outcome, once per version of the
 * Conversation: a summary at least as new as its last Message is left alone, so a replay and a
 * duplicate job store one. The Messages are read under the Organization's scope, fenced as
 * untrusted data and shown to the summarizer (bounded timeout, bounded jittered retries). A model
 * outage, a timeout or an unusable answer stores nothing and returns `unsummarized`: the summary
 * stays absent rather than wrong, and the job does not throw. A Conversation that took a new
 * Message while the model ran is left for the next sweep. Only a database failure throws. Logs
 * ids and reasons, never a Message.
 */
export async function summarizeConversation(
  deps: SummaryDeps,
  organizationId: OrganizationId,
  conversationId: ConversationId,
  options: SummaryOptions = {}
): Promise<SummaryOutcome> {
  const now = deps.clock.now()
  const quietBefore = new Date(now.getTime() - (options.quietAfterMs ?? QUIET_AFTER_MS))
  const read = await deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.getOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped' as const
    }
    const conversation = await scope.getConversation(conversationId, { kind: 'all' })
    if (!conversation) {
      return 'skipped' as const
    }
    const ready =
      conversation.state === 'closed' ||
      conversation.lastMessageAt.getTime() < quietBefore.getTime()
    const existing = await scope.getConversationSummary(conversationId)
    if (
      !ready ||
      (existing && existing.generatedAt.getTime() >= conversation.lastMessageAt.getTime())
    ) {
      return 'current' as const
    }
    const messages = await scope.listMessages({
      conversationId,
      newest: true,
      limit: MAX_SUMMARIZED_MESSAGES,
    })
    return { lastMessageAt: conversation.lastMessageAt, messages }
  })
  if (read === 'skipped' || read === 'current') {
    return read
  }

  const unsummarized = (reason: string): SummaryOutcome => {
    deps.logger.warn('a Conversation was left unsummarized', {
      organizationId,
      conversationId,
      reason,
    })
    return 'unsummarized'
  }

  const fencedMessages = read.messages.map((m) =>
    fenceUntrusted(`${m.authorKind}: ${m.body.slice(0, MAX_SUMMARIZED_BODY)}`)
  )
  let raw: unknown
  try {
    raw = await withRetry(
      (signal) => deps.summarizer.summarize({ fencedMessages }, signal),
      options.timeoutMs ?? TIMEOUT_MS,
      resolveRetry(options)
    )
  } catch {
    return unsummarized('summarizer_unavailable')
  }
  const narrowed = narrowSummary(raw)
  if (!narrowed) {
    return unsummarized('unusable_answer')
  }

  return deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped'
    }
    const conversation = await scope.getConversation(conversationId, { kind: 'all' })
    if (!conversation) {
      return 'skipped'
    }
    if (conversation.lastMessageAt.getTime() !== read.lastMessageAt.getTime()) {
      return 'current'
    }
    await scope.saveConversationSummary({
      conversationId,
      ...narrowed,
      generatedAt: deps.clock.now(),
    })
    return 'summarized'
  })
}

/**
 * Queues a summary job for each Conversation of the Organization that is closed or quiet and has
 * no current summary, one page of at most {@link SWEEP_PAGE_SIZE} after `after`, then the sweep
 * for the next page when this one was full. Returns how many summary jobs it queued. A queue that
 * refuses a publish throws, so the sweep is handed out again; the jobs are idempotent.
 */
export async function sweepSummaries(
  deps: SummaryDeps,
  organizationId: OrganizationId,
  after: ConversationId | undefined,
  options: SummaryOptions = {}
): Promise<number> {
  const quietBefore = new Date(
    deps.clock.now().getTime() - (options.quietAfterMs ?? QUIET_AFTER_MS)
  )
  const ids = await deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.getOrganization()
    if (!organization || organization.status === 'deleted') {
      return []
    }
    return scope.listSummaryCandidates({
      quietBefore,
      ...(after === undefined ? {} : { after }),
      limit: SWEEP_PAGE_SIZE,
    })
  })
  const jobs = ids.map((conversationId) =>
    jobRegistry.create({
      type: 'inbox.summarize_conversation',
      payload: { conversationId },
      organizationId,
      traceId: crypto.randomUUID(),
    })
  )
  const last = ids.at(-1)
  if (last !== undefined && ids.length === SWEEP_PAGE_SIZE) {
    jobs.push(
      jobRegistry.create({
        type: 'inbox.summarize_sweep',
        payload: { after: last },
        organizationId,
        traceId: crypto.randomUUID(),
      })
    )
  }
  if (jobs.length > 0 && (await deps.jobs.publishBatch(jobs)).failed.length > 0) {
    throw domainError(ERRORS['server.unavailable'])
  }
  return ids.length
}

/**
 * Reads the summary of a Conversation the caller may see. A Rep sees the summaries of their own
 * Conversations, a Manager those of their Team, an Admin and Owner all. A Conversation the caller
 * may not see, one that does not exist, one of another Organization and one without a summary yet
 * are all `request.not_found`, never 403. The text is untrusted model output; show it as plain text.
 */
export async function getSummary(
  deps: Pick<Container, 'store'>,
  caller: Caller,
  conversationId: ConversationId
): Promise<ConversationSummary> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.read')
    const { visibility } = await visibilityOf(scope, caller)
    const conversation = await scope.getConversation(conversationId, visibility)
    const stored = conversation ? await scope.getConversationSummary(conversationId) : null
    if (!stored) {
      throw domainError(ERRORS['request.not_found'])
    }
    return {
      conversationId: stored.conversationId,
      summary: stored.summary,
      outcomeLabel: stored.outcomeLabel,
      generatedAt: stored.generatedAt.toISOString(),
    }
  })
}

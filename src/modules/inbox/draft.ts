import {
  type DecisionId,
  type DraftId,
  formatId,
  holdReasonFor,
  MAX_DRAFT_SOURCES,
  MAX_STRATEGY_LENGTH,
  type MessageId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { BackoffSteps, Sleep } from '~/backoff'
import type { Container } from '~/container'
import { enqueueEvents, messageApprovedEvent } from '~/modules/prospect/events'
import type { NewDraftSource } from '~/ports/inbox-store'
import {
  type MomentSearchResult,
  momentSourceRef,
  type PlaybookMoment,
} from '~/ports/moment-search'
import { isSuppressed, ruleOf } from './approval'
import { assessDraft, holdsRelease } from './assess'
import { applyEscalation, notifyEscalated } from './escalation'
import { fenceUntrusted } from './fence'
import { resolveRetry, withRetry } from './retry'

/** What drafting needs from the container. */
export type DraftDeps = Pick<
  Container,
  'store' | 'clock' | 'writer' | 'judge' | 'moments' | 'env' | 'repNotifier' | 'logger'
>

/** What names one draft job. */
export type DraftJob = {
  organizationId: OrganizationId
  messageId: MessageId
  traceId: string
}

/** How the Playbook search and the model are called; every field has a default, tests shorten them. */
export type DraftOptions = {
  /** How many times each outside call is tried before the Conversation is escalated. */
  attempts?: number
  /** How long one Playbook search attempt may take, in ms. */
  searchTimeoutMs?: number
  /** How long one model attempt may take, in ms. */
  writerTimeoutMs?: number
  /** How long one judge attempt may take, in ms. */
  judgeTimeoutMs?: number
  /** The wait between attempts. */
  backoff?: BackoffSteps
  /** Rests between attempts. */
  sleep?: Sleep
  /** A random number in [0, 1) for the jitter. */
  random?: () => number
}

/** What a draft job did. */
export type DraftOutcome = 'drafted' | 'escalated' | 'skipped'

const SEARCH_TIMEOUT_MS = 8_000
const WRITER_TIMEOUT_MS = 30_000
const JUDGE_TIMEOUT_MS = 20_000

/** How many moments the Playbook is asked for and the writer is shown. */
const MOMENTS_SHOWN = MAX_DRAFT_SOURCES

/** The longest the Playbook search accepts of the Prospect's words. */
const MAX_QUERY_LENGTH = 2000

/** The longest part of the Prospect's Message the writer is shown. */
const MAX_MESSAGE_SHOWN = 4000

/** The longest Draft body the database accepts. */
const MAX_BODY_LENGTH = 20_000

const DEFAULT_STRATEGY = 'Answer from what won Deals did in similar moments.'
/** The writer's answer reduced to what it may decide: a body, a strategy, a confidence and the ids it cited. */
export type WrittenReply = {
  body: string
  strategy: string
  confidence: number
  citedIds: string[]
}

/**
 * Narrows whatever the writer returned. A body that is not text, is blank or is too long makes the
 * answer unusable (`null`); the strategy falls back to a default and is cut to its limit; a
 * confidence outside 0 to 1 becomes 0; the cited ids are the strings of `citedIds`. Every other
 * field, a status or a hold among them, is ignored, so model output can never set one.
 */
export function narrowWrittenReply(raw: unknown): WrittenReply | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const { body, strategy, confidence, citedIds } = raw as Record<string, unknown>
  if (typeof body !== 'string' || body.trim() === '' || body.length > MAX_BODY_LENGTH) {
    return null
  }
  const cleanStrategy =
    typeof strategy === 'string' && strategy.trim() !== ''
      ? strategy.trim().slice(0, MAX_STRATEGY_LENGTH)
      : DEFAULT_STRATEGY
  return {
    body,
    strategy: cleanStrategy,
    confidence:
      typeof confidence === 'number' &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
        ? confidence
        : 0,
    citedIds: Array.isArray(citedIds)
      ? citedIds.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

/**
 * The Sources of a Draft: the moments the writer cited that the Playbook really returned, once
 * each, in the order cited, at most {@link MAX_DRAFT_SOURCES}. An id the Playbook did not return
 * is dropped, so a made-up citation (or one a Prospect talked the model into) never becomes a
 * Source. Each is a moment of a won Deal, with the evidence count the search reported.
 */
export function groundedSources(
  cited: readonly string[],
  found: ReadonlyMap<string, PlaybookMoment>,
  evidenceMoments: number
): NewDraftSource[] {
  const sources: NewDraftSource[] = []
  const seen = new Set<string>()
  for (const id of cited) {
    const moment = found.get(id)
    if (!moment || seen.has(id) || sources.length >= MAX_DRAFT_SOURCES) {
      continue
    }
    seen.add(id)
    sources.push({
      kind: 'moment',
      sourceRef: id,
      position: sources.length,
      dealRecordId: moment.dealRecordId,
      outcome: 'won',
      // The search-wide evidence base (the Playbook gives no count per moment), at least 1.
      evidenceCount: Math.max(1, evidenceMoments),
    })
  }
  return sources
}

/**
 * Writes the Agent's Draft in reply to one inbound Message labelled `objection` or `question`,
 * grounded in the Organization's own won Deals. It searches the Playbook for the Prospect's words,
 * asks the writer for a reply that cites the moments it used, and keeps only the citations the
 * Playbook returned. With none left the Draft is stored `ungrounded` and held. The Draft is
 * `pending` and Sources, hold and status come from here, never from the model; the Message is
 * shown to the model as fenced, untrusted data.
 *
 * Each outside call has a timeout and a bounded, jittered retry; when one still fails, or the
 * writer gives nothing usable, the Conversation is `escalated` for a Rep and the job ends without
 * error (retrying would only repeat it). A Message without a Draft job's preconditions (missing,
 * outbound, of another label, in a Conversation a Rep or a stop has taken over) is skipped, and a
 * Message that already has a Draft is left alone, so a redelivery writes no second Draft.
 */
export async function draftReply(
  deps: DraftDeps,
  job: DraftJob,
  options: DraftOptions = {}
): Promise<DraftOutcome> {
  const retry = resolveRetry(options)
  const waiting = await deps.store.withOrganization(job.organizationId, async (scope) => {
    const message = await scope.getMessage(job.messageId)
    if (!message || !isDraftable(message)) {
      return null
    }
    const conversation = await scope.getConversation(message.conversationId, { kind: 'all' })
    if (
      !conversation ||
      !isHandledByAgent(conversation) ||
      (await scope.findDraftForMessage(message.id))
    ) {
      return null
    }
    return { message, conversation }
  })
  if (!waiting) {
    return 'skipped'
  }
  const { message, conversation } = waiting
  const label = message.classification?.label
  if (label !== 'objection' && label !== 'question') {
    return 'skipped'
  }

  const escalate = async () => {
    const escalated = await deps.store.withOrganization(job.organizationId, async (scope) => {
      const organization = await scope.lockOrganization()
      if (!organization || organization.status === 'deleted') {
        return null
      }
      // The calls may have taken a while: a Rep may have taken over or a Draft may exist now.
      const current = await scope.getConversation(conversation.id, { kind: 'all' })
      if (
        !current ||
        !isHandledByAgent(current) ||
        (await scope.findDraftForMessage(job.messageId))
      ) {
        return null
      }
      return applyEscalation(scope, {
        organizationId: job.organizationId,
        conversationId: conversation.id,
        trigger: 'writer_failure',
      })
    })
    await notifyEscalated(deps, escalated)
    return escalated === null ? ('skipped' as const) : ('escalated' as const)
  }

  let search: MomentSearchResult
  try {
    search = await withRetry(
      (signal) =>
        deps.moments.searchWonMoments(
          {
            organizationId: job.organizationId,
            query: message.body.slice(0, MAX_QUERY_LENGTH),
            limit: MOMENTS_SHOWN,
          },
          signal
        ),
      options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
      retry
    )
  } catch {
    return escalate()
  }

  const found = new Map<string, PlaybookMoment>()
  for (const moment of search.moments) {
    const ref = momentSourceRef(moment)
    if (ref !== null && !found.has(ref)) {
      found.set(ref, moment)
    }
  }

  let written: WrittenReply | null
  try {
    const raw = await withRetry(
      (signal) =>
        deps.writer.write(
          {
            label,
            channel: message.channel,
            fencedMessage: fenceUntrusted(message.body.slice(0, MAX_MESSAGE_SHOWN)),
            moments: [...found].map(([id, moment]) => ({
              id,
              prospect: fenceUntrusted(moment.prospect),
              repNext: fenceUntrusted(moment.repNext),
            })),
          },
          signal
        ),
      options.writerTimeoutMs ?? WRITER_TIMEOUT_MS,
      retry
    )
    written = narrowWrittenReply(raw)
  } catch {
    return escalate()
  }
  if (!written) {
    return escalate()
  }

  const sources = groundedSources(written.citedIds, found, search.evidence.moments)
  const draftId = formatId('drf', crypto.randomUUID()) as DraftId
  const now = deps.clock.now()
  const draft = written
  // The judge reads the Draft against only the Sources it cites; a judge that fails or cannot be
  // understood holds the Draft rather than letting it go unchecked.
  const assessment = await assessDraft(
    deps,
    {
      channel: message.channel,
      inboundBody: message.body.slice(0, MAX_MESSAGE_SHOWN),
      draftBody: draft.body,
      sources: sources.flatMap((source) => {
        const cited = found.get(source.sourceRef)
        return cited
          ? [{ id: source.sourceRef, prospect: cited.prospect, repNext: cited.repNext }]
          : []
      }),
    },
    { ...retry, judgeTimeoutMs: options.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS }
  )
  const checkFailed = holdsRelease(assessment)
  return deps.store.withOrganization(job.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped' as const
    }
    // Everything is read again under the lock: the label, the Conversation and the Draft may have
    // changed while the Playbook and the model were being called.
    const current = await scope.getMessage(job.messageId)
    const currentConversation = await scope.getConversation(conversation.id, { kind: 'all' })
    if (
      !current ||
      current.classification?.label !== label ||
      !currentConversation ||
      !isHandledByAgent(currentConversation) ||
      (await scope.findDraftForMessage(job.messageId))
    ) {
      return 'skipped' as const
    }
    const ungrounded = sources.length === 0
    const rule = await ruleOf(scope, currentConversation.channel)
    // The four holds no rule turns off come first; the Admin's rule decides only the rest.
    const held = holdReasonFor(rule, {
      label,
      confidence: draft.confidence,
      ungrounded,
      failedCheck: checkFailed,
      escalated: currentConversation.state === 'escalated',
      firstMessage: !(await scope.hasReleasedReply(conversation.id)),
    })
    // A suppressed address is never sent to without a person; the Draft waits and approval refuses it.
    const hold =
      held === null &&
      (await isSuppressed(deps.env, scope, job.organizationId, currentConversation))
        ? ('policy' as const)
        : held
    await scope.insertAgentDraft({
      id: draftId,
      conversationId: conversation.id,
      triggerMessageId: job.messageId,
      label,
      body: draft.body,
      strategy: draft.strategy,
      confidence: draft.confidence,
      ungrounded,
      checks: [{ name: 'claims_supported', passed: !checkFailed }],
      hold,
      sources,
      now,
    })
    if (assessment.status === 'judged') {
      await scope.saveDraftAssessment({
        draftId,
        draftVersion: 1,
        prospectId: currentConversation.prospectId,
        verdict: assessment.verdict,
        findings: assessment.findings,
        now,
      })
    }
    if (hold === null) {
      // Released without a person: the record says so, and the channel is told once.
      await scope.insertDecision({
        id: formatId('dcs', crypto.randomUUID()) as DecisionId,
        conversationId: conversation.id,
        draftId,
        kind: 'auto_release',
        decidedByMembershipId: null,
        note: null,
        editedBodySha256: null,
        acknowledgedUngrounded: false,
        decidedAt: now,
      })
      await enqueueEvents(scope, job.organizationId, job.traceId, [
        messageApprovedEvent(draftId, {
          draftId,
          conversationId: conversation.id,
          prospectId: currentConversation.prospectId,
          channel: currentConversation.channel,
          approvedByMembershipId: null,
          edited: false,
          acknowledgedUngrounded: false,
          approvedAt: now.toISOString(),
        }),
      ])
    }
    return 'drafted' as const
  })
}

const isDraftable = (message: { direction: string; classification: { label: string } | null }) =>
  message.direction === 'inbound' &&
  (message.classification?.label === 'objection' || message.classification?.label === 'question')

const isHandledByAgent = (conversation: { controller: string; state: string }) =>
  conversation.controller === 'agent' &&
  (conversation.state === 'agent' ||
    conversation.state === 'awaiting_approval' ||
    conversation.state === 'escalated')

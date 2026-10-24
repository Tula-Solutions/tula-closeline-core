import {
  type ConversationId,
  confidenceSchema,
  type MembershipId,
  type MessageId,
  type OrganizationId,
  replyLabelSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { enqueueEvents, replyClassifiedEvent } from '~/modules/prospect/events'
import type { OrganizationScope } from '~/ports/core-store'
import type {
  ConversationRecord,
  EscalationTrigger,
  InboxLabel,
  MessageClassification,
  MessageRecord,
} from '~/ports/inbox-store'
import { applyEscalation, type Escalated, notifyEscalated } from './escalation'
import { DRAFTED_LABELS, publishInboxJob } from './jobs'

/** What classifying needs from the container. */
export type ClassifyDeps = Pick<
  Container,
  'store' | 'clock' | 'classifier' | 'jobs' | 'repNotifier' | 'logger'
>

/** What names one classify job. */
export type ClassifyJob = {
  organizationId: OrganizationId
  messageId: MessageId
  traceId: string
}

/** How long the Rep notification may take before it is abandoned. */
const NOTIFY_TIMEOUT_MS = 5_000

/** How long the model may take before the attempt is abandoned and the job retried. */
const CLASSIFIER_TIMEOUT_MS = 10_000

/** The labels after which nothing more may be sent in the Conversation: the Prospect asked to stop, or the address is dead. */
const STOPPING_LABELS: readonly InboxLabel[] = ['unsubscribe', 'bounce']

/**
 * Narrows whatever the classifier returned to a label and a confidence. Anything that is not an
 * object with a label of the closed set becomes `other` with no confidence, and a confidence
 * outside 0 to 1 becomes 0, so model output can never name a state, an action or an unknown label.
 */
export function narrowClassification(raw: unknown): { label: InboxLabel; confidence: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { label: 'other', confidence: 0 }
  }
  const label = replyLabelSchema.safeParse((raw as { label?: unknown }).label)
  if (!label.success) {
    return { label: 'other', confidence: 0 }
  }
  const confidence = confidenceSchema.safeParse((raw as { confidence?: unknown }).confidence)
  return { label: label.data, confidence: confidence.success ? confidence.data : 0 }
}

/** The signals a classifier may raise besides the label, each naming the trigger it sets off. */
const SIGNAL_TRIGGERS: Readonly<Record<string, EscalationTrigger>> = {
  asks_for_person: 'asks_for_person',
  pricing_or_legal: 'pricing_or_legal',
}

/**
 * Narrows the `signals` the classifier returned to the escalation triggers it knows, in a fixed
 * order. Anything else (a non-array, an unknown name) is dropped, so model output can only pick
 * from the closed set.
 */
export function narrowSignals(raw: unknown): EscalationTrigger[] {
  const signals =
    typeof raw === 'object' && raw !== null ? (raw as { signals?: unknown }).signals : null
  if (!Array.isArray(signals)) {
    return []
  }
  return (['asks_for_person', 'pricing_or_legal'] as const).filter((trigger) =>
    signals.some((signal) => typeof signal === 'string' && SIGNAL_TRIGGERS[signal] === trigger)
  )
}

/**
 * Escalates the Conversation of a freshly labelled reply on the first trigger it sets off: a
 * signal of the classifier, a `negative` label, or a confidence under a `low_confidence` rule's
 * threshold. A Conversation that is already escalated, or not the Agent's, is left alone.
 */
async function escalateOnReply(
  scope: OrganizationScope,
  input: {
    organizationId: OrganizationId
    conversationId: ConversationId
    decided: { label: InboxLabel; confidence: number }
    signals: readonly EscalationTrigger[]
  }
): Promise<Escalated | null> {
  const triggers: EscalationTrigger[] = [...input.signals]
  if (input.decided.label === 'negative') {
    triggers.push('negative_tone')
  }
  triggers.push('low_confidence')
  for (const trigger of triggers) {
    const escalated = await applyEscalation(scope, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      trigger,
      confidence: input.decided.confidence,
    })
    if (escalated) {
      return escalated
    }
  }
  return null
}

/**
 * What follows a Message getting a label, inside the transaction that stored it: the
 * Conversation shows the label of its newest inbound Message, an `unsubscribe` or `bounce` stops
 * the Conversation (every pending Draft is voided and it is closed), and `reply.classified` is
 * written to the outbox under `eventId`, so a replay publishes it once. Only the label decides this;
 * the text of the reply is never read here. Answers the Conversation as it stands, or `null`.
 */
export async function recordClassification(
  scope: OrganizationScope,
  input: {
    organizationId: OrganizationId
    traceId: string
    now: Date
    message: MessageRecord
    classification: MessageClassification
    eventId: string
  }
): Promise<ConversationRecord | null> {
  const { message, classification } = input
  const conversation = await scope.getConversation(message.conversationId, { kind: 'all' })
  if (!conversation) {
    return null
  }
  await scope.refreshLatestLabel(conversation.id)
  if (STOPPING_LABELS.includes(classification.label)) {
    await scope.stopConversation(conversation.id, input.now)
  }
  await enqueueEvents(scope, input.organizationId, input.traceId, [
    replyClassifiedEvent(input.eventId, {
      conversationId: conversation.id as ConversationId,
      messageId: message.id,
      prospectId: conversation.prospectId,
      channel: conversation.channel,
      label: classification.label,
      confidence: classification.confidence,
      classifiedAt: classification.classifiedAt.toISOString(),
    }),
  ])
  return conversation
}

/**
 * Tells the Rep who controls a Conversation that the Prospect replied, with ids and a fixed
 * sentence only (never the reply). The notice is best effort and bounded: a failure is logged
 * without any Message text and never fails the job, because the reply is already stored and
 * labelled.
 */
async function tellRep(
  deps: Pick<ClassifyDeps, 'repNotifier' | 'logger'>,
  job: ClassifyJob,
  conversation: ConversationRecord,
  membershipId: MembershipId
): Promise<void> {
  try {
    await deps.repNotifier.notify(
      {
        kind: 'reply_during_takeover',
        organizationId: job.organizationId,
        membershipId,
        conversationId: conversation.id,
        messageId: job.messageId,
        text: 'A Prospect replied in a Conversation you took over.',
      },
      AbortSignal.timeout(NOTIFY_TIMEOUT_MS)
    )
  } catch (error) {
    deps.logger.warn('rep notice failed', {
      conversationId: conversation.id,
      messageId: job.messageId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/**
 * Labels one inbound Message with the model, exactly once. The model is called outside any
 * transaction (it is slow and may fail; a failure throws so the queue delivers the job again),
 * then the label, the Conversation's latest label, the stop on `unsubscribe` or `bounce` and the
 * `reply.classified` event are written in one transaction under the Organization lock. A Message
 * that is missing (or of another Organization), outbound, or already labelled (by an earlier run
 * or by a Rep) is left alone, so a redelivery stores no second label and publishes no second event.
 * The reply text goes to the classifier only; it is never logged and decides nothing but the label.
 */
export async function classifyMessage(
  deps: ClassifyDeps,
  job: ClassifyJob
): Promise<'classified' | 'skipped'> {
  const waiting = await deps.store.withOrganization(job.organizationId, (scope) =>
    scope.getMessage(job.messageId)
  )
  if (waiting?.direction !== 'inbound') {
    return 'skipped'
  }
  if (waiting.classification !== null) {
    // Labelled by an earlier run or by a Rep: the label is final, but an objection or a question
    // may still lack its Draft job (a publish that failed after the label was stored), and the
    // Draft job does nothing when the Draft exists.
    if (DRAFTED_LABELS.includes(waiting.classification.label)) {
      await publishInboxJob(
        deps,
        'inbox.draft_reply',
        job.organizationId,
        job.messageId,
        job.traceId
      )
    }
    return 'skipped'
  }
  const raw = await deps.classifier.classify(
    { body: waiting.body, channel: waiting.channel },
    AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS)
  )
  const decided = narrowClassification(raw)
  const signals = narrowSignals(raw)
  const now = deps.clock.now()
  const result = await deps.store.withOrganization(job.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return { outcome: 'skipped' as const }
    }
    const classification: MessageClassification = {
      ...decided,
      decidedBy: 'model',
      correctedByMembershipId: null,
      classifiedAt: now,
    }
    const stored = await scope.saveClassification({
      messageId: job.messageId,
      classification,
      onlyIfUnclassified: true,
    })
    if (!stored) {
      return { outcome: 'skipped' as const }
    }
    const conversation = await recordClassification(scope, {
      organizationId: job.organizationId,
      traceId: job.traceId,
      now,
      message: stored,
      classification,
      eventId: `reply.classified:${stored.id}:model`,
    })
    const rep =
      conversation?.controller === 'rep' && conversation.controllerMembershipId !== null
        ? { conversation, membershipId: conversation.controllerMembershipId }
        : null
    const escalated = conversation
      ? await escalateOnReply(scope, {
          organizationId: job.organizationId,
          conversationId: conversation.id,
          decided,
          signals,
        })
      : null
    return { outcome: 'classified' as const, rep, escalated }
  })
  const outcome = result.outcome
  if (result.outcome === 'classified' && result.rep !== null) {
    await tellRep(deps, job, result.rep.conversation, result.rep.membershipId)
  }
  if (result.outcome === 'classified') {
    await notifyEscalated(deps, result.escalated)
  }
  if (outcome === 'classified' && DRAFTED_LABELS.includes(decided.label)) {
    // After the commit; a refused publish throws, the job is delivered again, and the branch
    // above queues the Draft job then.
    await publishInboxJob(deps, 'inbox.draft_reply', job.organizationId, job.messageId, job.traceId)
  }
  return outcome
}

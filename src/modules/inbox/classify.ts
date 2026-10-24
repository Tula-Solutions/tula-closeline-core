import {
  type ConversationId,
  confidenceSchema,
  type MessageId,
  type OrganizationId,
  replyLabelSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { enqueueEvents, replyClassifiedEvent } from '~/modules/prospect/events'
import type { OrganizationScope } from '~/ports/core-store'
import type { InboxLabel, MessageClassification, MessageRecord } from '~/ports/inbox-store'

/** What classifying needs from the container. */
export type ClassifyDeps = Pick<Container, 'store' | 'clock' | 'classifier'>

/** What names one classify job. */
export type ClassifyJob = {
  organizationId: OrganizationId
  messageId: MessageId
  traceId: string
}

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

/**
 * What follows a Message getting a label, inside the transaction that stored it: the
 * Conversation shows the label of its newest inbound Message, an `unsubscribe` or `bounce` stops
 * the Conversation (every pending Draft is voided and it is closed), and `reply.classified` is
 * written to the outbox under `eventId`, so a replay publishes it once. Only the label decides this;
 * the text of the reply is never read here.
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
): Promise<void> {
  const { message, classification } = input
  const conversation = await scope.getConversation(message.conversationId, { kind: 'all' })
  if (!conversation) {
    return
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
  if (!waiting || waiting.direction !== 'inbound' || waiting.classification !== null) {
    return 'skipped'
  }
  const raw = await deps.classifier.classify(
    { body: waiting.body, channel: waiting.channel },
    AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS)
  )
  const decided = narrowClassification(raw)
  const now = deps.clock.now()
  return deps.store.withOrganization(job.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'skipped'
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
      return 'skipped'
    }
    await recordClassification(scope, {
      organizationId: job.organizationId,
      traceId: job.traceId,
      now,
      message: stored,
      classification,
      eventId: `reply.classified:${stored.id}:model`,
    })
    return 'classified'
  })
}

import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import {
  type bookingCancelled,
  type bookingRescheduled,
  type CoreEnvelope,
  type consentGranted,
  type consentWithdrawn,
  type conversationHandedBack,
  type conversationTakenOver,
  type crmConnected,
  type crmDisconnected,
  type exportRequested,
  type messageApproved,
  type prospectCreated,
  type prospectErased,
  type prospectUpdated,
  registry,
  type replyClassified,
  type suppressionAdded,
  type suppressionRemoved,
} from '~/messages'
import type { OrganizationScope } from '~/ports/core-store'

/** A domain event decided inside a transaction and written to the outbox in that transaction. */
export type PendingEvent =
  | { type: 'prospect.created'; id: string; payload: z.input<typeof prospectCreated.payload> }
  | { type: 'prospect.updated'; id: string; payload: z.input<typeof prospectUpdated.payload> }
  | { type: 'prospect.erased'; id: string; payload: z.input<typeof prospectErased.payload> }
  | { type: 'suppression.added'; id: string; payload: z.input<typeof suppressionAdded.payload> }
  | {
      type: 'suppression.removed'
      id: string
      payload: z.input<typeof suppressionRemoved.payload>
    }
  | { type: 'consent.granted'; id: string; payload: z.input<typeof consentGranted.payload> }
  | { type: 'consent.withdrawn'; id: string; payload: z.input<typeof consentWithdrawn.payload> }
  | { type: 'crm.connected'; id: string; payload: z.input<typeof crmConnected.payload> }
  | { type: 'crm.disconnected'; id: string; payload: z.input<typeof crmDisconnected.payload> }
  | { type: 'export.requested'; id: string; payload: z.input<typeof exportRequested.payload> }
  | { type: 'reply.classified'; id: string; payload: z.input<typeof replyClassified.payload> }
  | { type: 'message.approved'; id: string; payload: z.input<typeof messageApproved.payload> }
  | {
      type: 'conversation.taken_over'
      id: string
      payload: z.input<typeof conversationTakenOver.payload>
    }
  | {
      type: 'conversation.handed_back'
      id: string
      payload: z.input<typeof conversationHandedBack.payload>
    }
  | { type: 'booking.cancelled'; id: string; payload: z.input<typeof bookingCancelled.payload> }
  | {
      type: 'booking.rescheduled'
      id: string
      payload: z.input<typeof bookingRescheduled.payload>
    }

/**
 * A pending `message.approved`. Its id is derived from the Draft, so a Draft is approved for
 * release once however often the decision is retried: the outbox dedupes on it.
 */
export function messageApprovedEvent(
  draftId: string,
  payload: z.input<typeof messageApproved.payload>
): PendingEvent {
  return { type: 'message.approved', id: `message.approved:${draftId}`, payload }
}

/**
 * A pending `conversation.taken_over`. Its id is derived from the takeover Decision, so a retried
 * takeover publishes it once.
 */
export function conversationTakenOverEvent(
  decisionId: string,
  payload: z.input<typeof conversationTakenOver.payload>
): PendingEvent {
  return { type: 'conversation.taken_over', id: `conversation.taken_over:${decisionId}`, payload }
}

/** A pending `conversation.handed_back`, keyed by the hand back Decision so it publishes once. */
export function conversationHandedBackEvent(
  decisionId: string,
  payload: z.input<typeof conversationHandedBack.payload>
): PendingEvent {
  return {
    type: 'conversation.handed_back',
    id: `conversation.handed_back:${decisionId}`,
    payload,
  }
}

/** A pending `booking.cancelled`, keyed by the Booking: it is cancelled once, so it publishes once. */
export function bookingCancelledEvent(
  payload: z.input<typeof bookingCancelled.payload>
): PendingEvent {
  return { type: 'booking.cancelled', id: `booking.cancelled:${payload.bookingId}`, payload }
}

/** A pending `booking.rescheduled`, keyed by the Booking, its new start and a per-move nonce, so a retry publishes once and a later move to the same start still publishes. */
export function bookingRescheduledEvent(
  payload: z.input<typeof bookingRescheduled.payload>,
  nonce: string
): PendingEvent {
  return {
    type: 'booking.rescheduled',
    id: `booking.rescheduled:${payload.bookingId}:${payload.startsAt}:${nonce}`,
    payload,
  }
}

/** A new pending `prospect.created`; its id is fixed here so a retried publish keeps it. */
export function createdEvent(payload: z.input<typeof prospectCreated.payload>): PendingEvent {
  return { type: 'prospect.created', id: crypto.randomUUID(), payload }
}

/** A new pending `prospect.updated`; its id is fixed here so a retried publish keeps it. */
export function updatedEvent(payload: z.input<typeof prospectUpdated.payload>): PendingEvent {
  return { type: 'prospect.updated', id: crypto.randomUUID(), payload }
}

/** A new pending `prospect.erased`; it carries the Prospect's id and nothing else. */
export function erasedEvent(payload: z.input<typeof prospectErased.payload>): PendingEvent {
  return { type: 'prospect.erased', id: crypto.randomUUID(), payload }
}

/** The `prospect.updated` of a changed owner: no field changed, only the owner. */
export function ownerChangedEvent(prospectId: string): PendingEvent {
  return updatedEvent({
    prospectId,
    changedFields: [],
    ownerChanged: true,
    companyChanged: false,
    statusChanged: false,
    source: 'manual',
  })
}

/** What `enqueueEvents` needs from a transaction: the scope's outbox insert. */
export type EventScope = Pick<OrganizationScope, 'enqueueOutbox'>

/** Orders the ids made within one millisecond; a hint for the drain's order, never a correctness input. */
let outboxSequence = 0

/**
 * A new outbox row id: `obx_` and 32 hex digits (the shape the database checks). The first 16
 * digits are the time in ms and a per-process counter, so rows written in one transaction sort in
 * the order they were decided and the drain, which claims by due time then id, tends to publish
 * them in that order. The last 16 are random.
 */
export function newOutboxId(now: number = Date.now()): string {
  outboxSequence = (outboxSequence + 1) % 0x10000
  const time = now.toString(16).padStart(12, '0').slice(-12)
  const sequence = outboxSequence.toString(16).padStart(4, '0')
  const random = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  return `obx_${time}${sequence}${random}`
}

/**
 * Writes events to the transactional outbox inside the transaction that decided them, so a change
 * and its events commit or roll back together and a committed change is never left without its
 * event. The drain publishes them after commit. Each event is checked against its schema here; an
 * invalid one throws and rolls the change back. The event's own id is the dedupe key, so a replay
 * that re-decides an event (a consent ledger id, say) adds no second row. One insert per event, so
 * O(events in this transaction).
 */
export async function enqueueEvents(
  scope: EventScope,
  organizationId: OrganizationId,
  traceId: string,
  events: readonly PendingEvent[]
): Promise<void> {
  for (const event of events) {
    const envelope: CoreEnvelope = registry.create({
      type: event.type,
      id: event.id,
      payload: event.payload,
      organizationId,
      traceId,
    } as Parameters<typeof registry.create>[0])
    await scope.enqueueOutbox({
      id: newOutboxId(),
      topic: event.type,
      dedupeKey: event.id,
      payload: {
        eventId: event.id,
        occurredAt: envelope.occurredAt,
        traceId,
        payload: envelope.payload,
      },
    })
  }
}

/** A new pending `suppression.added`; its id is fixed here so a retried publish keeps it. It never carries the address. */
export function suppressionAddedEvent(
  payload: z.input<typeof suppressionAdded.payload>
): PendingEvent {
  return { type: 'suppression.added', id: crypto.randomUUID(), payload }
}

/** A new pending `suppression.removed`; its id is fixed here so a retried publish keeps it. */
export function suppressionRemovedEvent(
  payload: z.input<typeof suppressionRemoved.payload>
): PendingEvent {
  return { type: 'suppression.removed', id: crypto.randomUUID(), payload }
}

/** A new pending `consent.granted`; its id is the ledger event's, so a retried publish is one message. */
export function consentGrantedEvent(
  id: string,
  payload: z.input<typeof consentGranted.payload>
): PendingEvent {
  return { type: 'consent.granted', id, payload }
}

/** A new pending `consent.withdrawn`; its id is the ledger event's, so a retried publish is one message. */
export function consentWithdrawnEvent(
  id: string,
  payload: z.input<typeof consentWithdrawn.payload>
): PendingEvent {
  return { type: 'consent.withdrawn', id, payload }
}

/** A new pending `crm.connected`; its id is fixed here so a retried publish keeps it. It never carries a token. */
export function crmConnectedEvent(payload: z.input<typeof crmConnected.payload>): PendingEvent {
  return { type: 'crm.connected', id: crypto.randomUUID(), payload }
}

/** A new pending `crm.disconnected`; its id is fixed here so a retried publish keeps it. */
export function crmDisconnectedEvent(
  payload: z.input<typeof crmDisconnected.payload>
): PendingEvent {
  return { type: 'crm.disconnected', id: crypto.randomUUID(), payload }
}

/** A new pending `reply.classified`; its id is fixed by the caller so a retried flow publishes it once. It never carries the reply text. */
export function replyClassifiedEvent(
  id: string,
  payload: z.input<typeof replyClassified.payload>
): PendingEvent {
  return { type: 'reply.classified', id, payload }
}

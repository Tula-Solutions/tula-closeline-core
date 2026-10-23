import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import {
  type CoreEnvelope,
  type consentGranted,
  type consentWithdrawn,
  type crmConnected,
  type crmDisconnected,
  type prospectCreated,
  type prospectErased,
  type prospectUpdated,
  registry,
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

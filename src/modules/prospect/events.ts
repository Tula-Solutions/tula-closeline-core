import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
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

/** A domain event decided inside a transaction and published once it has committed. */
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

/** What publishing needs from the container. */
export type EventDeps = Pick<Container, 'events' | 'logger'>

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

/** The most envelopes one batch publish carries (the queue's own limit). */
const PUBLISH_BATCH = 10

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

/**
 * Publishes events after the transaction that decided them has committed, so a retried
 * transaction never publishes twice and a rolled-back one never publishes. They go in batches of
 * ten. A refused publish is logged by type and id and does not fail the request: the change is
 * already stored. (There is no outbox yet, so such an event is lost; the log line is how it is found.)
 */
export async function publishEvents(
  deps: EventDeps,
  organizationId: OrganizationId,
  traceId: string,
  events: readonly PendingEvent[]
): Promise<void> {
  const logFailure = (event: { type: string; id: string }, error: unknown): void => {
    deps.logger.error('event publish failed', {
      type: event.type,
      organizationId,
      id: event.id,
      error: typeof error === 'string' ? error : error instanceof Error ? error.name : 'unknown',
    })
  }
  for (let start = 0; start < events.length; start += PUBLISH_BATCH) {
    const group = events.slice(start, start + PUBLISH_BATCH)
    const built: { event: PendingEvent; envelope: CoreEnvelope }[] = []
    for (const event of group) {
      try {
        built.push({
          event,
          envelope: registry.create({
            type: event.type,
            id: event.id,
            payload: event.payload,
            organizationId,
            traceId,
          } as Parameters<typeof registry.create>[0]),
        })
      } catch (error) {
        logFailure(event, error)
      }
    }
    if (built.length === 0) {
      continue
    }
    try {
      const result = await deps.events.publishBatch(built.map((item) => item.envelope))
      for (const failure of result.failed) {
        const type = built.find((item) => item.event.id === failure.id)?.event.type ?? 'unknown'
        logFailure({ type, id: failure.id }, failure.code)
      }
    } catch (error) {
      for (const item of built) {
        logFailure(item.event, error)
      }
    }
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

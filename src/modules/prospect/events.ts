import type { OrganizationId } from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { type CoreEnvelope, type prospectCreated, type prospectUpdated, registry } from '~/messages'

/** A domain event decided inside a transaction and published once it has committed. */
export type PendingEvent =
  | { type: 'prospect.created'; id: string; payload: z.input<typeof prospectCreated.payload> }
  | { type: 'prospect.updated'; id: string; payload: z.input<typeof prospectUpdated.payload> }

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
        logFailure({ type: 'prospect.event', id: failure.id }, failure.code)
      }
    } catch (error) {
      for (const item of built) {
        logFailure(item.event, error)
      }
    }
  }
}

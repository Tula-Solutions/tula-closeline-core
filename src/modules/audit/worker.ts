import { auditRecordedEvent, organizationIdSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import type { AuditEnvelope } from '~/messages'
import { type AuditRecordedData, consume } from './service'

/** What the audit consumer needs from the container. */
export type AuditWorkerDeps = Pick<Container, 'audit' | 'store' | 'logger' | 'clock'>

/** How long a received message stays hidden from other workers, in seconds: far above one write. */
export const AUDIT_VISIBILITY_SECONDS = 60

/** How long one receive waits for a message when the queue is empty, in seconds. */
export const AUDIT_WAIT_SECONDS = 20

/** How long the loop rests after a failed receive, in ms. */
export const AUDIT_ERROR_PAUSE_MS = 5_000

/** The contract's `data` of `audit.recorded`: the shape core's audit service takes. */
const dataSchema = auditRecordedEvent.schema.shape.data

/** The contract's actor for the kit's `{ kind, id }`; the contract refuses one that lacks its id. */
function actorOf(actor: AuditEnvelope['payload']['actor']): unknown {
  switch (actor.kind) {
    case 'member':
      return { kind: 'member', membershipId: actor.id }
    case 'api_key':
      return { kind: 'api_key', apiKeyId: actor.id }
    case 'agent':
      return { kind: 'agent', agentKind: actor.id }
    case 'system':
      return actor.id === undefined ? { kind: 'system' } : { kind: 'system', id: actor.id }
  }
}

/**
 * Reads a message through the contract's `audit.recorded` schema. The envelope id is the event id
 * and must be an audit id. Returns `undefined` for a message the contract refuses; nothing of the
 * message is put in a log.
 */
function dataOf(envelope: AuditEnvelope): AuditRecordedData | undefined {
  const { payload } = envelope
  const parsed = dataSchema.safeParse({
    auditEventId: envelope.id,
    occurredAt: payload.occurredAt ?? envelope.occurredAt,
    actor: actorOf(payload.actor),
    action: payload.action,
    subject: payload.subject,
    prospectId: null,
    instructionVersion: payload.instructionVersion ?? null,
    requestId: payload.requestId ?? null,
    metadata: payload.metadata ?? {},
  })
  return parsed.success ? parsed.data : undefined
}

/**
 * One receive: takes up to ten `audit.recorded` messages and records each in its Organization
 * through the audit service, then acknowledges it. The event id makes a redelivery write nothing.
 * A message that is not valid is logged by id and left unacknowledged, as are core's job messages,
 * so the queue hands it out again and, after its retry limit, moves it to the dead-letter queue.
 * A message for an Organization that does not exist is acknowledged: there is no log to put it in.
 * A failed write is left the same way. Returns how many messages were received.
 */
export async function processAuditMessages(
  deps: AuditWorkerDeps,
  signal: AbortSignal,
  waitSeconds = 0
): Promise<number> {
  const deliveries = await deps.audit.receive({
    maxMessages: 10,
    visibilityTimeoutSeconds: AUDIT_VISIBILITY_SECONDS,
    waitSeconds,
    signal,
  })
  for (const delivery of deliveries) {
    if (delivery.kind === 'invalid') {
      deps.logger.error('an invalid audit message was received', {
        reason: delivery.reason,
        messageId: delivery.messageId,
        receiveCount: delivery.receiveCount,
      })
      continue
    }
    const { envelope } = delivery
    const organizationId = organizationIdSchema.safeParse(envelope.organizationId)
    const data = dataOf(envelope)
    if (!organizationId.success || data === undefined) {
      deps.logger.error('an audit message did not fit the contract', {
        messageId: envelope.id,
        receiveCount: delivery.receiveCount,
      })
      continue
    }
    try {
      const result = await consume(deps, { organizationId: organizationId.data, data })
      if (result === 'dropped') {
        deps.logger.warn('an audit message was for an Organization that does not exist', {
          messageId: envelope.id,
        })
      }
      await deps.audit.acknowledge(delivery.receipt)
    } catch (error) {
      deps.logger.error('an audit message failed and will be retried', {
        messageId: envelope.id,
        organizationId: envelope.organizationId,
        receiveCount: delivery.receiveCount,
        error: describeError(error),
      })
    }
  }
  return deliveries.length
}

/**
 * Starts the loop that records queued audit events. It holds no state, so any instance may run it
 * and any may stop at any time. It ends when `signal` aborts.
 */
export async function startAuditWorker(deps: AuditWorkerDeps, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await processAuditMessages(deps, signal, AUDIT_WAIT_SECONDS)
    } catch (error) {
      if (signal.aborted) {
        return
      }
      deps.logger.error('audit worker failed', { error: describeError(error) })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, AUDIT_ERROR_PAUSE_MS)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      })
    }
  }
}

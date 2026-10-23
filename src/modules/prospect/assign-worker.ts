import { organizationIdSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { jobRegistry } from '~/messages'
import {
  type ImportDeps,
  type ImportRunOptions,
  processImport,
} from '~/modules/prospect-import/process'
import { type AssignDeps, applyAssignChunk } from './assign'

/** What the assignment worker needs from the container. */
export type AssignWorkerDeps = AssignDeps & ImportDeps & Pick<Container, 'jobs'>

/** How long a received chunk stays hidden from other workers, in seconds: far above one chunk's time. */
export const CHUNK_VISIBILITY_SECONDS = 120

/** How long one receive waits for a job when the queue is empty, in seconds. */
export const CHUNK_WAIT_SECONDS = 20

/** How long the loop rests after a failed receive, in ms. */
export const CHUNK_ERROR_PAUSE_MS = 5_000

/**
 * One receive: takes up to ten jobs, applies each chunk and acknowledges it. A chunk that fails
 * (the database is unavailable) is left unacknowledged, so the queue hands it out again after its
 * visibility timeout and, after the queue's retry limit, moves it to the dead-letter queue. A job
 * that is not valid is logged by id and left the same way. Chunks set end states, so a repeat is
 * harmless. Returns how many jobs were received.
 */
export async function processAssignJobs(
  deps: AssignWorkerDeps,
  signal: AbortSignal,
  waitSeconds = 0,
  importOptions: ImportRunOptions = {}
): Promise<number> {
  const deliveries = await deps.jobs.receive({
    maxMessages: 10,
    visibilityTimeoutSeconds: CHUNK_VISIBILITY_SECONDS,
    waitSeconds,
    signal,
  })
  for (const delivery of deliveries) {
    if (delivery.kind === 'invalid') {
      deps.logger.error('an invalid job was received', {
        reason: delivery.reason,
        messageId: delivery.messageId,
        receiveCount: delivery.receiveCount,
      })
      continue
    }
    const { envelope } = delivery
    try {
      if (envelope.type === 'prospect.assign_chunk') {
        await applyAssignChunk(deps, {
          organizationId: organizationIdSchema.parse(envelope.organizationId),
          actorUserId: envelope.payload.actorUserId,
          ownerMembershipId: envelope.payload.ownerMembershipId,
          prospectIds: envelope.payload.prospectIds,
          traceId: envelope.traceId,
        })
      } else if (envelope.type === 'prospect.import_process') {
        const organizationId = organizationIdSchema.parse(envelope.organizationId)
        const outcome = await processImport(
          deps,
          {
            organizationId,
            importId: envelope.payload.importId,
            actorUserId: envelope.payload.actorUserId,
            traceId: envelope.traceId,
          },
          importOptions
        )
        if (outcome === 'continue') {
          // Hand the rest to a fresh job before this one is acknowledged: a refused publish
          // throws, so this job is delivered again and nothing is lost.
          const next = jobRegistry.create({
            type: 'prospect.import_process',
            payload: envelope.payload,
            organizationId,
            traceId: envelope.traceId,
          })
          const published = await deps.jobs.publishBatch([next])
          if (published.failed.length > 0) {
            throw new Error('The queue refused the continuation of an import')
          }
        }
      }
      await deps.jobs.acknowledge(delivery.receipt)
    } catch (error) {
      deps.logger.error('a queued job failed and will be retried', {
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
 * Starts the loop that applies queued bulk assignments. It holds no state, so any instance may run
 * it and any may stop at any time. It ends when `signal` aborts.
 */
export async function startAssignWorker(
  deps: AssignWorkerDeps,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      await processAssignJobs(deps, signal, CHUNK_WAIT_SECONDS)
    } catch (error) {
      if (signal.aborted) {
        return
      }
      deps.logger.error('assignment worker failed', { error: describeError(error) })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHUNK_ERROR_PAUSE_MS)
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

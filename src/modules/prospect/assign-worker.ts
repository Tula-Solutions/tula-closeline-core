import { exportJobIdSchema, organizationIdSchema } from 'tula-closeline-contract'
import { backoffDelayMs, rest, type Sleep } from '~/backoff'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { jobRegistry } from '~/messages'
import { attributeOutcome } from '~/modules/analytics/attribution'
import {
  consumeAnalyticsEvent,
  isAnalyticsEnvelope,
  reconcileAnalytics,
} from '~/modules/analytics/consumer'
import { assessTurn, type TurnDeps } from '~/modules/assessment/turn'
import { refreshBusy } from '~/modules/calendar/refresh'
import type { CalendarDeps } from '~/modules/calendar/service'
import {
  type SummaryDeps,
  summarizeConversation,
  sweepSummaries,
} from '~/modules/conversation-summary/service'
import type { CrmSyncDeps } from '~/modules/crm/sync'
import { type CrmSyncRunOptions, processCrmSyncRun } from '~/modules/crm/sync-worker'
import { type ExportRunOptions, runExportBuildStep } from '~/modules/export/build'
import * as Exports from '~/modules/export/service'
import { type ClassifyDeps, classifyMessage } from '~/modules/inbox/classify'
import { type DraftDeps, draftReply } from '~/modules/inbox/draft'
import {
  type ImportDeps,
  type ImportRunOptions,
  processImport,
} from '~/modules/prospect-import/process'
import {
  processSuppressionImport,
  type SuppressionImportDeps,
} from '~/modules/suppression-import/process'
import { type AssignDeps, applyAssignChunk } from './assign'
import { type EraseDeps, processErase } from './erase'

/** What the assignment worker needs from the container. */
export type AssignWorkerDeps = AssignDeps &
  ImportDeps &
  SuppressionImportDeps &
  EraseDeps &
  ClassifyDeps &
  DraftDeps &
  Exports.ExportDeps &
  TurnDeps &
  SummaryDeps &
  CalendarDeps &
  CrmSyncDeps &
  Pick<Container, 'jobs'>

/** How long a received chunk stays hidden from other workers, in seconds: far above one chunk's time. */
export const CHUNK_VISIBILITY_SECONDS = 120

/** How long one receive waits for a job when the queue is empty, in seconds. */
export const CHUNK_WAIT_SECONDS = 20

/** How long the loop rests after a failed receive, in ms. */
export const CHUNK_ERROR_PAUSE_MS = 5_000

/** The longest the loop rests after consecutive failed receives, in ms, before jitter. */
export const CHUNK_ERROR_PAUSE_CAP_MS = 60_000

/** What the loop reads from the outside world; tests replace both. */
export type AssignWorkerOptions = {
  /** Rests `ms`, or less when `signal` aborts; resolves either way. */
  sleep?: Sleep
  /** A number in [0, 1) for the backoff's jitter; `Math.random` unless a test fixes it. */
  random?: () => number
}

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
  importOptions: ImportRunOptions = {},
  exportOptions: ExportRunOptions = {},
  crmOptions: CrmSyncRunOptions = {}
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
      } else if (envelope.type === 'prospect.erase') {
        await processErase(deps, {
          organizationId: organizationIdSchema.parse(envelope.organizationId),
          prospectId: envelope.payload.prospectId,
          actorUserId: envelope.payload.actorUserId,
          traceId: envelope.traceId,
        })
      } else if (envelope.type === 'inbox.classify_message') {
        await classifyMessage(deps, {
          organizationId: organizationIdSchema.parse(envelope.organizationId),
          messageId: envelope.payload.messageId,
          traceId: envelope.traceId,
        })
      } else if (envelope.type === 'inbox.draft_reply') {
        await draftReply(deps, {
          organizationId: organizationIdSchema.parse(envelope.organizationId),
          messageId: envelope.payload.messageId,
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
      } else if (envelope.type === 'suppression.import_process') {
        const organizationId = organizationIdSchema.parse(envelope.organizationId)
        const outcome = await processSuppressionImport(
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
          // Same hand-off as a Prospect import: a refused publish throws, so nothing is lost.
          const next = jobRegistry.create({
            type: 'suppression.import_process',
            payload: envelope.payload,
            organizationId,
            traceId: envelope.traceId,
          })
          const published = await deps.jobs.publishBatch([next])
          if (published.failed.length > 0) {
            throw new Error('The queue refused the continuation of an import')
          }
        }
      } else if (envelope.type === 'crm.sync_run') {
        const organizationId = organizationIdSchema.parse(envelope.organizationId)
        const outcome = await processCrmSyncRun(
          deps,
          { organizationId, runId: envelope.payload.runId, traceId: envelope.traceId },
          delivery.receiveCount,
          crmOptions
        )
        if (outcome === 'continue') {
          // Same hand-off as an import: a refused publish throws, so the job is redelivered.
          const next = jobRegistry.create({
            type: 'crm.sync_run',
            payload: envelope.payload,
            organizationId,
            traceId: envelope.traceId,
          })
          const published = await deps.jobs.publishBatch([next])
          if (published.failed.length > 0) {
            throw new Error('The queue refused the continuation of a CRM sync run')
          }
        }
      } else if (envelope.type === 'export.build_core_part') {
        await runExportBuildStep(
          deps,
          {
            organizationId: organizationIdSchema.parse(envelope.organizationId),
            traceId: envelope.traceId,
            position: envelope.payload,
          },
          delivery.receiveCount,
          exportOptions
        )
      } else if (envelope.type === 'export.part_ready') {
        await Exports.receivePartReady(deps, organizationIdSchema.parse(envelope.organizationId), {
          ...envelope.payload,
          exportId: exportJobIdSchema.parse(envelope.payload.exportId),
        })
      } else if (envelope.type === 'export.part_failed') {
        await Exports.receivePartFailed(deps, organizationIdSchema.parse(envelope.organizationId), {
          ...envelope.payload,
          exportId: exportJobIdSchema.parse(envelope.payload.exportId),
        })
      } else if (isAnalyticsEnvelope(envelope)) {
        await consumeAnalyticsEvent(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope
        )
        if (envelope.type === 'deal.outcome_changed') {
          await attributeOutcome(
            deps,
            organizationIdSchema.parse(envelope.organizationId),
            envelope
          )
        }
      } else if (envelope.type === 'call.turn_completed') {
        await assessTurn(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope.payload
        )
      } else if (envelope.type === 'analytics.reconcile') {
        await reconcileAnalytics(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope.payload.days
        )
      } else if (envelope.type === 'inbox.summarize_conversation') {
        await summarizeConversation(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope.payload.conversationId
        )
      } else if (envelope.type === 'calendar.refresh_busy') {
        await refreshBusy(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope.payload.membershipId
        )
      } else if (envelope.type === 'inbox.summarize_sweep') {
        await sweepSummaries(
          deps,
          organizationIdSchema.parse(envelope.organizationId),
          envelope.payload.after
        )
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
 * it and any may stop at any time. It ends when `signal` aborts. After a failed receive it rests
 * with {@link backoffDelayMs} from {@link CHUNK_ERROR_PAUSE_MS} up to
 * {@link CHUNK_ERROR_PAUSE_CAP_MS}, longer for each failure in a row; a successful receive resets it.
 */
export async function startAssignWorker(
  deps: AssignWorkerDeps,
  signal: AbortSignal,
  options: AssignWorkerOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? rest
  const random = options.random ?? Math.random
  let failures = 0
  while (!signal.aborted) {
    try {
      await processAssignJobs(deps, signal, CHUNK_WAIT_SECONDS)
      failures = 0
    } catch (error) {
      if (signal.aborted) {
        return
      }
      failures += 1
      const nextDelayMs = backoffDelayMs(
        failures,
        { baseMs: CHUNK_ERROR_PAUSE_MS, capMs: CHUNK_ERROR_PAUSE_CAP_MS },
        random
      )
      deps.logger.error('assignment worker failed', {
        attempt: failures,
        nextDelayMs,
        error: describeError(error),
      })
      await sleep(nextDelayMs, signal)
    }
  }
}

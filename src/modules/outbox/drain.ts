import type { ProspectImportId } from 'tula-closeline-contract'
import { z } from 'zod'
import { backoffDelayMs, rest, type Sleep } from '~/backoff'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { type CoreEnvelope, type JobEnvelope, jobRegistry, registry } from '~/messages'
import { failProspectImport } from '~/modules/prospect-import/process'
import type { ClaimedOutboxRow, OutboxStore } from '~/ports/outbox'

/** What the drain needs from the container. */
export type OutboxDrainDeps = Pick<Container, 'clock' | 'events' | 'jobs' | 'logger' | 'store'> & {
  outbox: OutboxStore
}

/** The settings of one drain, all bounded by `src/env.ts`. */
export type OutboxDrainOptions = {
  /** Rows claimed per pass (1 to 100). */
  batchSize: number
  /** How long a claim hides its rows from other drains, in ms. It must outlast a whole pass. */
  leaseMs: number
  /** The longest one queue publish may take, in ms. */
  publishTimeoutMs: number
  /** Rest between passes when nothing was due, in ms. */
  pollIntervalMs: number
  /** A number in [0, 1) for the backoff's jitter; `Math.random` unless a test fixes it. */
  random?: () => number
  /** Rests `ms`, or less when `signal` aborts; `rest` unless a test replaces it. */
  sleep?: Sleep
}

/** The most envelopes one queue batch carries (the queue's own limit). */
const PUBLISH_BATCH = 10

/** The first retry waits this long, in ms; each later attempt doubles it. */
export const BACKOFF_BASE_MS = 1_000

/** No retry waits longer than this, in ms (the database allows a day). */
export const BACKOFF_CAP_MS = 15 * 60_000

/** The first rest after a pass that threw (the database is unreachable), in ms; it doubles per failure. */
export const PASS_ERROR_PAUSE_MS = 5_000

/** The longest the loop rests after consecutive failed passes, in ms, before jitter. */
export const PASS_ERROR_PAUSE_CAP_MS = 60_000

/** The attempt at which the database parks a row and stops returning it. */
const PARKED_AT_ATTEMPTS = 50

/** What a drain pass did, for the loop and for tests. */
export type DrainResult = { claimed: number; published: number; failed: number; parked: number }

/** What a row's payload holds: the event as `enqueueEvents` wrote it. */
const storedEvent = z.object({
  occurredAt: z.iso.datetime(),
  traceId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
})

/**
 * How long to wait before claiming a row again after its `attempts`-th failed publish: exponential
 * from {@link BACKOFF_BASE_MS}, capped at {@link BACKOFF_CAP_MS}, then jittered into the upper half
 * so rows that failed together do not come back together. `random` is in [0, 1). Bounded: at most
 * the cap.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  return backoffDelayMs(attempts, { baseMs: BACKOFF_BASE_MS, capMs: BACKOFF_CAP_MS }, random)
}

/** The codes the outbox stores: lower case, digits, dots and underscores, starting with a letter, at most 64. */
const ERROR_CODE = /^[a-z][a-z0-9_.]*$/

/** Thrown when a publish outlasts its timeout. */
class PublishTimeout extends Error {}

/** A stored row that cannot become an envelope: an unknown topic or a payload the schema refuses. */
class InvalidRow extends Error {
  constructor(readonly code: 'outbox.unknown_topic' | 'outbox.invalid_event') {
    super(code)
  }
}

/**
 * The code to store for a failed publish: the queue's own `code` when it fits the outbox's shape,
 * else a fixed one. Never the error's message, which could carry anything.
 */
function codeOf(error: unknown): string {
  if (error instanceof PublishTimeout) {
    return 'outbox.publish_timeout'
  }
  if (error instanceof InvalidRow) {
    return error.code
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined
  return typeof code === 'string' && code.length <= 64 && ERROR_CODE.test(code)
    ? code
    : 'outbox.publish_failed'
}

/** Rejects with a {@link PublishTimeout} when `work` takes longer than `ms`; a late result is dropped. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PublishTimeout()), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** A topic only the jobs registry knows is a job; one both know (`reply.classified`) is an event. */
const isJobTopic = (topic: string): boolean =>
  !registry.definitions.has(topic) && jobRegistry.definitions.has(topic)

/**
 * Builds the envelope of a claimed row; its id is the row id, so a republish carries the same id.
 * A topic of the jobs registry (such as `prospect.import_process`) is a job for the jobs queue.
 */
function envelopeOf(row: ClaimedOutboxRow): CoreEnvelope | JobEnvelope {
  const stored = storedEvent.safeParse(row.payload)
  if (!stored.success) {
    throw new InvalidRow('outbox.invalid_event')
  }
  const isJob = isJobTopic(row.topic)
  if (!isJob && !registry.definitions.has(row.topic)) {
    throw new InvalidRow('outbox.unknown_topic')
  }
  try {
    return (isJob ? jobRegistry : registry).create({
      type: row.topic,
      id: row.id,
      payload: stored.data.payload,
      organizationId: row.organizationId,
      traceId: stored.data.traceId,
      occurredAt: new Date(stored.data.occurredAt),
    } as never) as CoreEnvelope | JobEnvelope
  } catch {
    throw new InvalidRow('outbox.invalid_event')
  }
}

/**
 * One drain pass: claims a batch under a lease, publishes each row's event to the queue in groups
 * of ten (each call bounded by the publish timeout), then completes what the queue accepted and
 * fails the rest with a code and a jittered backoff. Delivery is at-least-once: a row whose
 * completion is lost, or whose drain dies mid-pass, is claimed again once its lease ends, and the
 * message carries the same id (the row id) for the consumer to drop. A row that fails on its 50th
 * claim is parked by the database; it is logged by id and topic, never by payload. Several drains
 * may run at once: the database hands each row to one claim at a time. One claim, one complete and
 * at most one fail per row; the queue calls are O(batch size).
 */
export async function drainOutbox(
  deps: OutboxDrainDeps,
  options: OutboxDrainOptions,
  signal?: AbortSignal
): Promise<DrainResult> {
  const random = options.random ?? Math.random
  const rows = await deps.outbox.claim(options.batchSize, options.leaseMs)
  const result: DrainResult = { claimed: rows.length, published: 0, failed: 0, parked: 0 }
  const done: ClaimedOutboxRow[] = []

  const fail = async (row: ClaimedOutboxRow, code: string): Promise<void> => {
    result.failed += 1
    const parked = row.attempts >= PARKED_AT_ATTEMPTS
    if (parked) {
      result.parked += 1
      deps.logger.error('outbox row parked after its last attempt', {
        id: row.id,
        organizationId: row.organizationId,
        topic: row.topic,
        attempts: row.attempts,
        code,
      })
    } else {
      deps.logger.warn('outbox publish failed and will be retried', {
        id: row.id,
        organizationId: row.organizationId,
        topic: row.topic,
        attempts: row.attempts,
        code,
      })
    }
    if (parked && row.topic === 'prospect.import_process') {
      // The client already has its 202; without this the import stays `uploaded` for good.
      try {
        await failProspectImport(
          deps,
          row.organizationId,
          (row.payload as { payload: { importId: ProspectImportId } }).payload.importId,
          'processing_failed'
        )
      } catch (error) {
        deps.logger.error('a parked import could not be marked failed', {
          id: row.id,
          error: describeError(error),
        })
      }
    }
    try {
      await deps.outbox.fail(
        { organizationId: row.organizationId, id: row.id },
        code,
        backoffMs(row.attempts, random)
      )
    } catch (error) {
      // The lease ends on its own and the row comes back; losing this write only loses the backoff.
      deps.logger.error('outbox failure could not be recorded', {
        id: row.id,
        error: describeError(error),
      })
    }
  }

  for (let start = 0; start < rows.length; start += PUBLISH_BATCH) {
    const group = rows.slice(start, start + PUBLISH_BATCH)
    if (signal?.aborted) {
      // Stopping: the rest keep their lease and are claimed again by the next drain.
      break
    }
    const built: { row: ClaimedOutboxRow; envelope: CoreEnvelope | JobEnvelope }[] = []
    for (const row of group) {
      try {
        built.push({ row, envelope: envelopeOf(row) })
      } catch (error) {
        await fail(row, codeOf(error))
      }
    }
    if (built.length === 0) {
      continue
    }
    for (const queue of ['events', 'jobs'] as const) {
      const items = built.filter((item) => isJobTopic(item.row.topic) === (queue === 'jobs'))
      if (items.length === 0) {
        continue
      }
      try {
        const envelopes = items.map((item) => item.envelope)
        const sent = await withTimeout(
          (queue === 'jobs' ? deps.jobs : deps.events).publishBatch(envelopes as never),
          options.publishTimeoutMs
        )
        const accepted = new Set(sent.sent)
        const refused = new Map(sent.failed.map((failure) => [failure.id, failure.code]))
        for (const item of items) {
          if (refused.has(item.row.id) || !accepted.has(item.row.id)) {
            await fail(item.row, codeOf({ code: refused.get(item.row.id) }))
          } else {
            done.push(item.row)
          }
        }
      } catch (error) {
        const code = codeOf(error)
        for (const item of items) {
          await fail(item.row, code)
        }
      }
    }
  }

  if (done.length > 0) {
    try {
      await deps.outbox.complete(
        done.map((row) => ({ organizationId: row.organizationId, id: row.id }))
      )
      result.published = done.length
    } catch (error) {
      // Published but not marked: the lease ends and the row is published again with the same id.
      deps.logger.error('outbox rows could not be marked published', {
        count: done.length,
        error: describeError(error),
      })
    }
  }
  return result
}

/**
 * Runs {@link drainOutbox} until `signal` aborts: straight on while a pass finds a full batch, a
 * poll interval's rest (with up to a fifth of jitter, so instances do not poll in step) when it
 * finds less. A pass that throws rests with {@link backoffDelayMs} from {@link PASS_ERROR_PAUSE_MS}
 * up to {@link PASS_ERROR_PAUSE_CAP_MS}, longer for each failure in a row; a pass that returns
 * resets it. It holds no state, so any instance may run it and any may stop at any time. The
 * returned promise settles once the pass in flight has ended, so a caller can wait for it before
 * closing the database.
 */
export async function startOutboxDrain(
  deps: OutboxDrainDeps,
  options: OutboxDrainOptions,
  signal: AbortSignal
): Promise<void> {
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? rest
  let failures = 0
  while (!signal.aborted) {
    let pause = options.pollIntervalMs * (1 + random() * 0.2)
    try {
      const pass = await drainOutbox(deps, options, signal)
      failures = 0
      if (pass.claimed >= options.batchSize) {
        pause = 0
      }
    } catch (error) {
      failures += 1
      pause = backoffDelayMs(
        failures,
        { baseMs: PASS_ERROR_PAUSE_MS, capMs: PASS_ERROR_PAUSE_CAP_MS },
        random
      )
      deps.logger.error('outbox drain failed', {
        attempt: failures,
        nextDelayMs: pause,
        error: describeError(error),
      })
    }
    await sleep(pause, signal)
  }
}

import {
  DEMO_NOTICE_CLAIM_MAX,
  DEMO_PURGE_BATCH_MAX,
  DEMO_RATE_PURGE_BATCH_MAX,
} from 'tula-closeline-db'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import type { ClaimedDemoNotice } from '~/ports/demo-request-store'

/** The most notices one pass claims: at this size a pass of slow sends fits in the backoff. */
export const NOTICE_BATCH = 5

/** A notice is not claimed again until this long after its last attempt, in seconds. */
export const NOTICE_BACKOFF_SECONDS = 60

/** The most times a notice is tried; past it the notice settles `failed` (the database has no cap). */
export const NOTICE_MAX_ATTEMPTS = 8

/** The longest one notice may take to hand over, retries included, in ms. */
export const NOTICE_SEND_TIMEOUT_MS = 10_000

/** How often the worker looks for pending notices, in ms. */
export const NOTICE_POLL_MS = 5_000

/** How often the purge runs, in ms (hourly). */
export const PURGE_INTERVAL_MS = 3_600_000

/** The most batches one purge run deletes, so one run is bounded however large the backlog. */
export const PURGE_MAX_BATCHES = 100

/** What the worker needs from the container. */
export type DemoWorkerDeps = Pick<
  Container,
  'demoRequests' | 'teamNoticeMailer' | 'logger' | 'env' | 'demoRateLimiter'
>

/**
 * One pass over the outbox: claims up to {@link NOTICE_BATCH} pending notices and settles each as
 * `sent` or `failed`. A notice whose hand-over fails stays pending and is claimed again after
 * {@link NOTICE_BACKOFF_SECONDS}; at {@link NOTICE_MAX_ATTEMPTS} it settles `failed` instead, and a
 * notice already past the cap (a worker died after its last claim) settles `failed` unsent. A
 * settle that fails leaves the notice pending to be claimed again, so delivery is at least once.
 * Returns how many notices were claimed. Nothing is logged but ids, counts and error names.
 */
export async function sendPendingNotices(
  deps: DemoWorkerDeps,
  signal: AbortSignal
): Promise<number> {
  const claimed = await deps.demoRequests.claimNotices(
    Math.min(NOTICE_BATCH, DEMO_NOTICE_CLAIM_MAX),
    NOTICE_BACKOFF_SECONDS
  )
  for (const notice of claimed) {
    if (signal.aborted) {
      break
    }
    try {
      await handleNotice(deps, notice, signal)
    } catch (error) {
      // A failed settle must not drop the notices after it; this one is claimed again later.
      deps.logger.error('demo notice not settled', {
        id: notice.id,
        error: describeError(error),
      })
    }
  }
  return claimed.length
}

/** Sends one claimed notice and settles it; a send failure is logged, a settle failure throws. */
async function handleNotice(
  deps: DemoWorkerDeps,
  notice: ClaimedDemoNotice,
  signal: AbortSignal
): Promise<void> {
  if (notice.attempts > NOTICE_MAX_ATTEMPTS) {
    await deps.demoRequests.settleNotice(notice.id, 'failed')
    deps.logger.error('demo notice given up', { id: notice.id, attempts: notice.attempts })
    return
  }
  try {
    await deps.teamNoticeMailer.deliver(
      {
        to: deps.env.DEMO_NOTICE_TO,
        id: notice.id,
        name: notice.name,
        workEmail: notice.workEmail,
        companyName: notice.companyName,
        message: notice.message,
        sourcePage: notice.sourcePage,
        submittedAt: notice.submittedAt,
      },
      AbortSignal.any([signal, AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS)])
    )
  } catch (error) {
    const spent = notice.attempts >= NOTICE_MAX_ATTEMPTS
    // The name only: a mail error's text is the adapter's, and never worth the risk here.
    const detail = {
      id: notice.id,
      attempts: notice.attempts,
      error: error instanceof Error ? error.name : 'unknown',
    }
    if (spent) {
      // The team is never told of this Demo Request; an error, so it is seen and reported.
      deps.logger.error('demo notice given up', detail)
      await deps.demoRequests.settleNotice(notice.id, 'failed')
    } else {
      deps.logger.warn('demo notice not sent', detail)
    }
    return
  }
  await deps.demoRequests.settleNotice(notice.id, 'sent')
}

/**
 * Deletes Demo Requests older than twelve months, a bounded batch at a time while a batch comes
 * back full (at most {@link PURGE_MAX_BATCHES}), and the rate counters of windows that have ended.
 * Returns how many Demo Requests went.
 */
export async function purgeExpired(deps: DemoWorkerDeps): Promise<number> {
  let total = 0
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const removed = await deps.demoRequests.purgeExpired(DEMO_PURGE_BATCH_MAX)
    total += removed
    if (removed < DEMO_PURGE_BATCH_MAX) {
      break
    }
  }
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
    const removed = await deps.demoRateLimiter.purge(DEMO_RATE_PURGE_BATCH_MAX)
    if (removed < DEMO_RATE_PURGE_BATCH_MAX) {
      break
    }
  }
  return total
}

/** Waits `ms` with up to a fifth added as jitter, or less when `signal` aborts; resolves either way. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms + Math.random() * ms * 0.2)
    signal.addEventListener('abort', done)
  })
}

/** Runs `step` every `everyMs` until `signal` aborts; a failing step is logged and the loop goes on. */
async function every(
  name: string,
  everyMs: number,
  signal: AbortSignal,
  deps: Pick<DemoWorkerDeps, 'logger'>,
  step: () => Promise<void>
): Promise<void> {
  while (!signal.aborted) {
    try {
      await step()
    } catch (error) {
      deps.logger.error(`${name} failed`, { error: describeError(error) })
    }
    await sleep(everyMs, signal)
  }
}

/**
 * Starts the two background loops of the Demo Request module: the notice outbox and the purge.
 * They hold no state of their own, so any instance may run them and any may stop at any time. They
 * end when `signal` aborts. Returns a promise that settles once both have ended.
 */
export function startDemoBackground(deps: DemoWorkerDeps, signal: AbortSignal): Promise<void> {
  return Promise.all([
    every('demo notice worker', NOTICE_POLL_MS, signal, deps, async () => {
      // A full batch means more may be waiting: go again at once, bounded.
      for (let pass = 0; pass < PURGE_MAX_BATCHES; pass += 1) {
        if ((await sendPendingNotices(deps, signal)) < NOTICE_BATCH) {
          break
        }
      }
    }),
    every('demo purge', PURGE_INTERVAL_MS, signal, deps, async () => {
      await purgeExpired(deps)
    }),
  ]).then(() => undefined)
}

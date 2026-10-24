import type { AnalyticsMetric, OrganizationId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import type { JobEnvelope } from '~/messages'
import type { AnalyticsEventEntry } from '~/ports/analytics-store'

/** What the analytics consumers need from the container. */
export type AnalyticsDeps = Pick<Container, 'store' | 'clock'>

/** The envelope types the rollups count; every other job type is not analytics. */
export type AnalyticsEnvelope = Extract<
  JobEnvelope,
  { type: 'message.sent' | 'reply.classified' | 'booking.created' | 'deal.outcome_changed' }
>

/** Whether a job is one of the events the rollups count. */
export function isAnalyticsEnvelope(envelope: JobEnvelope): envelope is AnalyticsEnvelope {
  return (
    envelope.type === 'message.sent' ||
    envelope.type === 'reply.classified' ||
    envelope.type === 'booking.created' ||
    envelope.type === 'deal.outcome_changed'
  )
}

/** The UTC calendar day (`YYYY-MM-DD`) of an ISO timestamp: the day the thing happened, never the day it was processed. */
export function utcDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

const entry = (
  metric: AnalyticsMetric,
  dedupeKey: string,
  timestamp: string,
  channel: AnalyticsEventEntry['channel']
): AnalyticsEventEntry => ({ metric, dedupeKey, day: utcDay(timestamp), channel })

/**
 * What an event counts. A send counts once per Message, a reply once per Message (and a positive
 * one also once as a positive reply), a meeting once per booking, and a Deal once per outcome it
 * reaches. The day is the one the event says it happened on, so a late event lands on its own day.
 * An outcome of `open` counts nothing. The ids are the dedupe keys, so a replay counts nothing.
 */
export function entriesOf(envelope: AnalyticsEnvelope): AnalyticsEventEntry[] {
  switch (envelope.type) {
    case 'message.sent': {
      const { messageId, sentAt, channel } = envelope.payload
      return [entry('sends', messageId, sentAt, channel)]
    }
    case 'reply.classified': {
      const { messageId, classifiedAt, channel, label } = envelope.payload
      const entries = [entry('replies', messageId, classifiedAt, channel)]
      if (label === 'positive') {
        entries.push(entry('positive_replies', messageId, classifiedAt, channel))
      }
      return entries
    }
    case 'booking.created':
      return [entry('meetings', envelope.payload.bookingId, envelope.occurredAt, null)]
    case 'deal.outcome_changed': {
      const { dealRecordId, outcome, changedAt } = envelope.payload
      if (outcome === 'won') {
        return [entry('outcomes_won', dealRecordId, changedAt, null)]
      }
      if (outcome === 'lost') {
        return [entry('outcomes_lost', dealRecordId, changedAt, null)]
      }
      return []
    }
  }
}

/**
 * Counts one event for its Organization in one transaction under the Organization lock. Returns
 * how many of its counts were new (0 for a replay, or for an Organization that is gone, which
 * counts nothing). Idempotent: the ledger decides, so a redelivery changes nothing.
 */
export async function consumeAnalyticsEvent(
  deps: AnalyticsDeps,
  organizationId: OrganizationId,
  envelope: AnalyticsEnvelope
): Promise<number> {
  const entries = entriesOf(envelope)
  if (entries.length === 0) {
    return 0
  }
  return deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 0
    }
    let recorded = 0
    for (const item of entries) {
      if (await scope.recordAnalyticsEvent(item)) {
        recorded += 1
      }
    }
    return recorded
  })
}

/** The first and last UTC day of the last `days` days, today included. */
export function reconcileWindow(now: Date, days: number): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10)
  const start = new Date(`${to}T00:00:00.000Z`)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return { from: start.toISOString().slice(0, 10), to }
}

/**
 * The nightly reconcile for one Organization: recounts the rollups of the last `days` UTC days
 * from the ledger and repairs any cell that differs. Work grows with the ledger rows of that
 * window. An Organization that is gone has nothing to repair.
 */
export async function reconcileAnalytics(
  deps: AnalyticsDeps,
  organizationId: OrganizationId,
  days: number
): Promise<{ cells: number; repaired: number }> {
  const window = reconcileWindow(deps.clock.now(), days)
  return deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return { cells: 0, repaired: 0 }
    }
    return scope.reconcileRollups(window)
  })
}

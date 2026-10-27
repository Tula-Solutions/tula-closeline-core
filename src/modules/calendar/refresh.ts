import type { MembershipId, OrganizationId } from 'tula-closeline-contract'
import { CalendarError } from 'tula-closeline-kit'
import { jobRegistry } from '~/messages'
import { newOutboxId } from '~/modules/prospect/events'
import type { CalendarConnectionRecord, OrganizationScope } from '~/ports/core-store'
import { type CalendarDeps, openVendorConnection } from './service'

/** How far ahead a Rep's busy times are kept, in days. */
export const BUSY_HORIZON_DAYS = 14

/** The longest a refresh waits on the calendar vendor, in ms; the job is not on a request path. */
const REFRESH_TIMEOUT_MS = 10_000

/**
 * Queues a busy-time refresh for a Rep's new connection through the outbox, in the caller's
 * transaction. The key is the connection id, so a repeat for the same connection is dropped and a
 * reconnect (a new id) queues again.
 */
export async function enqueueRefresh(
  scope: OrganizationScope,
  organizationId: OrganizationId,
  connection: Pick<CalendarConnectionRecord, 'id' | 'membershipId'>
): Promise<void> {
  const traceId = crypto.randomUUID()
  const job = jobRegistry.create({
    type: 'calendar.refresh_busy',
    payload: { membershipId: connection.membershipId },
    organizationId,
    traceId,
  })
  await scope.enqueueOutbox({
    id: newOutboxId(),
    topic: job.type,
    dedupeKey: `calendar.refresh_busy:${connection.id}`,
    payload: { eventId: job.id, occurredAt: job.occurredAt, traceId, payload: job.payload },
  })
}

/**
 * Reloads a Rep's busy times for the next {@link BUSY_HORIZON_DAYS} days from their calendar and
 * replaces the stored ones in that range. The vendor is called outside any lock. A revoked grant
 * marks the connection `needs_reconnect` and ends the job; any other vendor failure is thrown so
 * the queue delivers the job again. A Rep with no healthy connection is skipped. Idempotent: it
 * sets the end state for the range, so a repeat or a duplicate job changes nothing.
 */
export async function refreshBusy(
  deps: CalendarDeps,
  organizationId: OrganizationId,
  membershipId: MembershipId
): Promise<void> {
  if (!deps.calendar) {
    return
  }
  const found = await deps.store.withOrganization(organizationId, async (scope) => {
    const record = await scope.getCalendarConnection(membershipId)
    return record ? { record, sealed: await scope.getCalendarSealedCredential(membershipId) } : null
  })
  if (!found || !found.sealed || found.record.state !== 'healthy') {
    return
  }
  const { record } = found
  const vendor = await openVendorConnection(deps, organizationId, record.id, found.sealed)
  if (!vendor) {
    return
  }
  const from = new Date(deps.clock.now())
  const to = new Date(from.getTime() + BUSY_HORIZON_DAYS * 86_400_000)
  let intervals: { start: string; end: string }[]
  try {
    intervals = await deps.calendar.port.busy(
      { organizationId, connection: vendor, from: from.toISOString(), to: to.toISOString() },
      { timeoutMs: REFRESH_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof CalendarError && error.code === 'calendar.revoked') {
      await deps.store.withOrganization(organizationId, async (scope) => {
        if (await scope.lockOrganization()) {
          await scope.setCalendarConnectionState(membershipId, record.id, 'needs_reconnect', from)
        }
      })
      return
    }
    throw error
  }
  const blocks = intervals.map((interval) => ({
    startsAt: new Date(interval.start),
    endsAt: new Date(interval.end),
  }))
  await deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await scope.lockOrganization())) {
      return
    }
    // Written against the connection that was read: a Rep who reconnected meanwhile is refreshed by their own job.
    if (!(await scope.setCalendarConnectionState(membershipId, record.id, 'healthy', from))) {
      return
    }
    await scope.replaceBusyBlocks(membershipId, { from, to }, blocks, from)
  })
}

import {
  CORE_ERRORS,
  ERRORS,
  type EraseProspectResponse,
  formatId,
  type OrganizationId,
  PROSPECT_ERRORS,
  type ProspectId,
  type UserId,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import type { Caller } from '~/modules/caller'
import { openOrganizationForWrite } from '~/modules/organization/access'
import { hashAddress, normaliseAddress } from '~/modules/suppression/address'
import type { OrganizationScope } from '~/ports/core-store'
import { enqueueEvents, erasedEvent, type PendingEvent, suppressionAddedEvent } from './events'

/** What erasing a Prospect needs from the container. */
export type EraseDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events' | 'jobs' | 'env'>

/** The most field-history rows one transaction of the erase job removes. */
export const ERASE_BATCH_ROWS = 200

/** What names one erase job. */
export type EraseJob = {
  organizationId: OrganizationId
  prospectId: ProspectId
  actorUserId: UserId
  traceId: string
}

/**
 * Accepts the erasure of a Prospect, for Owner and Admin, and queues the job that does it. The
 * request does a constant amount of work whatever the Prospect holds: it checks the role, finds
 * the Prospect (whoever owns it) and publishes one job, answering 202. A Prospect that does not
 * exist here, including one of another Organization or one already erased, is
 * `prospect.not_found`; a Rep or Manager is `auth.forbidden` before anything is looked up. A
 * queue that refuses the job is `server.unavailable`, and nothing has changed.
 */
export async function requestErase(
  deps: EraseDeps,
  caller: Caller,
  prospectId: ProspectId,
  options: { traceId: string }
): Promise<EraseProspectResponse> {
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'prospect.erase')
    const found = await scope.getProspect(prospectId, { kind: 'all' })
    if (!found) {
      throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'prospect' })
    }
  })
  const job = jobRegistry.create({
    type: 'prospect.erase',
    payload: { prospectId, actorUserId: caller.userId },
    organizationId: caller.organizationId,
    traceId: options.traceId,
  })
  let refused = false
  try {
    refused = (await deps.jobs.publishBatch([job])).failed.length > 0
  } catch {
    refused = true
  }
  if (refused) {
    throw domainError(ERRORS['server.unavailable'])
  }
  return { prospectId, state: 'queued' }
}

/**
 * Runs `work` in one transaction with the Organization locked. A deleted or missing Organization
 * ends the job (`stop`); a suspended one throws, so the queue delivers the job again.
 */
async function inOrganization<T>(
  deps: EraseDeps,
  organizationId: OrganizationId,
  work: (scope: OrganizationScope) => Promise<T>
): Promise<T | 'stop'> {
  return deps.store.withOrganization(organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return 'stop'
    }
    if (organization.status === 'suspended') {
      throw domainError(CORE_ERRORS['organization.suspended'])
    }
    return work(scope)
  })
}

/**
 * Writes a suppression entry (reason `erased`, no mask) for every address the Prospect holds or
 * held, each hashed as the Suppression list hashes it. An address already suppressed is left as
 * it is. Returns the events of the entries made. Never logs or returns an address.
 */
async function suppressAddresses(
  deps: EraseDeps,
  scope: OrganizationScope,
  job: EraseJob
): Promise<PendingEvent[]> {
  const events: PendingEvent[] = []
  const now = deps.clock.now()
  for (const address of await scope.listProspectAddresses(job.prospectId)) {
    const normalised = normaliseAddress(address.kind, address.value)
    if (normalised === undefined) {
      continue
    }
    const { entry, created } = await scope.insertSuppressionEntry({
      id: formatId('sup', crypto.randomUUID()),
      addressKind: address.kind,
      addressHash: hashAddress(
        deps.env.CONSENT_HASH_KEY,
        job.organizationId,
        address.kind,
        normalised
      ),
      maskedAddress: null,
      reason: 'erased',
      channel: null,
      sourceRef: null,
      addedByUserId: job.actorUserId,
      now,
    })
    if (created) {
      // The Prospect is about to be gone, so the event does not point at it.
      events.push(
        suppressionAddedEvent({
          suppressionEntryId: entry.id,
          addressKind: entry.addressKind,
          reason: entry.reason,
          prospectId: null,
        })
      )
    }
  }
  return events
}

/**
 * Erases one Prospect for good, in steps that each commit, so a crash or a redelivery resumes
 * where it stopped. First the suppression entries for its addresses are written (so no address
 * can be contacted again whatever happens next); then its field history goes in batches of
 * {@link ERASE_BATCH_ROWS}; last the Prospect row goes, taking its identities (free to re-use at
 * once, and only by a new Contact Consent) and consent events with it, and `prospect.erased`
 * is written to the outbox in that same transaction. A Prospect that is already gone ends the job and publishes
 * nothing. No value, address or name is logged.
 */
export async function processErase(
  deps: EraseDeps,
  job: EraseJob,
  options: { batchRows?: number } = {}
): Promise<void> {
  const batchRows = options.batchRows ?? ERASE_BATCH_ROWS
  const suppressed = await inOrganization(deps, job.organizationId, async (scope) => {
    const found = await scope.getProspect(job.prospectId, { kind: 'all' })
    if (!found) {
      return null
    }
    // The events join this transaction's outbox rows, so they exist exactly when the entries do.
    const events = await suppressAddresses(deps, scope, job)
    await enqueueEvents(scope, job.organizationId, job.traceId, events)
    return events
  })
  if (suppressed === 'stop' || suppressed === null) {
    return
  }

  for (;;) {
    const removed = await inOrganization(deps, job.organizationId, (scope) =>
      scope.eraseProspectFields(job.prospectId, batchRows)
    )
    if (removed === 'stop') {
      return
    }
    if (removed < batchRows) {
      break
    }
  }

  // An edit may have added an address since the first step; the Organization lock makes this
  // final pass and the delete one unit, so no address is erased without its suppression entry.
  const last = await inOrganization(deps, job.organizationId, async (scope) => {
    const late = await suppressAddresses(deps, scope, job)
    const erased = await scope.eraseProspectRow(job.prospectId)
    await enqueueEvents(scope, job.organizationId, job.traceId, [
      ...late,
      ...(erased ? [erasedEvent({ prospectId: job.prospectId })] : []),
    ])
    return { erased }
  })
  if (last === 'stop' || !last.erased) {
    return
  }
  deps.logger.info('prospect erased', {
    organizationId: job.organizationId,
    prospectId: job.prospectId,
  })
}

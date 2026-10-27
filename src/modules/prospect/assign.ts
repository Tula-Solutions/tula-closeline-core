import {
  type BulkAssignProspectsRequest,
  type BulkAssignProspectsResponse,
  bulkAssignProspectsResponseSchema,
  ERRORS,
  type MembershipId,
  PROSPECT_ERRORS,
  type Prospect,
  type ProspectId,
  type UserId,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { ASSIGN_CHUNK_SIZE, jobRegistry } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import {
  findAnswer,
  type IdempotentAnswer,
  idempotent,
  recordAnswer,
} from '~/modules/idempotency/service'
import { openOrganizationForWrite } from '~/modules/organization/access'
import { MissingReferenceError, type OrganizationScope, REASSIGN_MAX_IDS } from '~/ports/core-store'
import { enqueueEvents, ownerChangedEvent, type PendingEvent } from './events'
import { toProspectResponse } from './schema'
import type { ProspectCallOptions } from './service'

/** What assigning owners needs from the container. */
export type AssignDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events' | 'jobs'>

/** The most requests one batch publish to the jobs queue carries (the queue's own limit). */
const JOBS_PUBLISH_BATCH = 10

/**
 * Locks the named Membership and requires it to be a Rep or Manager of this Organization. A
 * Membership that does not exist here (including one of another Organization) and one with any
 * other role are both `prospect.forbidden_owner`.
 */
async function requireAssignableOwner(
  scope: OrganizationScope,
  ownerMembershipId: MembershipId
): Promise<void> {
  const member = await scope.lockMembership(ownerMembershipId)
  if (!member || (member.role !== 'rep' && member.role !== 'manager')) {
    throw domainError(PROSPECT_ERRORS['prospect.forbidden_owner'])
  }
}

/** Turns a store refusal about the owner into the contract's code; any other error passes unchanged. */
function asOwnerError(error: unknown): unknown {
  return error instanceof MissingReferenceError
    ? domainError(PROSPECT_ERRORS['prospect.forbidden_owner'])
    : error
}

/**
 * Makes the named Rep or Manager the owner of one Prospect, for Owner and Admin. Decided on current,
 * locked data: the Prospect and the owner's Membership are read under lock, and the Prospect is
 * found whoever owns it now. Setting the owner it already has changes nothing and publishes
 * nothing; a change publishes `prospect.updated` (`ownerChanged`) once, through the outbox.
 */
export async function setOwner(
  deps: AssignDeps,
  caller: Caller,
  prospectId: ProspectId,
  ownerMembershipId: MembershipId,
  options: ProspectCallOptions
): Promise<Prospect> {
  const now = deps.clock.now()
  let result: { body: Prospect }
  try {
    result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const events: PendingEvent[] = []
      await openOrganizationForWrite(scope, caller, 'prospect.assign')
      const before = await scope.lockProspect(prospectId, { kind: 'all' })
      if (!before) {
        throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'prospect' })
      }
      await requireAssignableOwner(scope, ownerMembershipId)
      let record = before
      if (before.ownerMembershipId !== ownerMembershipId) {
        record = (await scope.updateProspect(prospectId, { ownerMembershipId }, now)) ?? before
        events.push(ownerChangedEvent(prospectId))
      }
      const fields = (await scope.listCurrentFields('prospect', [prospectId])).get(prospectId) ?? []
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
      return { body: toProspectResponse(record, fields) }
    })
  } catch (error) {
    throw asOwnerError(error)
  }
  return result.body
}

/** Sends the chunk jobs of a queued bulk assignment; a job the queue refuses fails the request. */
async function enqueueChunks(
  deps: AssignDeps,
  caller: Caller,
  request: BulkAssignProspectsRequest,
  traceId: string
): Promise<void> {
  const envelopes = []
  for (let start = 0; start < request.prospectIds.length; start += ASSIGN_CHUNK_SIZE) {
    envelopes.push(
      jobRegistry.create({
        type: 'prospect.assign_chunk',
        payload: {
          actorUserId: caller.userId,
          ownerMembershipId: request.ownerMembershipId,
          prospectIds: request.prospectIds.slice(start, start + ASSIGN_CHUNK_SIZE),
        },
        organizationId: caller.organizationId,
        traceId,
      })
    )
  }
  for (let start = 0; start < envelopes.length; start += JOBS_PUBLISH_BATCH) {
    const result = await deps.jobs.publishBatch(envelopes.slice(start, start + JOBS_PUBLISH_BATCH))
    if (result.failed.length > 0) {
      throw domainError(ERRORS['server.unavailable'])
    }
  }
}

/**
 * Makes the named Rep or Manager the owner of many Prospects, for Owner and Admin. Up to
 * {@link REASSIGN_MAX_IDS} ids are applied in the one transaction and answered `applied` (200):
 * `assigned` counts the Prospects that exist (including those already theirs) and `skipped` the
 * ids that do not exist here, which are not named. More ids are checked (role and owner) and
 * queued in chunks of {@link ASSIGN_CHUNK_SIZE} and answered `queued` (202), the counts not yet
 * known. With an `Idempotency-Key` the same request again returns the first answer and changes
 * and queues nothing; without one a repeat is harmless, since each chunk sets an end state.
 */
export async function bulkAssign(
  deps: AssignDeps,
  caller: Caller,
  request: BulkAssignProspectsRequest,
  options: ProspectCallOptions
): Promise<IdempotentAnswer<200 | 202, BulkAssignProspectsResponse>> {
  const queued = request.prospectIds.length > REASSIGN_MAX_IDS
  const call = {
    key: options.idempotencyKey,
    route: 'prospects.assign',
    request: { body: request },
  }
  if (queued) {
    return queueAssign(deps, caller, request, options, call)
  }
  const now = deps.clock.now()
  let result: { answer: IdempotentAnswer<200, BulkAssignProspectsResponse> }
  try {
    result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      // Created inside the callback: the store may run it again after a deadlock.
      const events: PendingEvent[] = []
      const answer = await idempotent(
        deps,
        scope,
        caller,
        { ...call, status: 200, response: bulkAssignProspectsResponseSchema },
        async () => {
          const access = await openOrganizationForWrite(scope, caller, 'prospect.assign')
          await requireAssignableOwner(scope, request.ownerMembershipId)
          const { found, changed } = await scope.reassignProspects(
            request.prospectIds,
            request.ownerMembershipId,
            now
          )
          for (const id of changed) {
            events.push(ownerChangedEvent(id))
          }
          if (changed.length > 0) {
            await Audit.recordIn(scope, caller.organizationId, {
              occurredAt: now,
              actor: { kind: 'member', membershipId: access.membershipId },
              action: 'prospects.assigned',
              subject: { type: 'membership', id: request.ownerMembershipId },
              metadata: { ownerMembershipId: request.ownerMembershipId, assigned: changed.length },
            })
          }
          return {
            state: 'applied' as const,
            requested: request.prospectIds.length,
            assigned: found,
            skipped: request.prospectIds.length - found,
          }
        }
      )
      if (!answer.replayed) {
        await enqueueEvents(scope, caller.organizationId, options.traceId, events)
      }
      return { answer }
    })
  } catch (error) {
    throw asOwnerError(error)
  }
  return result.answer
}

/** The queued path of {@link bulkAssign}: check, send the chunk jobs, then store the key's answer. */
async function queueAssign(
  deps: AssignDeps,
  caller: Caller,
  request: BulkAssignProspectsRequest,
  options: ProspectCallOptions,
  call: { key: string | undefined; route: string; request: unknown }
): Promise<IdempotentAnswer<202, BulkAssignProspectsResponse>> {
  const keyed = { ...call, status: 202 as const, response: bulkAssignProspectsResponseSchema }
  let earlier: IdempotentAnswer<202, BulkAssignProspectsResponse> | undefined
  try {
    earlier = await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const stored = await findAnswer(deps, scope, caller, keyed)
      if (stored) {
        return stored
      }
      await openOrganizationForWrite(scope, caller, 'prospect.assign')
      await requireAssignableOwner(scope, request.ownerMembershipId)
      return undefined
    })
  } catch (error) {
    throw asOwnerError(error)
  }
  if (earlier) {
    return earlier
  }
  await enqueueChunks(deps, caller, request, options.traceId)
  const body: BulkAssignProspectsResponse = {
    state: 'queued',
    requested: request.prospectIds.length,
    assigned: null,
    skipped: null,
  }
  await recordAnswer(deps, caller, keyed, body)
  return { status: 202, body, replayed: false }
}

/** What a chunk job carries. */
export type AssignChunk = {
  organizationId: Caller['organizationId']
  actorUserId: UserId
  ownerMembershipId: MembershipId
  prospectIds: readonly ProspectId[]
  traceId: string
}

/**
 * Applies one chunk of a queued bulk assignment. Everything is decided again on current data: the
 * Organization is locked first, the actor must still be an Owner or Admin of an Organization that
 * is neither suspended nor deleted, and the owner must still be a Rep or Manager. A chunk that
 * fails any of these is dropped (logged by ids and counts), because a retry could not succeed. The
 * write sets an end state, so a chunk delivered twice changes nothing the second time and
 * publishes `prospect.updated` only for the Prospects it changed.
 */
export async function applyAssignChunk(deps: AssignDeps, chunk: AssignChunk): Promise<void> {
  const now = deps.clock.now()
  try {
    await deps.store.withOrganization(chunk.organizationId, async (scope) => {
      const access = await openOrganizationForWrite(
        scope,
        { userId: chunk.actorUserId },
        'prospect.assign'
      )
      await requireAssignableOwner(scope, chunk.ownerMembershipId)
      const { changed } = await scope.reassignProspects(
        chunk.prospectIds,
        chunk.ownerMembershipId,
        now
      )
      if (changed.length > 0) {
        await Audit.recordIn(scope, chunk.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'prospects.assigned',
          subject: { type: 'membership', id: chunk.ownerMembershipId },
          metadata: { ownerMembershipId: chunk.ownerMembershipId, assigned: changed.length },
        })
      }
      await enqueueEvents(
        scope,
        chunk.organizationId,
        chunk.traceId,
        changed.map((id) => ownerChangedEvent(id))
      )
    })
  } catch (error) {
    const refusal = asOwnerError(error)
    if (refusal instanceof AppError && refusal.status < 500) {
      deps.logger.warn('a bulk assignment chunk was dropped', {
        organizationId: chunk.organizationId,
        actorUserId: chunk.actorUserId,
        prospects: chunk.prospectIds.length,
        reason: refusal.code,
      })
      return
    }
    throw error
  }
}

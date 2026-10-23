import {
  type AddSuppressionRequest,
  CONSENT_ERRORS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListSuppressionEntriesQuery,
  type lookupSuppressionRequestSchema,
  type RemoveSuppressionRequest,
  type SuppressionEntry,
  type SuppressionEntryId,
  type suppressionEntryPageSchema,
  suppressionEntrySchema,
} from 'tula-closeline-contract'
import { MAX_SUPPRESSION_SOURCE_REF_LENGTH } from 'tula-closeline-db/schema'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  enqueueEvents,
  type PendingEvent,
  suppressionAddedEvent,
  suppressionRemovedEvent,
} from '~/modules/prospect/events'
import type { SuppressionRecord } from '~/ports/core-store'
import { type AddressKind, hashAddress, maskAddress, normaliseAddress } from './address'
import { suppressionCursorSchema, toSuppressionResponse } from './schema'

/** The answer of the list and lookup routes. */
type SuppressionEntryPage = z.infer<typeof suppressionEntryPageSchema>

/** A lookup request: one address. */
type LookupSuppressionRequest = z.infer<typeof lookupSuppressionRequestSchema>

/** What the Suppression service needs from the container. */
export type SuppressionDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events' | 'env'>

/** What a call is given besides its request: the request id the events carry, and the validated `Idempotency-Key`, if sent. */
export type SuppressionCallOptions = { traceId: string; idempotencyKey?: string | undefined }

/** The one address a request names, as its kind and raw text. */
function addressOf(request: {
  email?: string | undefined
  phone?: string | undefined
  linkedinUrl?: string | undefined
}): { kind: AddressKind; value: string } {
  if (request.email !== undefined) {
    return { kind: 'email', value: request.email }
  }
  if (request.phone !== undefined) {
    return { kind: 'phone', value: request.phone }
  }
  if (request.linkedinUrl !== undefined) {
    return { kind: 'linkedin', value: request.linkedinUrl }
  }
  throw domainError(ERRORS['request.invalid'])
}

/** The normalised address a request names; one that cannot be normalised is `request.invalid`. */
function normalisedAddressOf(request: Parameters<typeof addressOf>[0]): {
  kind: AddressKind
  value: string
} {
  const { kind, value } = addressOf(request)
  const normalised = normaliseAddress(kind, value)
  if (normalised === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return { kind, value: normalised }
}

const notFound = () => domainError(CONSENT_ERRORS['consent.not_found'])

/**
 * Adds an address to the Organization's Suppression list with the reason `manual`. Owner and
 * Admin only. The address is normalised, hashed under the Organization and masked; only the hash
 * and the mask are stored. An address already suppressed answers its live entry (200) and writes
 * nothing; so does a repeat with the same `Idempotency-Key`. A new entry (201) publishes
 * `suppression.added` once, through the outbox. The note has no column of its own: its first 200
 * characters are kept as the entry's source reference.
 */
export async function add(
  deps: SuppressionDeps,
  caller: Caller,
  request: AddSuppressionRequest,
  options: SuppressionCallOptions
): Promise<IdempotentAnswer<200 | 201, SuppressionEntry>> {
  const now = deps.clock.now()
  const address = normalisedAddressOf(request)
  const note = request.note?.trim().slice(0, MAX_SUPPRESSION_SOURCE_REF_LENGTH) ?? ''
  const hash = hashAddress(
    deps.env.CONSENT_HASH_KEY,
    caller.organizationId,
    address.kind,
    address.value
  )
  const result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    const events: PendingEvent[] = []
    let existing = false
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'suppression.add',
        request: { body: request },
        status: 201,
        response: suppressionEntrySchema,
      },
      async () => {
        const { membershipId: actorId } = await openOrganizationForWrite(
          scope,
          caller,
          'suppression.add'
        )
        const { entry, created } = await scope.insertSuppressionEntry({
          id: formatId('sup', crypto.randomUUID()),
          addressKind: address.kind,
          addressHash: hash,
          maskedAddress: maskAddress(address.kind, address.value),
          reason: 'manual',
          channel: null,
          sourceRef: note === '' ? null : note,
          addedByUserId: caller.userId,
          now,
        })
        existing = !created
        if (created) {
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: actorId },
            action: 'suppression.added',
            subject: { type: 'suppression_entry', id: entry.id },
            metadata: { addressKind: entry.addressKind, reason: entry.reason },
          })
          const prospectId = await scope.findProspectByIdentity(address.kind, address.value)
          events.push(
            suppressionAddedEvent({
              suppressionEntryId: entry.id,
              addressKind: entry.addressKind,
              reason: entry.reason,
              prospectId,
            })
          )
        }
        return toSuppressionResponse(entry)
      }
    )
    if (!answer.replayed && !existing) {
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    }
    return { answer, existing }
  })
  const { answer } = result
  return {
    status: answer.replayed || result.existing ? 200 : 201,
    body: answer.body,
    replayed: answer.replayed,
  }
}

/** Reads one Suppression entry, live or removed; one that does not exist or is another Organization's is `consent.not_found`. Owner and Admin. */
export async function get(
  deps: Pick<SuppressionDeps, 'store'>,
  caller: Caller,
  entryId: SuppressionEntryId
): Promise<SuppressionEntry> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression.read')
    const record = await scope.getSuppressionEntry(entryId)
    if (!record) {
      throw notFound()
    }
    return toSuppressionResponse(record)
  })
}

/**
 * Lists the Suppression entries, newest first, one page at a time (at most 100): the live ones by
 * default, or the removed ones (newest removal first) with `state=removed`. Owner and Admin.
 */
export async function list(
  deps: Pick<SuppressionDeps, 'store'>,
  caller: Caller,
  query: ListSuppressionEntriesQuery
): Promise<SuppressionEntryPage> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, suppressionCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression.list')
    const rows = await scope.listSuppressionEntries({
      state: query.state ?? 'active',
      ...(query.reason === undefined ? {} : { reason: query.reason }),
      ...(query.addressKind === undefined ? {} : { addressKind: query.addressKind }),
      ...(after === undefined ? {} : { after: { at: new Date(after.at), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    const sortTime = (record: SuppressionRecord): Date =>
      query.state === 'removed' ? (record.removedAt ?? record.createdAt) : record.createdAt
    return {
      items: page.map(toSuppressionResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: sortTime(last).toISOString(), id: last.id })
          : null,
    }
  })
}

/**
 * Whether an address is on the list: answers the live entry for it, as a page of at most one
 * (`nextCursor` is always null). Owner and Admin. The address is normalised as on add.
 */
export async function lookup(
  deps: Pick<SuppressionDeps, 'store' | 'env'>,
  caller: Caller,
  request: LookupSuppressionRequest
): Promise<SuppressionEntryPage> {
  const address = normalisedAddressOf(request)
  const hash = hashAddress(
    deps.env.CONSENT_HASH_KEY,
    caller.organizationId,
    address.kind,
    address.value
  )
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression.lookup')
    const found = await scope.findLiveSuppression(address.kind, [hash])
    return { items: found.map(toSuppressionResponse), nextCursor: null }
  })
}

/**
 * Removes a `manual` entry so the address may be contacted again, with the reason given. Owner and
 * Admin. Only `manual` entries are removable (`consent.entry_not_removable`); a removed entry
 * answers as it is (200) and publishes nothing. Publishes `suppression.removed` once.
 */
export async function remove(
  deps: SuppressionDeps,
  caller: Caller,
  entryId: SuppressionEntryId,
  request: RemoveSuppressionRequest,
  options: SuppressionCallOptions
): Promise<SuppressionEntry> {
  const now = deps.clock.now()
  const result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const events: PendingEvent[] = []
    const { membershipId: actorId } = await openOrganizationForWrite(
      scope,
      caller,
      'suppression.remove'
    )
    const current = await scope.getSuppressionEntry(entryId)
    if (!current) {
      throw notFound()
    }
    if (!current.removable) {
      throw domainError(CONSENT_ERRORS['consent.entry_not_removable'])
    }
    if (current.removedAt !== null) {
      return { body: toSuppressionResponse(current) }
    }
    const removed = await scope.removeSuppressionEntry(entryId, {
      userId: caller.userId,
      reason: request.reason,
      now,
    })
    if (!removed) {
      throw notFound()
    }
    await Audit.recordIn(scope, caller.organizationId, {
      occurredAt: now,
      actor: { kind: 'member', membershipId: actorId },
      action: 'suppression.removed',
      subject: { type: 'suppression_entry', id: removed.id },
      metadata: { addressKind: removed.addressKind },
    })
    events.push(
      suppressionRemovedEvent({ suppressionEntryId: removed.id, addressKind: removed.addressKind })
    )
    await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    return { body: toSuppressionResponse(removed) }
  })
  return result.body
}

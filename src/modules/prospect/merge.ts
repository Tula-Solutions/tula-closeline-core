import {
  bookingIdSchema,
  conversationIdSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListProspectDuplicatesQuery,
  type ListProspectDuplicatesResponse,
  type MergeProspectsRequest,
  membershipIdSchema,
  PROSPECT_ERRORS,
  PROSPECT_MERGE_UNDO_DAYS,
  type ProspectId,
  type ProspectMerge,
  type ProspectMergeId,
  prospectCompanyIdSchema,
  prospectDuplicateCursorSchema,
  prospectIdSchema,
  prospectMergeSchema,
  prospectStatusSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import { MAX_MERGE_SNAPSHOT_BYTES } from 'tula-closeline-db/schema'
import { z } from 'zod'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  type OrganizationScope,
  type ProspectIdentityKind,
  ProspectIdentityTakenError,
  type ProspectRecord,
} from '~/ports/core-store'
import type { FieldHistoryRow, ProspectMergeRecord } from '~/ports/prospect-merge-store'
import { enqueueEvents, mergedEvent, mergeUndoneEvent, type PendingEvent } from './events'
import { mergeHistories } from './merge-fields'
import type { ProspectCallOptions, ProspectDeps } from './service'
import { prospectNotFound } from './service'

const ALL = { kind: 'all' } as const
const DAY_MS = 24 * 60 * 60 * 1000

/** The identity each identifying field holds (ADR 0011). */
const IDENTITY_FIELDS: ReadonlyArray<readonly [string, ProspectIdentityKind]> = [
  ['email', 'email'],
  ['phone', 'phone'],
  ['linkedinUrl', 'linkedin'],
]

const fieldRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  state: z.enum(['current', 'superseded', 'suggested']),
  source: z.string(),
  sourceRef: z.string().nullable(),
  setAt: z.coerce.date(),
  setByUserId: userIdSchema.nullable(),
})

/** A digest of a Prospect's field history, to tell whether anything was written to it since. */
function fieldsKey(rows: readonly FieldHistoryRow[]): string {
  const hash = new Bun.CryptoHasher('sha256')
  for (const r of rows) {
    hash.update(JSON.stringify([r.field, r.value, r.state, r.source, r.sourceRef, r.setAt]))
  }
  return hash.digest('hex')
}

const recordSchema = z.object({
  id: prospectIdSchema,
  companyId: prospectCompanyIdSchema.nullable(),
  ownerMembershipId: membershipIdSchema.nullable(),
  status: prospectStatusSchema,
  source: z.string(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

/** What undo needs, stored on the merge: both records as they were and the links that moved. */
const snapshotSchema = z.object({
  survivor: z.object({
    fields: z.array(fieldRowSchema),
    updatedAt: z.coerce.date(),
    mergedUpdatedAt: z.coerce.date(),
    mergedFieldsKey: z.string(),
  }),
  merged: z.array(
    z.object({
      record: recordSchema,
      fields: z.array(fieldRowSchema),
      links: z.object({
        bookingIds: z.array(bookingIdSchema),
        conversationIds: z.array(conversationIdSchema),
      }),
    })
  ),
})

type Snapshot = z.infer<typeof snapshotSchema>

/** The `prospect.merge_conflict` answer: the merge cannot be made or undone as things stand. */
function mergeConflict() {
  return domainError(PROSPECT_ERRORS['prospect.merge_conflict'])
}

/** The API shape of a merge, through the contract's schema; the snapshot is never part of it. */
function toMergeResponse(record: ProspectMergeRecord): ProspectMerge {
  return prospectMergeSchema.parse({
    id: record.id,
    survivorProspectId: record.survivorProspectId,
    mergedProspectIds: record.mergedProspectIds,
    fieldChoices: record.fieldChoices,
    state: record.state,
    mergedByUserId: record.mergedByUserId,
    createdAt: record.createdAt.toISOString(),
    undoableUntil: record.undoableUntil.toISOString(),
    undoneAt: record.undoneAt?.toISOString() ?? null,
  })
}

/** The current value of each identifying field in `rows`, as the identity of its kind. */
function identitiesOf(rows: readonly FieldHistoryRow[]): Map<ProspectIdentityKind, string> {
  const held = new Map<ProspectIdentityKind, string>()
  for (const [field, kind] of IDENTITY_FIELDS) {
    const current = rows.find((row) => row.field === field && row.state === 'current')
    if (current) {
      held.set(kind, current.value)
    }
  }
  return held
}

/** Makes a Prospect hold exactly these identities, clearing the kinds it has none of. */
async function applyIdentities(
  scope: OrganizationScope,
  prospectId: ProspectId,
  rows: readonly FieldHistoryRow[],
  now: Date
): Promise<void> {
  const held = identitiesOf(rows)
  for (const [, kind] of IDENTITY_FIELDS) {
    await scope.setProspectIdentity(prospectId, kind, held.get(kind) ?? null, now)
  }
}

/**
 * Lists suspected duplicates: pairs where one Prospect holds as its current email, phone or
 * LinkedIn address a value the other once had. Owner and Admin. Matching reads the indexed
 * identities and the field history, never the whole table; a page is at most 100 pairs, with a
 * cursor. With `prospectId`, only pairs that include it.
 */
export async function listDuplicates(
  deps: Pick<ProspectDeps, 'store'>,
  caller: Caller,
  query: ListProspectDuplicatesQuery
): Promise<ListProspectDuplicatesResponse> {
  const after =
    query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor, prospectDuplicateCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect.merge')
    if (query.prospectId !== undefined && !(await scope.getProspect(query.prospectId, ALL))) {
      throw prospectNotFound()
    }
    const rows = await scope.listProspectDuplicates({
      ...(query.prospectId === undefined ? {} : { prospectId: query.prospectId }),
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((pair) => ({
        prospectIds: [pair.first, pair.second] as [ProspectId, ProspectId],
        matchedOn: pair.matchedOn,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ first: last.first, second: last.second })
          : null,
    }
  })
}

/** Reads one merge; a merge that does not exist, or is in another Organization, is `prospect.not_found`. */
export async function getMerge(
  deps: Pick<ProspectDeps, 'store'>,
  caller: Caller,
  mergeId: ProspectMergeId
): Promise<ProspectMerge> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect.merge')
    const record = await scope.getProspectMerge(mergeId)
    if (!record) {
      throw prospectNotFound()
    }
    return toMergeResponse(record)
  })
}

/**
 * Merges Prospects into the survivor (ADR 0020), Owner and Admin. Each field keeps the value of
 * the Prospect named in `fieldChoices`, else the manual one, else the newer one; every other value
 * stays as history with its own Source. Bookings and Conversations move to the survivor, the merged
 * records are removed and a snapshot is kept for {@link undo} for 30 days. It is
 * `prospect.merge_conflict` when a merged Prospect is already merged, has a consent event (the
 * ledger is append-only and stays with its Prospect), a choice cannot be honoured, or the snapshot
 * is too large. Idempotent by `Idempotency-Key`. Publishes `prospect.merged` once.
 */
export async function merge(
  deps: ProspectDeps,
  caller: Caller,
  survivorId: ProspectId,
  request: MergeProspectsRequest,
  options: ProspectCallOptions
): Promise<IdempotentAnswer<200 | 201, ProspectMerge>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    const events: PendingEvent[] = []
    const result = await idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'prospects.merge',
        request: { body: request, params: { prospectId: survivorId } },
        status: 201,
        response: prospectMergeSchema,
      },
      async () => {
        await openOrganizationForWrite(scope, caller, 'prospect.merge')
        const ids = [survivorId, ...request.mergedProspectIds]
        if (request.mergedProspectIds.includes(survivorId)) {
          throw mergeConflict()
        }
        if (await scope.findActiveMerge(ids)) {
          throw mergeConflict()
        }
        const records = new Map<ProspectId, ProspectRecord>()
        for (const id of ids) {
          const locked = await scope.lockProspect(id, ALL)
          if (!locked) {
            throw prospectNotFound()
          }
          records.set(id, locked)
        }
        for (const id of request.mergedProspectIds) {
          if ((await scope.latestConsentEvents(id)).length > 0) {
            throw mergeConflict()
          }
        }
        const histories = new Map<ProspectId, FieldHistoryRow[]>()
        for (const id of ids) {
          histories.set(id, await scope.listProspectFieldHistory(id))
        }
        const merged = mergeHistories({
          survivorId,
          histories,
          choices: request.fieldChoices as Partial<Record<string, ProspectId>>,
        })
        if (!merged.ok) {
          throw mergeConflict()
        }
        const survivor = records.get(survivorId) as ProspectRecord
        const mergedSnapshots: Snapshot['merged'] = []
        for (const id of request.mergedProspectIds) {
          mergedSnapshots.push({
            record: records.get(id) as ProspectRecord,
            fields: histories.get(id) ?? [],
            links: { bookingIds: [], conversationIds: [] },
          })
        }
        // Links are read by moving them, so the snapshot is built after the move.
        for (const entry of mergedSnapshots) {
          entry.links = await scope.moveProspectLinks(entry.record.id, survivorId)
        }
        for (const entry of mergedSnapshots) {
          await scope.eraseProspectRow(entry.record.id)
        }
        await scope.replaceProspectFields(survivorId, merged.rows)
        await applyIdentities(scope, survivorId, merged.rows, now)
        const touched = (await scope.updateProspect(survivorId, {}, now)) ?? survivor
        const snapshot: Snapshot = {
          survivor: {
            fields: histories.get(survivorId) ?? [],
            updatedAt: survivor.updatedAt,
            mergedUpdatedAt: touched.updatedAt,
            mergedFieldsKey: fieldsKey(await scope.listProspectFieldHistory(survivorId)),
          },
          merged: mergedSnapshots,
        }
        const stored = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>
        if (JSON.stringify(stored).length > MAX_MERGE_SNAPSHOT_BYTES) {
          throw mergeConflict()
        }
        const id = formatId('pmrg', crypto.randomUUID())
        const record: ProspectMergeRecord = {
          id,
          survivorProspectId: survivorId,
          mergedProspectIds: request.mergedProspectIds,
          fieldChoices: request.fieldChoices as Record<string, string>,
          state: 'merged',
          mergedByUserId: caller.userId,
          snapshot: stored,
          createdAt: now,
          undoableUntil: new Date(now.getTime() + PROSPECT_MERGE_UNDO_DAYS * DAY_MS),
          undoneAt: null,
        }
        await scope.insertProspectMerge(record)
        events.push(
          mergedEvent({
            mergeId: id,
            survivorProspectId: survivorId,
            mergedProspectIds: request.mergedProspectIds,
          })
        )
        return toMergeResponse(record)
      }
    )
    if (!result.replayed) {
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    }
    return result
  })
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/**
 * Undoes a merge, Owner and Admin: both records come back exactly as they were, with their field
 * history, identities, times and the Bookings and Conversations that moved. Undone already answers
 * as it is. After 30 days, when the survivor was edited or merged again since, or when an address
 * of a merged Prospect now belongs to another, it is `prospect.merge_conflict`. Publishes
 * `prospect.merge_undone` once.
 */
export async function undo(
  deps: ProspectDeps,
  caller: Caller,
  mergeId: ProspectMergeId,
  options: ProspectCallOptions
): Promise<ProspectMerge> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const events: PendingEvent[] = []
    await openOrganizationForWrite(scope, caller, 'prospect.merge')
    const record = await scope.lockProspectMerge(mergeId)
    if (!record) {
      throw prospectNotFound()
    }
    if (record.state === 'undone') {
      return toMergeResponse(record)
    }
    if (now.getTime() > record.undoableUntil.getTime()) {
      throw mergeConflict()
    }
    const parsed = snapshotSchema.safeParse(record.snapshot)
    if (!parsed.success) {
      throw mergeConflict()
    }
    const snapshot = parsed.data
    const survivor = await scope.lockProspect(record.survivorProspectId, ALL)
    // Enrichment and imports can add history without touching `updatedAt`, so the rows count too.
    if (
      !survivor ||
      survivor.updatedAt.getTime() !== snapshot.survivor.mergedUpdatedAt.getTime() ||
      fieldsKey(await scope.listProspectFieldHistory(survivor.id)) !==
        snapshot.survivor.mergedFieldsKey
    ) {
      throw mergeConflict()
    }
    try {
      await scope.replaceProspectFields(survivor.id, snapshot.survivor.fields)
      await applyIdentities(scope, survivor.id, snapshot.survivor.fields, now)
      for (const entry of snapshot.merged) {
        await scope.restoreProspect(entry.record)
        await scope.replaceProspectFields(entry.record.id, entry.fields)
        await applyIdentities(scope, entry.record.id, entry.fields, now)
        await scope.restoreProspectLinks(entry.record.id, entry.links)
      }
    } catch (error) {
      if (error instanceof ProspectIdentityTakenError) {
        throw mergeConflict()
      }
      throw error
    }
    await scope.updateProspect(survivor.id, {}, snapshot.survivor.updatedAt)
    const undone = await scope.updateProspectMerge(mergeId, {
      state: 'undone',
      snapshot: {},
      undoneAt: now,
    })
    if (!undone) {
      throw prospectNotFound()
    }
    events.push(
      mergeUndoneEvent({
        mergeId,
        survivorProspectId: record.survivorProspectId,
        restoredProspectIds: record.mergedProspectIds,
      })
    )
    await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    return toMergeResponse(undone)
  })
}

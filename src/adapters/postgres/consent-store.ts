import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm'
import type { ConsentChannel, ConsentEvent, OrganizationId } from 'tula-closeline-contract'
import {
  CONSENT_CHANNELS,
  callIdSchema,
  consentChannelSchema,
  consentEventIdSchema,
  consentFormIdSchema,
  consentSourceSchema,
  consentWordingIdSchema,
  contactCheckIdSchema,
  prospectIdSchema,
  suppressionEntryIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  consentWordings,
  contactCheckLog,
  contactConsentEvents,
  suppressionEntries,
} from 'tula-closeline-db/schema'
import type {
  ContactCheckPageRequest,
  ContactCheckRecord,
  OrganizationScope,
  SuppressionPageRequest,
  SuppressionRecord,
} from '~/ports/core-store'

/** The Suppression, consent-read and Contact Check methods of the Postgres scope. */
export type ConsentStoreMethods = Pick<
  OrganizationScope,
  | 'findLiveSuppression'
  | 'getSuppressionEntry'
  | 'insertSuppressionEntry'
  | 'removeSuppressionEntry'
  | 'listSuppressionEntries'
  | 'latestConsentKind'
  | 'getConsentWording'
  | 'appendConsentEvents'
  | 'latestConsentEvents'
  | 'insertContactCheck'
  | 'listContactChecks'
  | 'purgeContactChecks'
>

type SuppressionRow = typeof suppressionEntries.$inferSelect
type ConsentRow = typeof contactConsentEvents.$inferSelect
type CheckRow = typeof contactCheckLog.$inferSelect

const toSuppression = (row: SuppressionRow): SuppressionRecord => ({
  id: suppressionEntryIdSchema.parse(row.id),
  addressKind: row.addressKind,
  maskedAddress: row.maskedAddress,
  reason: row.reason,
  channel: row.channel === null ? null : consentChannelSchema.parse(row.channel),
  sourceRef: row.sourceRef,
  addedByUserId: row.addedByUserId === null ? null : userIdSchema.parse(row.addedByUserId),
  removable: row.removable,
  createdAt: row.createdAt,
  removedAt: row.removedAt,
  removedByUserId: row.removedByUserId === null ? null : userIdSchema.parse(row.removedByUserId),
  removalReason: row.removalReason,
})

const toConsentEvent = (row: ConsentRow): ConsentEvent => ({
  id: consentEventIdSchema.parse(row.id),
  prospectId: prospectIdSchema.parse(row.prospectId),
  channel: row.channel,
  kind: row.kind,
  source: consentSourceSchema.parse(row.source),
  wordingId: row.wordingId === null ? null : consentWordingIdSchema.parse(row.wordingId),
  evidenceRef: row.evidenceRef,
  callId: row.callId === null ? null : callIdSchema.parse(row.callId),
  formId: row.formId === null ? null : consentFormIdSchema.parse(row.formId),
  stopAll: row.stopAll,
  recordedByUserId: row.recordedByUserId === null ? null : userIdSchema.parse(row.recordedByUserId),
  occurredAt: row.occurredAt.toISOString(),
  recordedAt: row.recordedAt.toISOString(),
})

const toCheck = (row: CheckRow): ContactCheckRecord => ({
  id: contactCheckIdSchema.parse(row.id),
  prospectId: row.prospectId === null ? null : prospectIdSchema.parse(row.prospectId),
  channel: row.channel,
  purpose: row.purpose,
  caller: row.caller,
  allowed: row.allowed,
  code: row.code,
  basis: row.basis,
  checkedAt: row.checkedAt,
})

/**
 * The statement behind `findLiveSuppression` for one hash: one read of `suppression_entry_live_key`.
 * Exported for plan tests.
 */
export function liveSuppressionQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  kind: SuppressionRecord['addressKind'],
  hash: Uint8Array
) {
  return tx
    .select()
    .from(suppressionEntries)
    .where(
      and(
        eq(suppressionEntries.organizationId, organizationId),
        eq(suppressionEntries.addressKind, kind),
        eq(suppressionEntries.addressHash, hash),
        isNull(suppressionEntries.removedAt)
      )
    )
    .limit(1)
}

/**
 * The statement behind `listSuppressionEntries`: live entries read in `created_at` order, removed
 * ones in `removed_at` order, each with the keyset. Exported for plan tests.
 */
export function suppressionPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  request: SuppressionPageRequest
) {
  const active = request.state === 'active'
  const sortColumn = active ? suppressionEntries.createdAt : suppressionEntries.removedAt
  return tx
    .select()
    .from(suppressionEntries)
    .where(
      and(
        eq(suppressionEntries.organizationId, organizationId),
        active ? isNull(suppressionEntries.removedAt) : isNotNull(suppressionEntries.removedAt),
        request.reason === undefined ? undefined : eq(suppressionEntries.reason, request.reason),
        request.addressKind === undefined
          ? undefined
          : eq(suppressionEntries.addressKind, request.addressKind),
        request.after === undefined
          ? undefined
          : sql`(${sortColumn}, ${suppressionEntries.id}) < (${request.after.at.toISOString()}::timestamptz, ${request.after.id})`
      )
    )
    .orderBy(sql`${sortColumn} desc nulls last`, sql`${suppressionEntries.id} desc nulls last`)
    .limit(request.limit)
}

/** The statement behind `latestConsentKind`: the newest event by sequence, from `contact_consent_events_channel_idx`. Exported for plan tests. */
export function latestConsentQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  prospectId: string,
  channel: ConsentChannel
) {
  return tx
    .select({ kind: contactConsentEvents.kind })
    .from(contactConsentEvents)
    .where(
      and(
        eq(contactConsentEvents.organizationId, organizationId),
        eq(contactConsentEvents.prospectId, prospectId),
        eq(contactConsentEvents.channel, channel)
      )
    )
    .orderBy(sql`${contactConsentEvents.seq} desc nulls last`)
    .limit(1)
}

/**
 * The statement behind `latestConsentEvents` for one channel: the newest event by sequence, from
 * `contact_consent_events_channel_idx`. Exported for plan tests.
 */
export function latestConsentEventQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  prospectId: string,
  channel: ConsentChannel
) {
  return tx
    .select()
    .from(contactConsentEvents)
    .where(
      and(
        eq(contactConsentEvents.organizationId, organizationId),
        eq(contactConsentEvents.prospectId, prospectId),
        eq(contactConsentEvents.channel, channel)
      )
    )
    .orderBy(sql`${contactConsentEvents.seq} desc nulls last`)
    .limit(1)
}

/** The statement behind `listContactChecks`, on `contact_check_log_list_idx` or `contact_check_log_prospect_idx`. Exported for plan tests. */
export function contactCheckPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  request: ContactCheckPageRequest
) {
  return tx
    .select()
    .from(contactCheckLog)
    .where(
      and(
        eq(contactCheckLog.organizationId, organizationId),
        request.channel === undefined ? undefined : eq(contactCheckLog.channel, request.channel),
        request.purpose === undefined ? undefined : eq(contactCheckLog.purpose, request.purpose),
        request.allowed === undefined ? undefined : eq(contactCheckLog.allowed, request.allowed),
        request.prospectId === undefined
          ? undefined
          : eq(contactCheckLog.prospectId, request.prospectId),
        request.code === undefined ? undefined : eq(contactCheckLog.code, request.code),
        request.after === undefined
          ? undefined
          : sql`(${contactCheckLog.checkedAt}, ${contactCheckLog.id}) < (${request.after.at.toISOString()}::timestamptz, ${request.after.id})`
      )
    )
    .orderBy(
      sql`${contactCheckLog.checkedAt} desc nulls last`,
      sql`${contactCheckLog.id} desc nulls last`
    )
    .limit(request.limit)
}

/**
 * The statement behind `purgeContactChecks`: one batch of an Organization's log rows older than
 * `before`, oldest first, skipping rows another transaction holds. Exported for plan tests.
 */
export function purgeContactChecksQuery(
  organizationId: OrganizationId,
  before: Date,
  limit: number
): SQL {
  return sql`
    delete from core.contact_check_log
    where ctid = any (array(
      select ctid from core.contact_check_log
      where organization_id = ${organizationId} and checked_at < ${before.toISOString()}::timestamptz
      order by checked_at nulls first
      limit ${limit}
      for update skip locked
    ))
    returning 1 as removed
  `
}

/** Builds the Suppression and Contact Check methods over one transaction of `organizationId`. */
export function createConsentStore(
  tx: Transaction,
  organizationId: OrganizationId
): ConsentStoreMethods {
  const entryIn = (id: string): SQL | undefined =>
    and(eq(suppressionEntries.organizationId, organizationId), eq(suppressionEntries.id, id))

  return {
    findLiveSuppression: async (kind, hashes) => {
      const found: SuppressionRecord[] = []
      for (const hash of hashes) {
        const row = (await liveSuppressionQuery(tx, organizationId, kind, hash))[0]
        if (row) {
          found.push(toSuppression(row))
        }
      }
      return found
    },

    getSuppressionEntry: async (id) => {
      const row = (await tx.select().from(suppressionEntries).where(entryIn(id)))[0]
      return row ? toSuppression(row) : null
    },

    insertSuppressionEntry: async (input) => {
      const inserted = await tx
        .insert(suppressionEntries)
        .values({
          id: input.id,
          organizationId,
          addressKind: input.addressKind,
          addressHash: input.addressHash,
          maskedAddress: input.maskedAddress,
          reason: input.reason,
          channel: input.channel,
          sourceRef: input.sourceRef,
          addedByUserId: input.addedByUserId,
          createdAt: input.now,
        })
        .onConflictDoNothing({
          target: [
            suppressionEntries.organizationId,
            suppressionEntries.addressKind,
            suppressionEntries.addressHash,
          ],
          where: isNull(suppressionEntries.removedAt),
        })
        .returning()
      const created = inserted[0]
      if (created) {
        return { entry: toSuppression(created), created: true }
      }
      const live = (
        await liveSuppressionQuery(tx, organizationId, input.addressKind, input.addressHash)
      )[0]
      if (!live) {
        throw new Error('core.suppression_entry_live_key: the live entry vanished mid-transaction')
      }
      return { entry: toSuppression(live), created: false }
    },

    removeSuppressionEntry: async (id, input) => {
      const rows = await tx
        .update(suppressionEntries)
        .set({
          removedAt: input.now,
          removedByUserId: input.userId,
          removalReason: input.reason,
        })
        .where(
          and(
            entryIn(id),
            isNull(suppressionEntries.removedAt),
            eq(suppressionEntries.removable, true)
          )
        )
        .returning()
      return rows[0] ? toSuppression(rows[0]) : null
    },

    listSuppressionEntries: async (request) =>
      (await suppressionPageQuery(tx, organizationId, request)).map(toSuppression),

    latestConsentKind: async (prospectId, channel) => {
      const row = (await latestConsentQuery(tx, organizationId, prospectId, channel))[0]
      return row ? row.kind : null
    },

    getConsentWording: async (id) => {
      const row = (
        await tx
          .select()
          .from(consentWordings)
          .where(
            and(eq(consentWordings.organizationId, organizationId), eq(consentWordings.id, id))
          )
      )[0]
      return row
        ? {
            id: consentWordingIdSchema.parse(row.id),
            version: row.version,
            channels: row.channels.map((channel) => consentChannelSchema.parse(channel)),
          }
        : null
    },

    appendConsentEvents: async (events) => {
      if (events.length === 0) {
        return []
      }
      const rows = await tx
        .insert(contactConsentEvents)
        .values(
          events.map((event) => ({
            id: event.id,
            organizationId,
            prospectId: event.prospectId,
            channel: event.channel,
            kind: event.kind,
            source: event.source,
            wordingId: event.wordingId,
            evidenceRef: event.evidenceRef,
            callId: event.callId,
            formId: event.formId,
            ipAddress: event.ipAddress,
            userAgent: event.userAgent,
            stopAll: event.stopAll,
            recordedByUserId: event.recordedByUserId,
            occurredAt: event.occurredAt,
          }))
        )
        .returning()
      const byId = new Map(rows.map((row) => [row.id, row]))
      return events.map((event) => toConsentEvent(byId.get(event.id) as ConsentRow))
    },

    latestConsentEvents: async (prospectId) => {
      const found: ConsentEvent[] = []
      for (const channel of CONSENT_CHANNELS) {
        const row = (await latestConsentEventQuery(tx, organizationId, prospectId, channel))[0]
        if (row) {
          found.push(toConsentEvent(row))
        }
      }
      return found
    },

    insertContactCheck: async (input) => {
      await tx.insert(contactCheckLog).values({
        id: input.id,
        organizationId,
        prospectId: input.prospectId,
        channel: input.channel,
        purpose: input.purpose,
        caller: input.caller,
        allowed: input.allowed,
        code: input.code,
        basis: input.basis,
        checkedAt: input.checkedAt,
      })
    },

    listContactChecks: async (request) =>
      (await contactCheckPageQuery(tx, organizationId, request)).map(toCheck),

    purgeContactChecks: async (before, limit) => {
      // In a savepoint: a statement that fails must not abort the write it follows.
      const gone = await tx.transaction((savepoint) =>
        savepoint.execute(purgeContactChecksQuery(organizationId, before, limit))
      )
      return gone.rows.length
    },
  }
}

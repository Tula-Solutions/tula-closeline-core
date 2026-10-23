import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  ConsentChannel,
  ConsentEvent,
  ConsentFormId,
  ConsentWordingId,
  OrganizationId,
} from 'tula-closeline-contract'
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
  consentForms,
  consentWordings,
  contactCheckLog,
  contactConsentEvents,
  suppressionEntries,
} from 'tula-closeline-db/schema'
import {
  type ConsentEventPageRequest,
  type ConsentEvidenceRow,
  type ConsentFormRecord,
  type ConsentWordingDetail,
  ConsentWordingLockedError,
  type ContactCheckPageRequest,
  type ContactCheckRecord,
  type OrganizationScope,
  type SuppressionPageRequest,
  type SuppressionRecord,
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
  | 'findConsentWording'
  | 'insertConsentWording'
  | 'updateConsentWording'
  | 'listConsentWordings'
  | 'findConsentForm'
  | 'insertConsentForm'
  | 'listConsentForms'
  | 'publishConsentForm'
  | 'closeConsentForm'
  | 'appendConsentEvents'
  | 'latestConsentEvents'
  | 'listConsentEvents'
  | 'listConsentEvidence'
  | 'insertContactCheck'
  | 'listContactChecks'
  | 'purgeContactChecks'
>

type WordingRow = typeof consentWordings.$inferSelect
type FormRow = typeof consentForms.$inferSelect

const toForm = (row: FormRow): ConsentFormRecord => ({
  id: consentFormIdSchema.parse(row.id),
  wordingId: consentWordingIdSchema.parse(row.wordingId),
  name: row.name,
  channels: row.channels.map((channel) => consentChannelSchema.parse(channel)),
  state: row.state,
  token: row.token,
  createdAt: row.createdAt,
  createdByUserId: userIdSchema.parse(row.createdByUserId),
  publishedAt: row.publishedAt,
  closedAt: row.closedAt,
})

/**
 * Wording rows with their lock and succession flags, from three reads over the page's ids (a page
 * is at most one page size, so this is bounded). A wording is locked once a ledger event cites it
 * or a published or closed form uses it, the rule of the `consent_wording_locked` trigger.
 */
async function wordingDetails(
  tx: Transaction,
  organizationId: OrganizationId,
  rows: WordingRow[]
): Promise<ConsentWordingDetail[]> {
  if (rows.length === 0) {
    return []
  }
  const ids = rows.map((row) => row.id)
  const cited = await tx
    .selectDistinct({ id: contactConsentEvents.wordingId })
    .from(contactConsentEvents)
    .where(
      and(
        eq(contactConsentEvents.organizationId, organizationId),
        inArray(contactConsentEvents.wordingId, ids)
      )
    )
  const used = await tx
    .selectDistinct({ id: consentForms.wordingId })
    .from(consentForms)
    .where(
      and(
        eq(consentForms.organizationId, organizationId),
        inArray(consentForms.wordingId, ids),
        ne(consentForms.state, 'draft')
      )
    )
  const successors = await tx
    .select({ id: consentWordings.supersedesId })
    .from(consentWordings)
    .where(
      and(
        eq(consentWordings.organizationId, organizationId),
        inArray(consentWordings.supersedesId, ids)
      )
    )
  const locked = new Set([...cited, ...used].map((row) => row.id))
  const superseded = new Set(successors.map((row) => row.id))
  return rows.map((row) => ({
    id: consentWordingIdSchema.parse(row.id),
    version: row.version,
    text: row.text,
    channels: row.channels.map((channel) => consentChannelSchema.parse(channel)),
    locked: locked.has(row.id),
    supersedesId: row.supersedesId === null ? null : consentWordingIdSchema.parse(row.supersedesId),
    superseded: superseded.has(row.id),
    createdAt: row.createdAt,
    createdByUserId: userIdSchema.parse(row.createdByUserId),
  }))
}

/** Rows strictly after a `(createdAt, id)` position in a newest-first list. */
const afterPosition = (
  createdAt: AnyPgColumn,
  idColumn: AnyPgColumn,
  after: { at: Date; id: string } | undefined
): SQL | undefined =>
  after
    ? or(lt(createdAt, after.at), and(eq(createdAt, after.at), lt(idColumn, after.id)))
    : undefined

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

/**
 * The statement behind `listConsentEvents` and `listConsentEvidence`: a Prospect's events, newest
 * sequence first, from `contact_consent_events_prospect_idx` (or `_channel_idx` with a channel),
 * with no sort. Exported for plan tests.
 */
export function consentEventPageQuery(
  tx: Transaction,
  organizationId: OrganizationId,
  request: ConsentEventPageRequest
) {
  return tx
    .select()
    .from(contactConsentEvents)
    .where(
      and(
        eq(contactConsentEvents.organizationId, organizationId),
        eq(contactConsentEvents.prospectId, request.prospectId),
        request.channel === undefined
          ? undefined
          : eq(contactConsentEvents.channel, request.channel),
        request.after === undefined ? undefined : lt(contactConsentEvents.seq, request.after.seq)
      )
    )
    .orderBy(sql`${contactConsentEvents.seq} desc nulls last`)
    .limit(request.limit)
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

    findConsentWording: async (id: ConsentWordingId) => {
      const rows = await tx
        .select()
        .from(consentWordings)
        .where(and(eq(consentWordings.organizationId, organizationId), eq(consentWordings.id, id)))
      return (await wordingDetails(tx, organizationId, rows))[0] ?? null
    },

    insertConsentWording: async (input) => {
      const rows = await tx
        .insert(consentWordings)
        .values({
          id: input.id,
          organizationId,
          version: input.version,
          text: input.text,
          channels: input.channels,
          supersedesId: input.supersedesId,
          createdAt: input.now,
          createdByUserId: input.createdByUserId,
        })
        .returning()
      return (await wordingDetails(tx, organizationId, rows))[0] as ConsentWordingDetail
    },

    updateConsentWording: async (id, patch) => {
      const existing = (
        await tx
          .select()
          .from(consentWordings)
          .where(
            and(eq(consentWordings.organizationId, organizationId), eq(consentWordings.id, id))
          )
      )[0]
      if (!existing) {
        return null
      }
      const current = (await wordingDetails(tx, organizationId, [existing]))[0]
      if (current?.locked) {
        throw new ConsentWordingLockedError()
      }
      const rows = await tx
        .update(consentWordings)
        .set({
          ...(patch.text === undefined ? {} : { text: patch.text }),
          ...(patch.channels === undefined ? {} : { channels: patch.channels }),
        })
        .where(and(eq(consentWordings.organizationId, organizationId), eq(consentWordings.id, id)))
        .returning()
      return (await wordingDetails(tx, organizationId, rows))[0] ?? null
    },

    listConsentWordings: async (request) => {
      const rows = await tx
        .select()
        .from(consentWordings)
        .where(
          and(
            eq(consentWordings.organizationId, organizationId),
            afterPosition(consentWordings.createdAt, consentWordings.id, request.after)
          )
        )
        .orderBy(desc(consentWordings.createdAt), desc(consentWordings.id))
        .limit(request.limit)
      return wordingDetails(tx, organizationId, rows)
    },

    findConsentForm: async (id: ConsentFormId) => {
      const row = (
        await tx
          .select()
          .from(consentForms)
          .where(and(eq(consentForms.organizationId, organizationId), eq(consentForms.id, id)))
      )[0]
      return row ? toForm(row) : null
    },

    insertConsentForm: async (input) => {
      const rows = await tx
        .insert(consentForms)
        .values({
          id: input.id,
          organizationId,
          wordingId: input.wordingId,
          name: input.name,
          channels: input.channels,
          state: 'draft',
          createdAt: input.now,
          createdByUserId: input.createdByUserId,
        })
        .returning()
      return toForm(rows[0] as FormRow)
    },

    listConsentForms: async (request) => {
      const rows = await tx
        .select()
        .from(consentForms)
        .where(
          and(
            eq(consentForms.organizationId, organizationId),
            request.state === undefined ? undefined : eq(consentForms.state, request.state),
            afterPosition(consentForms.createdAt, consentForms.id, request.after)
          )
        )
        .orderBy(desc(consentForms.createdAt), desc(consentForms.id))
        .limit(request.limit)
      return rows.map(toForm)
    },

    publishConsentForm: async (id, input) => {
      const rows = await tx
        .update(consentForms)
        .set({ state: 'published', token: input.token, publishedAt: input.now })
        .where(
          and(
            eq(consentForms.organizationId, organizationId),
            eq(consentForms.id, id),
            eq(consentForms.state, 'draft')
          )
        )
        .returning()
      return rows[0] ? toForm(rows[0]) : null
    },

    closeConsentForm: async (id, now) => {
      const rows = await tx
        .update(consentForms)
        .set({ state: 'closed', closedAt: now })
        .where(
          and(
            eq(consentForms.organizationId, organizationId),
            eq(consentForms.id, id),
            eq(consentForms.state, 'published')
          )
        )
        .returning()
      return rows[0] ? toForm(rows[0]) : null
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

    listConsentEvents: async (request) =>
      (await consentEventPageQuery(tx, organizationId, request)).map((row) => ({
        seq: row.seq,
        event: toConsentEvent(row),
      })),

    listConsentEvidence: async (request) => {
      const rows = await consentEventPageQuery(tx, organizationId, request)
      const wordingIds = [...new Set(rows.flatMap((row) => (row.wordingId ? [row.wordingId] : [])))]
      const wordings =
        wordingIds.length === 0
          ? []
          : await tx
              .select({
                id: consentWordings.id,
                version: consentWordings.version,
                text: consentWordings.text,
              })
              .from(consentWordings)
              .where(
                and(
                  eq(consentWordings.organizationId, organizationId),
                  inArray(consentWordings.id, wordingIds)
                )
              )
      const byId = new Map(wordings.map((wording) => [wording.id, wording]))
      return rows.map((row): ConsentEvidenceRow => {
        const wording = row.wordingId ? byId.get(row.wordingId) : undefined
        return {
          seq: row.seq,
          event: toConsentEvent(row),
          wording: wording
            ? {
                id: consentWordingIdSchema.parse(wording.id),
                version: wording.version,
                text: wording.text,
              }
            : null,
          submission:
            row.ipAddress !== null && row.userAgent !== null
              ? { ipAddress: row.ipAddress, userAgent: row.userAgent }
              : null,
        }
      })
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

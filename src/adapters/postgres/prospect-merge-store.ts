import { and, asc, eq, sql } from 'drizzle-orm'
import {
  bookingIdSchema,
  conversationIdSchema,
  type OrganizationId,
  type ProspectId,
  prospectIdSchema,
  prospectMergeIdSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  memberships,
  prospectCompanies,
  prospectFields,
  prospectMerges,
  prospects,
} from 'tula-closeline-db/schema'
import type { ProspectIdentityKind } from '~/ports/core-store'
import type {
  DuplicatePair,
  FieldHistoryRow,
  ProspectLinks,
  ProspectMergeRecord,
  ProspectMergeScope,
} from '~/ports/prospect-merge-store'

/** The Prospect field names of the port, and the snake_case the columns use. */
const COLUMN_OF: Readonly<Record<string, string>> = {
  firstName: 'first_name',
  lastName: 'last_name',
  jobTitle: 'job_title',
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin_url',
}
const FIELD_OF = Object.fromEntries(
  Object.entries(COLUMN_OF).map(([name, column]) => [column, name])
)

type MergeRow = typeof prospectMerges.$inferSelect

function toMerge(row: MergeRow): ProspectMergeRecord {
  return {
    id: prospectMergeIdSchema.parse(row.id),
    survivorProspectId: prospectIdSchema.parse(row.survivorProspectId),
    mergedProspectIds: row.mergedProspectIds.map((id) => prospectIdSchema.parse(id)),
    fieldChoices: row.fieldChoices as Record<string, string>,
    state: row.state,
    mergedByUserId: userIdSchema.parse(row.mergedByUserId),
    snapshot: row.snapshot as Record<string, unknown>,
    createdAt: row.createdAt,
    undoableUntil: row.undoableUntil,
    undoneAt: row.undoneAt,
  }
}

/** The merge, duplicate and undo methods of a scope over one transaction of `organizationId`. */
/** A `text[]` value built element by element, since a bound JS array expands to a row. */
function textArray(ids: readonly string[]) {
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`
}

export function createProspectMergeStore(
  tx: Transaction,
  organizationId: OrganizationId
): ProspectMergeScope {
  const mergeIn = (id: string) =>
    and(eq(prospectMerges.organizationId, organizationId), eq(prospectMerges.id, id))

  const readMerge = async (id: string, lock: boolean) => {
    const query = tx.select().from(prospectMerges).where(mergeIn(id))
    const row = (await (lock ? query.for('update') : query))[0]
    return row ? toMerge(row) : null
  }

  return {
    // shortcut: cost follows the non-current field rows of the Organization, not its Prospects, and
    // the index on (field_name, value) for them is a db follow-up; upgrade to a materialised pair table if history grows.
    listProspectDuplicates: async ({ prospectId, after, limit }) => {
      const only = prospectId
        ? sql`and (f.prospect_id = ${prospectId} or i.prospect_id = ${prospectId})`
        : sql``
      const past = after ? sql`where (m.a, m.b) > (${after.first}, ${after.second})` : sql``
      const result = await tx.execute(sql`
        with m as (
          select least(i.prospect_id, f.prospect_id) as a,
                 greatest(i.prospect_id, f.prospect_id) as b,
                 i.kind::text as kind
          from core.prospect_fields f
          join core.prospect_identities i
            on i.organization_id = f.organization_id
           and i.value = f.value
           and i.kind::text = case f.field_name
                 when 'email' then 'email' when 'phone' then 'phone' else 'linkedin' end
          where f.organization_id = ${organizationId}
            and f.state <> 'current'
            and f.field_name in ('email', 'phone', 'linkedin_url')
            and i.prospect_id <> f.prospect_id
            ${only})
        select m.a, m.b, array_agg(distinct m.kind order by m.kind) as matched_on
        from m ${past}
        group by m.a, m.b
        order by m.a, m.b
        limit ${limit}`)
      return result.rows.map(
        (row: { a: string; b: string; matched_on: string[] }): DuplicatePair => ({
          first: prospectIdSchema.parse(row.a),
          second: prospectIdSchema.parse(row.b),
          matchedOn: row.matched_on as ProspectIdentityKind[],
        })
      )
    },

    listProspectFieldHistory: async (prospectId) => {
      const rows = await tx
        .select()
        .from(prospectFields)
        .where(
          and(
            eq(prospectFields.organizationId, organizationId),
            eq(prospectFields.prospectId, prospectId)
          )
        )
        .orderBy(asc(prospectFields.seq))
      return rows.map(
        (row): FieldHistoryRow => ({
          field: FIELD_OF[row.fieldName] ?? row.fieldName,
          value: row.value,
          state: row.state,
          source: row.source,
          sourceRef: row.sourceRef,
          setAt: row.setAt,
          setByUserId: row.setByUserId === null ? null : userIdSchema.parse(row.setByUserId),
        })
      )
    },

    replaceProspectFields: async (prospectId, rows) => {
      await tx
        .delete(prospectFields)
        .where(
          and(
            eq(prospectFields.organizationId, organizationId),
            eq(prospectFields.prospectId, prospectId)
          )
        )
      if (rows.length === 0) {
        return
      }
      await tx.insert(prospectFields).values(
        rows.map((row) => ({
          organizationId,
          prospectId,
          fieldName: COLUMN_OF[row.field] ?? row.field,
          state: row.state,
          value: row.value,
          source: row.source,
          sourceRef: row.sourceRef,
          setAt: row.setAt,
          setByUserId: row.setByUserId,
        }))
      )
    },

    restoreProspect: async (record) => {
      // A Membership or Company removed since the merge cannot be pointed at again.
      const [company] = record.companyId
        ? await tx
            .select({ id: prospectCompanies.id })
            .from(prospectCompanies)
            .where(
              and(
                eq(prospectCompanies.organizationId, organizationId),
                eq(prospectCompanies.id, record.companyId)
              )
            )
        : []
      const [owner] = record.ownerMembershipId
        ? await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.organizationId, organizationId),
                eq(memberships.id, record.ownerMembershipId)
              )
            )
        : []
      await tx.insert(prospects).values({
        id: record.id,
        organizationId,
        companyId: company?.id ?? null,
        ownerMembershipId: owner?.id ?? null,
        status: record.status,
        source: record.source,
        tags: record.tags,
        notes: record.notes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
    },

    moveProspectLinks: async (from, to) => {
      const bookings = await tx.execute(sql`
        update core.bookings set prospect_id = ${to}
        where organization_id = ${organizationId} and prospect_id = ${from} returning id`)
      const conversations = await tx.execute(sql`
        update core.conversations set prospect_id = ${to}
        where organization_id = ${organizationId} and prospect_id = ${from} returning id`)
      return {
        bookingIds: bookings.rows.map((row: { id: string }) => bookingIdSchema.parse(row.id)),
        conversationIds: conversations.rows.map((row: { id: string }) =>
          conversationIdSchema.parse(row.id)
        ),
      } satisfies ProspectLinks
    },

    restoreProspectLinks: async (prospectId, links) => {
      if (links.bookingIds.length > 0) {
        await tx.execute(sql`
          update core.bookings set prospect_id = ${prospectId}
          where organization_id = ${organizationId} and id = any(${textArray(links.bookingIds)})`)
      }
      if (links.conversationIds.length > 0) {
        await tx.execute(sql`
          update core.conversations set prospect_id = ${prospectId}
          where organization_id = ${organizationId} and id = any(${textArray(links.conversationIds)})`)
      }
    },

    insertProspectMerge: async (record) => {
      await tx.insert(prospectMerges).values({ ...record, organizationId })
    },

    getProspectMerge: (id) => readMerge(id, false),
    lockProspectMerge: (id) => readMerge(id, true),

    updateProspectMerge: async (id, patch) => {
      const rows = await tx.update(prospectMerges).set(patch).where(mergeIn(id)).returning()
      return rows[0] ? toMerge(rows[0]) : null
    },

    findActiveMerge: async (prospectIds: readonly ProspectId[]) => {
      if (prospectIds.length === 0) {
        return null
      }
      const rows = await tx
        .select()
        .from(prospectMerges)
        .where(
          and(
            eq(prospectMerges.organizationId, organizationId),
            eq(prospectMerges.state, 'merged'),
            sql`${prospectMerges.mergedProspectIds} && ${textArray(prospectIds)}`
          )
        )
        .limit(1)
      return rows[0] ? toMerge(rows[0]) : null
    },
  }
}

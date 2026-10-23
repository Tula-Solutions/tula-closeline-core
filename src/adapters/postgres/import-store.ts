import { and, asc, eq, type SQL, sql } from 'drizzle-orm'
import {
  type OrganizationId,
  type ProspectImportId,
  prospectIdSchema,
  prospectImportFailureReasonSchema,
  prospectImportIdSchema,
  prospectImportRowReasonSchema,
  prospectImportRowResultSchema,
  prospectImportStateSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { prospectCompanies, prospectImportRows, prospectImports } from 'tula-closeline-db/schema'
import {
  MissingReferenceError,
  type OrganizationScope,
  type ProspectImportRecord,
  type ProspectImportRowCounts,
  type ProspectImportRowRecord,
} from '~/ports/core-store'
import { toCompany } from './prospect-store'

/** The Prospect import methods of a scope over one transaction. */
export type ImportStoreMethods = Pick<
  OrganizationScope,
  | 'insertProspectImport'
  | 'getProspectImport'
  | 'lockProspectImport'
  | 'listProspectImports'
  | 'updateProspectImport'
  | 'deleteProspectImport'
  | 'insertProspectImportRows'
  | 'listProspectImportRows'
  | 'countProspectImportRows'
  | 'findProspectCompany'
>

type ImportRow = typeof prospectImports.$inferSelect
type ImportResultRow = typeof prospectImportRows.$inferSelect

function toImport(row: ImportRow): ProspectImportRecord {
  return {
    id: prospectImportIdSchema.parse(row.id),
    state: prospectImportStateSchema.parse(row.state),
    failureReason:
      row.failureReason === null
        ? null
        : prospectImportFailureReasonSchema.parse(row.failureReason),
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    objectKey: row.objectKey,
    processedRows: row.processedRows,
    rowCount: row.rowCount,
    createdCount: row.createdCount,
    updatedCount: row.updatedCount,
    skippedCount: row.skippedCount,
    rejectedCount: row.rejectedCount,
    uploadedByUserId: userIdSchema.parse(row.uploadedByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toResultRow(row: ImportResultRow): ProspectImportRowRecord {
  return {
    rowNumber: row.rowNumber,
    result: prospectImportRowResultSchema.parse(row.result),
    reason: row.reason === null ? null : prospectImportRowReasonSchema.parse(row.reason),
    prospectId: row.prospectId === null ? null : prospectIdSchema.parse(row.prospectId),
  }
}

/** Builds the Prospect import methods over one transaction of `organizationId`. */
export function createImportStore(
  tx: Transaction,
  organizationId: OrganizationId
): ImportStoreMethods {
  const importIn = (id: string): SQL | undefined =>
    and(eq(prospectImports.organizationId, organizationId), eq(prospectImports.id, id))

  const readImport = async (id: ProspectImportId, lock: boolean) => {
    const query = tx.select().from(prospectImports).where(importIn(id))
    const row = (await (lock ? query.for('update') : query))[0]
    return row ? toImport(row) : null
  }

  return {
    insertProspectImport: async (input) => {
      const rows = await tx
        .insert(prospectImports)
        .values({
          id: input.id,
          organizationId,
          sizeBytes: input.sizeBytes,
          contentHash: input.contentHash,
          objectKey: input.objectKey,
          uploadedByUserId: input.uploadedByUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The Prospect import was not stored')
      }
      return toImport(row)
    },

    getProspectImport: (id) => readImport(id, false),

    lockProspectImport: (id) => readImport(id, true),

    listProspectImports: async (request) =>
      (
        await tx
          .select()
          .from(prospectImports)
          .where(
            and(
              eq(prospectImports.organizationId, organizationId),
              request.after === undefined
                ? undefined
                : sql`(${prospectImports.createdAt}, ${prospectImports.id}) < (${request.after.createdAt.toISOString()}::timestamptz, ${request.after.id})`
            )
          )
          .orderBy(
            sql`${prospectImports.createdAt} desc nulls last`,
            sql`${prospectImports.id} desc nulls last`
          )
          .limit(request.limit)
      ).map(toImport),

    updateProspectImport: async (id, patch, now) => {
      const rows = await tx
        .update(prospectImports)
        .set({
          ...(patch.state === undefined ? {} : { state: patch.state }),
          ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
          ...(patch.processedRows === undefined ? {} : { processedRows: patch.processedRows }),
          ...(patch.counts === undefined
            ? {}
            : {
                rowCount: patch.counts.rowCount,
                createdCount: patch.counts.created,
                updatedCount: patch.counts.updated,
                skippedCount: patch.counts.skipped,
                rejectedCount: patch.counts.rejected,
              }),
          updatedAt: now,
        })
        .where(importIn(id))
        .returning()
      const row = rows[0]
      return row ? toImport(row) : null
    },

    deleteProspectImport: async (id) =>
      (await tx.delete(prospectImports).where(importIn(id)).returning({ id: prospectImports.id }))
        .length > 0,

    insertProspectImportRows: async (importId, rows) => {
      if (rows.length === 0) {
        return
      }
      if (!(await readImport(importId, false))) {
        throw new MissingReferenceError('The import')
      }
      await tx
        .insert(prospectImportRows)
        .values(
          rows.map((row) => ({
            organizationId,
            importId,
            rowNumber: row.rowNumber,
            result: row.result,
            reason: row.reason,
            prospectId: row.prospectId,
          }))
        )
        .onConflictDoNothing()
    },

    listProspectImportRows: async (request) =>
      (
        await tx
          .select()
          .from(prospectImportRows)
          .where(
            and(
              eq(prospectImportRows.organizationId, organizationId),
              eq(prospectImportRows.importId, request.importId),
              request.result === undefined
                ? undefined
                : eq(prospectImportRows.result, request.result),
              request.afterRow === undefined
                ? undefined
                : sql`${prospectImportRows.rowNumber} > ${request.afterRow}`
            )
          )
          .orderBy(asc(prospectImportRows.rowNumber))
          .limit(request.limit)
      ).map(toResultRow),

    countProspectImportRows: async (importId) => {
      const counts: ProspectImportRowCounts = { created: 0, updated: 0, skipped: 0, rejected: 0 }
      const rows = await tx
        .select({ result: prospectImportRows.result, total: sql<number>`count(*)::int` })
        .from(prospectImportRows)
        .where(
          and(
            eq(prospectImportRows.organizationId, organizationId),
            eq(prospectImportRows.importId, importId)
          )
        )
        .groupBy(prospectImportRows.result)
      for (const row of rows) {
        counts[prospectImportRowResultSchema.parse(row.result)] = row.total
      }
      return counts
    },

    findProspectCompany: async (match) => {
      const rows = await tx
        .select()
        .from(prospectCompanies)
        .where(
          and(
            eq(prospectCompanies.organizationId, organizationId),
            'domain' in match
              ? eq(prospectCompanies.domain, match.domain)
              : sql`lower(${prospectCompanies.name}) = ${match.name.toLowerCase()}`
          )
        )
        .orderBy(asc(prospectCompanies.createdAt), asc(prospectCompanies.id))
        .limit(1)
      const row = rows[0]
      return row ? toCompany(row) : null
    },
  }
}

import { and, asc, eq, type SQL, sql } from 'drizzle-orm'
import {
  type OrganizationId,
  SUPPRESSION_IMPORT_FAILURE_REASONS,
  SUPPRESSION_IMPORT_ROW_RESULTS,
  suppressionImportIdSchema,
  suppressionImportStateSchema,
  userIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { suppressionImportRows, suppressionImports } from 'tula-closeline-db/schema'
import { MissingReferenceError } from '~/ports/core-store'
import type {
  SuppressionImportRecord,
  SuppressionImportRowCounts,
  SuppressionImportRowRecord,
  SuppressionImportScope,
} from '~/ports/suppression-import-store'

type ImportRow = typeof suppressionImports.$inferSelect
type ResultRow = typeof suppressionImportRows.$inferSelect

const FAILURE_REASONS: readonly string[] = SUPPRESSION_IMPORT_FAILURE_REASONS
const ROW_RESULTS: readonly string[] = SUPPRESSION_IMPORT_ROW_RESULTS

function toImport(row: ImportRow): SuppressionImportRecord {
  const failureReason = row.failureReason
  if (failureReason !== null && !FAILURE_REASONS.includes(failureReason)) {
    throw new Error('A Suppression import has an unknown failure reason')
  }
  return {
    id: suppressionImportIdSchema.parse(row.id),
    state: suppressionImportStateSchema.parse(row.state),
    failureReason,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    objectKey: row.objectKey,
    processedRows: row.processedRows,
    totalRows: row.totalRows,
    addedRows: row.addedRows,
    alreadySuppressedRows: row.alreadySuppressedRows,
    invalidRows: row.invalidRows,
    createdByUserId: userIdSchema.parse(row.createdByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  }
}

function toResultRow(row: ResultRow): SuppressionImportRowRecord {
  return { rowNumber: row.rowNumber, result: row.result, reason: row.reason }
}

/** Builds the bulk Suppression import methods over one transaction of `organizationId`. */
export function createSuppressionImportStore(
  tx: Transaction,
  organizationId: OrganizationId
): SuppressionImportScope {
  const importIn = (id: string): SQL | undefined =>
    and(eq(suppressionImports.organizationId, organizationId), eq(suppressionImports.id, id))

  const readImport = async (id: string, lock: boolean) => {
    const query = tx.select().from(suppressionImports).where(importIn(id))
    const row = (await (lock ? query.for('update') : query))[0]
    return row ? toImport(row) : null
  }

  return {
    insertSuppressionImport: async (input) => {
      const rows = await tx
        .insert(suppressionImports)
        .values({
          id: input.id,
          organizationId,
          sizeBytes: input.sizeBytes,
          contentHash: input.contentHash,
          objectKey: input.objectKey,
          createdByUserId: input.createdByUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The Suppression import was not stored')
      }
      return toImport(row)
    },

    getSuppressionImport: (id) => readImport(id, false),

    lockSuppressionImport: (id) => readImport(id, true),

    listSuppressionImports: async (request) =>
      (
        await tx
          .select()
          .from(suppressionImports)
          .where(
            and(
              eq(suppressionImports.organizationId, organizationId),
              request.after === undefined
                ? undefined
                : sql`(${suppressionImports.createdAt}, ${suppressionImports.id}) < (${request.after.createdAt.toISOString()}::timestamptz, ${request.after.id})`
            )
          )
          .orderBy(sql`${suppressionImports.createdAt} desc`, sql`${suppressionImports.id} desc`)
          .limit(request.limit)
      ).map(toImport),

    updateSuppressionImport: async (id, patch, now) => {
      const rows = await tx
        .update(suppressionImports)
        .set({
          ...(patch.state === undefined ? {} : { state: patch.state }),
          ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
          ...(patch.processedRows === undefined ? {} : { processedRows: patch.processedRows }),
          ...(patch.counts === undefined
            ? {}
            : {
                totalRows: patch.counts.total,
                addedRows: patch.counts.added,
                alreadySuppressedRows: patch.counts.alreadySuppressed,
                invalidRows: patch.counts.invalid,
                completedAt: now,
              }),
          updatedAt: now,
        })
        .where(importIn(id))
        .returning()
      const row = rows[0]
      return row ? toImport(row) : null
    },

    insertSuppressionImportRows: async (importId, rows) => {
      if (rows.length === 0) {
        return
      }
      if (!(await readImport(importId, false))) {
        throw new MissingReferenceError('The import')
      }
      await tx
        .insert(suppressionImportRows)
        .values(
          rows.map((row) => ({
            organizationId,
            importId,
            rowNumber: row.rowNumber,
            result: row.result,
            reason: row.reason,
          }))
        )
        .onConflictDoNothing()
    },

    listSuppressionImportRows: async (request) =>
      (
        await tx
          .select()
          .from(suppressionImportRows)
          .where(
            and(
              eq(suppressionImportRows.organizationId, organizationId),
              eq(suppressionImportRows.importId, request.importId),
              request.result === undefined
                ? undefined
                : eq(suppressionImportRows.result, request.result),
              request.afterRow === undefined
                ? undefined
                : sql`${suppressionImportRows.rowNumber} > ${request.afterRow}`
            )
          )
          .orderBy(asc(suppressionImportRows.rowNumber))
          .limit(request.limit)
      ).map(toResultRow),

    countSuppressionImportRows: async (importId) => {
      const counts: SuppressionImportRowCounts = { added: 0, already_suppressed: 0, invalid: 0 }
      const rows = await tx
        .select({ result: suppressionImportRows.result, total: sql<number>`count(*)::int` })
        .from(suppressionImportRows)
        .where(
          and(
            eq(suppressionImportRows.organizationId, organizationId),
            eq(suppressionImportRows.importId, importId)
          )
        )
        .groupBy(suppressionImportRows.result)
      for (const row of rows) {
        if (ROW_RESULTS.includes(row.result)) {
          counts[row.result] = row.total
        }
      }
      return counts
    },
  }
}

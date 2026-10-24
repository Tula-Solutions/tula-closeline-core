import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm'
import {
  type ExportService,
  exportFailureReasonSchema,
  exportJobIdSchema,
  exportPartFailureReasonSchema,
  exportServiceSchema,
  exportStateSchema,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { exportJobs, exportParts } from 'tula-closeline-db/schema'
import type { ExportJobRecord, ExportPartRecord, ExportScope } from '~/ports/export-store'

const toJob = (row: typeof exportJobs.$inferSelect): ExportJobRecord => ({
  id: exportJobIdSchema.parse(row.id),
  state: exportStateSchema.parse(row.state),
  requestedByMembershipId: membershipIdSchema.parse(row.requestedByMembershipId),
  includeRecordingLinks: row.includeRecordingLinks,
  failureReason:
    row.failureReason === null ? null : exportFailureReasonSchema.parse(row.failureReason),
  requestedAt: row.requestedAt,
  completedAt: row.completedAt,
  expiresAt: row.expiresAt,
})

const toPart = (row: typeof exportParts.$inferSelect): ExportPartRecord => ({
  exportId: exportJobIdSchema.parse(row.exportId),
  service: exportServiceSchema.parse(row.service),
  state: row.state as ExportPartRecord['state'],
  prefix: row.prefix,
  fileCount: row.fileCount,
  bytes: row.bytes,
  failureReason:
    row.failureReason === null ? null : exportPartFailureReasonSchema.parse(row.failureReason),
  readyAt: row.readyAt,
})

/** Builds the export methods of one transaction's scope, under the transaction's row-level security. */
export function createExportStore(tx: Transaction, organizationId: OrganizationId): ExportScope {
  const jobsIn = eq(exportJobs.organizationId, organizationId)
  const active = inArray(exportJobs.state, ['queued', 'running'])
  const activeJob = async () => {
    const rows = await tx.select().from(exportJobs).where(and(jobsIn, active)).limit(1)
    return rows[0] ? toJob(rows[0]) : null
  }
  const partIn = (id: string, service: ExportService) =>
    and(
      eq(exportParts.organizationId, organizationId),
      eq(exportParts.exportId, id),
      eq(exportParts.service, service),
      eq(exportParts.state, 'pending'),
      sql`exists (select 1 from ${exportJobs} where ${exportJobs.organizationId} = ${organizationId}
        and ${exportJobs.id} = ${id} and ${exportJobs.state} in ('queued', 'running'))`
    )

  return {
    insertExportJob: async (input) => {
      const inserted = await tx
        .insert(exportJobs)
        .values({
          id: input.id,
          organizationId,
          kind: 'organization',
          requestedByMembershipId: input.requestedByMembershipId,
          includeRecordingLinks: input.includeRecordingLinks,
          requestedAt: input.requestedAt,
        })
        .onConflictDoNothing()
        .returning({ id: exportJobs.id })
      if (inserted.length === 0) {
        return false
      }
      if (input.services.length > 0) {
        await tx.insert(exportParts).values(
          input.services.map((service) => ({
            organizationId,
            exportId: input.id,
            service,
          }))
        )
      }
      return true
    },

    getActiveExportJob: activeJob,

    countExportsSince: async (since) => {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(exportJobs)
        .where(and(jobsIn, gte(exportJobs.requestedAt, since)))
      return rows[0]?.n ?? 0
    },

    getExportJob: async (id) => {
      const rows = await tx
        .select()
        .from(exportJobs)
        .where(and(jobsIn, eq(exportJobs.id, id)))
        .limit(1)
      return rows[0] ? toJob(rows[0]) : null
    },

    listExportJobs: async ({ after, limit }) => {
      const rows = await tx
        .select()
        .from(exportJobs)
        .where(
          and(
            jobsIn,
            after
              ? or(
                  lt(exportJobs.requestedAt, after.requestedAt),
                  and(eq(exportJobs.requestedAt, after.requestedAt), lt(exportJobs.id, after.id))
                )
              : undefined
          )
        )
        .orderBy(desc(exportJobs.requestedAt), desc(exportJobs.id))
        .limit(limit)
      return rows.map(toJob)
    },

    listExportParts: async (ids) => {
      if (ids.length === 0) {
        return []
      }
      const rows = await tx
        .select()
        .from(exportParts)
        .where(
          and(
            eq(exportParts.organizationId, organizationId),
            inArray(exportParts.exportId, [...ids])
          )
        )
      return rows.map(toPart)
    },

    markExportRunning: async (id) => {
      const rows = await tx
        .update(exportJobs)
        .set({ state: 'running' })
        .where(and(jobsIn, eq(exportJobs.id, id), eq(exportJobs.state, 'queued')))
        .returning({ id: exportJobs.id })
      return rows.length > 0
    },

    markExportPartReady: async (id, service, result) => {
      const rows = await tx
        .update(exportParts)
        .set({
          state: 'ready',
          prefix: result.prefix,
          fileCount: result.fileCount,
          bytes: result.bytes,
          readyAt: result.readyAt,
          updatedAt: result.readyAt,
        })
        .where(partIn(id, service))
        .returning({ id: exportParts.exportId })
      return rows.length > 0
    },

    markExportPartFailed: async (id, service, reason) => {
      const rows = await tx
        .update(exportParts)
        .set({ state: 'failed', failureReason: reason, updatedAt: new Date() })
        .where(partIn(id, service))
        .returning({ id: exportParts.exportId })
      return rows.length > 0
    },

    failExportJob: async (id, reason, at) => {
      const rows = await tx
        .update(exportJobs)
        .set({ state: 'failed', failureReason: reason, completedAt: at })
        .where(and(jobsIn, eq(exportJobs.id, id), active))
        .returning({ id: exportJobs.id })
      return rows.length > 0
    },

    completeExportJob: async (id, completedAt, expiresAt) => {
      const rows = await tx
        .update(exportJobs)
        .set({ state: 'ready', completedAt, expiresAt })
        .where(and(jobsIn, eq(exportJobs.id, id), active))
        .returning({ id: exportJobs.id })
      return rows.length > 0
    },

    expireExportJob: async (id) => {
      const rows = await tx
        .update(exportJobs)
        .set({ state: 'expired' })
        .where(and(jobsIn, eq(exportJobs.id, id), eq(exportJobs.state, 'ready')))
        .returning({ id: exportJobs.id })
      return rows.length > 0
    },

    retryExportJob: async (id, at) => {
      if (await activeJob()) {
        return false
      }
      const rows = await tx
        .update(exportJobs)
        .set({ state: 'queued', failureReason: null, completedAt: null, requestedAt: at })
        .where(and(jobsIn, eq(exportJobs.id, id), eq(exportJobs.state, 'failed')))
        .returning({ id: exportJobs.id })
      if (rows.length === 0) {
        return false
      }
      await tx
        .update(exportParts)
        .set({
          state: 'pending',
          prefix: null,
          fileCount: null,
          bytes: null,
          failureReason: null,
          readyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(exportParts.organizationId, organizationId),
            eq(exportParts.exportId, id),
            eq(exportParts.state, 'failed')
          )
        )
      return true
    },
  }
}

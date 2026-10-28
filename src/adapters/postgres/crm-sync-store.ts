import { and, desc, eq, lt, or, type SQL, sql } from 'drizzle-orm'
import {
  type CrmProvider,
  type CrmStageMappingEntry,
  crmConnectionIdSchema,
  crmSyncRunSchema,
  formatId,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { crmConnections, crmExternalRefs, crmMappings, crmSyncRuns } from 'tula-closeline-db/schema'
import type { OrganizationScope } from '~/ports/core-store'
import type { CrmSyncRunRecord } from '~/ports/crm-sync-store'

/** The CRM Stage mapping and sync run methods of the Postgres scope. */
export type CrmSyncStoreMethods = Pick<
  OrganizationScope,
  | 'getCrmStageMapping'
  | 'replaceCrmStageMapping'
  | 'insertCrmSyncRun'
  | 'getCrmSyncRun'
  | 'updateCrmSyncRun'
  | 'listCrmSyncRuns'
  | 'findActiveCrmSyncRun'
  | 'latestCrmCursor'
  | 'getCrmExternalRef'
  | 'upsertCrmExternalRef'
  | 'setCrmLastSynced'
>

type RunRow = typeof crmSyncRuns.$inferSelect

const toRun = (row: RunRow, provider: CrmProvider): CrmSyncRunRecord => ({
  ...crmSyncRunSchema.parse({
    id: row.id,
    connectionId: row.connectionId,
    provider,
    objectKind: row.objectKind,
    trigger: row.trigger,
    state: row.state,
    requestedAt: row.requestedAt.toISOString(),
    requestedByMembershipId: row.requestedByMembershipId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    counts: {
      created: row.createdCount,
      updated: row.updatedCount,
      skipped: row.skippedCount,
      failed: row.failedCount,
      unlinked: row.unlinkedCount,
    },
    skipped: row.skipped,
    skippedFields: row.skippedFields,
    failures: row.failures,
    failuresTruncated: row.failuresTruncated,
    errorCode: row.errorCode,
    retryOfRunId: row.retryOfRunId,
  }),
  cursor: row.cursor,
})

/** Builds the CRM Stage mapping and sync run methods over one transaction of `organizationId`. */
export function createCrmSyncStore(
  tx: Transaction,
  organizationId: OrganizationId
): CrmSyncStoreMethods {
  const connectionOf = async (provider: CrmProvider) =>
    (
      await tx
        .select({ id: crmConnections.id })
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.organizationId, organizationId),
            eq(crmConnections.provider, provider)
          )
        )
        .limit(1)
    )[0]?.id

  const ownRuns = (...conditions: (SQL | undefined)[]) =>
    tx
      .select({ run: crmSyncRuns, provider: crmConnections.provider })
      .from(crmSyncRuns)
      .innerJoin(
        crmConnections,
        and(
          eq(crmConnections.organizationId, crmSyncRuns.organizationId),
          eq(crmConnections.id, crmSyncRuns.connectionId)
        )
      )
      .where(and(eq(crmSyncRuns.organizationId, organizationId), ...conditions))

  const runById = async (id: string) => {
    const row = (await ownRuns(eq(crmSyncRuns.id, id)).limit(1))[0]
    return row ? toRun(row.run, row.provider) : null
  }

  return {
    getCrmStageMapping: async (provider) => {
      const row = (
        await tx
          .select({
            id: crmConnections.id,
            by: crmConnections.stageMappingConfirmedByMembershipId,
            at: crmConnections.stageMappingConfirmedAt,
          })
          .from(crmConnections)
          .where(
            and(
              eq(crmConnections.organizationId, organizationId),
              eq(crmConnections.provider, provider)
            )
          )
          .limit(1)
      )[0]
      if (!row) {
        return null
      }
      const rows = await tx
        .select({ key: crmMappings.key, label: crmMappings.label, outcome: crmMappings.outcome })
        .from(crmMappings)
        .where(
          and(
            eq(crmMappings.organizationId, organizationId),
            eq(crmMappings.connectionId, row.id),
            eq(crmMappings.kind, 'stage')
          )
        )
        .orderBy(crmMappings.key)
        .limit(500)
      const entries: CrmStageMappingEntry[] = rows.flatMap((mapping) =>
        mapping.outcome
          ? [{ stageId: mapping.key, label: mapping.label, outcome: mapping.outcome }]
          : []
      )
      return {
        entries,
        confirmedByMembershipId: row.by ? membershipIdSchema.parse(row.by) : null,
        confirmedAt: row.at,
      }
    },

    replaceCrmStageMapping: async (provider, entries, membershipId, at) => {
      const connectionId = await connectionOf(provider)
      if (!connectionId) {
        return false
      }
      await tx
        .delete(crmMappings)
        .where(
          and(
            eq(crmMappings.organizationId, organizationId),
            eq(crmMappings.connectionId, connectionId),
            eq(crmMappings.kind, 'stage')
          )
        )
      if (entries.length > 0) {
        await tx.insert(crmMappings).values(
          entries.map((entry) => ({
            organizationId,
            connectionId,
            kind: 'stage' as const,
            key: entry.stageId,
            outcome: entry.outcome,
            label: entry.label,
            direction: null,
            updatedAt: at,
          }))
        )
      }
      await tx
        .update(crmConnections)
        .set({
          stageMappingConfirmedByMembershipId: membershipId,
          stageMappingConfirmedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(crmConnections.organizationId, organizationId),
            eq(crmConnections.id, connectionId)
          )
        )
      return true
    },

    insertCrmSyncRun: async (input) => {
      const connectionId = await connectionOf(input.provider)
      if (!connectionId) {
        return null
      }
      await tx.insert(crmSyncRuns).values({
        id: input.id,
        organizationId,
        connectionId,
        objectKind: input.objectKind,
        trigger: input.trigger,
        state: 'queued',
        requestedAt: new Date(input.requestedAt),
        requestedByMembershipId: input.requestedByMembershipId,
        retryOfRunId: input.retryOfRunId,
      })
      return runById(input.id)
    },

    getCrmSyncRun: (id) => runById(id),

    updateCrmSyncRun: async (id, patch) => {
      const set: Partial<typeof crmSyncRuns.$inferInsert> = {}
      if (patch.state !== undefined) {
        set.state = patch.state
      }
      if (patch.startedAt !== undefined) {
        set.startedAt = patch.startedAt === null ? null : new Date(patch.startedAt)
      }
      if (patch.completedAt !== undefined) {
        set.completedAt = patch.completedAt === null ? null : new Date(patch.completedAt)
      }
      if (patch.counts !== undefined) {
        set.createdCount = patch.counts.created
        set.updatedCount = patch.counts.updated
        set.skippedCount = patch.counts.skipped
        set.failedCount = patch.counts.failed
        set.unlinkedCount = patch.counts.unlinked
      }
      if (patch.skipped !== undefined) {
        set.skipped = patch.skipped
      }
      if (patch.failures !== undefined) {
        set.failures = patch.failures
      }
      if (patch.failuresTruncated !== undefined) {
        set.failuresTruncated = patch.failuresTruncated
      }
      if (patch.errorCode !== undefined) {
        set.errorCode = patch.errorCode
      }
      if (patch.cursor !== undefined) {
        set.cursor = patch.cursor
      }
      if (Object.keys(set).length > 0) {
        await tx
          .update(crmSyncRuns)
          .set(set)
          .where(and(eq(crmSyncRuns.organizationId, organizationId), eq(crmSyncRuns.id, id)))
      }
      return runById(id)
    },

    listCrmSyncRuns: async ({ provider, state, objectKind, after, limit }) =>
      (
        await ownRuns(
          eq(crmConnections.provider, provider),
          state === undefined ? undefined : eq(crmSyncRuns.state, state),
          objectKind === undefined ? undefined : eq(crmSyncRuns.objectKind, objectKind),
          after === undefined
            ? undefined
            : or(
                lt(crmSyncRuns.requestedAt, new Date(after.requestedAt)),
                and(
                  eq(crmSyncRuns.requestedAt, new Date(after.requestedAt)),
                  lt(crmSyncRuns.id, after.id)
                )
              )
        )
          .orderBy(desc(crmSyncRuns.requestedAt), desc(crmSyncRuns.id))
          .limit(limit)
      ).map((row) => toRun(row.run, row.provider)),

    findActiveCrmSyncRun: async (provider, objectKind) => {
      const row = (
        await ownRuns(
          eq(crmConnections.provider, provider),
          eq(crmSyncRuns.objectKind, objectKind),
          sql`${crmSyncRuns.state} in ('queued', 'running')`
        )
          .orderBy(desc(crmSyncRuns.requestedAt), desc(crmSyncRuns.id))
          .limit(1)
      )[0]
      return row ? toRun(row.run, row.provider) : null
    },

    latestCrmCursor: async (provider, objectKind) =>
      (
        await ownRuns(
          eq(crmConnections.provider, provider),
          eq(crmSyncRuns.objectKind, objectKind),
          sql`${crmSyncRuns.cursor} is not null`
        )
          .orderBy(desc(crmSyncRuns.requestedAt), desc(crmSyncRuns.id))
          .limit(1)
      )[0]?.run.cursor ?? null,

    getCrmExternalRef: async (provider, objectKind, externalId) => {
      const row = (
        await tx
          .select({ localId: crmExternalRefs.localId, version: crmExternalRefs.lastSeenVersion })
          .from(crmExternalRefs)
          .where(
            and(
              eq(crmExternalRefs.organizationId, organizationId),
              eq(crmExternalRefs.provider, provider),
              eq(crmExternalRefs.objectKind, objectKind),
              eq(crmExternalRefs.externalId, externalId)
            )
          )
          .limit(1)
      )[0]
      return row ? { localId: row.localId, lastSeenVersion: row.version } : null
    },

    upsertCrmExternalRef: async (input) => {
      const connectionId = await connectionOf(input.provider)
      if (!connectionId) {
        return false
      }
      await tx
        .insert(crmExternalRefs)
        .values({
          id: formatId('cxr', crypto.randomUUID()),
          organizationId,
          connectionId: crmConnectionIdSchema.parse(connectionId),
          provider: input.provider,
          objectKind: input.objectKind,
          externalId: input.externalId,
          localId: input.localId,
          state: 'linked',
          lastSeenVersion: input.version,
          lastSeenAt: input.at,
          createdAt: input.at,
          updatedAt: input.at,
        })
        .onConflictDoUpdate({
          target: [
            crmExternalRefs.organizationId,
            crmExternalRefs.provider,
            crmExternalRefs.objectKind,
            crmExternalRefs.externalId,
          ],
          set: {
            localId: input.localId,
            state: 'linked',
            lastSeenVersion: input.version,
            lastSeenAt: input.at,
            updatedAt: input.at,
          },
        })
      return true
    },

    setCrmLastSynced: async (provider, at) =>
      (
        await tx
          .update(crmConnections)
          .set({ lastSyncedAt: at, updatedAt: at })
          .where(
            and(
              eq(crmConnections.organizationId, organizationId),
              eq(crmConnections.provider, provider)
            )
          )
          .returning({ id: crmConnections.id })
      ).length > 0,
  }
}

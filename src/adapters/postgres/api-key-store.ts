import { and, desc, eq, lt, sql } from 'drizzle-orm'
import {
  type ApiKeyId,
  apiKeyIdSchema,
  apiKeyScopeSchema,
  membershipIdSchema,
  type OrganizationId,
  roleSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { apiKeyUsage, coreApiKeys } from 'tula-closeline-db/schema'
import type { ApiKeyRecord, ApiKeyStoreScope, ApiKeyWithHash } from '~/ports/api-key-store'

type Row = typeof coreApiKeys.$inferSelect

/** How long a key's finished usage windows are kept before the next new window deletes them. */
const USAGE_RETENTION_MS = 24 * 60 * 60 * 1000

const toRecord = (row: Row): ApiKeyRecord => ({
  id: apiKeyIdSchema.parse(row.id),
  name: row.name,
  prefix: row.prefix,
  scopes: row.scopes.map((scope) => apiKeyScopeSchema.parse(scope)),
  roleCeiling: roleSchema.parse(row.roleCeiling),
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  createdByMembershipId: membershipIdSchema.parse(row.createdByMembershipId),
  createdAt: row.createdAt,
})

/** Builds the API key methods of one transaction's scope, under the transaction's row-level security. */
export function createApiKeyStore(
  tx: Transaction,
  organizationId: OrganizationId
): ApiKeyStoreScope {
  const inOrganization = eq(coreApiKeys.organizationId, organizationId)
  const byId = (id: ApiKeyId) => and(inOrganization, eq(coreApiKeys.id, id))

  return {
    insertApiKey: async (key) => {
      const rows = await tx
        .insert(coreApiKeys)
        .values({
          id: key.id,
          organizationId,
          name: key.name,
          prefix: key.prefix,
          secretHash: key.secretHash,
          scopes: key.scopes,
          roleCeiling: key.roleCeiling,
          expiresAt: key.expiresAt,
          createdByMembershipId: key.createdByMembershipId,
          createdAt: key.createdAt,
        })
        .returning()
      const row = rows[0]
      if (!row) {
        throw new Error('The API key insert returned no row')
      }
      return toRecord(row)
    },

    getApiKeyWithHash: async (id) => {
      const rows = await tx.select().from(coreApiKeys).where(byId(id)).limit(1)
      const row = rows[0]
      return row
        ? ({ ...toRecord(row), secretHash: row.secretHash } satisfies ApiKeyWithHash)
        : null
    },

    getApiKey: async (id) => {
      const rows = await tx.select().from(coreApiKeys).where(byId(id)).limit(1)
      return rows[0] ? toRecord(rows[0]) : null
    },

    listApiKeys: async ({ includeRevoked, after, limit }) => {
      const rows = await tx
        .select()
        .from(coreApiKeys)
        .where(
          and(
            inOrganization,
            includeRevoked ? undefined : sql`${coreApiKeys.revokedAt} is null`,
            after === undefined
              ? undefined
              : sql`(${coreApiKeys.createdAt}, ${coreApiKeys.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id})`
          )
        )
        .orderBy(desc(coreApiKeys.createdAt), desc(coreApiKeys.id))
        .limit(limit)
      return rows.map(toRecord)
    },

    revokeApiKey: async (id, now) => {
      await tx
        .update(coreApiKeys)
        .set({ revokedAt: now })
        .where(and(byId(id), sql`${coreApiKeys.revokedAt} is null`))
      const rows = await tx.select().from(coreApiKeys).where(byId(id)).limit(1)
      return rows[0] ? toRecord(rows[0]) : null
    },

    hitApiKeyUsage: async ({ apiKeyId, now, windowSeconds, limit }) => {
      const windowMs = windowSeconds * 1000
      const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)
      // The conditional update refuses a full window without counting, so the counter stays bounded.
      const counted = await tx
        .insert(apiKeyUsage)
        .values({ organizationId, apiKeyId, windowStart, requestCount: 1 })
        .onConflictDoUpdate({
          target: [apiKeyUsage.organizationId, apiKeyUsage.apiKeyId, apiKeyUsage.windowStart],
          set: { requestCount: sql`${apiKeyUsage.requestCount} + 1` },
          setWhere: lt(apiKeyUsage.requestCount, limit),
        })
        .returning({ requestCount: apiKeyUsage.requestCount })
      const hit = counted[0]
      if (!hit) {
        return false
      }
      if (hit.requestCount === 1) {
        // A new window: the key's windows past retention go, so the table stays bounded per key.
        await tx
          .delete(apiKeyUsage)
          .where(
            and(
              eq(apiKeyUsage.organizationId, organizationId),
              eq(apiKeyUsage.apiKeyId, apiKeyId),
              lt(apiKeyUsage.windowStart, new Date(now.getTime() - USAGE_RETENTION_MS))
            )
          )
      }
      await tx.update(coreApiKeys).set({ lastUsedAt: now }).where(byId(apiKeyId))
      return true
    },
  }
}

import { and, asc, eq, gt } from 'drizzle-orm'
import {
  type CrmProvider,
  crmConnectionIdSchema,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { crmConnections } from 'tula-closeline-db/schema'
import {
  CrmAccountTakenError,
  type CrmConnectionRecord,
  type CrmSealedTokens,
  type OrganizationScope,
} from '~/ports/core-store'

/** The unique index that holds "one Organization per CRM account". */
const ONE_ORGANIZATION_PER_CRM_ACCOUNT = 'crm_connection_account_key'

/** The CRM connection methods of the Postgres scope. */
export type CrmStoreMethods = Pick<
  OrganizationScope,
  | 'listCrmConnections'
  | 'getCrmConnection'
  | 'getCrmSealedTokens'
  | 'upsertCrmConnection'
  | 'deleteCrmConnection'
>

type ConnectionRow = typeof crmConnections.$inferSelect

/** The columns of a connection that are not a token: what every read of metadata selects. */
const metadataColumns = {
  id: crmConnections.id,
  provider: crmConnections.provider,
  state: crmConnections.state,
  externalAccountId: crmConnections.externalAccountId,
  accountLabel: crmConnections.accountLabel,
  scopeLevel: crmConnections.scopeLevel,
  connectedByMembershipId: crmConnections.connectedByMembershipId,
  connectedAt: crmConnections.connectedAt,
  lastSyncedAt: crmConnections.lastSyncedAt,
  needsReconnectSince: crmConnections.needsReconnectSince,
}

const toRecord = (row: Pick<ConnectionRow, keyof typeof metadataColumns>): CrmConnectionRecord => ({
  id: crmConnectionIdSchema.parse(row.id),
  provider: row.provider,
  state: row.state,
  externalAccountId: row.externalAccountId,
  accountLabel: row.accountLabel,
  scopeLevel: row.scopeLevel,
  connectedByMembershipId: membershipIdSchema.parse(row.connectedByMembershipId),
  connectedAt: row.connectedAt,
  lastSyncedAt: row.lastSyncedAt,
  needsReconnectSince: row.needsReconnectSince,
})

/**
 * Turns a unique violation on the CRM account into the port's error, or returns `undefined`.
 * Every other failure is left as it came.
 */
export function translateCrmError(info: { code?: string; constraint?: string }): unknown {
  if (info.code === '23505' && info.constraint === ONE_ORGANIZATION_PER_CRM_ACCOUNT) {
    return new CrmAccountTakenError()
  }
  return undefined
}

/** Builds the CRM connection methods over one transaction of `organizationId`. */
export function createCrmStore(tx: Transaction, organizationId: OrganizationId): CrmStoreMethods {
  const forProvider = (provider: CrmProvider) =>
    and(eq(crmConnections.organizationId, organizationId), eq(crmConnections.provider, provider))

  return {
    listCrmConnections: async ({ afterId, limit }) =>
      (
        await tx
          .select(metadataColumns)
          .from(crmConnections)
          .where(
            and(
              eq(crmConnections.organizationId, organizationId),
              afterId === undefined ? undefined : gt(crmConnections.id, afterId)
            )
          )
          .orderBy(asc(crmConnections.id))
          .limit(limit)
      ).map(toRecord),

    getCrmConnection: async (provider) => {
      const row = (
        await tx.select(metadataColumns).from(crmConnections).where(forProvider(provider)).limit(1)
      )[0]
      return row ? toRecord(row) : null
    },

    getCrmSealedTokens: async (provider): Promise<CrmSealedTokens | null> => {
      const row = (
        await tx
          .select({
            id: crmConnections.id,
            accessTokenSealed: crmConnections.accessTokenSealed,
            refreshTokenSealed: crmConnections.refreshTokenSealed,
            tokenKeyId: crmConnections.tokenKeyId,
            accessTokenExpiresAt: crmConnections.accessTokenExpiresAt,
          })
          .from(crmConnections)
          .where(forProvider(provider))
          .limit(1)
      )[0]
      return row
        ? {
            connectionId: crmConnectionIdSchema.parse(row.id),
            accessTokenSealed: row.accessTokenSealed,
            refreshTokenSealed: row.refreshTokenSealed,
            tokenKeyId: row.tokenKeyId,
            accessTokenExpiresAt: row.accessTokenExpiresAt,
          }
        : null
    },

    upsertCrmConnection: async (input) => {
      const grant = {
        state: 'connected' as const,
        externalAccountId: input.externalAccountId,
        accountLabel: input.accountLabel,
        scopeLevel: input.scopeLevel,
        accessTokenSealed: input.accessTokenSealed,
        refreshTokenSealed: input.refreshTokenSealed,
        tokenKeyId: input.tokenKeyId,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        connectedByMembershipId: input.connectedByMembershipId,
        connectedAt: input.now,
        needsReconnectSince: null,
        updatedAt: input.now,
      }
      const rows = await tx
        .insert(crmConnections)
        .values({ id: input.id, organizationId, provider: input.provider, ...grant })
        .onConflictDoUpdate({
          target: [crmConnections.organizationId, crmConnections.provider],
          set: grant,
        })
        .returning(metadataColumns)
      const row = rows[0]
      if (!row) {
        throw new Error('The CRM connection was not stored')
      }
      return toRecord(row)
    },

    deleteCrmConnection: async (provider) => {
      const rows = await tx
        .delete(crmConnections)
        .where(forProvider(provider))
        .returning(metadataColumns)
      const row = rows[0]
      return row ? toRecord(row) : null
    },
  }
}

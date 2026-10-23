import type { CrmConnectionId, CrmProvider, OrganizationId } from 'tula-closeline-contract'
import {
  CrmAccountTakenError,
  type CrmConnectionRecord,
  type CrmSealedTokens,
  type OrganizationScope,
} from '~/ports/core-store'

/** A connection with the Organization it belongs to and its sealed tokens. */
type StoredCrmConnection = {
  organizationId: OrganizationId
  record: CrmConnectionRecord
  tokens: CrmSealedTokens
}

/** What the in-memory store keeps for CRM connections. The map is replaced, never changed in place, once a transaction has taken its copy. */
export type CrmState = {
  /** `organization/provider` to the connection. */
  crmConnections: Map<string, StoredCrmConnection>
}

/** An empty {@link CrmState}. */
export function emptyCrmState(): CrmState {
  return { crmConnections: new Map() }
}

/** A copy of the shell of the map, for a transaction's first write. */
export function copyCrmState(state: CrmState): CrmState {
  return { crmConnections: new Map(state.crmConnections) }
}

const keyOf = (organizationId: OrganizationId, provider: CrmProvider): string =>
  `${organizationId}\u0000${provider}`

/** A copy of the bytes, so a later change to the caller's array cannot reach the stored row. */
const bytes = (value: Uint8Array | null): Uint8Array | null =>
  value === null ? null : new Uint8Array(value)

/** The CRM connection methods of an {@link OrganizationScope}. */
export type CrmScope = Pick<
  OrganizationScope,
  | 'listCrmConnections'
  | 'getCrmConnection'
  | 'getCrmSealedTokens'
  | 'upsertCrmConnection'
  | 'deleteCrmConnection'
>

/** What a method needs from the transaction it runs in. */
export type CrmEnvironment = {
  organizationId: OrganizationId
  read: () => CrmState
  write: () => CrmState
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

/** Builds the CRM connection methods of one transaction's scope. */
export function createCrmScope(env: CrmEnvironment): CrmScope {
  const { organizationId, read, write, requireLock } = env
  const own = (provider: CrmProvider): StoredCrmConnection | undefined => {
    const stored = read().crmConnections.get(keyOf(organizationId, provider))
    return stored?.organizationId === organizationId ? stored : undefined
  }

  return {
    listCrmConnections: async ({ afterId, limit }) => {
      const rows: CrmConnectionRecord[] = []
      for (const stored of read().crmConnections.values()) {
        if (stored.organizationId === organizationId) {
          rows.push({ ...stored.record })
        }
      }
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return rows.filter((row) => afterId === undefined || row.id > afterId).slice(0, limit)
    },

    getCrmConnection: async (provider) => {
      const stored = own(provider)
      return stored ? { ...stored.record } : null
    },

    getCrmSealedTokens: async (provider) => {
      const stored = own(provider)
      if (!stored) {
        return null
      }
      return {
        ...stored.tokens,
        accessTokenSealed: bytes(stored.tokens.accessTokenSealed),
        refreshTokenSealed: bytes(stored.tokens.refreshTokenSealed),
      }
    },

    upsertCrmConnection: async (input) => {
      requireLock()
      for (const other of read().crmConnections.values()) {
        if (
          other.organizationId !== organizationId &&
          other.record.provider === input.provider &&
          other.record.externalAccountId === input.externalAccountId
        ) {
          throw new CrmAccountTakenError()
        }
      }
      const existing = own(input.provider)
      const id: CrmConnectionId = existing ? existing.record.id : input.id
      const record: CrmConnectionRecord = {
        id,
        provider: input.provider,
        state: 'connected',
        externalAccountId: input.externalAccountId,
        accountLabel: input.accountLabel,
        scopeLevel: input.scopeLevel,
        connectedByMembershipId: input.connectedByMembershipId,
        connectedAt: input.now,
        lastSyncedAt: existing ? existing.record.lastSyncedAt : null,
        needsReconnectSince: null,
      }
      write().crmConnections.set(keyOf(organizationId, input.provider), {
        organizationId,
        record,
        tokens: {
          connectionId: id,
          accessTokenSealed: bytes(input.accessTokenSealed),
          refreshTokenSealed: bytes(input.refreshTokenSealed),
          tokenKeyId: input.tokenKeyId,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
        },
      })
      return { ...record }
    },

    deleteCrmConnection: async (provider) => {
      requireLock()
      const stored = own(provider)
      if (!stored) {
        return null
      }
      write().crmConnections.delete(keyOf(organizationId, provider))
      return { ...stored.record }
    },
  }
}

/** Test helper: the sealed bytes held for a connection, for a test that shows nothing plain is stored. */
export function sealedBytesOf(
  state: CrmState,
  organizationId: OrganizationId,
  provider: CrmProvider
): Uint8Array[] {
  const stored = state.crmConnections.get(keyOf(organizationId, provider))
  if (!stored) {
    return []
  }
  const { accessTokenSealed, refreshTokenSealed } = stored.tokens
  return [accessTokenSealed, refreshTokenSealed].filter(
    (value): value is Uint8Array => value !== null
  )
}

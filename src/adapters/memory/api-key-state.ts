import type { ApiKeyId, OrganizationId } from 'tula-closeline-contract'
import type { ApiKeyRecord, ApiKeyStoreScope, ApiKeyWithHash } from '~/ports/api-key-store'

/** What the in-memory store keeps for API keys and their usage windows. */
export type ApiKeyState = {
  /** The map is replaced, never changed in place, once a transaction has taken its copy. */
  apiKeys: Map<ApiKeyId, ApiKeyWithHash & { organizationId: OrganizationId }>
  /** Keyed `key id / window start (ms)`. */
  apiKeyUsage: Map<string, number>
}

/** An empty {@link ApiKeyState}. */
export function emptyApiKeyState(): ApiKeyState {
  return { apiKeys: new Map(), apiKeyUsage: new Map() }
}

/** A copy of the shells of the maps, for a transaction's first write. */
export function copyApiKeyState(state: ApiKeyState): ApiKeyState {
  return { apiKeys: new Map(state.apiKeys), apiKeyUsage: new Map(state.apiKeyUsage) }
}

const publicKey = (stored: ApiKeyWithHash & { organizationId: OrganizationId }): ApiKeyRecord => {
  const { secretHash: _hash, organizationId: _org, ...record } = stored
  return { ...record, scopes: [...record.scopes] }
}

/** Builds the API key methods of one transaction's scope, with the database's own rules. */
export function createApiKeyScope(env: {
  organizationId: OrganizationId
  read: () => ApiKeyState
  write: () => ApiKeyState
  requireLock: () => void
}): ApiKeyStoreScope {
  const { organizationId, read, write, requireLock } = env
  const own = (id: ApiKeyId) => {
    const found = read().apiKeys.get(id)
    return found?.organizationId === organizationId ? found : undefined
  }

  return {
    insertApiKey: async (key) => {
      requireLock()
      const state = write()
      for (const other of state.apiKeys.values()) {
        if (other.secretHash === key.secretHash) {
          throw new Error('duplicate api key hash')
        }
      }
      const stored = { ...key, organizationId, lastUsedAt: null, revokedAt: null }
      state.apiKeys.set(key.id, stored)
      return publicKey(stored)
    },

    getApiKeyWithHash: async (id) => {
      const found = own(id)
      return found ? { ...found, scopes: [...found.scopes] } : null
    },

    getApiKey: async (id) => {
      const found = own(id)
      return found ? publicKey(found) : null
    },

    listApiKeys: async ({ includeRevoked, after, limit }) =>
      [...read().apiKeys.values()]
        .filter((key) => key.organizationId === organizationId)
        .filter((key) => includeRevoked || key.revokedAt === null)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )
        .filter(
          (key) =>
            after === undefined ||
            key.createdAt.getTime() < after.createdAt.getTime() ||
            (key.createdAt.getTime() === after.createdAt.getTime() && key.id < after.id)
        )
        .slice(0, limit)
        .map(publicKey),

    revokeApiKey: async (id, now) => {
      requireLock()
      const found = own(id)
      if (!found) {
        return null
      }
      if (found.revokedAt !== null) {
        return publicKey(found)
      }
      const revoked = { ...found, revokedAt: now }
      write().apiKeys.set(id, revoked)
      return publicKey(revoked)
    },

    hitApiKeyUsage: async ({ apiKeyId, now, windowSeconds, limit }) => {
      const found = own(apiKeyId)
      if (!found) {
        return false
      }
      const windowMs = windowSeconds * 1000
      const start = Math.floor(now.getTime() / windowMs) * windowMs
      const slot = `${apiKeyId}/${start}`
      const state = write()
      const count = state.apiKeyUsage.get(slot) ?? 0
      if (count >= limit) {
        return false
      }
      state.apiKeyUsage.set(slot, count + 1)
      state.apiKeys.set(apiKeyId, { ...found, lastUsedAt: now })
      return true
    },
  }
}

import type {
  ApiKeyId,
  ApiKeyScope,
  MembershipId,
  OrganizationId,
  Role,
} from 'tula-closeline-contract'

/** One API key as the store keeps it, without its hash. */
export type ApiKeyRecord = {
  id: ApiKeyId
  name: string
  /** The first 12 characters of the secret, safe to show. */
  prefix: string
  scopes: ApiKeyScope[]
  roleCeiling: Role
  expiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdByMembershipId: MembershipId
  createdAt: Date
}

/** An API key with the SHA-256 hex of its secret, read only to compare in constant time. */
export type ApiKeyWithHash = ApiKeyRecord & { secretHash: string }

/** What a create writes: the record's fields and the hash, never the secret. */
export type NewApiKey = Omit<ApiKeyRecord, 'lastUsedAt' | 'revokedAt'> & { secretHash: string }

/** A keyset page of the Organization's API keys, newest first. */
export type ApiKeyPageRequest = {
  includeRevoked: boolean
  after?: { createdAt: Date; id: ApiKeyId }
  limit: number
}

/** What the exchange knows about a key from its hash alone, before any Organization is open. */
export type ApiKeyLocation = {
  organizationId: OrganizationId
  apiKeyId: ApiKeyId
}

/** The usage window a call is counted in and the most calls it may hold. */
export type ApiKeyUsageHit = {
  apiKeyId: ApiKeyId
  now: Date
  windowSeconds: number
  limit: number
}

/** The API key methods of an Organization scope. */
export interface ApiKeyStoreScope {
  /** Writes a new key. Call after `lockOrganization`. */
  insertApiKey(key: NewApiKey): Promise<ApiKeyRecord>
  /** One key with its hash, or `null` when it does not exist in this Organization. */
  getApiKeyWithHash(id: ApiKeyId): Promise<ApiKeyWithHash | null>
  /** One key, or `null` when it does not exist in this Organization. */
  getApiKey(id: ApiKeyId): Promise<ApiKeyRecord | null>
  /** One page, at most `limit`, newest first (`created_at` then `id`, both descending). */
  listApiKeys(request: ApiKeyPageRequest): Promise<ApiKeyRecord[]>
  /** Sets `revoked_at` when it is null and returns the key; a revoked key keeps its first time. */
  revokeApiKey(id: ApiKeyId, now: Date): Promise<ApiKeyRecord | null>
  /**
   * Counts one use of the key in the current fixed window. Returns `false`, counting nothing,
   * when the window already holds `limit` uses. On `true` it also stamps `last_used_at`.
   */
  hitApiKeyUsage(hit: ApiKeyUsageHit): Promise<boolean>
}

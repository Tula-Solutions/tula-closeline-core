import { type ApiKey, type ApiKeyId, apiKeyIdSchema, apiKeySchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { ApiKeyRecord } from '~/ports/api-key-store'

/** The path parameters of the revoke route. */
export const apiKeyParamsSchema = z.strictObject({ apiKeyId: apiKeyIdSchema })

/** Smallest and largest year a stored time can have; a position outside it cannot match a row. */
const FIRST_YEAR = 1970
const LAST_YEAR = 9999

/**
 * What an API keys cursor carries: the position the next page starts after (the list is newest
 * first), and nothing else.
 */
export const apiKeyCursorSchema = z.object({
  dir: z.literal('desc'),
  createdAt: z.iso
    .datetime({ offset: true })
    .max(64)
    .refine((text) => {
      const year = new Date(text).getUTCFullYear()
      return year >= FIRST_YEAR && year <= LAST_YEAR
    }, 'the time is outside 1970 to 9999 in UTC'),
  id: apiKeyIdSchema,
})

/** The cursor position of an API key. */
export function toApiKeyCursor(record: ApiKeyRecord): {
  dir: 'desc'
  createdAt: string
  id: ApiKeyId
} {
  return { dir: 'desc', createdAt: record.createdAt.toISOString(), id: record.id }
}

/** The API shape of a key: the contract's schema applied to the record, never the hash. */
export function toApiKeyResponse(record: ApiKeyRecord): ApiKey {
  return apiKeySchema.parse({
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    roleCeiling: record.roleCeiling,
    expiresAt: record.expiresAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    createdByMembershipId: record.createdByMembershipId,
  })
}

import {
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** Describes a failure response in a route's OpenAPI definition with the contract's error body. */
export function errorResponse(description: string) {
  return {
    description,
    content: { 'application/json': { schema: errorBodySchema } },
  }
}

/**
 * Describes a failure response that also carries `Retry-After` (whole seconds), such as
 * `request.idempotency_in_progress` with its `details.retryAfter`.
 */
export function errorResponseWithRetryAfter(description: string) {
  return {
    ...errorResponse(description),
    headers: z.object({
      'Retry-After': z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .meta({ description: 'Whole seconds to wait before trying again.' }),
    }),
  }
}

/**
 * The optional `Idempotency-Key` header of a public `POST` with effects (16 to 128 characters from
 * `A-Za-z0-9_.:-`), described in `description`: a route says what a repeated key does for it.
 */
export function optionalIdempotencyKeyHeader(description: string) {
  return z.object({
    [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: idempotencyKeySchema.optional().meta({ description }),
  })
}

/** The header of a route whose key is claimed in the write's own transaction (the Team routes). */
export const optionalIdempotencyKeyHeaderSchema = optionalIdempotencyKeyHeader(
  'A client-chosen key. The same key with the same request returns the first answer and does ' +
    'nothing again, for 24 hours; the same key with another request is ' +
    'request.idempotency_key_reused (422); the same key while the first request is still ' +
    'running is request.idempotency_in_progress (409, with Retry-After). Without it the call ' +
    'is not protected against being repeated.'
)

/** The `Idempotency-Key` header of a call with effects: 16 to 128 characters from `A-Za-z0-9_.:-`. */
export const idempotencyKeyHeaderSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: idempotencyKeySchema,
})

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

/** The `Idempotency-Key` header of a call with effects: 16 to 128 characters from `A-Za-z0-9_.:-`. */
export const idempotencyKeyHeaderSchema = z.object({
  [IDEMPOTENCY_KEY_HEADER.toLowerCase()]: idempotencyKeySchema,
})

import {
  assessmentIdSchema,
  findingCategorySchema,
  findingIdSchema,
  idempotencyKeySchema,
} from 'tula-closeline-contract'
import { z } from 'zod'

/** The path of one Assessment. */
export const assessmentParamsSchema = z.strictObject({ assessmentId: assessmentIdSchema })

/** The path of one finding of an Assessment. */
export const findingParamsSchema = z.strictObject({
  assessmentId: assessmentIdSchema,
  findingId: findingIdSchema,
})

/** The optional Idempotency-Key of a feedback request. */
export const optionalKeyHeadersSchema = z.object({
  'idempotency-key': idempotencyKeySchema.optional(),
})

/** The position in the Assessment list (cursor input is client-controlled). */
export const assessmentCursorSchema = z.strictObject({
  sort: z.enum(['newest', 'worst_first']),
  rank: z.number().int().min(0).max(3),
  createdAt: z.iso.datetime(),
  id: assessmentIdSchema,
})

/** The position in the weekly rates. */
export const rateCursorSchema = z.strictObject({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  agentKind: z.enum(['inbound', 'outbound']),
  instructionVersion: z.number().int().min(1).nullable(),
  category: findingCategorySchema.nullable().default(null),
  grouped: z.boolean().default(false),
})

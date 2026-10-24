import {
  agentKindSchema,
  type InstructionVersion,
  type InstructionVersionSummary,
  organizationIdSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { InstructionPointerRecord, InstructionVersionRecord } from '~/ports/instruction-store'

/** True when the text has no control character other than tab, newline and carriage return. */
function hasNoControlCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return false
    }
  }
  return true
}

/**
 * The body of a save. The contract's own schema refuses a long text as `request.invalid`; the
 * ticket wants `agent.instruction_too_long`, so the length is checked by the service instead.
 */
export const saveBodySchema = z.strictObject({
  text: z.string().min(1).refine(hasNoControlCharacters, 'Control characters are not allowed.'),
})

/** The path of the routes that name a kind. */
export const kindParamsSchema = z.object({ agentKind: agentKindSchema })

/** The path of the routes that name a kind and a version number. */
export const versionParamsSchema = z.object({
  agentKind: agentKindSchema,
  versionNumber: z.coerce.number().int().min(1).max(2_147_483_647),
})

/**
 * What a save or publish stores for replay: the version's number only. The text can be 20,000
 * characters, past what an idempotency key keeps, so a replay re-reads the version instead.
 */
export const versionRefSchema = z.strictObject({
  agentKind: agentKindSchema,
  number: z.number().int().min(1),
})

/** The cursor of the version list (newest first): the number of the last version on the page. */
export const versionListCursorSchema = z.strictObject({ before: z.number().int().min(1) })

/** The body of the internal read of the published instructions. */
export const internalPublishedRequestSchema = z.strictObject({
  organizationId: organizationIdSchema,
  agentKind: agentKindSchema,
})

/** A stored version as the contract's full version, given the kind's published pointer. */
export function toVersionResponse(
  record: InstructionVersionRecord,
  pointer: InstructionPointerRecord | null
): InstructionVersion {
  const published = pointer?.versionNumber === record.number
  return {
    id: record.id,
    agentKind: record.agentKind,
    number: record.number,
    state: published ? 'published' : 'draft',
    authorMembershipId: record.authorMembershipId,
    createdAt: record.createdAt.toISOString(),
    publishedAt: published && pointer ? pointer.publishedAt.toISOString() : null,
    text: record.text,
  }
}

/** A stored version without its text, for a list. */
export function toSummaryResponse(
  record: InstructionVersionRecord,
  pointer: InstructionPointerRecord | null
): InstructionVersionSummary {
  const { text, ...rest } = toVersionResponse(record, pointer)
  return { ...rest, length: text.length }
}

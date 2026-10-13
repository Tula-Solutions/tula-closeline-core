import {
  createInvitationRequestSchema,
  type Invitation,
  type InvitationId,
  internalAcceptInvitationRequestSchema,
  invitationIdSchema,
  invitationSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { InvitationRecord } from '~/ports/core-store'
import { requestEmailSchema } from './email'

/**
 * The contract's request to invite someone, with the address read by {@link requestEmailSchema}
 * so an internationalised domain is converted before it is validated. Nothing else changes.
 */
export const createInvitationBodySchema = createInvitationRequestSchema.extend({
  email: requestEmailSchema,
})

/** The contract's request to accept an Invitation, with the address read the same way. */
export const acceptInvitationBodySchema = internalAcceptInvitationRequestSchema.extend({
  email: requestEmailSchema,
})

/** Smallest and largest year a stored time can have; a position outside it cannot match a row. */
const FIRST_YEAR = 1970
const LAST_YEAR = 9999

/**
 * Whether a cursor's time, moved to UTC, has a year from 1970 to 9999. Past that range
 * `toISOString()` writes a signed six-digit year, or year 0, which the database refuses; the
 * request is then answered as an invalid cursor instead of failing as a 500.
 */
function isStorableTime(text: string): boolean {
  const year = new Date(text).getUTCFullYear()
  return year >= FIRST_YEAR && year <= LAST_YEAR
}

/**
 * What an Invitations cursor carries: the position the next page starts after, and nothing else.
 * `dir` names the order the position belongs to (the list is newest first). The list was once
 * oldest first with no `dir`; such a cursor fails here and is answered as an invalid cursor
 * instead of being read in the new order.
 */
export const invitationCursorSchema = z.object({
  dir: z.literal('desc'),
  createdAt: z.iso
    .datetime({ offset: true })
    .max(64)
    .refine(isStorableTime, 'the time is outside 1970 to 9999 in UTC'),
  id: invitationIdSchema,
})

/** The cursor position of an Invitation. */
export function toInvitationCursor(record: InvitationRecord): {
  dir: 'desc'
  createdAt: string
  id: InvitationId
} {
  return { dir: 'desc', createdAt: record.createdAt.toISOString(), id: record.id }
}

/** The API shape of an Invitation: the contract's schema applied to the record, never the row. */
export function toInvitationResponse(record: InvitationRecord): Invitation {
  return invitationSchema.parse({
    id: record.id,
    email: record.email,
    role: record.role,
    teamId: record.teamId,
    state: record.state,
    invitedByUserId: record.invitedByUserId,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  })
}

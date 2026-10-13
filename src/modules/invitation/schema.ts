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

/** What an Invitations cursor carries: the position the next page starts after, and nothing else. */
export const invitationCursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }).max(64),
  id: invitationIdSchema,
})

/** The cursor position of an Invitation. */
export function toInvitationCursor(record: InvitationRecord): {
  createdAt: string
  id: InvitationId
} {
  return { createdAt: record.createdAt.toISOString(), id: record.id }
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

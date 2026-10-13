import { createHash, randomBytes } from 'node:crypto'
import { formatId, type InvitationId, type MembershipId } from 'tula-closeline-contract'

/** How long an Invitation can be accepted after it is created: 7 days. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The most pending Invitations one Organization may hold; past it a new one is `rate.limited`. */
export const MAX_PENDING_INVITATIONS = 1000

/** The window the send budget is counted over: 24 hours. */
export const INVITATION_SEND_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * The most Invitations one Organization may create in {@link INVITATION_SEND_WINDOW_MS}, in any
 * state, revoked ones included; past it a new one is `rate.limited`. Revoking frees the pending cap
 * but not this, which is what bounds the mail an Organization can cause.
 */
export const INVITATION_SEND_BUDGET = 2000

/** The size of an Invitation token in bytes: 256 bits, twice the 128 the database requires. */
const TOKEN_BYTES = 32

/** A fresh Invitation token: 32 bytes from the platform's cryptographic generator, base64url. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** The SHA-256 of a token as 64 lowercase hex characters: the only form of it that is stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * The id of the Membership that accepting an Invitation creates, derived from the Invitation's id
 * (`inv_<hex>` gives `mem_<hex>`). An Invitation is accepted once, so the id is unique, and it lets
 * a retry of the accept recognise the Membership its first run made without any column that
 * records who accepted.
 */
export function membershipIdFor(invitationId: InvitationId): MembershipId {
  return formatId('mem', invitationId.slice('inv_'.length))
}

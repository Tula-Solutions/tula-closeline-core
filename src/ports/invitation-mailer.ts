import type { InvitableRole } from 'tula-closeline-contract'

/**
 * What an adapter needs to tell someone they are invited. The `token` and the `link` (which
 * carries the token) are as secret as a password: an adapter must never log either, put either in
 * an error message or keep either beyond the send.
 */
export type InvitationMessage = {
  /** Where to send it: the invitee's folded address. */
  email: string
  /** The role on offer. */
  role: InvitableRole
  /** The inviting Organization's name, untrusted text: escape it wherever it is interpolated. */
  organizationName: string
  /** The raw invitation token. */
  token: string
  /** The link the recipient follows, built once by `invitationLink` so every adapter sends the same one. */
  link: string
  /** When the invitation stops being acceptable. */
  expiresAt: Date
}

/** Hands an invitation message to whatever delivers email. */
export interface InvitationMailer {
  /**
   * Hands one message over. Resolves once the mail system has accepted it; rejects when it did not.
   * `signal` aborts when the caller's time has run out. An adapter that retries does so a bounded
   * number of times with jitter, inside that time, and never sends twice once a send succeeded.
   */
  deliver(message: InvitationMessage, signal: AbortSignal): Promise<void>
}

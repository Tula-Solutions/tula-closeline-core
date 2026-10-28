import type { OrganizationId } from 'tula-closeline-contract'

/** One Deal and its Outcome, as the Playbook learns it from a CRM. */
export type PlaybookDeal = {
  organizationId: OrganizationId
  /** The Playbook's customer Deal id; stable for one CRM record, so a repeat updates it. */
  dealId: string
  name: string
  outcome: 'won' | 'lost' | 'open'
  /** The day the Deal closed (`YYYY-MM-DD`), or `null` while it is open. */
  closedAt: string | null
  amount: number | null
  currency: string | null
  /** Derived from provider, object and version: a repeat of the same version is a no-op. */
  idempotencyKey: string
}

/** The Playbook refused this Deal for good; trying again will not help. */
export class PlaybookRejectedError extends Error {}

/** The Playbook could not be reached or did not answer in time; trying again may help. */
export class PlaybookUnavailableError extends Error {}

/**
 * Where Deals and their Outcomes go to be learned from. It throws {@link PlaybookRejectedError} for
 * a Deal the Playbook will never accept and {@link PlaybookUnavailableError} for a failure worth
 * retrying; a repeat with the same idempotency key has no further effect.
 */
export interface PlaybookDeals {
  /** Sends one Deal; aborts when `signal` does. */
  recordDeal(deal: PlaybookDeal, signal: AbortSignal): Promise<void>
}

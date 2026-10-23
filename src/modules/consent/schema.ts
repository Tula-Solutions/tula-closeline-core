import { consentEventSchema, prospectConsentSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/**
 * A ledger event as core serialises it: the contract's fields without its cross-field check. That
 * check requires a withdrawal's source to be outside the grant sources, but `manual` and `crm` are
 * in both lists, so it refuses every `manual` withdrawal, the one source the withdrawal route
 * sets. The database's own constraints (not the contract's check) still guard every row.
 */
export const ledgerEventSchema = z.object(consentEventSchema.shape)

/** The answer of the record and withdraw routes: the new events and the Prospect's consent now. */
export const recordedConsentResponseSchema = z.object({
  events: z.array(ledgerEventSchema),
  consent: prospectConsentSchema,
})

/** The answer of the record and withdraw routes. */
export type RecordedConsentResponse = z.infer<typeof recordedConsentResponseSchema>

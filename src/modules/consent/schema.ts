import { consentEventSchema, prospectConsentSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The answer of the record and withdraw routes: the new events and the Prospect's consent now. */
export const recordedConsentResponseSchema = z.object({
  events: z.array(consentEventSchema),
  consent: prospectConsentSchema,
})

/** The answer of the record and withdraw routes. */
export type RecordedConsentResponse = z.infer<typeof recordedConsentResponseSchema>

/** The cursor of the consent event and evidence pages: the ledger sequence of the last event seen. */
export const consentCursorSchema = z.strictObject({ seq: z.number().int().positive() })

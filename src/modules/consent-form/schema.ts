import {
  CONSENT_ADMIN_ROLES,
  type ConsentForm,
  consentFormIdSchema,
  consentFormSchema,
  type Role,
  timestampSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { ConsentFormRecord } from '~/ports/core-store'

/** The cursor of a list of forms: the creation time and the id of the last item. */
export const consentFormCursorSchema = z.strictObject({
  at: timestampSchema,
  id: consentFormIdSchema,
})

/**
 * The API shape of a form. The link token is the secret that opens the public form, so only an
 * Owner or Admin sees it; everyone else, and every draft, gets `null`.
 */
export function toFormResponse(record: ConsentFormRecord, role: Role): ConsentForm {
  const mayReadToken = (CONSENT_ADMIN_ROLES as readonly Role[]).includes(role)
  return consentFormSchema.parse({
    id: record.id,
    wordingId: record.wordingId,
    name: record.name,
    channels: record.channels,
    state: record.state,
    token: mayReadToken ? record.token : null,
    createdAt: record.createdAt.toISOString(),
    createdByUserId: record.createdByUserId,
    publishedAt: record.publishedAt?.toISOString() ?? null,
    closedAt: record.closedAt?.toISOString() ?? null,
  })
}

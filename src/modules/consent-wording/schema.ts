import {
  type ConsentWording,
  consentWordingIdSchema,
  consentWordingSchema,
  timestampSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { ConsentWordingDetail } from '~/ports/core-store'

/** The cursor of a list of wordings: the creation time and the id of the last item. */
export const consentWordingCursorSchema = z.strictObject({
  at: timestampSchema,
  id: consentWordingIdSchema,
})

/** The API shape of a wording: the record through the contract's schema, which refuses an inconsistent one. */
export function toWordingResponse(record: ConsentWordingDetail): ConsentWording {
  return consentWordingSchema.parse({
    id: record.id,
    version: record.version,
    text: record.text,
    channels: record.channels,
    locked: record.locked,
    supersedesId: record.supersedesId,
    createdAt: record.createdAt.toISOString(),
    createdByUserId: record.createdByUserId,
  })
}

import {
  contactCheckIdSchema,
  type SuppressionEntry,
  suppressionEntryIdSchema,
  suppressionEntrySchema,
  timestampSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { SuppressionRecord } from '~/ports/core-store'

/** The cursor of a Suppression list: the sort time (creation, or removal for removed entries) and the id of the last item. */
export const suppressionCursorSchema = z.strictObject({
  at: timestampSchema,
  id: suppressionEntryIdSchema,
})

/** The cursor of the Contact Check log: the check time and the id of the last item. */
export const contactCheckCursorSchema = z.strictObject({
  at: timestampSchema,
  id: contactCheckIdSchema,
})

/** The API shape of a Suppression entry: the record through the contract's schema, which refuses an inconsistent one. */
export function toSuppressionResponse(record: SuppressionRecord): SuppressionEntry {
  return suppressionEntrySchema.parse({
    id: record.id,
    addressKind: record.addressKind,
    maskedAddress: record.maskedAddress,
    reason: record.reason,
    channel: record.channel,
    sourceRef: record.sourceRef,
    addedByUserId: record.addedByUserId,
    removable: record.removable,
    createdAt: record.createdAt.toISOString(),
    removedAt: record.removedAt?.toISOString() ?? null,
    removedByUserId: record.removedByUserId,
    removalReason: record.removalReason,
  })
}

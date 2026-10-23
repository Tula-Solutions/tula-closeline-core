import { timestampSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The cursor of the audit list (newest first): the time and sequence of the last event on the page. */
export const auditListCursorSchema = z.strictObject({
  at: timestampSchema,
  sequence: z.number().int().min(1),
})

/** The cursor of the audit download (oldest first): the sequence of the last row on the page. */
export const auditCsvCursorSchema = z.strictObject({
  sequence: z.number().int().min(1),
  /** The last sequence when the download began, so the events it records itself are not paged. */
  upTo: z.number().int().min(1),
})

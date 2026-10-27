import { z } from 'zod'

/** The position in a series page: the group key of the last line served (cursor input is client-controlled). */
export const seriesCursorSchema = z.strictObject({ key: z.string().max(64) })

/** The last touch of a Deal's page: its time and id (cursor input is client-controlled). */
export const touchCursorSchema = z.strictObject({ at: z.iso.datetime(), id: z.string().max(64) })

/** The last row of a source-performance page (cursor input is client-controlled). */
export const sourceCursorSchema = z.strictObject({
  touched: z.number().int().min(0),
  kind: z.enum(['moment', 'document']),
  key: z.string().max(512),
})

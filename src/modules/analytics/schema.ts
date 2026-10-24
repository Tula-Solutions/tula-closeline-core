import { z } from 'zod'

/** The position in a series page: the group key of the last line served (cursor input is client-controlled). */
export const seriesCursorSchema = z.strictObject({ key: z.string().max(64) })

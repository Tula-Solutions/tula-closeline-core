import { exportJobIdSchema, timestampSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The path of the routes that read one export. */
export const exportParamsSchema = z.strictObject({ exportId: exportJobIdSchema })

/** The cursor of the list of exports: the request time and the id of the last item. */
export const exportCursorSchema = z.strictObject({ at: timestampSchema, id: exportJobIdSchema })

/** The path of the public download route: the signed link token. */
export const downloadTokenParamsSchema = z.strictObject({
  token: z
    .string()
    .min(20)
    .max(400)
    .regex(/^[A-Za-z0-9_-]+$/),
})

/** The most files one page of the public download lists. */
export const MAX_DOWNLOAD_PAGE_FILES = 100

/** The query of the public download route. */
export const downloadQuerySchema = z.object({
  cursor: z.string().min(1).max(600).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_DOWNLOAD_PAGE_FILES).default(50),
})

/** One file of an export, with a short-lived link that reads it. */
export const exportFileSchema = z.strictObject({
  key: z.string(),
  bytes: z.number().int().min(0),
  url: z.string(),
  expiresAt: timestampSchema,
})

/** One page of the files of an export. */
export const exportFilePageSchema = z.strictObject({
  items: z.array(exportFileSchema),
  nextCursor: z.string().nullable(),
})

/** One page of the files of an export. */
export type ExportFilePage = z.infer<typeof exportFilePageSchema>

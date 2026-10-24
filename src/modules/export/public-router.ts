import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { ERRORS, EXPORT_ERRORS, EXPORT_ROUTES } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { exactOriginCors } from '~/http/cors'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import type { AppEnv } from '~/http/types'
import { downloadQuerySchema, downloadTokenParamsSchema, exportFilePageSchema } from './schema'
import * as Exports from './service'

const files = createRoute({
  method: 'get',
  path: '/v1/public/export-downloads/{token}',
  tags: ['export'],
  summary: 'List the files of an export by its download link',
  description:
    `${EXPORT_ROUTES.createExportDownload.description} The link token is the only credential: ` +
    'this lists the export files, each with a short-lived URL to fetch it from.',
  request: { params: downloadTokenParamsSchema, query: downloadQuerySchema },
  responses: {
    200: {
      description: 'One page of the export files.',
      content: { 'application/json': { schema: exportFilePageSchema } },
    },
    400: errorResponse('request.invalid: the query is not valid.'),
    404: errorResponse('export.not_found: the link does not work.'),
    410: errorResponse('export.expired: the link has expired.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The public export download route: no access token, only the signed link token in the path. A
 * token that is malformed is the same `export.not_found` as one that is tampered or for an export
 * that is gone, so a probe learns nothing from the shape.
 */
export function createExportPublicRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (result.success) {
        return
      }
      if (result.target === 'param') {
        throw domainError(EXPORT_ERRORS['export.not_found'])
      }
      throw new AppError({
        code: ERRORS['request.invalid'].code,
        status: ERRORS['request.invalid'].status,
        message: ERRORS['request.invalid'].message,
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
        cause: result.error,
      })
    },
  })

  router.use(
    '/v1/public/export-downloads/*',
    exactOriginCors(new URL(container.env.PORTAL_BASE_URL).origin)
  )

  router.openapi(files, async (c) => {
    const query = c.req.valid('query')
    return c.json(
      await Exports.readPublicDownload(container, {
        token: c.req.valid('param').token,
        cursor: query.cursor,
        limit: query.limit,
      }),
      200
    )
  })

  return router
}

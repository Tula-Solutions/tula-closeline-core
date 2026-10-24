import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  createExportRequestSchema,
  EXPORT_ROUTES,
  exportDownloadSchema,
  exportJobSchema,
  listExportsQuerySchema,
  listExportsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  idempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { exportParamsSchema } from './schema'
import * as Exports from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const create = createRoute({
  method: 'post',
  path: '/exports',
  tags: ['export'],
  summary: 'Request an export of the Organization data',
  description: EXPORT_ROUTES.createExport.description,
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createExportRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: exportJobSchema } },
    },
    202: {
      description: 'The export is queued; read it to follow its progress.',
      content: { 'application/json': { schema: exportJobSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    409: errorResponseWithRetryAfter(
      'export.already_running: another export is queued or running. Or ' +
        'request.idempotency_in_progress: the first request with this Idempotency-Key is still running.'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    429: errorResponse('export.daily_limit: two exports were already requested in 24 hours.'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the export could not be queued; request it again.'),
  },
})

const list = createRoute({
  method: 'get',
  path: '/exports',
  tags: ['export'],
  summary: 'List exports',
  description: EXPORT_ROUTES.listExports.description,
  security,
  request: { query: listExportsQuerySchema },
  responses: {
    200: {
      description: 'One page of exports, newest first.',
      content: { 'application/json': { schema: listExportsResponseSchema } },
    },
    400: errorResponse('The request is not valid, or the cursor is not one this route issued.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/exports/{exportId}',
  tags: ['export'],
  summary: 'Read an export',
  description: EXPORT_ROUTES.getExport.description,
  security,
  request: { params: exportParamsSchema },
  responses: {
    200: {
      description: 'The export and the state of each part.',
      content: { 'application/json': { schema: exportJobSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('export.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const download = createRoute({
  method: 'post',
  path: '/exports/{exportId}/download-links',
  tags: ['export'],
  summary: 'Get the download link of a ready export',
  description: EXPORT_ROUTES.createExportDownload.description,
  security,
  request: { params: exportParamsSchema, headers: idempotencyKeyHeaderSchema },
  responses: {
    200: {
      description: 'The first link, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: exportDownloadSchema } },
    },
    201: {
      description: 'The link, valid for 24 hours after the export finished.',
      content: { 'application/json': { schema: exportDownloadSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('export.not_found, or organization.not_found'),
    409: errorResponseWithRetryAfter(
      'export.not_ready: the export is not finished. Or request.idempotency_in_progress.'
    ),
    410: errorResponse('export.expired, or organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The authenticated export routes: request an export, follow it, and get its download link. Owner
 * and Admin only. The files themselves are read through the public download route.
 */
export function createExportRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(create, async (c) => {
    const answer = await Exports.createExport(container, callerOf(c), c.req.valid('json'), {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.replayed ? 200 : answer.status)
  })

  router.openapi(list, async (c) => {
    return c.json(await Exports.listExports(container, callerOf(c), c.req.valid('query')), 200)
  })

  router.openapi(get, async (c) => {
    return c.json(
      await Exports.getExport(container, callerOf(c), c.req.valid('param').exportId),
      200
    )
  })

  router.openapi(download, async (c) => {
    const answer = await Exports.createExportDownload(
      container,
      callerOf(c),
      c.req.valid('param').exportId,
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.replayed ? 200 : answer.status)
  })

  return router
}

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CRM_ROUTES,
  crmConnectionStatusSchema,
  crmProviderParamsSchema,
  listCrmConnectionsQuerySchema,
  listCrmConnectionsResponseSchema,
  publicApiExtensions,
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
import * as Crm from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/crm/connections',
  ...publicApiExtensions(CRM_ROUTES.listCrmConnections),
  tags: ['crm'],
  summary: 'List the CRM connections',
  description:
    "Owner, Admin and Manager. The Organization's connections, at most one per provider, by " +
    'cursor and limit (at most 100). No token is ever returned.',
  security,
  request: { query: listCrmConnectionsQuerySchema },
  responses: {
    200: {
      description: 'One page of connections.',
      content: { 'application/json': { schema: listCrmConnectionsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/crm/connections/{provider}',
  ...publicApiExtensions(CRM_ROUTES.getCrmConnection),
  tags: ['crm'],
  summary: 'Get the status of a CRM connection',
  description:
    'Owner, Admin and Manager. `not_connected` is a state of the answer, not an error. ' +
    'No token is ever returned.',
  security,
  request: { params: crmProviderParamsSchema },
  responses: {
    200: {
      description: 'The status of the provider for the Organization.',
      content: { 'application/json': { schema: crmConnectionStatusSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const disconnect = createRoute({
  method: 'delete',
  path: '/crm/connections/{provider}',
  ...publicApiExtensions(CRM_ROUTES.disconnectCrm),
  tags: ['crm'],
  summary: 'Disconnect a CRM',
  description:
    'Owner and Admin. Deletes the stored tokens with the connection and publishes ' +
    '`crm.disconnected`. A provider with no connection is `crm.not_connected`. Requires an ' +
    '`Idempotency-Key` header: a repeat with the same key returns the first 204.',
  security,
  request: { headers: idempotencyKeyHeaderSchema, params: crmProviderParamsSchema },
  responses: {
    204: { description: 'The connection and its tokens are deleted.' },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('crm.not_connected, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
        'running (see Retry-After and details.retryAfter, in seconds).'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The CRM connections of the caller's Organization. Mounted behind the access-token middleware. */
export function createCrmRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Crm.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(await Crm.status(container, callerOf(c), c.req.valid('param').provider), 200)
  )

  router.openapi(disconnect, async (c) => {
    await Crm.disconnect(container, callerOf(c), c.req.valid('param').provider, {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.body(null, 204)
  })

  return router
}

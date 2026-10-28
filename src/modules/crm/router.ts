import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CRM_ROUTES,
  crmAuthorisationRequestSchema,
  crmAuthorisationSchema,
  crmConnectionStatusSchema,
  crmProviderParamsSchema,
  listCrmConnectionsQuerySchema,
  listCrmConnectionsResponseSchema,
  publicApiExtensions,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  idempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Authorisation from './authorisation'
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

/** The portal's return from the CRM sign-in: the `code` and `state` the CRM put on the redirect. */
const crmCompletionRequestSchema = z.strictObject({
  code: z.string().min(1).max(2_048),
  state: z.string().min(1).max(2_048),
})

const completeRoute = createRoute({
  method: 'post',
  path: '/crm/connections/{provider}/completions',
  tags: ['crm'],
  summary: 'Finish connecting a CRM',
  description:
    'Owner and Admin. The portal sends the `code` and `state` it was given when the CRM sent the ' +
    'Admin back to its Integrations page. The `state` must have been made for this same caller; ' +
    'anyone else, an expired or tampered state, a refused code or a CRM account another ' +
    'Organization holds is one generic `crm.authorisation_failed`. The code is single use.',
  security,
  request: {
    params: crmProviderParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: crmCompletionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The connection, now connected.',
      content: { 'application/json': { schema: crmConnectionStatusSchema } },
    },
    400: errorResponse('crm.authorisation_failed, or the request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const authorise = createRoute({
  method: 'post',
  path: '/crm/connections/{provider}/authorisations',
  ...publicApiExtensions(CRM_ROUTES.startCrmAuthorisation),
  tags: ['crm'],
  summary: 'Start connecting a CRM',
  description:
    "Owner and Admin. Answers the CRM's sign-in address with a state that expires in ten " +
    "minutes. Read scopes only, unless `writeBack` is set. The redirect address is the portal's Integrations page, which finishes through the completions route. " +
    'Requires an `Idempotency-Key` header: a repeat returns the first answer with 200.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    params: crmProviderParamsSchema,
    body: {
      required: false,
      content: { 'application/json': { schema: crmAuthorisationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first answer for this Idempotency-Key.',
      content: { 'application/json': { schema: crmAuthorisationSchema } },
    },
    201: {
      description: 'Where to send the Admin to sign in at the CRM.',
      content: { 'application/json': { schema: crmAuthorisationSchema } },
    },
    400: errorResponse(
      'crm.authorisation_failed: the provider is not configured, or the request is not valid.'
    ),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
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

  router.openapi(authorise, async (c) => {
    const answer = await Authorisation.start(
      container,
      callerOf(c),
      c.req.valid('param').provider,
      { writeBack: c.req.valid('json')?.writeBack ?? false },
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.replayed ? 200 : 201)
  })

  router.openapi(completeRoute, async (c) =>
    c.json(
      await Authorisation.complete(
        container,
        callerOf(c),
        c.req.valid('param').provider,
        c.req.valid('json'),
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  return router
}

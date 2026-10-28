import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CRM_ROUTES,
  crmAuthorisationRequestSchema,
  crmAuthorisationSchema,
  crmConnectionStatusSchema,
  crmListRunsQuerySchema,
  crmProviderParamsSchema,
  crmSetStageMappingRequestSchema,
  crmStageMappingSchema,
  crmStartRunRequestSchema,
  crmSyncPreviewSchema,
  crmSyncRunIdSchema,
  crmSyncRunSchema,
  listCrmConnectionsQuerySchema,
  listCrmConnectionsResponseSchema,
  listCrmStagesQuerySchema,
  listCrmStagesResponseSchema,
  listCrmSyncRunsResponseSchema,
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
import * as Sync from './sync'

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

const runParamsSchema = z.strictObject({
  provider: crmProviderParamsSchema.shape.provider,
  runId: crmSyncRunIdSchema,
})

const KEY_ERRORS = {
  409: errorResponseWithRetryAfter(
    'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
      'running (see Retry-After and details.retryAfter, in seconds).'
  ),
  422: errorResponse(
    'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
  ),
} as const

const COMMON_ERRORS = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden'),
  404: errorResponse('crm.not_connected, request.not_found, or organization.not_found.'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
} as const

const getMapping = createRoute({
  method: 'get',
  path: '/crm/connections/{provider}/stage-mapping',
  ...publicApiExtensions(CRM_ROUTES.getCrmStageMapping),
  tags: ['crm'],
  summary: 'Get the Stage mapping',
  description:
    'Owner, Admin and Manager. Which CRM deal stages mean won, lost or open, and whether it is confirmed.',
  security,
  request: { params: crmProviderParamsSchema },
  responses: {
    200: {
      description: 'The Stage mapping.',
      content: { 'application/json': { schema: crmStageMappingSchema } },
    },
    ...COMMON_ERRORS,
  },
})

const setMapping = createRoute({
  method: 'put',
  path: '/crm/connections/{provider}/stage-mapping',
  ...publicApiExtensions(CRM_ROUTES.setCrmStageMapping),
  tags: ['crm'],
  summary: 'Confirm the Stage mapping',
  description:
    'Owner and Admin. Replaces the whole mapping; saving it is the confirmation. Requires an ' +
    '`Idempotency-Key` header.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    params: crmProviderParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: crmSetStageMappingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The mapping, now confirmed.',
      content: { 'application/json': { schema: crmStageMappingSchema } },
    },
    ...COMMON_ERRORS,
    ...KEY_ERRORS,
  },
})

const listStages = createRoute({
  method: 'get',
  path: '/crm/connections/{provider}/stages',
  ...publicApiExtensions(CRM_ROUTES.listCrmStages),
  tags: ['crm'],
  summary: 'List the CRM deal stages',
  description:
    'Owner and Admin. Read live from the CRM with a timeout. Labels are untrusted text from the CRM.',
  security,
  request: { params: crmProviderParamsSchema, query: listCrmStagesQuerySchema },
  responses: {
    200: {
      description: 'One page of stages.',
      content: { 'application/json': { schema: listCrmStagesResponseSchema } },
    },
    ...COMMON_ERRORS,
    409: errorResponse('crm.needs_reconnect'),
    429: errorResponse('crm.rate_limited'),
  },
})

const preview = createRoute({
  method: 'post',
  path: '/crm/connections/{provider}/sync-previews',
  ...publicApiExtensions(CRM_ROUTES.previewCrmSync),
  tags: ['crm'],
  summary: 'Preview a first load',
  description:
    'Owner and Admin. Counts the Deals a first load would pull. Nothing is written and no run is recorded.',
  security,
  request: {
    params: crmProviderParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: crmStartRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The counts.',
      content: { 'application/json': { schema: crmSyncPreviewSchema } },
    },
    ...COMMON_ERRORS,
    409: errorResponse('crm.mapping_incomplete, or crm.needs_reconnect.'),
    429: errorResponse('crm.rate_limited'),
  },
})

const startRun = createRoute({
  method: 'post',
  path: '/crm/connections/{provider}/sync-runs',
  ...publicApiExtensions(CRM_ROUTES.startCrmSync),
  tags: ['crm'],
  summary: 'Start a sync run',
  description:
    'Owner and Admin. Queues a Deal run and answers 202; no CRM page is pulled on the request. ' +
    'A run already queued or running, or a replay of the key, answers 200. Requires an ' +
    '`Idempotency-Key` header.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    params: crmProviderParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: crmStartRunRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The run already in progress, or the first answer for this key.',
      content: { 'application/json': { schema: crmSyncRunSchema } },
    },
    202: {
      description: 'The run, queued.',
      content: { 'application/json': { schema: crmSyncRunSchema } },
    },
    ...COMMON_ERRORS,
    409: errorResponseWithRetryAfter(
      'crm.mapping_incomplete, crm.needs_reconnect, or request.idempotency_in_progress.'
    ),
    422: KEY_ERRORS[422],
    429: errorResponse('crm.rate_limited'),
  },
})

const listRuns = createRoute({
  method: 'get',
  path: '/crm/connections/{provider}/sync-runs',
  ...publicApiExtensions(CRM_ROUTES.listCrmSyncRuns),
  tags: ['crm'],
  summary: 'List the sync runs',
  description: 'Owner, Admin and Manager. Newest first, by cursor and limit (at most 100).',
  security,
  request: { params: crmProviderParamsSchema, query: crmListRunsQuerySchema },
  responses: {
    200: {
      description: 'One page of runs.',
      content: { 'application/json': { schema: listCrmSyncRunsResponseSchema } },
    },
    ...COMMON_ERRORS,
  },
})

const getRun = createRoute({
  method: 'get',
  path: '/crm/connections/{provider}/sync-runs/{runId}',
  ...publicApiExtensions(CRM_ROUTES.getCrmSyncRun),
  tags: ['crm'],
  summary: 'Get a sync run',
  description: 'Owner, Admin and Manager. A run of another Organization is request.not_found.',
  security,
  request: { params: runParamsSchema },
  responses: {
    200: {
      description: 'The run and its report.',
      content: { 'application/json': { schema: crmSyncRunSchema } },
    },
    ...COMMON_ERRORS,
  },
})

const retryRun = createRoute({
  method: 'post',
  path: '/crm/connections/{provider}/sync-runs/{runId}/retries',
  ...publicApiExtensions(CRM_ROUTES.retryCrmSyncRun),
  tags: ['crm'],
  summary: 'Retry a failed sync run',
  description:
    'Owner and Admin. Starts a new run that resumes from the failed one. Only a failed run can ' +
    'be retried (request.conflict). Requires an `Idempotency-Key` header.',
  security,
  request: { headers: idempotencyKeyHeaderSchema, params: runParamsSchema },
  responses: {
    200: {
      description: 'The run already in progress, or the first answer for this key.',
      content: { 'application/json': { schema: crmSyncRunSchema } },
    },
    202: {
      description: 'The new run, queued.',
      content: { 'application/json': { schema: crmSyncRunSchema } },
    },
    ...COMMON_ERRORS,
    409: errorResponseWithRetryAfter(
      'request.conflict, crm.mapping_incomplete, crm.needs_reconnect, or request.idempotency_in_progress.'
    ),
    422: KEY_ERRORS[422],
    429: errorResponse('crm.rate_limited'),
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

  router.openapi(getMapping, async (c) =>
    c.json(await Sync.getMapping(container, callerOf(c), c.req.valid('param').provider), 200)
  )

  router.openapi(setMapping, async (c) => {
    const answer = await Sync.setMapping(
      container,
      callerOf(c),
      c.req.valid('param').provider,
      c.req.valid('json').entries,
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, 200)
  })

  router.openapi(listStages, async (c) =>
    c.json(
      await Sync.listStages(
        container,
        callerOf(c),
        c.req.valid('param').provider,
        c.req.valid('query')
      ),
      200
    )
  )

  router.openapi(preview, async (c) =>
    c.json(
      await Sync.preview(
        container,
        callerOf(c),
        c.req.valid('param').provider,
        c.req.valid('json').objectKind
      ),
      200
    )
  )

  router.openapi(startRun, async (c) => {
    const answer = await Sync.start(
      container,
      callerOf(c),
      c.req.valid('param').provider,
      c.req.valid('json').objectKind,
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return answer.replayed || answer.existing ? c.json(answer.body, 200) : c.json(answer.body, 202)
  })

  router.openapi(listRuns, async (c) =>
    c.json(
      await Sync.listRuns(
        container,
        callerOf(c),
        c.req.valid('param').provider,
        c.req.valid('query')
      ),
      200
    )
  )

  router.openapi(getRun, async (c) => {
    const { provider, runId } = c.req.valid('param')
    return c.json(await Sync.getRun(container, callerOf(c), provider, runId), 200)
  })

  router.openapi(retryRun, async (c) => {
    const { provider, runId } = c.req.valid('param')
    const answer = await Sync.retry(container, callerOf(c), provider, runId, {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return answer.replayed || answer.existing ? c.json(answer.body, 200) : c.json(answer.body, 202)
  })

  return router
}

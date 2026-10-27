import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  AGENT_CONTROL_ROUTES,
  agentControlSchema,
  agentsPausedSchema,
  listAgentControlsQuerySchema,
  listAgentControlsResponseSchema,
  publicApiExtensions,
  setAgentControlRequestSchema,
  setAgentsPausedRequestSchema,
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
import { controlParamsSchema } from './schema'
import * as Controls from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden'),
  404: errorResponse('organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
} as const

const writeErrors = {
  ...common,
  409: errorResponseWithRetryAfter(
    'request.idempotency_in_progress: the first request with this Idempotency-Key is still running.'
  ),
  422: errorResponse(
    'agent.settings_invalid, or request.idempotency_key_reused: the key was used for a different request.'
  ),
} as const

const list = createRoute({
  method: 'get',
  path: '/agent-controls',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.listAgentControls),
  tags: ['agent'],
  summary: 'List Agent controls',
  description: AGENT_CONTROL_ROUTES.listAgentControls.description,
  security,
  request: { query: listAgentControlsQuerySchema },
  responses: {
    200: {
      description: 'One page of the stored controls, by Agent kind then channel.',
      content: { 'application/json': { schema: listAgentControlsResponseSchema } },
    },
    ...common,
  },
})

const set = createRoute({
  method: 'put',
  path: '/agent-controls/{agentKind}/{channel}',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.setAgentControl),
  tags: ['agent'],
  summary: 'Set the controls of an Agent kind on a channel',
  description: AGENT_CONTROL_ROUTES.setAgentControl.description,
  security,
  request: {
    params: controlParamsSchema,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setAgentControlRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The controls now stored, or the first result for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: agentControlSchema } },
    },
    ...writeErrors,
  },
})

const getPaused = createRoute({
  method: 'get',
  path: '/agent-controls/organization-pause',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.getAgentsPaused),
  tags: ['agent'],
  summary: 'Read whether the Agents are paused',
  description: AGENT_CONTROL_ROUTES.getAgentsPaused.description,
  security,
  responses: {
    200: {
      description: 'Whether every Agent of the Organization is paused.',
      content: { 'application/json': { schema: agentsPausedSchema } },
    },
    ...common,
  },
})

const setPaused = createRoute({
  method: 'put',
  path: '/agent-controls/organization-pause',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.setAgentsPaused),
  tags: ['agent'],
  summary: 'Pause or resume every Agent',
  description: AGENT_CONTROL_ROUTES.setAgentsPaused.description,
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setAgentsPausedRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The pause state now stored.',
      content: { 'application/json': { schema: agentsPausedSchema } },
    },
    ...writeErrors,
  },
})

/** The Agent controls and the Organization pause switch. Mounted behind the access-token middleware. */
export function createAgentControlRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Controls.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getPaused, async (c) =>
    c.json(await Controls.getPaused(container, callerOf(c)), 200)
  )
  router.openapi(set, async (c) => {
    const answer = await Controls.setControl(
      container,
      callerOf(c),
      c.req.valid('param'),
      c.req.valid('json'),
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, 200)
  })
  router.openapi(setPaused, async (c) => {
    const answer = await Controls.setPaused(container, callerOf(c), c.req.valid('json').paused, {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, 200)
  })

  return router
}

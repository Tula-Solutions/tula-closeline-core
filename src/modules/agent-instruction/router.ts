import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  AGENT_CONTROL_ROUTES,
  diffInstructionVersionsQuerySchema,
  instructionDiffSchema,
  instructionVersionSchema,
  listInstructionVersionsQuerySchema,
  listInstructionVersionsResponseSchema,
  publicApiExtensions,
  publishedInstructionsSchema,
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
import { kindParamsSchema, saveBodySchema, versionParamsSchema } from './schema'
import * as Instructions from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden'),
  404: errorResponse('organization.not_found, or agent.version_not_found.'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
} as const

const writeErrors = {
  ...common,
  409: errorResponseWithRetryAfter(
    'request.idempotency_in_progress: the first request with this Idempotency-Key is still running.'
  ),
  422: errorResponse(
    'agent.instruction_too_long, or request.idempotency_key_reused: the key was used for a ' +
      'different request.'
  ),
} as const

const versionBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: instructionVersionSchema } },
})

const list = createRoute({
  method: 'get',
  path: '/agent-instructions/{agentKind}/versions',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.listInstructionVersions),
  tags: ['agent'],
  summary: 'List instruction versions',
  description: AGENT_CONTROL_ROUTES.listInstructionVersions.description,
  security,
  request: { params: kindParamsSchema, query: listInstructionVersionsQuerySchema },
  responses: {
    200: {
      description: 'One page of versions without their text, newest first.',
      content: { 'application/json': { schema: listInstructionVersionsResponseSchema } },
    },
    ...common,
  },
})

const getPublished = createRoute({
  method: 'get',
  path: '/agent-instructions/{agentKind}/published',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.getPublishedInstructions),
  tags: ['agent'],
  summary: 'Read the published instructions',
  description: AGENT_CONTROL_ROUTES.getPublishedInstructions.description,
  security,
  request: { params: kindParamsSchema },
  responses: {
    200: {
      description: 'The published version, or version: null.',
      content: { 'application/json': { schema: publishedInstructionsSchema } },
    },
    ...common,
  },
})

const diff = createRoute({
  method: 'get',
  path: '/agent-instructions/{agentKind}/diff',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.diffInstructionVersions),
  tags: ['agent'],
  summary: 'Compare two instruction versions',
  description: AGENT_CONTROL_ROUTES.diffInstructionVersions.description,
  security,
  request: { params: kindParamsSchema, query: diffInstructionVersionsQuerySchema },
  responses: {
    200: {
      description: 'The lines of the later version against the earlier.',
      content: { 'application/json': { schema: instructionDiffSchema } },
    },
    ...common,
  },
})

const get = createRoute({
  method: 'get',
  path: '/agent-instructions/{agentKind}/versions/{versionNumber}',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.getInstructionVersion),
  tags: ['agent'],
  summary: 'Read one instruction version',
  description: AGENT_CONTROL_ROUTES.getInstructionVersion.description,
  security,
  request: { params: versionParamsSchema },
  responses: { 200: versionBody('The version with its text.'), ...common },
})

const save = createRoute({
  method: 'post',
  path: '/agent-instructions/{agentKind}/versions',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.saveInstructionVersion),
  tags: ['agent'],
  summary: 'Save instructions as a new draft version',
  description: AGENT_CONTROL_ROUTES.saveInstructionVersion.description,
  security,
  request: {
    params: kindParamsSchema,
    headers: idempotencyKeyHeaderSchema,
    body: { required: true, content: { 'application/json': { schema: saveBodySchema } } },
  },
  responses: {
    200: versionBody('The first result, for a repeated Idempotency-Key.'),
    201: versionBody('The new draft version.'),
    ...writeErrors,
  },
})

const publish = createRoute({
  method: 'post',
  path: '/agent-instructions/{agentKind}/versions/{versionNumber}/publish',
  ...publicApiExtensions(AGENT_CONTROL_ROUTES.publishInstructionVersion),
  tags: ['agent'],
  summary: 'Publish an instruction version, or roll back to an earlier one',
  description: AGENT_CONTROL_ROUTES.publishInstructionVersion.description,
  security,
  request: { params: versionParamsSchema, headers: idempotencyKeyHeaderSchema },
  responses: { 200: versionBody('The version, now published.'), ...writeErrors },
})

/** The versioned Agent instructions of the caller's Organization. Mounted behind the access-token middleware. */
export function createAgentInstructionRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(
      await Instructions.list(
        container,
        callerOf(c),
        c.req.valid('param').agentKind,
        c.req.valid('query')
      ),
      200
    )
  )
  router.openapi(getPublished, async (c) =>
    c.json(
      await Instructions.published(container, callerOf(c), c.req.valid('param').agentKind),
      200
    )
  )
  router.openapi(diff, async (c) =>
    c.json(
      await Instructions.diff(
        container,
        callerOf(c),
        c.req.valid('param').agentKind,
        c.req.valid('query')
      ),
      200
    )
  )
  router.openapi(get, async (c) => {
    const { agentKind, versionNumber } = c.req.valid('param')
    return c.json(await Instructions.get(container, callerOf(c), agentKind, versionNumber), 200)
  })
  router.openapi(save, async (c) => {
    const answer = await Instructions.save(
      container,
      callerOf(c),
      c.req.valid('param').agentKind,
      c.req.valid('json').text,
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })
  router.openapi(publish, async (c) => {
    const { agentKind, versionNumber } = c.req.valid('param')
    const answer = await Instructions.publish(container, callerOf(c), agentKind, versionNumber, {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, 200)
  })

  return router
}

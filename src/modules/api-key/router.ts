import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  apiKeySchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  listApiKeysQuerySchema,
  listApiKeysResponseSchema,
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
import { apiKeyParamsSchema } from './schema'
import * as ApiKeys from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const create = createRoute({
  method: 'post',
  path: '/api-keys',
  tags: ['api-keys'],
  summary: 'Create an API key',
  description:
    'Owner and Admin. The answer carries the secret once; it is never returned again, never ' +
    'logged and never in an audit event. Only its SHA-256 and a display prefix are stored. The ' +
    'role ceiling may not be above your own role. `Idempotency-Key` is required: a repeat ' +
    'answers 200 with the same key and `secret: null`, so a caller that lost the response ' +
    'revokes the key and makes another.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createApiKeyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'A repeat of an earlier create: the same key, with the secret null.',
      content: { 'application/json': { schema: createApiKeyResponseSchema } },
    },
    201: {
      description: 'The key, with its secret this once.',
      content: { 'application/json': { schema: createApiKeyResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, apikey.scope_not_allowed, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    422: errorResponse('request.idempotency_key_reused'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const list = createRoute({
  method: 'get',
  path: '/api-keys',
  tags: ['api-keys'],
  summary: "List the Organization's API keys",
  description:
    'Owner and Admin. Newest first, revoked keys only with `includeRevoked`. Cursor ' +
    'pagination, at most 100 per page. A key never shows its secret.',
  security,
  request: { query: listApiKeysQuerySchema },
  responses: {
    200: {
      description: 'One page of keys.',
      content: { 'application/json': { schema: listApiKeysResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const revoke = createRoute({
  method: 'post',
  path: '/api-keys/{apiKeyId}/revoke',
  tags: ['api-keys'],
  summary: 'Revoke an API key',
  description:
    'Owner and Admin. Takes effect at the next exchange. A key already revoked answers 200 with ' +
    'the same key and its first revocation time. A key of another Organization is ' +
    'apikey.not_found. `Idempotency-Key` is required.',
  security,
  request: { headers: idempotencyKeyHeaderSchema, params: apiKeyParamsSchema },
  responses: {
    200: {
      description: 'The revoked key.',
      content: { 'application/json': { schema: apiKeySchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('apikey.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    422: errorResponse('request.idempotency_key_reused'),
    429: errorResponseWithRetryAfter('rate.limited'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The API key routes of the caller's Organization. Mounted behind the access-token middleware. */
export function createApiKeyRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(create, async (c) => {
    const answer = await ApiKeys.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(list, async (c) =>
    c.json(await ApiKeys.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(revoke, async (c) => {
    const answer = await ApiKeys.revoke(container, callerOf(c), c.req.valid('param').apiKeyId, {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, 200)
  })

  return router
}

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  createProspectRequestSchema,
  listProspectsQuerySchema,
  listProspectsResponseSchema,
  prospectParamsSchema,
  prospectSchema,
  updateProspectRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Prospects from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/prospects',
  tags: ['prospects'],
  summary: 'List the Prospects you may see',
  description:
    'Any role. Owner and Admin see every Prospect, a Manager those they own and those of the ' +
    'Reps who share a Team with them, a Rep their own. Filters (owner, Source, company, status, ' +
    'and `q` on a name or an email) only narrow that. Newest first, cursor pagination, at most ' +
    '100 per page.',
  security,
  request: { query: listProspectsQuerySchema },
  responses: {
    200: {
      description: 'One page of Prospects.',
      content: { 'application/json': { schema: listProspectsResponseSchema } },
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
  path: '/prospects/{prospectId}',
  tags: ['prospects'],
  summary: 'Get a Prospect',
  description:
    'Any role, for a Prospect the caller may see. One the caller may not see, one that does not ' +
    'exist and one of another Organization are all `prospect.not_found`, never 403.',
  security,
  request: { params: prospectParamsSchema },
  responses: {
    200: {
      description: 'The Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/prospects',
  tags: ['prospects'],
  summary: 'Create a Prospect',
  description:
    'Any role. The Source is `manual`. A Rep or Manager owns what they create; Owner and Admin ' +
    'may name an owner (a Rep or Manager) or leave the Prospect unowned. Accepts an ' +
    '`Idempotency-Key` header: a repeat with the same key and body returns the first Prospect ' +
    '(200) and creates nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createProspectRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first Prospect, for a repeat of a request with the same Idempotency-Key.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    201: {
      description: 'The new Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, prospect.forbidden_owner, or organization.suspended.'),
    404: errorResponse('prospect.not_found (the company), or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'prospect.duplicate_identity, or request.idempotency_in_progress: the first request with ' +
        'this Idempotency-Key is still running (see Retry-After and details.retryAfter, in seconds).'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const update = createRoute({
  method: 'patch',
  path: '/prospects/{prospectId}',
  tags: ['prospects'],
  summary: 'Edit a Prospect',
  description:
    'Any role, for a Prospect the caller may see. Every field sent is written as `manual`, which ' +
    'a later import, CRM sync or enrichment cannot overwrite; `null` clears a field. The owner ' +
    'is not changed here.',
  security,
  request: {
    params: prospectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateProspectRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The edited Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse(
      'prospect.not_found (the Prospect or the company), or organization.not_found.'
    ),
    409: errorResponse('prospect.duplicate_identity'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Prospects of the caller's Organization. Mounted behind the access-token middleware. */
export function createProspectRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Prospects.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(await Prospects.get(container, callerOf(c), c.req.valid('param').prospectId), 200)
  )

  router.openapi(create, async (c) => {
    const answer = await Prospects.create(container, callerOf(c), c.req.valid('json'), {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(update, async (c) =>
    c.json(
      await Prospects.update(
        container,
        callerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('json'),
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  return router
}

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  createProspectCompanyRequestSchema,
  listProspectCompaniesQuerySchema,
  listProspectCompaniesResponseSchema,
  PROSPECT_ROUTES,
  prospectCompanyParamsSchema,
  prospectCompanySchema,
  publicApiExtensions,
  updateProspectCompanyRequestSchema,
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
import * as Companies from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/prospect-companies',
  ...publicApiExtensions(PROSPECT_ROUTES.listProspectCompanies),
  tags: ['prospects'],
  summary: 'List Prospect Companies',
  description:
    'Any role. Optionally narrowed by `q` on the name or the domain, and by `ids` (at most 100 ' +
    'Prospect Company ids, comma separated; both together must match). Newest first, cursor ' +
    'pagination, at most 100 per page.',
  security,
  request: { query: listProspectCompaniesQuerySchema },
  responses: {
    200: {
      description: 'One page of Prospect Companies.',
      content: { 'application/json': { schema: listProspectCompaniesResponseSchema } },
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
  path: '/prospect-companies/{companyId}',
  ...publicApiExtensions(PROSPECT_ROUTES.getProspectCompany),
  tags: ['prospects'],
  summary: 'Get a Prospect Company',
  description: 'Any role. One of another Organization is `prospect.not_found`.',
  security,
  request: { params: prospectCompanyParamsSchema },
  responses: {
    200: {
      description: 'The Prospect Company.',
      content: { 'application/json': { schema: prospectCompanySchema } },
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
  path: '/prospect-companies',
  ...publicApiExtensions(PROSPECT_ROUTES.createProspectCompany),
  tags: ['prospects'],
  summary: 'Create a Prospect Company',
  description:
    'Any role. The Source is `manual`. A domain another Prospect Company already has is ' +
    '`request.invalid`. Accepts an `Idempotency-Key` header: a repeat with the same key and body ' +
    'returns the first company (200) and creates nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createProspectCompanyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first company, for a repeat of a request with the same Idempotency-Key.',
      content: { 'application/json': { schema: prospectCompanySchema } },
    },
    201: {
      description: 'The new Prospect Company.',
      content: { 'application/json': { schema: prospectCompanySchema } },
    },
    400: errorResponse('The request is not valid, or the domain is already in use.'),
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

const update = createRoute({
  method: 'patch',
  path: '/prospect-companies/{companyId}',
  ...publicApiExtensions(PROSPECT_ROUTES.updateProspectCompany),
  tags: ['prospects'],
  summary: 'Edit a Prospect Company',
  description:
    'Any role. Each field sent is written as `manual`; `domain: null` clears the domain.',
  security,
  request: {
    params: prospectCompanyParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateProspectCompanyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The edited Prospect Company.',
      content: { 'application/json': { schema: prospectCompanySchema } },
    },
    400: errorResponse('The request is not valid, or the domain is already in use.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Prospect Companies of the caller's Organization. Mounted behind the access-token middleware. */
export function createProspectCompanyRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Companies.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(await Companies.get(container, callerOf(c), c.req.valid('param').companyId), 200)
  )

  router.openapi(create, async (c) => {
    const answer = await Companies.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(update, async (c) =>
    c.json(
      await Companies.update(
        container,
        callerOf(c),
        c.req.valid('param').companyId,
        c.req.valid('json')
      ),
      200
    )
  )

  return router
}

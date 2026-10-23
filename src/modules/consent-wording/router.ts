import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CONSENT_ROUTES,
  consentWordingPageSchema,
  consentWordingParamsSchema,
  consentWordingSchema,
  createConsentWordingRequestSchema,
  listConsentWordingsQuerySchema,
  updateConsentWordingRequestSchema,
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
import * as Wordings from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const idempotentResponses = {
  409: errorResponseWithRetryAfter(
    'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
      'running (see Retry-After and details.retryAfter, in seconds). Or request.conflict: a ' +
      'newer version already replaces this wording.'
  ),
  422: errorResponse(
    'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
  ),
}

const list = createRoute({
  method: 'get',
  path: '/consent-wordings',
  tags: ['consent'],
  summary: 'List Consent Wordings',
  description: CONSENT_ROUTES.listConsentWordings.description,
  security,
  request: { query: listConsentWordingsQuerySchema },
  responses: {
    200: {
      description: 'One page of wordings, newest first.',
      content: { 'application/json': { schema: consentWordingPageSchema } },
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
  path: '/consent-wordings/{wordingId}',
  tags: ['consent'],
  summary: 'Read a Consent Wording',
  description: CONSENT_ROUTES.getConsentWording.description,
  security,
  request: { params: consentWordingParamsSchema },
  responses: {
    200: {
      description: 'The wording.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('consent.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/consent-wordings',
  tags: ['consent'],
  summary: 'Write a Consent Wording',
  description: CONSENT_ROUTES.createConsentWording.description,
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createConsentWordingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    201: {
      description: 'The new wording, version 1.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    ...idempotentResponses,
    500: errorResponse('Something went wrong on our side.'),
  },
})

const update = createRoute({
  method: 'patch',
  path: '/consent-wordings/{wordingId}',
  tags: ['consent'],
  summary: 'Edit a Consent Wording that nothing uses yet',
  description: CONSENT_ROUTES.updateConsentWording.description,
  security,
  request: {
    params: consentWordingParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateConsentWordingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The edited wording.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('consent.not_found, or organization.not_found'),
    409: errorResponse('consent.wording_locked: a consent event or a published form uses it.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const createVersion = createRoute({
  method: 'post',
  path: '/consent-wordings/{wordingId}/versions',
  tags: ['consent'],
  summary: 'Write the next version of a Consent Wording',
  description: CONSENT_ROUTES.createConsentWordingVersion.description,
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentWordingParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createConsentWordingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    201: {
      description: 'The new version.',
      content: { 'application/json': { schema: consentWordingSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('consent.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    ...idempotentResponses,
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The routes that write, edit, version and read Consent Wordings. */
export function createConsentWordingRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) => {
    return c.json(await Wordings.list(container, callerOf(c), c.req.valid('query')), 200)
  })

  router.openapi(get, async (c) => {
    return c.json(await Wordings.get(container, callerOf(c), c.req.valid('param').wordingId), 200)
  })

  router.openapi(create, async (c) => {
    const answer = await Wordings.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(update, async (c) => {
    const wording = await Wordings.update(
      container,
      callerOf(c),
      c.req.valid('param').wordingId,
      c.req.valid('json')
    )
    return c.json(wording, 200)
  })

  router.openapi(createVersion, async (c) => {
    const answer = await Wordings.createVersion(
      container,
      callerOf(c),
      c.req.valid('param').wordingId,
      c.req.valid('json'),
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  return router
}

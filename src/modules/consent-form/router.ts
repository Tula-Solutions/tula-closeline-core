import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  CONSENT_ROUTES,
  consentFormPageSchema,
  consentFormParamsSchema,
  consentFormSchema,
  createConsentFormRequestSchema,
  listConsentFormsQuerySchema,
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
import * as Forms from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/consent-forms',
  tags: ['consent'],
  summary: 'List hosted consent forms',
  description: CONSENT_ROUTES.listConsentForms.description,
  security,
  request: { query: listConsentFormsQuerySchema },
  responses: {
    200: {
      description: 'One page of forms, newest first.',
      content: { 'application/json': { schema: consentFormPageSchema } },
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
  path: '/consent-forms/{formId}',
  tags: ['consent'],
  summary: 'Read a hosted consent form',
  description: CONSENT_ROUTES.getConsentForm.description,
  security,
  request: { params: consentFormParamsSchema },
  responses: {
    200: {
      description: 'The form.',
      content: { 'application/json': { schema: consentFormSchema } },
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
  path: '/consent-forms',
  tags: ['consent'],
  summary: 'Create a hosted consent form',
  description: CONSENT_ROUTES.createConsentForm.description,
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createConsentFormRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: consentFormSchema } },
    },
    201: {
      description: 'The new draft form.',
      content: { 'application/json': { schema: consentFormSchema } },
    },
    400: errorResponse('The request is not valid, or a channel is not one the wording covers.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('consent.not_found, or organization.not_found'),
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

const transitionResponses = {
  200: {
    description: 'The form after the change.',
    content: { 'application/json': { schema: consentFormSchema } },
  },
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  404: errorResponse('consent.not_found, or organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const publish = createRoute({
  method: 'post',
  path: '/consent-forms/{formId}/publication',
  tags: ['consent'],
  summary: 'Publish a hosted consent form',
  description: CONSENT_ROUTES.publishConsentForm.description,
  security,
  request: { params: consentFormParamsSchema },
  responses: {
    ...transitionResponses,
    409: errorResponse('request.conflict: the form is not a draft.'),
  },
})

const close = createRoute({
  method: 'post',
  path: '/consent-forms/{formId}/closure',
  tags: ['consent'],
  summary: 'Close a hosted consent form',
  description: CONSENT_ROUTES.closeConsentForm.description,
  security,
  request: { params: consentFormParamsSchema },
  responses: {
    ...transitionResponses,
    409: errorResponse('request.conflict: the form is not published.'),
  },
})

/** The routes that create, publish, close and read hosted consent forms. */
export function createConsentFormRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) => {
    return c.json(await Forms.list(container, callerOf(c), c.req.valid('query')), 200)
  })

  router.openapi(get, async (c) => {
    return c.json(await Forms.get(container, callerOf(c), c.req.valid('param').formId), 200)
  })

  router.openapi(create, async (c) => {
    const answer = await Forms.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(publish, async (c) => {
    return c.json(await Forms.publish(container, callerOf(c), c.req.valid('param').formId), 200)
  })

  router.openapi(close, async (c) => {
    return c.json(await Forms.close(container, callerOf(c), c.req.valid('param').formId), 200)
  })

  return router
}

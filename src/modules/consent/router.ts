import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  consentProspectParamsSchema,
  recordConsentRequestSchema,
  withdrawConsentRequestSchema,
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
import { recordedConsentResponseSchema } from './schema'
import * as Consent from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const record = createRoute({
  method: 'post',
  path: '/prospects/{prospectId}/consents',
  tags: ['consent'],
  summary: 'Record a granted Contact Consent',
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see (anything else is ' +
    '`prospect.not_found`). Needs a source, a Consent Wording that covers the channel and an ' +
    'evidence reference. Appends a `granted` event to the ledger and publishes `consent.granted`. ' +
    'Accepts an `Idempotency-Key` header: a repeat with the same key and body returns the first ' +
    'result (200) and publishes nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentProspectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: recordConsentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    201: {
      description: 'The ledger event and the resulting consent.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, consent.not_found or organization.not_found'),
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

const withdraw = createRoute({
  method: 'post',
  path: '/prospects/{prospectId}/consent-withdrawals',
  tags: ['consent'],
  summary: 'Withdraw a Contact Consent',
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see. Withdraws the named channels, ' +
    'or every channel with `all: true` (STOP-all). Other channels are unchanged. It needs no ' +
    'reason and is allowed in a suspended Organization. Publishes one `consent.withdrawn` per ' +
    'channel. Accepts an `Idempotency-Key` header.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentProspectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: withdrawConsentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    201: {
      description: 'The ledger events and the resulting consent.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, consent.not_found or organization.not_found'),
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

/** The routes that record and withdraw a Prospect's Contact Consent. */
export function createConsentRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(record, async (c) => {
    const answer = await Consent.record(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  router.openapi(withdraw, async (c) => {
    const answer = await Consent.withdraw(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  return router
}

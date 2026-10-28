import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { inquiryEmbedSchema, setInquiryEmbedRequestSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse, idempotencyKeyHeaderSchema } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as InquiryEmbeds from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  404: errorResponse('organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const get = createRoute({
  method: 'get',
  path: '/inquiry-embed',
  tags: ['inquiry-embed'],
  summary: "Read the Organization's Inquiry embed settings",
  description:
    'Owner and Admin. The first read makes the publishable key. The form is live only once an ' +
    'allowed origin and a Consent Wording are set.',
  security,
  responses: {
    200: {
      description: 'The embed settings.',
      content: { 'application/json': { schema: inquiryEmbedSchema } },
    },
    ...common,
  },
})

const set = createRoute({
  method: 'put',
  path: '/inquiry-embed',
  tags: ['inquiry-embed'],
  summary: 'Set the allowed origins and the Consent Wording of the Inquiry form',
  description:
    'Owner and Admin. Replaces the origins and the wording. A wording that does not exist or ' +
    'does not cover the phone channel is inquiry.embed_invalid. A repeat changes nothing.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: setInquiryEmbedRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The saved settings.',
      content: { 'application/json': { schema: inquiryEmbedSchema } },
    },
    400: errorResponse('The request is not valid.'),
    422: errorResponse('inquiry.embed_invalid'),
    ...common,
  },
})

const rotate = createRoute({
  method: 'post',
  path: '/inquiry-embed/rotate-key',
  tags: ['inquiry-embed'],
  summary: 'Issue a new publishable key',
  description:
    'Owner and Admin. The old key stops working at once. `Idempotency-Key` is required: a ' +
    'replay answers the same new key and rotates once.',
  security,
  request: { headers: idempotencyKeyHeaderSchema },
  responses: {
    200: {
      description: 'The settings with the new key.',
      content: { 'application/json': { schema: inquiryEmbedSchema } },
    },
    400: errorResponse('The request is not valid.'),
    422: errorResponse('request.idempotency_key_reused'),
    ...common,
  },
})

/** The Inquiry embed admin routes. Mounted behind the access-token middleware. */
export function createInquiryEmbedRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(get, async (c) => c.json(await InquiryEmbeds.get(container, callerOf(c)), 200))

  router.openapi(set, async (c) => {
    const answer = await InquiryEmbeds.set(container, callerOf(c), c.req.valid('json'), {})
    return c.json(answer.body, 200)
  })

  router.openapi(rotate, async (c) => {
    const answer = await InquiryEmbeds.rotateKey(container, callerOf(c), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, 200)
  })

  return router
}

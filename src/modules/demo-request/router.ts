import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  createDemoRequestRequestSchema,
  createDemoRequestResponseSchema,
  ERRORS,
  MARKETING_ERRORS,
  MARKETING_ROUTES,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { hashClientAddress, resolveClientAddress } from '~/http/client-address'
import { exactOriginCors } from '~/http/cors'
import { domainError } from '~/http/domain-error'
import { respond } from '~/http/errors'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  idempotencyKeyHeaderSchema,
} from '~/http/responses'
import type { AppEnv } from '~/http/types'
import * as DemoRequests from './service'

/** The largest body this route reads, in bytes; the contract's fields come to far less. */
export const MAX_DEMO_REQUEST_BODY_BYTES = 8_192

const create = createRoute({
  method: 'post',
  path: MARKETING_ROUTES.createDemoRequest.path,
  tags: ['marketing'],
  summary: 'Request a demo',
  description: MARKETING_ROUTES.createDemoRequest.description,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createDemoRequestRequestSchema } },
    },
  },
  responses: {
    201: {
      description:
        'The Demo Request was taken (or the honeypot was filled and nothing was stored).',
      content: { 'application/json': { schema: createDemoRequestResponseSchema } },
    },
    200: {
      description: 'The Idempotency-Key was used before with this same request: the first answer.',
      content: { 'application/json': { schema: createDemoRequestResponseSchema } },
    },
    400: errorResponse('marketing.invalid_request: the body or the Idempotency-Key is not valid.'),
    413: errorResponse('request.too_large: the body is over the size limit.'),
    422: errorResponse('request.idempotency_key_reused: the key was used with another request.'),
    429: errorResponseWithRetryAfter(
      'marketing.rate_limited: too many requests from this address.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The Demo Request module's public route: no token and no Organization. CORS allows only the
 * portal's origin; the body is cut at {@link MAX_DEMO_REQUEST_BODY_BYTES}; any body or header that
 * fails validation, malformed JSON included, is `marketing.invalid_request` and names nothing.
 */
export function createDemoRequestRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw domainError(MARKETING_ERRORS['marketing.invalid_request'])
      }
    },
  })

  const path = create.path
  router.use(path, exactOriginCors(new URL(container.env.PORTAL_BASE_URL).origin))
  router.use(
    path,
    bodyLimit({
      maxSize: MAX_DEMO_REQUEST_BODY_BYTES,
      onError: (c) => respond(c, ERRORS['request.too_large']),
    })
  )
  // Malformed JSON would reach the validator as an HTTPException; refuse it here, in our own words.
  router.use(path, async (c, next) => {
    if (c.req.method === 'POST') {
      // A body that is not JSON (a wrong content type included) is the same answer as any other
      // bad body, not the generic 415, so the route has one failure shape.
      try {
        if (!(c.req.header('content-type') ?? '').toLowerCase().includes('json')) {
          throw new Error('not json')
        }
        await c.req.raw.clone().json()
      } catch {
        throw domainError(MARKETING_ERRORS['marketing.invalid_request'])
      }
    }
    await next()
  })

  router.openapi(create, async (c) => {
    const address = resolveClientAddress({
      socketAddress: c.env?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: container.env.TRUSTED_PROXY_HOPS,
    })
    const idempotencyKey = c.req.valid('header')['idempotency-key']
    if (idempotencyKey === undefined) {
      throw domainError(MARKETING_ERRORS['marketing.invalid_request'])
    }
    const result = await DemoRequests.submit(container, {
      request: c.req.valid('json'),
      idempotencyKey,
      addressHash: hashClientAddress(address, container.env.DEMO_RATE_KEY),
    })
    return c.json({ id: result.id }, result.replayed ? 200 : 201)
  })

  return router
}

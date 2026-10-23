import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  CONSENT_ERRORS,
  CONSENT_ROUTES,
  consentTokenParamsSchema,
  ERRORS,
  hostedConsentFormViewSchema,
  hostedConsentReceiptSchema,
  hostedConsentSubmissionSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { resolveClientAddress, resolveRawClientAddress } from '~/http/client-address'
import { exactOriginCors } from '~/http/cors'
import { domainError } from '~/http/domain-error'
import { respond } from '~/http/errors'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeaderSchema,
} from '~/http/responses'
import type { AppEnv } from '~/http/types'
import * as HostedConsent from './service'

/** The largest body this route reads, in bytes; the contract's fields come to far less. */
export const MAX_HOSTED_CONSENT_BODY_BYTES = 16_384

const view = createRoute({
  method: 'get',
  path: '/v1/public/consent-forms/{token}',
  tags: ['consent'],
  summary: 'Read a hosted consent form',
  description: CONSENT_ROUTES.getHostedConsentForm.description,
  request: { params: consentTokenParamsSchema },
  responses: {
    200: {
      description: 'What the hosted page shows.',
      content: { 'application/json': { schema: hostedConsentFormViewSchema } },
    },
    400: errorResponse('consent.invalid_token: the link does not work.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests from this address.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const submit = createRoute({
  method: 'post',
  path: '/v1/public/consent-forms/{token}/submissions',
  tags: ['consent'],
  summary: 'Submit a hosted consent form',
  description: CONSENT_ROUTES.submitHostedConsentForm.description,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentTokenParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: hostedConsentSubmissionSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first receipt, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: hostedConsentReceiptSchema } },
    },
    201: {
      description: 'The consent was recorded, one grant per ticked channel.',
      content: { 'application/json': { schema: hostedConsentReceiptSchema } },
    },
    400: errorResponse(
      'consent.invalid_token: the link does not work. Or request.invalid: the body is not valid.'
    ),
    409: errorResponseWithRetryAfter(
      'request.idempotency_in_progress: the first request with this Idempotency-Key is still running.'
    ),
    413: errorResponse('request.too_large: the body is over the size limit.'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    429: errorResponseWithRetryAfter('rate.limited: too many requests from this address.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The public routes of a hosted consent form: no access token, only the link token in the path.
 * CORS allows only the portal's origin. A link token that is malformed is the same
 * `consent.invalid_token` as one that is unknown, so a probe learns nothing from the shape.
 */
export function createConsentFormPublicRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (result.success) {
        return
      }
      if (result.target === 'param') {
        throw domainError(CONSENT_ERRORS['consent.invalid_token'])
      }
      throw new AppError({
        code: ERRORS['request.invalid'].code,
        status: ERRORS['request.invalid'].status,
        message: ERRORS['request.invalid'].message,
        details: {
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            code: issue.code,
            message: issue.message,
          })),
        },
        cause: result.error,
      })
    },
  })

  const origin = new URL(container.env.PORTAL_BASE_URL).origin
  router.use('/v1/public/consent-forms/*', exactOriginCors(origin))
  router.use(
    '/v1/public/consent-forms/*',
    bodyLimit({
      maxSize: MAX_HOSTED_CONSENT_BODY_BYTES,
      onError: (c) => respond(c, ERRORS['request.too_large']),
    })
  )

  /** The client's address as the rate limit counts it and as evidence keeps it. */
  const addressOf = (c: {
    env?: AppEnv['Bindings']
    req: { raw: Request; header: (name: string) => string | undefined }
  }) => {
    const input = {
      socketAddress: c.env?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: container.env.TRUSTED_PROXY_HOPS,
    }
    return { canonical: resolveClientAddress(input), raw: resolveRawClientAddress(input) }
  }

  router.openapi(view, async (c) => {
    const body = await HostedConsent.view(container, {
      token: c.req.valid('param').token,
      address: addressOf(c),
    })
    return c.json(body, 200)
  })

  router.openapi(submit, async (c) => {
    const answer = await HostedConsent.submit(container, {
      token: c.req.valid('param').token,
      request: c.req.valid('json'),
      traceId: c.get('requestId'),
      address: addressOf(c),
      userAgent: c.req.header('user-agent'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  return router
}

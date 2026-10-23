import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  CONSENT_ERRORS,
  CONSENT_ROUTES,
  consentTokenParamsSchema,
  ERRORS,
  oneClickUnsubscribeRequestSchema,
  unsubscribePreviewSchema,
  unsubscribeReceiptSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { resolveClientAddress } from '~/http/client-address'
import { exactOriginCors } from '~/http/cors'
import { domainError } from '~/http/domain-error'
import { respond } from '~/http/errors'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import type { AppEnv } from '~/http/types'
import * as Unsubscribe from './service'

/** The largest body this route reads, in bytes; the one-click body is a single pair. */
export const MAX_UNSUBSCRIBE_BODY_BYTES = 1_024

const preview = createRoute({
  method: 'get',
  path: '/v1/public/unsubscribe/{token}',
  tags: ['consent'],
  summary: 'Preview an unsubscribe link',
  description: CONSENT_ROUTES.previewUnsubscribe.description,
  request: { params: consentTokenParamsSchema },
  responses: {
    200: {
      description: 'What the confirmation page shows: the Organization and the channel.',
      content: { 'application/json': { schema: unsubscribePreviewSchema } },
    },
    400: errorResponse('consent.invalid_token: the link does not work.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests from this address.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const oneClick = createRoute({
  method: 'post',
  path: '/v1/public/unsubscribe/{token}',
  tags: ['consent'],
  summary: 'Unsubscribe by a link, in one click',
  description:
    `${CONSENT_ROUTES.oneClickUnsubscribe.description} The body is the RFC 8058 pair ` +
    '`List-Unsubscribe=One-Click`, sent form-encoded by mail clients (JSON is accepted too).',
  request: {
    params: consentTokenParamsSchema,
    body: {
      required: true,
      content: {
        'application/x-www-form-urlencoded': { schema: oneClickUnsubscribeRequestSchema },
        'application/json': { schema: oneClickUnsubscribeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'The address is unsubscribed; a link used again answers the same.',
      content: { 'application/json': { schema: unsubscribeReceiptSchema } },
    },
    400: errorResponse(
      'consent.invalid_token: the link does not work. Or request.invalid: the body is not the one-click pair.'
    ),
    413: errorResponse('request.too_large: the body is over the size limit.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests from this address.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The body of a one-click POST as an object: form-encoded (what mail clients send) or JSON; anything else is not valid. */
async function readBody(contentType: string | undefined, request: Request): Promise<unknown> {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase()
  try {
    if (type === 'application/x-www-form-urlencoded') {
      return Object.fromEntries(new URLSearchParams(await request.text()))
    }
    if (type === 'application/json') {
      return await request.json()
    }
  } catch {
    throw domainError(ERRORS['request.invalid'])
  }
  throw domainError(ERRORS['request.unsupported_media_type'])
}

/**
 * The public unsubscribe routes: no access token, only the signed link token in the path. The GET
 * reads and writes nothing, so a link opened by a mail scanner unsubscribes no one; the POST is
 * RFC 8058 one-click. A token that is malformed is the same `consent.invalid_token` as one that is
 * tampered, expired or of an Organization that is gone, so a probe learns nothing from the shape.
 */
export function createUnsubscribeRouter(container: Container): OpenAPIHono<AppEnv> {
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
  router.use('/v1/public/unsubscribe/*', exactOriginCors(origin))
  router.use(
    '/v1/public/unsubscribe/*',
    bodyLimit({
      maxSize: MAX_UNSUBSCRIBE_BODY_BYTES,
      onError: (c) => respond(c, ERRORS['request.too_large']),
    })
  )

  /** The client's address as the rate limit counts it. */
  const addressOf = (c: {
    env?: AppEnv['Bindings']
    req: { raw: Request; header: (name: string) => string | undefined }
  }) => ({
    canonical: resolveClientAddress({
      socketAddress: c.env?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: container.env.TRUSTED_PROXY_HOPS,
    }),
  })

  router.openapi(preview, async (c) =>
    c.json(
      await Unsubscribe.preview(container, {
        token: c.req.valid('param').token,
        address: addressOf(c),
      }),
      200
    )
  )

  // The POST is a plain handler, described here: mail clients send the RFC 8058 pair form-encoded
  // and the contract describes it as JSON, which one OpenAPI route cannot validate both of.
  router.openAPIRegistry.registerPath(oneClick)
  router.post('/v1/public/unsubscribe/:token', async (c) => {
    const params = consentTokenParamsSchema.safeParse({ token: c.req.param('token') })
    if (!params.success) {
      throw domainError(CONSENT_ERRORS['consent.invalid_token'])
    }
    const body = await readBody(c.req.header('content-type'), c.req.raw)
    if (!oneClickUnsubscribeRequestSchema.safeParse(body).success) {
      throw domainError(ERRORS['request.invalid'])
    }
    return c.json(
      await Unsubscribe.unsubscribe(container, {
        token: params.data.token,
        address: addressOf(c),
        traceId: c.get('requestId'),
      }),
      200
    )
  })

  return router
}

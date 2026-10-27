import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import {
  BOOKING_ERRORS,
  BOOKING_ROUTES,
  bookHeadersSchema,
  ERRORS,
  publicBookingConfirmationSchema,
  publicBookingParamsSchema,
  publicBookRequestSchema,
  publicListSlotsQuerySchema,
  publicSlotPageSchema,
} from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { resolveClientAddress } from '~/http/client-address'
import { exactOriginCors } from '~/http/cors'
import { domainError } from '~/http/domain-error'
import { respond } from '~/http/errors'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import type { AppEnv } from '~/http/types'
import * as PublicBooking from './service'

/** The largest body the public booking route reads, in bytes; its fields come to far less. */
export const MAX_PUBLIC_BOOKING_BODY_BYTES = 4096

const slots = createRoute({
  method: 'get',
  path: '/v1/public/booking-types/{token}/slots',
  tags: ['booking'],
  summary: 'List free times of a Booking Type link',
  description: BOOKING_ROUTES.publicListSlots.description,
  request: { params: publicBookingParamsSchema, query: publicListSlotsQuerySchema },
  responses: {
    200: {
      description: 'One page of free times, each a start and an end.',
      content: { 'application/json': { schema: publicSlotPageSchema } },
    },
    400: errorResponse('request.invalid: the range or cursor is not valid.'),
    404: errorResponse('booking.type_not_found: the link does not work.'),
    409: errorResponse('booking.no_eligible_rep: nobody is available for this Booking Type.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const book = createRoute({
  method: 'post',
  path: '/v1/public/booking-types/{token}/bookings',
  tags: ['booking'],
  summary: 'Book a time through a Booking Type link',
  description: BOOKING_ROUTES.publicBook.description,
  request: {
    headers: bookHeadersSchema,
    params: publicBookingParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: publicBookRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first confirmation, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: publicBookingConfirmationSchema } },
    },
    201: {
      description: 'The time is booked.',
      content: { 'application/json': { schema: publicBookingConfirmationSchema } },
    },
    400: errorResponse('request.invalid: the body or the Idempotency-Key is not valid.'),
    404: errorResponse('booking.type_not_found: the link does not work.'),
    409: errorResponseWithRetryAfter(
      'booking.slot_taken, booking.no_eligible_rep, or request.idempotency_in_progress (with Retry-After).'
    ),
    413: errorResponse('request.too_large: the body is over the size limit.'),
    422: errorResponse(
      'booking.slot_invalid, or request.idempotency_key_reused: the key was used for a different request.'
    ),
    429: errorResponseWithRetryAfter('rate.limited: too many requests.'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('booking.calendar_unavailable: try again shortly.'),
  },
})

/**
 * The public routes of a Booking Type link: no access token, only the link token in the path.
 * CORS allows only the portal's origin. A malformed token is the same `booking.type_not_found` as
 * an unknown one, so a probe learns nothing from the shape.
 */
export function createBookingPublicRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (result.success) {
        return
      }
      if (result.target === 'param') {
        throw domainError(BOOKING_ERRORS['booking.type_not_found'])
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
  router.use('/v1/public/booking-types/*', exactOriginCors(origin))
  router.use(
    '/v1/public/booking-types/*',
    bodyLimit({
      maxSize: MAX_PUBLIC_BOOKING_BODY_BYTES,
      onError: (c) => respond(c, ERRORS['request.too_large']),
    })
  )

  const addressOf = (c: {
    env?: AppEnv['Bindings']
    req: { raw: Request; header: (name: string) => string | undefined }
  }) =>
    resolveClientAddress({
      socketAddress: c.env?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: container.env.TRUSTED_PROXY_HOPS,
    })

  router.openapi(slots, async (c) => {
    const body = await PublicBooking.slots(container, {
      token: c.req.valid('param').token,
      address: addressOf(c),
      query: c.req.valid('query'),
    })
    return c.json(body, 200)
  })

  router.openapi(book, async (c) => {
    const answer = await PublicBooking.bookTime(container, {
      token: c.req.valid('param').token,
      address: addressOf(c),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
      request: c.req.valid('json'),
    })
    return c.json(answer.body, answer.status)
  })

  return router
}

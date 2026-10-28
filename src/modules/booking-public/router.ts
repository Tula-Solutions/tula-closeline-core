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
  publicManagedBookingSchema,
  publicManageParamsSchema,
  publicRescheduleRequestSchema,
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

const managedOk = {
  description: 'The Booking, as its Prospect may see it.',
  content: { 'application/json': { schema: publicManagedBookingSchema } },
}

const getManaged = createRoute({
  method: 'get',
  path: '/v1/public/bookings/manage/{manageToken}',
  tags: ['booking'],
  summary: 'Read a Booking by its manage link',
  description: BOOKING_ROUTES.publicGetManagedBooking.description,
  request: { params: publicManageParamsSchema },
  responses: {
    200: managedOk,
    404: errorResponse('booking.not_found: the link does not work.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const managedSlots = createRoute({
  method: 'get',
  path: '/v1/public/bookings/manage/{manageToken}/slots',
  tags: ['booking'],
  summary: 'List free times to move a Booking to',
  description: BOOKING_ROUTES.publicListManagedSlots.description,
  request: { params: publicManageParamsSchema, query: publicListSlotsQuerySchema },
  responses: {
    200: {
      description: 'One page of free times, each a start and an end.',
      content: { 'application/json': { schema: publicSlotPageSchema } },
    },
    400: errorResponse('request.invalid: the range or cursor is not valid.'),
    404: errorResponse('booking.not_found: the link does not work.'),
    409: errorResponse('booking.not_active or booking.already_started.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const cancelManaged = createRoute({
  method: 'post',
  path: '/v1/public/bookings/manage/{manageToken}/cancel',
  tags: ['booking'],
  summary: 'Cancel a Booking by its manage link',
  description: BOOKING_ROUTES.publicCancelBooking.description,
  request: { params: publicManageParamsSchema },
  responses: {
    200: managedOk,
    404: errorResponse('booking.not_found: the link does not work.'),
    409: errorResponse('booking.already_started.'),
    429: errorResponseWithRetryAfter('rate.limited: too many requests.'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('booking.calendar_unavailable: try again shortly.'),
  },
})

const rescheduleManaged = createRoute({
  method: 'post',
  path: '/v1/public/bookings/manage/{manageToken}/reschedule',
  tags: ['booking'],
  summary: 'Move a Booking by its manage link',
  description: BOOKING_ROUTES.publicRescheduleBooking.description,
  request: {
    headers: bookHeadersSchema,
    params: publicManageParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: publicRescheduleRequestSchema } },
    },
  },
  responses: {
    200: managedOk,
    400: errorResponse('request.invalid: the body or the Idempotency-Key is not valid.'),
    404: errorResponse('booking.not_found: the link does not work.'),
    409: errorResponse('booking.not_active, booking.already_started or booking.slot_taken.'),
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
    defaultHook: (result, c) => {
      if (result.success) {
        return
      }
      if (result.target === 'param') {
        // A manage link's malformed token is the same answer as an unknown one.
        throw domainError(
          c.req.path.startsWith('/v1/public/bookings/')
            ? BOOKING_ERRORS['booking.not_found']
            : BOOKING_ERRORS['booking.type_not_found']
        )
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
  for (const area of ['/v1/public/booking-types/*', '/v1/public/bookings/*']) {
    router.use(area, exactOriginCors(origin))
  }

  const addressOf = (c: {
    env?: AppEnv['Bindings']
    req: { raw: Request; header: (name: string) => string | undefined }
  }) =>
    resolveClientAddress({
      socketAddress: c.env?.requestIP?.(c.req.raw)?.address,
      forwardedFor: c.req.header('x-forwarded-for'),
      trustedProxyHops: container.env.TRUSTED_PROXY_HOPS,
    })

  // Counted before validation, so a request that fails it still spends the address's budget.
  for (const area of ['/v1/public/booking-types/*', '/v1/public/bookings/*']) {
    router.use(area, async (c, next) => {
      await PublicBooking.countAddress(container, addressOf(c))
      await next()
    })
    router.use(
      area,
      bodyLimit({
        maxSize: MAX_PUBLIC_BOOKING_BODY_BYTES,
        onError: (c) => respond(c, ERRORS['request.too_large']),
      })
    )
  }

  router.openapi(slots, async (c) => {
    const body = await PublicBooking.slots(container, {
      token: c.req.valid('param').token,
      query: c.req.valid('query'),
    })
    return c.json(body, 200)
  })

  router.openapi(book, async (c) => {
    const answer = await PublicBooking.bookTime(container, {
      token: c.req.valid('param').token,
      idempotencyKey: c.req.valid('header')['idempotency-key'],
      request: c.req.valid('json'),
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(getManaged, async (c) =>
    c.json(
      await PublicBooking.getManaged(container, { token: c.req.valid('param').manageToken }),
      200
    )
  )

  router.openapi(managedSlots, async (c) =>
    c.json(
      await PublicBooking.managedSlots(container, {
        token: c.req.valid('param').manageToken,
        query: c.req.valid('query'),
      }),
      200
    )
  )

  router.openapi(cancelManaged, async (c) =>
    c.json(
      await PublicBooking.cancelManaged(container, { token: c.req.valid('param').manageToken }),
      200
    )
  )

  router.openapi(rescheduleManaged, async (c) =>
    c.json(
      await PublicBooking.rescheduleManaged(container, {
        token: c.req.valid('param').manageToken,
        idempotencyKey: c.req.valid('header')['idempotency-key'],
        request: c.req.valid('json'),
      }),
      200
    )
  )

  return router
}

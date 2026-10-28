import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  BOOKING_ROUTES,
  bookHeadersSchema,
  bookingPageSchema,
  bookingParamsSchema,
  bookingSchema,
  bookRequestSchema,
  listBookingsQuerySchema,
  listSlotsQuerySchema,
  rescheduleBookingRequestSchema,
  slotPageSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Booking from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  404: errorResponse('booking.not_found, prospect.not_found, or organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const slots = createRoute({
  method: 'get',
  path: '/booking-slots',
  tags: ['booking'],
  summary: 'List free times',
  description: BOOKING_ROUTES.listSlots.description,
  security,
  request: { query: listSlotsQuerySchema },
  responses: {
    ...common,
    200: { description: 'One page of free times, earliest first.', content: json(slotPageSchema) },
    409: errorResponse('booking.no_eligible_rep'),
  },
})

const book = createRoute({
  method: 'post',
  path: '/bookings',
  tags: ['booking'],
  summary: 'Book a time',
  description: BOOKING_ROUTES.book.description,
  security,
  request: {
    headers: bookHeadersSchema,
    body: { required: true, content: json(bookRequestSchema) },
  },
  responses: {
    ...common,
    200: {
      description: 'The first answer, for a repeated Idempotency-Key.',
      content: json(bookingSchema),
    },
    201: { description: 'The new Booking.', content: json(bookingSchema) },
    409: errorResponseWithRetryAfter(
      'booking.slot_taken, booking.no_eligible_rep, or request.idempotency_in_progress (with Retry-After).'
    ),
    422: errorResponse('booking.slot_invalid, or request.idempotency_key_reused.'),
    503: errorResponse('booking.calendar_unavailable'),
  },
})

const listAll = createRoute({
  method: 'get',
  path: '/bookings',
  tags: ['booking'],
  summary: 'List Bookings',
  description: BOOKING_ROUTES.listBookings.description,
  security,
  request: { query: listBookingsQuerySchema },
  responses: {
    ...common,
    200: {
      description: 'One page of Bookings, latest start first unless `order=asc`.',
      content: json(bookingPageSchema),
    },
  },
})

const getOne = createRoute({
  method: 'get',
  path: '/bookings/{bookingId}',
  tags: ['booking'],
  summary: 'Read a Booking',
  description: BOOKING_ROUTES.getBooking.description,
  security,
  request: { params: bookingParamsSchema },
  responses: { ...common, 200: { description: 'The Booking.', content: json(bookingSchema) } },
})

const reschedule = createRoute({
  method: 'post',
  path: '/bookings/{bookingId}/reschedule',
  tags: ['booking'],
  summary: 'Move a Booking',
  description: BOOKING_ROUTES.rescheduleBooking.description,
  security,
  request: {
    params: bookingParamsSchema,
    body: { required: true, content: json(rescheduleBookingRequestSchema) },
  },
  responses: {
    ...common,
    200: { description: 'The Booking at its new time.', content: json(bookingSchema) },
    409: errorResponse('booking.slot_taken, or booking.not_active.'),
    422: errorResponse('booking.slot_invalid'),
    503: errorResponse('booking.calendar_unavailable'),
  },
})

const cancel = createRoute({
  method: 'post',
  path: '/bookings/{bookingId}/cancel',
  tags: ['booking'],
  summary: 'Cancel a Booking',
  description: BOOKING_ROUTES.cancelBooking.description,
  security,
  request: { params: bookingParamsSchema },
  responses: {
    ...common,
    200: { description: 'The cancelled Booking.', content: json(bookingSchema) },
    503: errorResponse('booking.calendar_unavailable'),
  },
})

/** The routes that list free times and book, move, cancel and read Bookings. */
export function createBookingRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(slots, async (c) =>
    c.json(await Booking.listSlots(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(book, async (c) => {
    const answer = await Booking.book(
      container,
      callerOf(c),
      c.req.valid('header')['idempotency-key'],
      c.req.valid('json')
    )
    return c.json(answer.body, answer.status)
  })
  router.openapi(listAll, async (c) =>
    c.json(await Booking.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getOne, async (c) =>
    c.json(await Booking.get(container, callerOf(c), c.req.valid('param').bookingId), 200)
  )
  router.openapi(reschedule, async (c) =>
    c.json(
      await Booking.reschedule(
        container,
        callerOf(c),
        c.req.valid('param').bookingId,
        c.req.valid('json')
      ),
      200
    )
  )
  router.openapi(cancel, async (c) =>
    c.json(await Booking.cancel(container, callerOf(c), c.req.valid('param').bookingId), 200)
  )
  return router
}

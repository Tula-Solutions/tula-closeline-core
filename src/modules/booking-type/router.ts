import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  BOOKING_ROUTES,
  bookingTypeParamsSchema,
  bookingTypeSchema,
  createBookingTypeRequestSchema,
  listBookingTypesQuerySchema,
  pageSchema,
  updateBookingTypeRequestSchema,
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
import * as BookingTypes from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const bookingTypePageSchema = pageSchema(bookingTypeSchema)

const list = createRoute({
  method: 'get',
  path: '/booking-types',
  tags: ['booking'],
  summary: 'List Booking Types',
  description: BOOKING_ROUTES.listBookingTypes.description,
  security,
  request: { query: listBookingTypesQuerySchema },
  responses: {
    200: {
      description: 'One page of Booking Types, newest first.',
      content: { 'application/json': { schema: bookingTypePageSchema } },
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
  path: '/booking-types/{bookingTypeId}',
  tags: ['booking'],
  summary: 'Read a Booking Type',
  description: BOOKING_ROUTES.getBookingType.description,
  security,
  request: { params: bookingTypeParamsSchema },
  responses: {
    200: {
      description: 'The Booking Type.',
      content: { 'application/json': { schema: bookingTypeSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('booking.type_not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/booking-types',
  tags: ['booking'],
  summary: 'Create a Booking Type',
  description: BOOKING_ROUTES.createBookingType.description,
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createBookingTypeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: bookingTypeSchema } },
    },
    201: {
      description: 'The new Booking Type.',
      content: { 'application/json': { schema: bookingTypeSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    409: errorResponseWithRetryAfter(
      'request.conflict: another Booking Type has the name. ' +
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

const update = createRoute({
  method: 'patch',
  path: '/booking-types/{bookingTypeId}',
  tags: ['booking'],
  summary: 'Change a Booking Type',
  description: BOOKING_ROUTES.updateBookingType.description,
  security,
  request: {
    params: bookingTypeParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateBookingTypeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Booking Type after the change.',
      content: { 'application/json': { schema: bookingTypeSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('booking.type_not_found, or organization.not_found'),
    409: errorResponse('request.conflict: another Booking Type has the name.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const retire = createRoute({
  method: 'post',
  path: '/booking-types/{bookingTypeId}/retire',
  tags: ['booking'],
  summary: 'Retire a Booking Type',
  description: BOOKING_ROUTES.retireBookingType.description,
  security,
  request: { params: bookingTypeParamsSchema },
  responses: {
    200: {
      description: 'The retired Booking Type.',
      content: { 'application/json': { schema: bookingTypeSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('booking.type_not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The routes that create, list, read, change and retire Booking Types. */
export function createBookingTypeRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) => {
    return c.json(await BookingTypes.list(container, callerOf(c), c.req.valid('query')), 200)
  })

  router.openapi(get, async (c) => {
    const { bookingTypeId } = c.req.valid('param')
    return c.json(await BookingTypes.get(container, callerOf(c), bookingTypeId), 200)
  })

  router.openapi(create, async (c) => {
    const answer = await BookingTypes.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(update, async (c) => {
    const { bookingTypeId } = c.req.valid('param')
    return c.json(
      await BookingTypes.update(container, callerOf(c), bookingTypeId, c.req.valid('json')),
      200
    )
  })

  router.openapi(retire, async (c) => {
    const { bookingTypeId } = c.req.valid('param')
    return c.json(await BookingTypes.retire(container, callerOf(c), bookingTypeId), 200)
  })

  return router
}

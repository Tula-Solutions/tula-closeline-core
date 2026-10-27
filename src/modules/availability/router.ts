import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { availabilitySchema, BOOKING_ROUTES } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Availability from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const get = createRoute({
  method: 'get',
  path: '/availability',
  tags: ['booking'],
  summary: 'Read my working hours',
  description: BOOKING_ROUTES.getAvailability.description,
  security,
  responses: {
    200: {
      description: 'The caller own working hours and time zone.',
      content: { 'application/json': { schema: availabilitySchema } },
    },
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const set = createRoute({
  method: 'put',
  path: '/availability',
  tags: ['booking'],
  summary: 'Set my working hours',
  description: BOOKING_ROUTES.setAvailability.description,
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: availabilitySchema } } },
  },
  responses: {
    200: {
      description: 'The working hours after the change.',
      content: { 'application/json': { schema: availabilitySchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'calendar.hours_invalid: the time zone is unknown, or there are more than 28 windows.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The routes that read and replace the caller's own working hours. */
export function createAvailabilityRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(get, async (c) => c.json(await Availability.get(container, callerOf(c)), 200))
  router.openapi(set, async (c) =>
    c.json(await Availability.set(container, callerOf(c), c.req.valid('json')), 200)
  )
  return router
}

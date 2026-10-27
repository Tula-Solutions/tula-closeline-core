import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  calendarConnectionSchema,
  completeCalendarConnectionRequestSchema,
  startCalendarConnectionRequestSchema,
  startCalendarConnectionResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Calendar from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const json = <T extends import('zod').ZodType>(schema: T) => ({
  'application/json': { schema },
})

const common = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  404: errorResponse('organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
  503: errorResponse('server.unavailable: no calendar is configured, or the vendor is down.'),
}

const start = createRoute({
  method: 'post',
  path: '/calendar-connection/start',
  tags: ['calendar'],
  summary: 'Start connecting my calendar',
  description:
    'Any role, for its own calendar. Answers the Google consent URL and a short-lived `state` ' +
    'sealed to the caller; send both back to `/calendar-connection/complete`.',
  security,
  request: {
    body: { required: true, content: json(startCalendarConnectionRequestSchema) },
  },
  responses: {
    200: {
      description: 'Where to send the Rep, and the state to return.',
      content: json(startCalendarConnectionResponseSchema),
    },
    ...common,
  },
})

const complete = createRoute({
  method: 'post',
  path: '/calendar-connection/complete',
  tags: ['calendar'],
  summary: 'Finish connecting my calendar',
  description:
    'Any role, for its own calendar. Exchanges the code for a grant and stores it sealed. A bad ' +
    'or expired `state` or a refused code is `calendar.authorization_failed`. No token is returned.',
  security,
  request: {
    body: { required: true, content: json(completeCalendarConnectionRequestSchema) },
  },
  responses: {
    200: { description: 'The connection, healthy.', content: json(calendarConnectionSchema) },
    ...common,
    422: errorResponse('calendar.authorization_failed'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/calendar-connection',
  tags: ['calendar'],
  summary: 'Get my calendar connection',
  description:
    "The caller's own connection only: healthy, or needs_reconnect when the grant was revoked. " +
    'No token is returned. No connection is `calendar.not_connected`.',
  security,
  responses: {
    200: { description: 'The connection.', content: json(calendarConnectionSchema) },
    ...common,
    404: errorResponse('calendar.not_connected, or organization.not_found.'),
  },
})

const disconnect = createRoute({
  method: 'delete',
  path: '/calendar-connection',
  tags: ['calendar'],
  summary: 'Disconnect my calendar',
  description:
    'Any role, for its own calendar. Deletes the stored grant and revokes it at the vendor. ' +
    'Answers 204 whether or not there was a connection.',
  security,
  responses: {
    204: { description: 'The connection is gone.' },
    ...common,
  },
})

/** The caller's own calendar connection. Mounted behind the access-token middleware. */
export function createCalendarRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(start, async (c) => c.json(await Calendar.start(container, callerOf(c)), 200))

  router.openapi(complete, async (c) =>
    c.json(await Calendar.complete(container, callerOf(c), c.req.valid('json')), 200)
  )

  router.openapi(get, async (c) => c.json(await Calendar.status(container, callerOf(c)), 200))

  router.openapi(disconnect, async (c) => {
    await Calendar.disconnect(container, callerOf(c))
    return c.body(null, 204)
  })

  return router
}

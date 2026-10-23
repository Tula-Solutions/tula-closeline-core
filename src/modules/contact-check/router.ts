import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { contactCheckLogPageSchema, listContactChecksQuerySchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as ContactChecks from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/contact-checks',
  tags: ['contact-checks'],
  summary: 'List the Contact Check log',
  description:
    'Owner and Admin only. Every Contact Check answered for the Organization in the last 90 days, ' +
    'newest first, narrowed by channel, purpose, outcome (`allowed`), Prospect or denial code. ' +
    'An entry holds no address and no message. Cursor pagination, at most 100 per page.',
  security,
  request: { query: listContactChecksQuerySchema },
  responses: {
    200: {
      description: 'One page of log entries.',
      content: { 'application/json': { schema: contactCheckLogPageSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Contact Check log of the caller's Organization. Mounted behind the access-token middleware. */
export function createContactCheckRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await ContactChecks.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  return router
}

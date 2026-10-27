import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  ANALYTICS_ROUTES,
  conversationParamsSchema,
  conversationSummarySchema,
  publicApiExtensions,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Summaries from './service'

const getSummary = createRoute({
  method: 'get',
  path: '/conversations/{conversationId}/summary',
  ...publicApiExtensions(ANALYTICS_ROUTES.getConversationSummary),
  tags: ['analytics'],
  summary: 'Get the summary of a Conversation',
  description:
    'All roles, for a Conversation the caller may see: a Rep their own, a Manager those of their ' +
    'Team, an Admin and Owner all. The summary and Outcome label only, never a Message body. The ' +
    'summary is untrusted model output: show it as plain text. A Conversation without a summary ' +
    'yet, one the caller may not see, one that does not exist and one of another Organization are ' +
    'all `request.not_found`, never 403.',
  security: [{ [PUBLIC_SECURITY]: [] }],
  request: { params: conversationParamsSchema },
  responses: {
    200: {
      description: 'The summary and Outcome label.',
      content: { 'application/json': { schema: conversationSummarySchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('request.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Conversation summary read route, behind the access-token middleware. */
export function createConversationSummaryRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()
  router.openapi(getSummary, async (c) =>
    c.json(
      await Summaries.getSummary(container, callerOf(c), c.req.valid('param').conversationId),
      200
    )
  )
  return router
}

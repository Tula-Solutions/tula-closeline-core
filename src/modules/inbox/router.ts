import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  conversationMessageParamsSchema,
  conversationPageSchema,
  conversationParamsSchema,
  conversationSchema,
  correctClassificationRequestSchema,
  INBOX_ROUTES,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  messagePageSchema,
  messageSchema,
  publicApiExtensions,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Inbox from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/conversations',
  ...publicApiExtensions(INBOX_ROUTES.listConversations),
  tags: ['inbox'],
  summary: 'List the Conversations you may see',
  description:
    'Any role. Owner and Admin see every Conversation, a Manager those of Prospects owned by ' +
    'them or by the Reps who share a Team with them, a Rep those of their own Prospects. ' +
    'Filters (channel, state, controller, label, Prospect) only narrow that. Latest activity ' +
    'first, cursor pagination, at most 100 per page.',
  security,
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      description: 'One page of Conversations.',
      content: { 'application/json': { schema: conversationPageSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/conversations/{conversationId}',
  ...publicApiExtensions(INBOX_ROUTES.getConversation),
  tags: ['inbox'],
  summary: 'Get a Conversation',
  description:
    'Any role, for a Conversation the caller may see. One the caller may not see, one that does ' +
    'not exist and one of another Organization are all `inbox.conversation_not_found`, never 403.',
  security,
  request: { params: conversationParamsSchema },
  responses: {
    200: {
      description: 'The Conversation.',
      content: { 'application/json': { schema: conversationSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('inbox.conversation_not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const messages = createRoute({
  method: 'get',
  path: '/conversations/{conversationId}/messages',
  ...publicApiExtensions(INBOX_ROUTES.listConversationMessages),
  tags: ['inbox'],
  summary: 'List the Messages of a Conversation',
  description:
    'Any role, for a Conversation the caller may see (otherwise `inbox.conversation_not_found`). ' +
    'Oldest first, cursor pagination, at most 100 per page.',
  security,
  request: { params: conversationParamsSchema, query: listMessagesQuerySchema },
  responses: {
    200: {
      description: 'One page of Messages.',
      content: { 'application/json': { schema: messagePageSchema } },
    },
    400: errorResponse('The path, the query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('inbox.conversation_not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const correct = createRoute({
  method: 'put',
  path: '/conversations/{conversationId}/messages/{messageId}/classification',
  ...publicApiExtensions(INBOX_ROUTES.correctClassification),
  tags: ['inbox'],
  summary: 'Correct the label of an inbound Message',
  description:
    'Any role, for a Conversation the caller may see (otherwise `inbox.conversation_not_found`). ' +
    'Replaces the label with one of the closed set and records who corrected it and when. A ' +
    'repeat with the same label changes nothing. A correction to `unsubscribe` or `bounce` stops ' +
    'the Conversation and publishes `reply.classified`. An outbound Message has no label ' +
    '(`inbox.message_not_inbound`).',
  security,
  request: {
    params: conversationMessageParamsSchema,
    body: { content: { 'application/json': { schema: correctClassificationRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The Message with its corrected label.',
      content: { 'application/json': { schema: messageSchema } },
    },
    400: errorResponse('The path or the body is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse(
      'inbox.conversation_not_found, inbox.message_not_found, or organization.not_found.'
    ),
    409: errorResponse('inbox.message_not_inbound'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The inbox routes (Conversations and their Messages), behind the access-token middleware. */
export function createInboxRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Inbox.listConversations(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(
      await Inbox.getConversation(container, callerOf(c), c.req.valid('param').conversationId),
      200
    )
  )

  router.openapi(messages, async (c) =>
    c.json(
      await Inbox.listMessages(
        container,
        callerOf(c),
        c.req.valid('param').conversationId,
        c.req.valid('query')
      ),
      200
    )
  )

  router.openapi(correct, async (c) =>
    c.json(
      await Inbox.correctClassification(
        container,
        callerOf(c),
        c.req.valid('param'),
        c.req.valid('json'),
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  return router
}

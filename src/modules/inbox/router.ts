import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  approvalPoliciesSchema,
  approvalPolicySchema,
  approvalQueuePageSchema,
  approveDraftRequestSchema,
  channelParamsSchema,
  conversationMessageParamsSchema,
  conversationPageSchema,
  conversationParamsSchema,
  conversationSchema,
  correctClassificationRequestSchema,
  decisionPageSchema,
  draftParamsSchema,
  draftSchema,
  draftSourcesSchema,
  INBOX_ROUTES,
  inboxKeyedHeadersSchema,
  listApprovalQueueQuerySchema,
  listConversationsQuerySchema,
  listDecisionsQuerySchema,
  listMessagesQuerySchema,
  messagePageSchema,
  messageSchema,
  publicApiExtensions,
  rejectDraftRequestSchema,
  replyRequestSchema,
  setApprovalPolicyRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Approval from './approval'
import * as Escalation from './escalation'
import {
  escalationRulePageSchema,
  escalationRuleSchema,
  escalationTriggerParamsSchema,
  listEscalationRulesQuerySchema,
  setEscalationRuleRequestSchema,
} from './escalation-schema'
import * as Inbox from './service'
import * as Takeover from './takeover'

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

const common = {
  400: errorResponse('The path, the query, the header or the body is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const keyed = {
  409: errorResponseWithRetryAfter(
    'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
      'running (see Retry-After and details.retryAfter, in seconds).'
  ),
  422: errorResponse(
    'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
  ),
}

const queue = createRoute({
  method: 'get',
  path: '/approvals',
  ...publicApiExtensions(INBOX_ROUTES.listApprovalQueue),
  tags: ['inbox'],
  summary: 'List the Drafts waiting for approval',
  description:
    'Any role. The pending Drafts of Conversations the caller may see (Owner and Admin all, a ' +
    'Manager their Team, a Rep their own), oldest first, cursor pagination, at most 100 per page. ' +
    '`canApprove` says whether the caller may decide the Draft now.',
  security,
  request: { query: listApprovalQueueQuerySchema },
  responses: {
    200: {
      description: 'One page of the approval queue.',
      content: { 'application/json': { schema: approvalQueuePageSchema } },
    },
    ...common,
    404: errorResponse('organization.not_found'),
  },
})

const getOneDraft = createRoute({
  method: 'get',
  path: '/drafts/{draftId}',
  ...publicApiExtensions(INBOX_ROUTES.getDraft),
  tags: ['inbox'],
  summary: 'Get a Draft',
  description:
    'Any role, for a Draft of a Conversation the caller may see. Any other, and one of another ' +
    'Organization, is `inbox.draft_not_found`, never 403.',
  security,
  request: { params: draftParamsSchema },
  responses: {
    200: {
      description: 'The Draft with its reason, checks, hold and Sources.',
      content: { 'application/json': { schema: draftSchema } },
    },
    ...common,
    404: errorResponse('inbox.draft_not_found, or organization.not_found.'),
  },
})

const sources = createRoute({
  method: 'get',
  path: '/drafts/{draftId}/sources',
  ...publicApiExtensions(INBOX_ROUTES.getDraftSources),
  tags: ['inbox'],
  summary: 'Read the Sources of a Draft with their passages',
  description:
    'Any role, for a Draft the caller may see. The passages come from the Playbook, for display ' +
    'only, and are untrusted text. A Playbook that does not answer is `server.unavailable` or ' +
    '`server.timeout`; the Draft itself stays readable.',
  security,
  request: { params: draftParamsSchema },
  responses: {
    200: {
      description: 'The Sources with their passages.',
      content: { 'application/json': { schema: draftSourcesSchema } },
    },
    ...common,
    404: errorResponse('inbox.draft_not_found, or organization.not_found.'),
    503: errorResponse('server.unavailable: the Playbook could not be reached.'),
    504: errorResponse('server.timeout: the Playbook did not answer in time.'),
  },
})

const approve = createRoute({
  method: 'post',
  path: '/drafts/{draftId}/approve',
  ...publicApiExtensions(INBOX_ROUTES.approveDraft),
  tags: ['inbox'],
  summary: 'Approve a Draft, optionally with edits',
  description:
    'Any role, for a Draft the caller may see. With `body` the Draft is sent with that text ' +
    '(an edit-approve) and the Decision keeps only its SHA-256. An ungrounded Draft needs ' +
    '`acknowledgeUngrounded`. Exactly one `message.approved` is published, whoever races. ' +
    'Requires an `Idempotency-Key`.',
  security,
  request: {
    headers: inboxKeyedHeadersSchema,
    params: draftParamsSchema,
    body: {
      required: false,
      content: { 'application/json': { schema: approveDraftRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The approved Draft.',
      content: { 'application/json': { schema: draftSchema } },
    },
    ...common,
    404: errorResponse('inbox.draft_not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'inbox.draft_not_pending, inbox.conversation_closed, inbox.prospect_suppressed, or ' +
        'request.idempotency_in_progress (see Retry-After).'
    ),
    422: errorResponse(
      'inbox.draft_ungrounded, or request.idempotency_key_reused: the Idempotency-Key was used ' +
        'for a different request.'
    ),
  },
})

const reject = createRoute({
  method: 'post',
  path: '/drafts/{draftId}/reject',
  ...publicApiExtensions(INBOX_ROUTES.rejectDraft),
  tags: ['inbox'],
  summary: 'Reject a Draft',
  description:
    'Any role, for a Draft the caller may see. The Draft is never sent; the Decision keeps who, ' +
    'when and the optional note. Requires an `Idempotency-Key`.',
  security,
  request: {
    headers: inboxKeyedHeadersSchema,
    params: draftParamsSchema,
    body: {
      required: false,
      content: { 'application/json': { schema: rejectDraftRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The rejected Draft.',
      content: { 'application/json': { schema: draftSchema } },
    },
    ...common,
    404: errorResponse('inbox.draft_not_found, or organization.not_found.'),
    409: keyed[409],
    422: keyed[422],
  },
})

const reply = createRoute({
  method: 'post',
  path: '/conversations/{conversationId}/replies',
  ...publicApiExtensions(INBOX_ROUTES.replyToConversation),
  tags: ['inbox'],
  summary: "Send the controlling Rep's own reply",
  description:
    'Only the Rep in control of the Conversation. Records an approved Rep Draft and publishes ' +
    '`message.approved`. While the Agent is in control it is `inbox.takeover_required`. ' +
    'Requires an `Idempotency-Key`.',
  security,
  request: {
    headers: inboxKeyedHeadersSchema,
    params: conversationParamsSchema,
    body: { required: true, content: { 'application/json': { schema: replyRequestSchema } } },
  },
  responses: {
    202: {
      description: 'The approved Rep Draft, on its way to the channel.',
      content: { 'application/json': { schema: draftSchema } },
    },
    ...common,
    403: errorResponse('auth.forbidden, organization.suspended, or inbox.not_conversation_owner.'),
    404: errorResponse('inbox.conversation_not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'inbox.takeover_required, inbox.conversation_closed, inbox.prospect_suppressed, or ' +
        'request.idempotency_in_progress (see Retry-After).'
    ),
    422: keyed[422],
  },
})

const takeOver = createRoute({
  method: 'post',
  path: '/conversations/{conversationId}/takeover',
  ...publicApiExtensions(INBOX_ROUTES.takeOverConversation),
  tags: ['inbox'],
  summary: 'Take over a Conversation',
  description:
    'Any role, for a Conversation the caller may see (a Rep their own, a Manager their Team, an ' +
    'Admin and Owner any). The caller becomes the controller, every pending Draft is voided and ' +
    '`conversation.taken_over` is published. Taking over what the caller already controls answers ' +
    '200 and publishes nothing again. Requires an `Idempotency-Key`.',
  security,
  request: { headers: inboxKeyedHeadersSchema, params: conversationParamsSchema },
  responses: {
    200: {
      description: 'The Conversation, as it stands now.',
      content: { 'application/json': { schema: conversationSchema } },
    },
    ...common,
    404: errorResponse('inbox.conversation_not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'inbox.already_controlled, inbox.conversation_closed, or ' +
        'request.idempotency_in_progress (see Retry-After).'
    ),
    422: keyed[422],
  },
})

const handBack = createRoute({
  method: 'post',
  path: '/conversations/{conversationId}/handback',
  ...publicApiExtensions(INBOX_ROUTES.handBackConversation),
  tags: ['inbox'],
  summary: 'Hand a Conversation back to the Agent',
  description:
    'Only the Rep who took the Conversation over, or an Admin or Owner. The Agent is in control ' +
    'again, `conversation.handed_back` is published, and new replies are classified and drafted ' +
    'again. Requires an `Idempotency-Key`.',
  security,
  request: { headers: inboxKeyedHeadersSchema, params: conversationParamsSchema },
  responses: {
    200: {
      description: 'The Conversation, as it stands now.',
      content: { 'application/json': { schema: conversationSchema } },
    },
    ...common,
    403: errorResponse('auth.forbidden, organization.suspended, or inbox.not_conversation_owner.'),
    404: errorResponse('inbox.conversation_not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'inbox.not_taken_over, or request.idempotency_in_progress (see Retry-After).'
    ),
    422: keyed[422],
  },
})

const decisions = createRoute({
  method: 'get',
  path: '/decisions',
  ...publicApiExtensions(INBOX_ROUTES.listDecisions),
  tags: ['inbox'],
  summary: 'List the approval Decisions',
  description:
    'Owner, Admin and Manager. Decisions on Conversations the caller may see, newest first, ' +
    'cursor pagination, at most 100 per page. An edit shows no text, only that it was edited.',
  security,
  request: { query: listDecisionsQuerySchema },
  responses: {
    200: {
      description: 'One page of Decisions.',
      content: { 'application/json': { schema: decisionPageSchema } },
    },
    ...common,
    404: errorResponse('organization.not_found'),
  },
})

const policies = createRoute({
  method: 'get',
  path: '/approval-policies',
  ...publicApiExtensions(INBOX_ROUTES.listApprovalPolicies),
  tags: ['inbox'],
  summary: 'List the approval policies',
  description: 'Owner and Admin. One entry per channel; a channel nobody set follows `always`.',
  security,
  responses: {
    200: {
      description: 'The policy of each channel.',
      content: { 'application/json': { schema: approvalPoliciesSchema } },
    },
    ...common,
    404: errorResponse('organization.not_found'),
  },
})

const setPolicy = createRoute({
  method: 'put',
  path: '/approval-policies/{channel}',
  ...publicApiExtensions(INBOX_ROUTES.setApprovalPolicy),
  tags: ['inbox'],
  summary: 'Set the approval policy of a channel',
  description:
    "Owner and Admin. Replaces the channel's rule. No rule releases an ungrounded Draft, one " +
    'that failed a check, one of an escalated Conversation or a first message.',
  security,
  request: {
    params: channelParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setApprovalPolicyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The policy now in force.',
      content: { 'application/json': { schema: approvalPolicySchema } },
    },
    ...common,
    404: errorResponse('organization.not_found'),
  },
})

const listRules = createRoute({
  method: 'get',
  path: '/escalation-rules',
  tags: ['inbox'],
  summary: 'List the escalation rules',
  description:
    'Owner and Admin. The rules in trigger order, cursor pagination, at most 100 per page.',
  security,
  request: { query: listEscalationRulesQuerySchema },
  responses: {
    200: {
      description: 'One page of escalation rules.',
      content: { 'application/json': { schema: escalationRulePageSchema } },
    },
    ...common,
    404: errorResponse('organization.not_found'),
  },
})

const setRule = createRoute({
  method: 'put',
  path: '/escalation-rules/{trigger}',
  tags: ['inbox'],
  summary: 'Set the escalation rule of a trigger',
  description:
    'Owner and Admin. Replaces the rule of the trigger. A reply that matches escalates its ' +
    'Conversation once, to the Prospect owner, a Team round-robin or the Admin queue. ' +
    '`teamId` is required for `team_round_robin` and `threshold` for `low_confidence`, and ' +
    'neither is allowed otherwise.',
  security,
  request: {
    params: escalationTriggerParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setEscalationRuleRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The rule now in force.',
      content: { 'application/json': { schema: escalationRuleSchema } },
    },
    ...common,
    404: errorResponse('organization.not_found, or team.not_found.'),
  },
})

const deleteRule = createRoute({
  method: 'delete',
  path: '/escalation-rules/{trigger}',
  tags: ['inbox'],
  summary: 'Delete the escalation rule of a trigger',
  description: 'Owner and Admin. A writer failure still escalates without a rule.',
  security,
  request: { params: escalationTriggerParamsSchema },
  responses: {
    204: { description: 'The rule is deleted.' },
    ...common,
    404: errorResponse('escalation_rule.not_found, or organization.not_found.'),
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

  router.openapi(queue, async (c) =>
    c.json(await Approval.listApprovalQueue(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(getOneDraft, async (c) =>
    c.json(await Approval.getDraft(container, callerOf(c), c.req.valid('param').draftId), 200)
  )

  router.openapi(sources, async (c) =>
    c.json(
      await Approval.getDraftSources(container, callerOf(c), c.req.valid('param').draftId),
      200
    )
  )

  router.openapi(approve, async (c) => {
    const answer = await Approval.approveDraft(
      container,
      callerOf(c),
      c.req.valid('param').draftId,
      c.req.valid('json') ?? { acknowledgeUngrounded: false },
      { idempotencyKey: c.req.valid('header')['idempotency-key'], traceId: c.get('requestId') }
    )
    return c.json(answer.body, 200)
  })

  router.openapi(reject, async (c) => {
    const answer = await Approval.rejectDraft(
      container,
      callerOf(c),
      c.req.valid('param').draftId,
      c.req.valid('json') ?? {},
      { idempotencyKey: c.req.valid('header')['idempotency-key'], traceId: c.get('requestId') }
    )
    return c.json(answer.body, 200)
  })

  router.openapi(reply, async (c) => {
    const answer = await Approval.replyToConversation(
      container,
      callerOf(c),
      c.req.valid('param').conversationId,
      c.req.valid('json'),
      { idempotencyKey: c.req.valid('header')['idempotency-key'], traceId: c.get('requestId') }
    )
    return c.json(answer.body, 202)
  })

  router.openapi(takeOver, async (c) => {
    const answer = await Takeover.takeOverConversation(
      container,
      callerOf(c),
      c.req.valid('param').conversationId,
      { idempotencyKey: c.req.valid('header')['idempotency-key'], traceId: c.get('requestId') }
    )
    return c.json(answer.body, 200)
  })

  router.openapi(handBack, async (c) => {
    const answer = await Takeover.handBackConversation(
      container,
      callerOf(c),
      c.req.valid('param').conversationId,
      { idempotencyKey: c.req.valid('header')['idempotency-key'], traceId: c.get('requestId') }
    )
    return c.json(answer.body, 200)
  })

  router.openapi(decisions, async (c) =>
    c.json(await Approval.listDecisions(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(policies, async (c) =>
    c.json(await Approval.listApprovalPolicies(container, callerOf(c)), 200)
  )

  router.openapi(setPolicy, async (c) =>
    c.json(
      await Approval.setApprovalPolicy(
        container,
        callerOf(c),
        c.req.valid('param').channel,
        c.req.valid('json').rule
      ),
      200
    )
  )

  router.openapi(listRules, async (c) =>
    c.json(await Escalation.listEscalationRules(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(setRule, async (c) =>
    c.json(
      await Escalation.setEscalationRule(
        container,
        callerOf(c),
        c.req.valid('param').trigger,
        c.req.valid('json')
      ),
      200
    )
  )

  router.openapi(deleteRule, async (c) => {
    await Escalation.deleteEscalationRule(container, callerOf(c), c.req.valid('param').trigger)
    return c.body(null, 204)
  })

  return router
}

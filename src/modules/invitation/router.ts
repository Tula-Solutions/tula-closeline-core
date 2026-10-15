import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  invitationParamsSchema,
  invitationSchema,
  listInvitationsQuerySchema,
  listInvitationsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeader,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { createInvitationBodySchema } from './schema'
import * as Invitations from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const create = createRoute({
  method: 'post',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'Invite someone to your Organization',
  description:
    'An Owner invites for Admin, Manager or Rep; an Admin only for Manager or Rep. The invitee is ' +
    'emailed a link that is valid for 7 days, and the token is in that email only, never in a ' +
    'response. An internationalised domain is converted to its ASCII form. At most 1,000 ' +
    'Invitations are pending at once. If the email cannot be handed to the mail system the ' +
    'Invitation is revoked and the answer is server.unavailable (if even that revoke fails, revoke ' +
    'the Invitation and invite again). Accepts an `Idempotency-Key` header. The key is stored only ' +
    'once the email has been handed over: a repeat before that (the first request still running, ' +
    'or failed) is invitation.already_pending or a new attempt, as without a key; a repeat after ' +
    'that returns the first Invitation and sends no second email; the same key with a different ' +
    'request is request.idempotency_key_reused.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeader(
      'A client-chosen key, kept for 24 hours once the email has been handed over. The same key ' +
        'with the same request after that returns the first Invitation and sends nothing; the ' +
        'same key with another request is request.idempotency_key_reused (422). A repeat sent ' +
        'before the email is confirmed handed over is invitation.already_pending (409), not a ' +
        'stored answer. Without it the call is not protected against being repeated.'
    ),
    body: {
      required: true,
      content: { 'application/json': { schema: createInvitationBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'The pending Invitation.',
      content: { 'application/json': { schema: invitationSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('team.not_found, or organization.not_found.'),
    409: errorResponse(
      'invitation.already_pending: the email already has a pending Invitation, which includes a ' +
        'repeat with the same Idempotency-Key sent before the first request finished; ' +
        'invitation.already_member: the email already belongs to a member of this Organization; ' +
        'invitation.pending_limit: the Organization already has 1,000 pending Invitations.'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    429: errorResponseWithRetryAfter(
      'invitation.daily_limit: the Organization has created 2,000 Invitations in the last 24 ' +
        'hours (the only one that carries Retry-After and details.retryAfter, in seconds); or ' +
        'rate.limited: too many requests.'
    ),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the email could not be sent, or a lock timed out.'),
  },
})

const list = createRoute({
  method: 'get',
  path: '/invitations',
  tags: ['invitations'],
  summary: 'List the Invitations of your Organization',
  description:
    'Owner and Admin. Pending Invitations unless `state` says otherwise; an expired Invitation ' +
    'stays pending until it is revoked or replaced. Cursor pagination, at most 100 per page.',
  security,
  request: { query: listInvitationsQuerySchema },
  responses: {
    200: {
      description: 'One page of Invitations, newest first.',
      content: { 'application/json': { schema: listInvitationsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const revoke = createRoute({
  method: 'delete',
  path: '/invitations/{invitationId}',
  tags: ['invitations'],
  summary: 'Revoke a pending Invitation',
  description:
    'An Owner revokes any pending Invitation; an Admin only one that offers Manager or Rep. An ' +
    'Invitation that is not pending, or is not in your Organization, is invitation.not_found.',
  security,
  request: { params: invitationParamsSchema },
  responses: {
    204: { description: 'The Invitation was revoked.' },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('invitation.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Invitations of the caller's Organization. Mounted behind the access-token middleware. */
export function createInvitationRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(create, async (c) => {
    const answer = await Invitations.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(list, async (c) =>
    c.json(await Invitations.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(revoke, async (c) => {
    await Invitations.revoke(container, callerOf(c), c.req.valid('param').invitationId)
    return c.body(null, 204)
  })

  return router
}

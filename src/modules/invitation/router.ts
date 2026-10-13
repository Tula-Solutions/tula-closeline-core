import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  invitationParamsSchema,
  invitationSchema,
  listInvitationsQuerySchema,
  listInvitationsResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
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
    'the Invitation and invite again).',
  security,
  request: {
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
    409: errorResponse('invitation.already_pending'),
    410: errorResponse('organization.deleted'),
    429: errorResponse(
      'rate.limited: the Organization already has 1,000 pending Invitations, or has created 2,000 in the last 24 hours (then with a Retry-After in seconds).'
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

  router.openapi(create, async (c) =>
    c.json(await Invitations.create(container, callerOf(c), c.req.valid('json')), 201)
  )

  router.openapi(list, async (c) =>
    c.json(await Invitations.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(revoke, async (c) => {
    await Invitations.revoke(container, callerOf(c), c.req.valid('param').invitationId)
    return c.body(null, 204)
  })

  return router
}

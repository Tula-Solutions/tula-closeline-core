import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  internalAbandonOrganizationParamsSchema,
  internalAbandonOrganizationRequestSchema,
  internalAbandonOrganizationResponseSchema,
  internalAcceptInvitationResponseSchema,
  internalCreateOrganizationRequestSchema,
  internalCreateOrganizationResponseSchema,
  internalMembershipRequestSchema,
  internalMembershipResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  idempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { acceptInvitationBodySchema } from '~/modules/invitation/schema'
import * as Internal from './service'

const security = [{ [INTERNAL_SECURITY]: [] }]

const createOrganization = createRoute({
  method: 'post',
  path: '/organizations',
  tags: ['internal'],
  summary: 'Create an Organization at sign-up',
  description:
    'Called only by the auth service. Creates the Organization and the user as its Owner in one ' +
    'transaction. Idempotent on the user id: a user who already owns an Organization gets it back. ' +
    "The request's email and name are stored on the Membership as core's copy (a missing or null " +
    'name is stored as null; a replay never changes a stored copy). The contract leaves email ' +
    'optional only so core can deploy before auth sends it, but a Membership cannot exist ' +
    'without one: a request without email is refused with request.invalid before anything is ' +
    'written.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalCreateOrganizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Organization the user owns, newly created or created by an earlier call.',
      content: { 'application/json': { schema: internalCreateOrganizationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse(
      'membership.already_member: the user belongs to an Organization they do not own.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const membership = createRoute({
  method: 'post',
  path: '/membership',
  tags: ['internal'],
  summary: 'Look up the membership of a user',
  description:
    'Called only by the auth service, from the token hook on every sign-in and refresh. Two ' +
    'indexed reads. A user with no membership is answered found: false, not an error.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalMembershipRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The user is a member (with the Organization status), or is not.',
      content: { 'application/json': { schema: internalMembershipResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const acceptInvitation = createRoute({
  method: 'post',
  path: '/invitations/accept',
  tags: ['internal'],
  summary: 'Accept an Invitation at sign-up',
  description:
    'Called only by the auth service with the raw token and the verified address. Creates the ' +
    "Membership with the offered role (never Owner) and stores the request's address, which must " +
    "equal the Invitation's, and its name (null when absent) as core's copy, adds it to the " +
    "Invitation's Team if it " +
    'names one, and marks the Invitation accepted, in one transaction. A retry by the same user ' +
    'answers as the first call did. Every way the Invitation cannot be used (unknown, expired, ' +
    'revoked, used, a different address, an Organization that is not active) is the same ' +
    'invitation.invalid; an Organization status is never revealed.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: acceptInvitationBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The Organization joined and the role offered.',
      content: { 'application/json': { schema: internalAcceptInvitationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse('membership.already_member: the user belongs to an Organization.'),
    422: errorResponse('invitation.invalid'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: a lock timed out; try again.'),
  },
})

const abandonOrganization = createRoute({
  method: 'post',
  path: '/organizations/{organizationId}/abandon',
  tags: ['internal'],
  summary: 'Abandon an Organization whose Owner has no account',
  description:
    'Called only by the auth service, when the account write fails after core created the ' +
    'Organization and from its sweep of abandoned sign-ups. Defined by its end state: it answers ' +
    'status deleted whenever no live Organization with this id exists when the call returns ' +
    '(abandoned by this call, deleted or abandoned earlier, or never created), so success does ' +
    'not mean this call deleted it and a repeat, with the same key, a new key or another user, ' +
    'answers success. A live Organization is abandoned only if it has exactly one member, that ' +
    'member is the userId and it was created less than 24 hours ago by the database clock; ' +
    'otherwise organization.not_abandonable and nothing changes. The check and the delete are ' +
    'one transaction holding the Organization lock, so a concurrent accept either lands first ' +
    '(then this refuses) or finds the Organization deleted. The only member is removed in the ' +
    'same transaction, so the user id is free when it returns; Teams, Invitations and the rest ' +
    'are left to the deletion job, and a pending Invitation can no longer be accepted.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    params: internalAbandonOrganizationParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalAbandonOrganizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'No live Organization with this id exists any more.',
      content: { 'application/json': { schema: internalAbandonOrganizationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse(
      'organization.not_abandonable: a live Organization has another member, a different sole member, or is a day old or more.'
    ),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponseWithRetryAfter('server.unavailable: a lock timed out; try again.'),
  },
})

/**
 * The calls only the auth service makes, under `/internal`. They sit behind the shared secret and
 * never behind the public access-token middleware, and they take no Organization from the caller.
 */
export function createInternalRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('*', internalAuth(container.env.INTERNAL_API_TOKENS))

  router.openapi(createOrganization, async (c) =>
    c.json(await Internal.createOrganization(container, c.req.valid('json')), 200)
  )

  router.openapi(acceptInvitation, async (c) =>
    c.json(await Internal.acceptInvitation(container, c.req.valid('json')), 200)
  )

  router.openapi(abandonOrganization, async (c) =>
    c.json(
      await Internal.abandonOrganization(
        container,
        c.req.valid('param').organizationId,
        c.req.valid('json')
      ),
      200
    )
  )

  router.openapi(membership, async (c) =>
    c.json(await Internal.lookupMembership(container, c.req.valid('json').userId), 200)
  )

  return router
}

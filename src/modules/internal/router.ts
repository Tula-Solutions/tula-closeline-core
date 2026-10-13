import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  internalCreateOrganizationRequestSchema,
  internalCreateOrganizationResponseSchema,
  internalMembershipRequestSchema,
  internalMembershipResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import { errorResponse, idempotencyKeyHeaderSchema } from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import * as Internal from './service'

const security = [{ [INTERNAL_SECURITY]: [] }]

const createOrganization = createRoute({
  method: 'post',
  path: '/organizations',
  tags: ['internal'],
  summary: 'Create an Organization at sign-up',
  description:
    'Called only by the auth service. Creates the Organization and the user as its Owner in one ' +
    'transaction. Idempotent on the user id: a user who already owns an Organization gets it back.',
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

  router.openapi(membership, async (c) =>
    c.json(await Internal.lookupMembership(container, c.req.valid('json').userId), 200)
  )

  return router
}

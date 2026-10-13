import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  changeMemberRoleRequestSchema,
  listMembersQuerySchema,
  listMembersResponseSchema,
  memberParamsSchema,
  memberSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Members from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/members',
  tags: ['members'],
  summary: 'List the members of your Organization',
  description: 'Owner, Admin and Manager. Cursor pagination, at most 100 per page.',
  security,
  request: { query: listMembersQuerySchema },
  responses: {
    200: {
      description: 'One page of members.',
      content: { 'application/json': { schema: listMembersResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const changeRole = createRoute({
  method: 'patch',
  path: '/members/{membershipId}',
  tags: ['members'],
  summary: "Change a member's role",
  description:
    'An Owner changes any member to any role. An Admin changes only a Manager or Rep, and only ' +
    'to Manager or Rep. Nobody changes their own role, and the last Owner cannot be demoted.',
  security,
  request: {
    params: memberParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: changeMemberRoleRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The member with the new role.',
      content: { 'application/json': { schema: memberSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('member.not_found, or organization.not_found.'),
    409: errorResponse('member.last_owner'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/members/{membershipId}',
  tags: ['members'],
  summary: 'Remove a member',
  description:
    'An Owner removes any member. An Admin removes only a Manager or Rep. Nobody removes ' +
    'themselves, and the last Owner cannot be removed.',
  security,
  request: { params: memberParamsSchema },
  responses: {
    204: { description: 'The member was removed.' },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('member.not_found, or organization.not_found.'),
    409: errorResponse('member.last_owner'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The members of the caller's Organization. Mounted behind the access-token middleware. */
export function createMemberRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Members.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(changeRole, async (c) =>
    c.json(
      await Members.changeRole(
        container,
        callerOf(c),
        c.req.valid('param').membershipId,
        c.req.valid('json').role
      ),
      200
    )
  )

  router.openapi(remove, async (c) => {
    await Members.remove(container, callerOf(c), c.req.valid('param').membershipId)
    return c.body(null, 204)
  })

  return router
}

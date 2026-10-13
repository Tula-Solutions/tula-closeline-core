import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  addTeamMemberRequestSchema,
  createTeamRequestSchema,
  listTeamsQuerySchema,
  listTeamsResponseSchema,
  renameTeamRequestSchema,
  teamMemberParamsSchema,
  teamMemberSchema,
  teamParamsSchema,
  teamSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Teams from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/teams',
  tags: ['teams'],
  summary: 'List the Teams of your Organization',
  description: 'Any role. Cursor pagination, at most 100 per page, in Team id order.',
  security,
  request: { query: listTeamsQuerySchema },
  responses: {
    200: {
      description: 'One page of Teams.',
      content: { 'application/json': { schema: listTeamsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/teams',
  tags: ['teams'],
  summary: 'Create a Team',
  description: 'Owner and Admin. Names are unique in an Organization, ignoring ASCII case.',
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: createTeamRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The new Team.',
      content: { 'application/json': { schema: teamSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    409: errorResponse('team.name_taken'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const rename = createRoute({
  method: 'patch',
  path: '/teams/{teamId}',
  tags: ['teams'],
  summary: 'Rename a Team',
  description: 'Owner and Admin.',
  security,
  request: {
    params: teamParamsSchema,
    body: { required: true, content: { 'application/json': { schema: renameTeamRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The renamed Team.',
      content: { 'application/json': { schema: teamSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('team.not_found, or organization.not_found.'),
    409: errorResponse('team.name_taken'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/teams/{teamId}',
  tags: ['teams'],
  summary: 'Delete a Team',
  description:
    'Owner and Admin. Its members stay members of the Organization; pending Invitations that ' +
    'named the Team are kept and no longer name one.',
  security,
  request: { params: teamParamsSchema },
  responses: {
    204: { description: 'The Team was deleted.' },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('team.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const addMember = createRoute({
  method: 'post',
  path: '/teams/{teamId}/members',
  tags: ['teams'],
  summary: 'Add a member to a Team',
  description: 'Owner and Admin. Adding a member who is already in the Team succeeds.',
  security,
  request: {
    params: teamParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: addTeamMemberRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The member's place in the Team.",
      content: { 'application/json': { schema: teamMemberSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('team.not_found, member.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const removeMember = createRoute({
  method: 'delete',
  path: '/teams/{teamId}/members/{membershipId}',
  tags: ['teams'],
  summary: 'Remove a member from a Team',
  description: 'Owner and Admin. Removing a member who is not in the Team succeeds.',
  security,
  request: { params: teamMemberParamsSchema },
  responses: {
    204: { description: 'The member is not in the Team.' },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('team.not_found, member.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Teams of the caller's Organization. Mounted behind the access-token middleware. */
export function createTeamRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Teams.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(create, async (c) =>
    c.json(await Teams.create(container, callerOf(c), c.req.valid('json')), 201)
  )

  router.openapi(rename, async (c) =>
    c.json(
      await Teams.rename(container, callerOf(c), c.req.valid('param').teamId, c.req.valid('json')),
      200
    )
  )

  router.openapi(remove, async (c) => {
    await Teams.remove(container, callerOf(c), c.req.valid('param').teamId)
    return c.body(null, 204)
  })

  router.openapi(addMember, async (c) =>
    c.json(
      await Teams.addMember(
        container,
        callerOf(c),
        c.req.valid('param').teamId,
        c.req.valid('json').membershipId
      ),
      200
    )
  )

  router.openapi(removeMember, async (c) => {
    const { teamId, membershipId } = c.req.valid('param')
    await Teams.removeMember(container, callerOf(c), teamId, membershipId)
    return c.body(null, 204)
  })

  return router
}

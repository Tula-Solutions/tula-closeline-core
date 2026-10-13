import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { organizationSchema, renameOrganizationRequestSchema } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Organizations from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const read = createRoute({
  method: 'get',
  path: '/organization',
  tags: ['organization'],
  summary: 'Read your Organization',
  description: 'Any role. The Organization is the one in your access token.',
  security,
  responses: {
    200: {
      description: 'Your Organization.',
      content: { 'application/json': { schema: organizationSchema } },
    },
    401: errorResponse('The access token is missing, expired or not valid.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const rename = createRoute({
  method: 'patch',
  path: '/organization',
  tags: ['organization'],
  summary: 'Rename your Organization',
  description: 'Owner and Admin. A suspended Organization cannot be renamed.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: renameOrganizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The renamed Organization.',
      content: { 'application/json': { schema: organizationSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The caller's own Organization: read it and rename it. Mounted behind the access-token middleware. */
export function createOrganizationRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(read, async (c) => c.json(await Organizations.read(container, callerOf(c)), 200))

  router.openapi(rename, async (c) =>
    c.json(await Organizations.rename(container, callerOf(c), c.req.valid('json').name), 200)
  )

  return router
}

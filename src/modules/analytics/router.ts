import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  ANALYTICS_ERRORS,
  ANALYTICS_RANGE_ISSUE_MESSAGE,
  ANALYTICS_ROUTES,
  getSeriesQuerySchema,
  getSeriesResponseSchema,
  publicApiExtensions,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import { createRouter, invalidRequest } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Analytics from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const getSeries = createRoute({
  method: 'get',
  path: '/analytics/series',
  ...publicApiExtensions(ANALYTICS_ROUTES.getSeries),
  tags: ['analytics'],
  summary: 'Read the daily series of one metric',
  description:
    'Owner and Admin. The daily counts of one metric over a range of at most 13 months, read ' +
    'from rollups built from events. Without `groupBy` it is one line (the total, or the one ' +
    'filtered group); with it, one line per group in key order, cursor-paged by group, at most ' +
    '20 lines a page. Only days that have a count appear. One filter at most, and when `groupBy` ' +
    'is given the filter must be on the same dimension. Channel is the only dimension filled so ' +
    'far; the others are empty.',
  security,
  request: { query: getSeriesQuerySchema },
  responses: {
    200: {
      description: 'The lines of the series.',
      content: { 'application/json': { schema: getSeriesResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    422: errorResponse('analytics.range_too_large'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The analytics read routes, behind the access-token middleware. */
export function createAnalyticsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(
    getSeries,
    async (c) => c.json(await Analytics.series(container, callerOf(c), c.req.valid('query')), 200),
    (result) => {
      if (!result.success) {
        if (result.error.issues.some((issue) => issue.message === ANALYTICS_RANGE_ISSUE_MESSAGE)) {
          throw domainError(ANALYTICS_ERRORS['analytics.range_too_large'])
        }
        throw invalidRequest(result.error)
      }
    }
  )

  return router
}

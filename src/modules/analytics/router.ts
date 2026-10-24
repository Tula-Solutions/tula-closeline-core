import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  ANALYTICS_ERRORS,
  ANALYTICS_RANGE_ISSUE_MESSAGE,
  ANALYTICS_ROUTES,
  getSeriesQuerySchema,
  getSeriesResponseSchema,
  listTableQuerySchema,
  listTableResponseSchema,
  publicApiExtensions,
  tableCsvQuerySchema,
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
    'All roles, scoped: Owner and Admin read the whole Organization, a Manager the Reps on their ' +
    'Teams (their total is the sum of those Reps), a Rep only their own row. A Manager or Rep may ' +
    'group or filter only by Rep (anything else is `auth.forbidden`); a Rep outside their view is ' +
    '`request.not_found`. The daily counts, or for a ratio metric the daily rate (or "not enough ' +
    'data" under 20 records), over a range of at most 13 months, read from rollups built from ' +
    'events. Without `groupBy` it is one line (the total, or the one filtered group); with it, one ' +
    'line per group in key order, cursor-paged by group, at most 20 lines a page. Only days that ' +
    'have a count appear. One filter at most, and when `groupBy` is given the filter must be on ' +
    'the same dimension. Channel is filled for sends and replies, and Rep for meetings only; ' +
    'Agent kind and Campaign are empty until events carry them.',
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

const tableCommon = {
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden'),
  404: errorResponse('organization.not_found, or request.not_found for a Rep outside the view'),
  410: errorResponse('organization.deleted'),
  422: errorResponse('analytics.range_too_large'),
  500: errorResponse('Something went wrong on our side.'),
}

const TABLE_NOTE =
  'All roles, scoped like the series: a Manager or Rep may only group by Rep and sees only the ' +
  'Reps in their view. A filter must be on the same dimension as `groupBy`. A rate with fewer ' +
  'than 20 records is "not enough data". Rows come in group-key order.'

const listTable = createRoute({
  method: 'get',
  path: '/analytics/table',
  ...publicApiExtensions(ANALYTICS_ROUTES.listTable),
  tags: ['analytics'],
  summary: 'Compare channels, Agent kinds, Campaigns or Reps',
  description: `One row per group over a range of at most 13 months, cursor-paged, at most 100 rows. ${TABLE_NOTE}`,
  security,
  request: { query: listTableQuerySchema },
  responses: {
    200: {
      description: 'One page of rows.',
      content: { 'application/json': { schema: listTableResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    ...tableCommon,
  },
})

const downloadTableCsv = createRoute({
  method: 'get',
  path: '/analytics/table.csv',
  ...publicApiExtensions(ANALYTICS_ROUTES.downloadTableCsv),
  tags: ['analytics'],
  summary: 'Download the comparison table as CSV',
  description:
    `text/csv, at most 1,000 rows per page; the next cursor is in the \`x-next-cursor\` response ` +
    `header and is absent on the last page. A cell that starts with \`=\`, \`+\`, \`-\` or \`@\` ` +
    `is escaped. ${TABLE_NOTE}`,
  security,
  request: { query: tableCsvQuerySchema },
  responses: {
    200: {
      description: 'One page of the table as CSV.',
      headers: z.object({
        'x-next-cursor': z.string().optional().openapi({ description: 'The next page, if any.' }),
      }),
      content: { 'text/csv': { schema: z.string() } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    ...tableCommon,
  },
})

/** Maps a range-limit issue to its own error and any other to `request.invalid`. */
const onInvalid = (result: { success: boolean; error?: z.ZodError }): undefined => {
  if (!result.success && result.error) {
    if (result.error.issues.some((issue) => issue.message === ANALYTICS_RANGE_ISSUE_MESSAGE)) {
      throw domainError(ANALYTICS_ERRORS['analytics.range_too_large'])
    }
    throw invalidRequest(result.error)
  }
  return undefined
}

/** The analytics read routes, behind the access-token middleware. */
export function createAnalyticsRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(
    getSeries,
    async (c) => c.json(await Analytics.series(container, callerOf(c), c.req.valid('query')), 200),
    onInvalid
  )
  router.openapi(
    listTable,
    async (c) => c.json(await Analytics.table(container, callerOf(c), c.req.valid('query')), 200),
    onInvalid
  )
  router.openapi(
    downloadTableCsv,
    async (c) => {
      const page = await Analytics.tableCsv(container, callerOf(c), c.req.valid('query'))
      return c.body(page.body, 200, {
        'content-type': 'text/csv; charset=utf-8',
        ...(page.nextCursor === null ? {} : { 'x-next-cursor': page.nextCursor }),
      })
    },
    onInvalid
  )

  return router
}

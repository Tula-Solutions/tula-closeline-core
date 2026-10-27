import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  ANALYTICS_ERRORS,
  ANALYTICS_RANGE_ISSUE_MESSAGE,
  ASSESSMENT_ROUTES,
  assessmentSchema,
  findingSchema,
  getAssessmentRatesQuerySchema,
  getAssessmentRatesResponseSchema,
  giveFindingFeedbackRequestSchema,
  listAssessmentsQuerySchema,
  listAssessmentsResponseSchema,
  publicApiExtensions,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { domainError } from '~/http/domain-error'
import { errorResponse, errorResponseWithRetryAfter } from '~/http/responses'
import { createRouter, invalidRequest } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { assessmentParamsSchema, findingParamsSchema, optionalKeyHeadersSchema } from './schema'
import * as Assessments from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const list = createRoute({
  method: 'get',
  path: '/assessments',
  ...publicApiExtensions(ASSESSMENT_ROUTES.listAssessments),
  tags: ['assessments'],
  summary: 'List the Assessed Call turns',
  description:
    'Owner and Admin; a Manager or Rep is `auth.forbidden`. Every finished Agent turn gets one Assessment. `sort=worst_first` puts the ' +
    'worst severity first, then the newest, and lists flagged turns only (no `pass`) unless a `verdict` is given; the default is newest first, every verdict. Cursor-paged, at most ' +
    '100 a page. A turn that could not be judged has no Assessment. Findings hold spans, never text.',
  security,
  request: { query: listAssessmentsQuerySchema },
  responses: {
    200: {
      description: 'One page of Assessments.',
      content: { 'application/json': { schema: listAssessmentsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    ...common,
    404: errorResponse('organization.not_found'),
    422: errorResponse('analytics.range_too_large'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/assessments/{assessmentId}',
  ...publicApiExtensions(ASSESSMENT_ROUTES.getAssessment),
  tags: ['assessments'],
  summary: 'Read one Assessment',
  description:
    'Any role, for a turn of a Prospect the caller may see; anything else is ' +
    '`assessment.not_found`.',
  security,
  request: { params: assessmentParamsSchema },
  responses: {
    200: {
      description: 'The Assessment with its findings.',
      content: { 'application/json': { schema: assessmentSchema } },
    },
    400: errorResponse('The path is not valid.'),
    ...common,
    404: errorResponse('assessment.not_found, or organization.not_found.'),
  },
})

const feedback = createRoute({
  method: 'post',
  path: '/assessments/{assessmentId}/findings/{findingId}/feedback',
  ...publicApiExtensions(ASSESSMENT_ROUTES.giveFindingFeedback),
  tags: ['assessments'],
  summary: 'Mark a finding correct or a false alarm',
  description:
    'Owner and Admin. Keeps who and when. The same mark again changes nothing; another mark ' +
    'replaces it. A false alarm stops counting towards the failed rate. An `Idempotency-Key` is ' +
    'optional.',
  security,
  request: {
    headers: optionalKeyHeadersSchema,
    params: findingParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: giveFindingFeedbackRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The finding with its mark.',
      content: { 'application/json': { schema: findingSchema } },
    },
    400: errorResponse('The path, the header or the body is not valid.'),
    ...common,
    404: errorResponse('assessment.not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
        'running (see Retry-After).'
    ),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
  },
})

const rates = createRoute({
  method: 'get',
  path: '/assessment-rates',
  ...publicApiExtensions(ASSESSMENT_ROUTES.getAssessmentRates),
  tags: ['assessments'],
  summary: 'Read the weekly failed rate',
  description:
    'Owner and Admin. One item per ISO week, Agent kind and instruction version over a range of ' +
    'at most 13 months, oldest week first, cursor-paged. A fail whose findings are all marked ' +
    'false alarms does not count. Under 20 Assessments a week the rate is "not enough data". `groupBy=category` gives one ' +
    'item per finding category with a counted failing finding; `category` is null otherwise.',
  security,
  request: { query: getAssessmentRatesQuerySchema },
  responses: {
    200: {
      description: 'One page of weekly rates.',
      content: { 'application/json': { schema: getAssessmentRatesResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    ...common,
    404: errorResponse('organization.not_found'),
    422: errorResponse('analytics.range_too_large'),
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

/** The Assessment review routes, behind the access-token middleware. */
export function createAssessmentRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(
    list,
    async (c) => c.json(await Assessments.list(container, callerOf(c), c.req.valid('query')), 200),
    onInvalid
  )
  router.openapi(get, async (c) =>
    c.json(await Assessments.get(container, callerOf(c), c.req.valid('param').assessmentId), 200)
  )
  router.openapi(feedback, async (c) => {
    const answer = await Assessments.giveFeedback(
      container,
      callerOf(c),
      c.req.valid('param'),
      c.req.valid('json'),
      { idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, 200)
  })
  router.openapi(
    rates,
    async (c) => c.json(await Assessments.rates(container, callerOf(c), c.req.valid('query')), 200),
    onInvalid
  )

  return router
}

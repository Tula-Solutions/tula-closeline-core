import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  BOOKING_ROUTES,
  createRoutingRuleRequestSchema,
  listRoutingRulesQuerySchema,
  pageSchema,
  reorderRoutingRulesRequestSchema,
  routeRequestSchema,
  routingResultSchema,
  routingRuleParamsSchema,
  routingRuleSchema,
  testRoutingRequestSchema,
  updateRoutingRuleRequestSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Routing from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const rulePageSchema = pageSchema(routingRuleSchema)

const common = {
  400: errorResponse('The request is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden, or organization.suspended.'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
}

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const list = createRoute({
  method: 'get',
  path: '/routing-rules',
  tags: ['booking'],
  summary: 'List Routing Rules',
  description: BOOKING_ROUTES.listRoutingRules.description,
  security,
  request: { query: listRoutingRulesQuerySchema },
  responses: {
    ...common,
    200: {
      description: 'One page of rules, in the order they are tried.',
      content: json(rulePageSchema),
    },
    404: errorResponse('organization.not_found'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/routing-rules',
  tags: ['booking'],
  summary: 'Create a Routing Rule',
  description: BOOKING_ROUTES.createRoutingRule.description,
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: { required: true, content: json(createRoutingRuleRequestSchema) },
  },
  responses: {
    ...common,
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: json(routingRuleSchema),
    },
    201: { description: 'The new rule.', content: json(routingRuleSchema) },
    404: errorResponse('routing.rule_not_found, or organization.not_found'),
    409: errorResponseWithRetryAfter(
      'request.idempotency_in_progress: the first request with this Idempotency-Key is still running.'
    ),
    422: errorResponse(
      'routing.rule_invalid, or request.idempotency_key_reused: the key was used for a different request.'
    ),
  },
})

const get = createRoute({
  method: 'get',
  path: '/routing-rules/{ruleId}',
  tags: ['booking'],
  summary: 'Read a Routing Rule',
  description: BOOKING_ROUTES.getRoutingRule.description,
  security,
  request: { params: routingRuleParamsSchema },
  responses: {
    ...common,
    200: { description: 'The rule.', content: json(routingRuleSchema) },
    404: errorResponse('routing.rule_not_found, or organization.not_found'),
  },
})

const update = createRoute({
  method: 'put',
  path: '/routing-rules/{ruleId}',
  tags: ['booking'],
  summary: 'Replace a Routing Rule',
  description: BOOKING_ROUTES.updateRoutingRule.description,
  security,
  request: {
    params: routingRuleParamsSchema,
    body: { required: true, content: json(updateRoutingRuleRequestSchema) },
  },
  responses: {
    ...common,
    200: { description: 'The rule after the change.', content: json(routingRuleSchema) },
    404: errorResponse('routing.rule_not_found, or organization.not_found'),
    422: errorResponse('routing.rule_invalid'),
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/routing-rules/{ruleId}',
  tags: ['booking'],
  summary: 'Delete a Routing Rule',
  description: BOOKING_ROUTES.deleteRoutingRule.description,
  security,
  request: { params: routingRuleParamsSchema },
  responses: {
    ...common,
    204: { description: 'The rule is gone.' },
    404: errorResponse('routing.rule_not_found, or organization.not_found'),
  },
})

const reorder = createRoute({
  method: 'post',
  path: '/routing-rules/reorder',
  tags: ['booking'],
  summary: 'Reorder Routing Rules',
  description: BOOKING_ROUTES.reorderRoutingRules.description,
  security,
  request: { body: { required: true, content: json(reorderRoutingRulesRequestSchema) } },
  responses: {
    ...common,
    200: {
      description: 'The first page of rules in the new order.',
      content: json(rulePageSchema),
    },
    404: errorResponse('organization.not_found'),
    422: errorResponse('routing.rule_invalid'),
  },
})

const test = createRoute({
  method: 'post',
  path: '/routing-rules/test',
  tags: ['booking'],
  summary: 'Test the Routing Rules',
  description: BOOKING_ROUTES.testRouting.description,
  security,
  request: { body: { required: true, content: json(testRoutingRequestSchema) } },
  responses: {
    ...common,
    200: {
      description: 'Who the sample would be routed to; nothing is stored.',
      content: json(routingResultSchema),
    },
    404: errorResponse('organization.not_found'),
  },
})

const route = createRoute({
  method: 'post',
  path: '/routing/route',
  tags: ['booking'],
  summary: 'Route a Prospect',
  description: BOOKING_ROUTES.route.description,
  security,
  request: { body: { required: true, content: json(routeRequestSchema) } },
  responses: {
    ...common,
    200: {
      description: 'The ordered candidates and the skipped Reps.',
      content: json(routingResultSchema),
    },
    404: errorResponse('prospect.not_found, or organization.not_found'),
  },
})

/** The routes that manage Routing Rules and route a Prospect. */
export function createRoutingRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Routing.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Routing.get(container, callerOf(c), c.req.valid('param').ruleId), 200)
  )
  router.openapi(create, async (c) => {
    const answer = await Routing.create(container, callerOf(c), c.req.valid('json'), {
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })
  router.openapi(update, async (c) =>
    c.json(
      await Routing.update(
        container,
        callerOf(c),
        c.req.valid('param').ruleId,
        c.req.valid('json')
      ),
      200
    )
  )
  router.openapi(remove, async (c) => {
    await Routing.remove(container, callerOf(c), c.req.valid('param').ruleId)
    return c.body(null, 204)
  })
  router.openapi(reorder, async (c) =>
    c.json(await Routing.reorder(container, callerOf(c), c.req.valid('json').ruleIds), 200)
  )
  router.openapi(test, async (c) =>
    c.json(await Routing.test(container, callerOf(c), c.req.valid('json')), 200)
  )
  router.openapi(route, async (c) =>
    c.json(await Routing.route(container, callerOf(c), c.req.valid('json')), 200)
  )

  return router
}

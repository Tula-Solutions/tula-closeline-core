import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  addSuppressionRequestSchema,
  CONSENT_ROUTES,
  listSuppressionEntriesQuerySchema,
  lookupSuppressionRequestSchema,
  publicApiExtensions,
  removeSuppressionRequestSchema,
  suppressionEntryPageSchema,
  suppressionEntryParamsSchema,
  suppressionEntrySchema,
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
import * as Suppression from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const add = createRoute({
  method: 'post',
  path: '/suppression-entries',
  ...publicApiExtensions(CONSENT_ROUTES.addSuppression),
  tags: ['suppression'],
  summary: 'Add an address to the Suppression list',
  description:
    'Owner and Admin only. Exactly one of `email`, `phone` or `linkedinUrl`, and an optional ' +
    'note. The reason is `manual`. Only a salted hash and a masked form of the address are ' +
    'stored. No Contact Check allows a suppressed address, on any channel, for any purpose. An ' +
    'address already on the list answers its live entry (200) and writes nothing. Accepts an ' +
    '`Idempotency-Key` header: a repeat with the same key and body returns the first entry (200). ' +
    'Publishes `suppression.added` when it adds one.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: addSuppressionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The entry the address already had, or the first entry for a repeated key.',
      content: { 'application/json': { schema: suppressionEntrySchema } },
    },
    201: {
      description: 'The new entry.',
      content: { 'application/json': { schema: suppressionEntrySchema } },
    },
    400: errorResponse('The request is not valid, or the address cannot be normalised.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    409: errorResponseWithRetryAfter(
      'request.idempotency_in_progress: the first request with this Idempotency-Key is still ' +
        'running (see Retry-After and details.retryAfter, in seconds).'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const list = createRoute({
  method: 'get',
  path: '/suppression-entries',
  ...publicApiExtensions(CONSENT_ROUTES.listSuppressionEntries),
  tags: ['suppression'],
  summary: 'List the Suppression entries',
  description:
    'Owner and Admin only. The live entries by default, newest first; `state=removed` lists the ' +
    'removed ones, newest removal first. Filters on the reason and the address kind. Cursor ' +
    'pagination, at most 100 per page.',
  security,
  request: { query: listSuppressionEntriesQuerySchema },
  responses: {
    200: {
      description: 'One page of entries.',
      content: { 'application/json': { schema: suppressionEntryPageSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const lookup = createRoute({
  method: 'post',
  path: '/suppression-entries/lookups',
  ...publicApiExtensions(CONSENT_ROUTES.lookupSuppression),
  tags: ['suppression'],
  summary: 'Look an address up on the Suppression list',
  description:
    'Owner and Admin only. Exactly one of `email`, `phone` or `linkedinUrl`. Answers a page with ' +
    'the live entry for the address, or an empty one; `nextCursor` is always null. Changes ' +
    'nothing.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: lookupSuppressionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The live entry for the address, if any.',
      content: { 'application/json': { schema: suppressionEntryPageSchema } },
    },
    400: errorResponse('The request is not valid, or the address cannot be normalised.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/suppression-entries/{entryId}',
  ...publicApiExtensions(CONSENT_ROUTES.getSuppressionEntry),
  tags: ['suppression'],
  summary: 'Get a Suppression entry',
  description:
    'Owner and Admin only. A live or removed entry. One that does not exist and one of another ' +
    'Organization are both `consent.not_found`.',
  security,
  request: { params: suppressionEntryParamsSchema },
  responses: {
    200: {
      description: 'The entry.',
      content: { 'application/json': { schema: suppressionEntrySchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('consent.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const remove = createRoute({
  method: 'post',
  path: '/suppression-entries/{entryId}/removal',
  ...publicApiExtensions(CONSENT_ROUTES.removeSuppression),
  tags: ['suppression'],
  summary: 'Remove a manual Suppression entry',
  description:
    'Owner and Admin only, with a reason. Only an entry added by hand (`manual`) can be removed; ' +
    'a stop, bounce, complaint or erasure stays (`consent.entry_not_removable`). Removing an ' +
    'entry already removed answers it as it is. Publishes `suppression.removed`.',
  security,
  request: {
    params: suppressionEntryParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: removeSuppressionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The removed entry.',
      content: { 'application/json': { schema: suppressionEntrySchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('consent.not_found, or organization.not_found.'),
    409: errorResponse('consent.entry_not_removable'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Suppression list of the caller's Organization. Mounted behind the access-token middleware. */
export function createSuppressionRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(add, async (c) => {
    const answer = await Suppression.add(container, callerOf(c), c.req.valid('json'), {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(list, async (c) =>
    c.json(await Suppression.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(lookup, async (c) =>
    c.json(await Suppression.lookup(container, callerOf(c), c.req.valid('json')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(await Suppression.get(container, callerOf(c), c.req.valid('param').entryId), 200)
  )

  router.openapi(remove, async (c) =>
    c.json(
      await Suppression.remove(
        container,
        callerOf(c),
        c.req.valid('param').entryId,
        c.req.valid('json'),
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  return router
}

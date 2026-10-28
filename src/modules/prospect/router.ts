import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  bulkAssignProspectsRequestSchema,
  bulkAssignProspectsResponseSchema,
  createProspectRequestSchema,
  eraseProspectResponseSchema,
  listProspectDuplicatesQuerySchema,
  listProspectDuplicatesResponseSchema,
  listProspectsQuerySchema,
  listProspectsResponseSchema,
  mergeProspectsRequestSchema,
  PROSPECT_ROUTES,
  prospectMergeParamsSchema,
  prospectMergeSchema,
  prospectParamsSchema,
  prospectSchema,
  publicApiExtensions,
  setProspectOwnerRequestSchema,
  updateProspectRequestSchema,
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
import * as Assign from './assign'
import * as Erase from './erase'
import * as Merge from './merge'
import * as Prospects from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const list = createRoute({
  method: 'get',
  path: '/prospects',
  ...publicApiExtensions(PROSPECT_ROUTES.listProspects),
  tags: ['prospects'],
  summary: 'List the Prospects you may see',
  description:
    'Any role. Owner and Admin see every Prospect, a Manager those they own and those of the ' +
    'Reps who share a Team with them, a Rep their own. Filters (owner, Source, company, status, ' +
    'and `q` on a name or an email) only narrow that. Newest first, cursor pagination, at most ' +
    '100 per page.',
  security,
  request: { query: listProspectsQuerySchema },
  responses: {
    200: {
      description: 'One page of Prospects.',
      content: { 'application/json': { schema: listProspectsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const get = createRoute({
  method: 'get',
  path: '/prospects/{prospectId}',
  ...publicApiExtensions(PROSPECT_ROUTES.getProspect),
  tags: ['prospects'],
  summary: 'Get a Prospect',
  description:
    'Any role, for a Prospect the caller may see. One the caller may not see, one that does not ' +
    'exist and one of another Organization are all `prospect.not_found`, never 403.',
  security,
  request: { params: prospectParamsSchema },
  responses: {
    200: {
      description: 'The Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const create = createRoute({
  method: 'post',
  path: '/prospects',
  ...publicApiExtensions(PROSPECT_ROUTES.createProspect),
  tags: ['prospects'],
  summary: 'Create a Prospect',
  description:
    'Any role. The Source is `manual`. A Rep or Manager owns what they create; Owner and Admin ' +
    'may name an owner (a Rep or Manager) or leave the Prospect unowned. Accepts an ' +
    '`Idempotency-Key` header: a repeat with the same key and body returns the first Prospect ' +
    '(200) and creates nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: createProspectRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first Prospect, for a repeat of a request with the same Idempotency-Key.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    201: {
      description: 'The new Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, prospect.forbidden_owner, or organization.suspended.'),
    404: errorResponse('prospect.not_found (the company), or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'prospect.duplicate_identity, or request.idempotency_in_progress: the first request with ' +
        'this Idempotency-Key is still running (see Retry-After and details.retryAfter, in seconds).'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const update = createRoute({
  method: 'patch',
  path: '/prospects/{prospectId}',
  ...publicApiExtensions(PROSPECT_ROUTES.updateProspect),
  tags: ['prospects'],
  summary: 'Edit a Prospect',
  description:
    'Any role, for a Prospect the caller may see. Every field sent is written as `manual`, which ' +
    'a later import, CRM sync or enrichment cannot overwrite; `null` clears a field. The owner ' +
    'is not changed here.',
  security,
  request: {
    params: prospectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: updateProspectRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The edited Prospect.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse(
      'prospect.not_found (the Prospect or the company), or organization.not_found.'
    ),
    409: errorResponse('prospect.duplicate_identity'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const setOwner = createRoute({
  method: 'put',
  path: '/prospects/{prospectId}/owner',
  ...publicApiExtensions(PROSPECT_ROUTES.setProspectOwner),
  tags: ['prospects'],
  summary: 'Assign or reassign the owner of a Prospect',
  description:
    'Owner and Admin only. The new owner must be a Rep or Manager of the Organization. Setting ' +
    'the owner it already has changes nothing. The old owner stops seeing the Prospect and the ' +
    'new one sees it at once. Publishes `prospect.updated` when the owner changed.',
  security,
  request: {
    params: prospectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: setProspectOwnerRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Prospect with its new owner.',
      content: { 'application/json': { schema: prospectSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, prospect.forbidden_owner, or organization.suspended.'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const bulkAssign = createRoute({
  method: 'post',
  path: '/prospects/assign',
  ...publicApiExtensions(PROSPECT_ROUTES.bulkAssignProspects),
  tags: ['prospects'],
  summary: 'Assign or reassign the owner of many Prospects',
  description:
    'Owner and Admin only. The new owner must be a Rep or Manager of the Organization. Up to 500 ' +
    'ids are applied before the answer (200, `applied`, with the counts); more are queued in ' +
    'chunks (202, `queued`). An id that does not exist is counted in `skipped`, never named. ' +
    'Accepts an `Idempotency-Key` header: a repeat with the same key and body returns the first ' +
    'answer and changes nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: bulkAssignProspectsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Applied: the counts of Prospects assigned and ids skipped.',
      content: { 'application/json': { schema: bulkAssignProspectsResponseSchema } },
    },
    202: {
      description: 'Queued: more than 500 ids, applied in the background.',
      content: { 'application/json': { schema: bulkAssignProspectsResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, prospect.forbidden_owner, or organization.suspended.'),
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
    503: errorResponse('server.unavailable: the jobs could not be queued; try again.'),
  },
})

const erase = createRoute({
  method: 'delete',
  path: '/prospects/{prospectId}',
  ...publicApiExtensions(PROSPECT_ROUTES.eraseProspect),
  tags: ['prospects'],
  summary: 'Erase a Prospect',
  description:
    "Owner and Admin only. Accepted at once (202) and done in the background: the Prospect's " +
    'fields, history, identities and notes are deleted, a salted-hash suppression entry is kept ' +
    'for each address it held, and `prospect.erased` is published with the id alone. Once done ' +
    'the Prospect is `prospect.not_found`, so a repeat that answers 404 after an accepted ' +
    'request means it is done. Its addresses can be used again only by a new Contact Consent ' +
    'and a removal of the suppression entry.',
  security,
  request: { params: prospectParamsSchema },
  responses: {
    202: {
      description: 'Accepted: the erasure is queued.',
      content: { 'application/json': { schema: eraseProspectResponseSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the job could not be queued; try again.'),
  },
})

const listDuplicates = createRoute({
  method: 'get',
  path: '/prospect-duplicates',
  ...publicApiExtensions(PROSPECT_ROUTES.listProspectDuplicates),
  tags: ['prospects'],
  summary: 'List suspected duplicate Prospects',
  description:
    'Owner and Admin. Pairs where one Prospect holds, as its current email, phone or LinkedIn ' +
    'address, a value the other once had. Optionally only the pairs that include `prospectId`. ' +
    'Cursor pagination, at most 100 per page.',
  security,
  request: { query: listProspectDuplicatesQuerySchema },
  responses: {
    200: {
      description: 'One page of suspected duplicates.',
      content: { 'application/json': { schema: listProspectDuplicatesResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const merge = createRoute({
  method: 'post',
  path: '/prospects/{prospectId}/merges',
  ...publicApiExtensions(PROSPECT_ROUTES.mergeProspects),
  tags: ['prospects'],
  summary: 'Merge Prospects into this one',
  description:
    'Owner and Admin. The Prospect in the path survives; the others are merged into it. Each ' +
    'field keeps the value of the Prospect named in `fieldChoices`, else the manual one, else the ' +
    'newer one; every other value stays as history. Bookings and Conversations move to the ' +
    'survivor. Undo is possible for 30 days. Accepts an `Idempotency-Key` header: a repeat with ' +
    'the same key and body returns the first merge (200).',
  security,
  request: {
    params: prospectParamsSchema,
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: mergeProspectsRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first merge, for a repeat of a request with the same Idempotency-Key.',
      content: { 'application/json': { schema: prospectMergeSchema } },
    },
    201: {
      description: 'The merge.',
      content: { 'application/json': { schema: prospectMergeSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    409: errorResponseWithRetryAfter(
      'prospect.merge_conflict, or request.idempotency_in_progress: the first request with this ' +
        'Idempotency-Key is still running (see Retry-After and details.retryAfter, in seconds).'
    ),
    410: errorResponse('organization.deleted'),
    422: errorResponse(
      'request.idempotency_key_reused: the Idempotency-Key was used for a different request.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const getMerge = createRoute({
  method: 'get',
  path: '/prospect-merges/{mergeId}',
  ...publicApiExtensions(PROSPECT_ROUTES.getProspectMerge),
  tags: ['prospects'],
  summary: 'Get a Prospect merge',
  description:
    'Owner and Admin. A merge that does not exist or is in another Organization is `prospect.not_found`.',
  security,
  request: { params: prospectMergeParamsSchema },
  responses: {
    200: {
      description: 'The merge.',
      content: { 'application/json': { schema: prospectMergeSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const undoMerge = createRoute({
  method: 'post',
  path: '/prospect-merges/{mergeId}/undo',
  ...publicApiExtensions(PROSPECT_ROUTES.undoProspectMerge),
  tags: ['prospects'],
  summary: 'Undo a Prospect merge',
  description:
    'Owner and Admin. Restores both records exactly as they were, with their history and the ' +
    'Bookings and Conversations that moved. A merge already undone answers as it is. After 30 ' +
    'days, or when the survivor was changed or merged again since, it is `prospect.merge_conflict`.',
  security,
  request: { params: prospectMergeParamsSchema },
  responses: {
    200: {
      description: 'The merge, undone.',
      content: { 'application/json': { schema: prospectMergeSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, or organization.not_found.'),
    409: errorResponse('prospect.merge_conflict'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The Prospects of the caller's Organization. Mounted behind the access-token middleware. */
export function createProspectRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Prospects.list(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(get, async (c) =>
    c.json(await Prospects.get(container, callerOf(c), c.req.valid('param').prospectId), 200)
  )

  router.openapi(create, async (c) => {
    const answer = await Prospects.create(container, callerOf(c), c.req.valid('json'), {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(update, async (c) =>
    c.json(
      await Prospects.update(
        container,
        callerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('json'),
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  router.openapi(setOwner, async (c) =>
    c.json(
      await Assign.setOwner(
        container,
        callerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('json').ownerMembershipId,
        { traceId: c.get('requestId') }
      ),
      200
    )
  )

  router.openapi(erase, async (c) =>
    c.json(
      await Erase.requestErase(container, callerOf(c), c.req.valid('param').prospectId, {
        traceId: c.get('requestId'),
      }),
      202
    )
  )

  router.openapi(bulkAssign, async (c) => {
    const answer = await Assign.bulkAssign(container, callerOf(c), c.req.valid('json'), {
      traceId: c.get('requestId'),
      idempotencyKey: c.req.valid('header')['idempotency-key'],
    })
    return c.json(answer.body, answer.status)
  })

  router.openapi(listDuplicates, async (c) =>
    c.json(await Merge.listDuplicates(container, callerOf(c), c.req.valid('query')), 200)
  )

  router.openapi(merge, async (c) => {
    const answer = await Merge.merge(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  router.openapi(getMerge, async (c) =>
    c.json(await Merge.getMerge(container, callerOf(c), c.req.valid('param').mergeId), 200)
  )

  router.openapi(undoMerge, async (c) =>
    c.json(
      await Merge.undo(container, callerOf(c), c.req.valid('param').mergeId, {
        traceId: c.get('requestId'),
      }),
      200
    )
  )

  return router
}

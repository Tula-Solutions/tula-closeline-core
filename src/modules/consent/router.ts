import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { accepts } from 'hono/accepts'
import {
  CONSENT_ROUTES,
  consentEventPageSchema,
  consentProspectParamsSchema,
  evidencePageSchema,
  listConsentEventsQuerySchema,
  listEvidenceQuerySchema,
  prospectConsentSchema,
  publicApiExtensions,
  recordConsentRequestSchema,
  withdrawConsentRequestSchema,
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
import { recordedConsentResponseSchema } from './schema'
import * as Consent from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const record = createRoute({
  method: 'post',
  path: '/prospects/{prospectId}/consents',
  ...publicApiExtensions(CONSENT_ROUTES.recordConsent),
  tags: ['consent'],
  summary: 'Record a granted Contact Consent',
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see (anything else is ' +
    '`prospect.not_found`). Needs a source, a Consent Wording that covers the channel and an ' +
    'evidence reference. Appends a `granted` event to the ledger and publishes `consent.granted`. ' +
    'Accepts an `Idempotency-Key` header: a repeat with the same key and body returns the first ' +
    'result (200) and publishes nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentProspectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: recordConsentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    201: {
      description: 'The ledger event and the resulting consent.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, consent.not_found or organization.not_found'),
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

const withdraw = createRoute({
  method: 'post',
  path: '/prospects/{prospectId}/consent-withdrawals',
  ...publicApiExtensions(CONSENT_ROUTES.withdrawConsent),
  tags: ['consent'],
  summary: 'Withdraw a Contact Consent',
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see. Withdraws the named channels, ' +
    'or every channel with `all: true` (STOP-all). Other channels are unchanged. It needs no ' +
    'reason and is allowed in a suspended Organization. Publishes one `consent.withdrawn` per ' +
    'channel. Accepts an `Idempotency-Key` header.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    params: consentProspectParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: withdrawConsentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The first result, for a repeated Idempotency-Key.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    201: {
      description: 'The ledger events and the resulting consent.',
      content: { 'application/json': { schema: recordedConsentResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('prospect.not_found, consent.not_found or organization.not_found'),
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

const getConsent = createRoute({
  method: 'get',
  path: '/prospects/{prospectId}/consent',
  ...publicApiExtensions(CONSENT_ROUTES.getProspectConsent),
  tags: ['consent'],
  summary: "Read a Prospect's Contact Consent",
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see (anything else, or a Prospect of ' +
    "another Organization, is `prospect.not_found`). The state of every channel from the ledger's " +
    'newest event of each, and whether an address of the Prospect is suppressed.',
  security,
  request: { params: consentProspectParamsSchema },
  responses: {
    200: {
      description: "The Prospect's consent per channel.",
      content: { 'application/json': { schema: prospectConsentSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const listEvents = createRoute({
  method: 'get',
  path: '/prospects/{prospectId}/consent-events',
  ...publicApiExtensions(CONSENT_ROUTES.listProspectConsentEvents),
  tags: ['consent'],
  summary: "List a Prospect's consent events",
  description:
    'Owner, Admin, Manager and Rep, for a Prospect they can see. The ledger events newest first, ' +
    'one cursor-paginated page at a time (at most 100), optionally one channel.',
  security,
  request: { params: consentProspectParamsSchema, query: listConsentEventsQuerySchema },
  responses: {
    200: {
      description: 'One page of events.',
      content: { 'application/json': { schema: consentEventPageSchema } },
    },
    400: errorResponse('The request is not valid, or the cursor is not one this route issued.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const listEvidence = createRoute({
  method: 'get',
  path: '/prospects/{prospectId}/consent-evidence',
  ...publicApiExtensions(CONSENT_ROUTES.getProspectConsentEvidence),
  tags: ['consent'],
  summary: "Export a Prospect's consent evidence",
  description:
    'Owner and Admin only, for a Prospect they can see. The ledger events newest first, one ' +
    'cursor-paginated page at a time (at most 100), each with the wording text shown and, for a ' +
    'hosted form, the submission details. Send `Accept: text/csv` for every event as one CSV file ' +
    '(columns event_id, prospect_id, channel, kind, source, occurred_at, recorded_at, wording_id, ' +
    'wording_version, wording_text, evidence_ref, ip_address, user_agent), streamed in pages; the ' +
    'cursor and limit are then ignored.',
  security,
  request: { params: consentProspectParamsSchema, query: listEvidenceQuerySchema },
  responses: {
    200: {
      description: 'One page of evidence.',
      content: {
        'application/json': { schema: evidencePageSchema },
        'text/csv': { schema: z.string() },
      },
    },
    400: errorResponse('The request is not valid, or the cursor is not one this route issued.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found, or organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The routes that record, withdraw and read a Prospect's Contact Consent. */
export function createConsentRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(record, async (c) => {
    const answer = await Consent.record(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  router.openapi(withdraw, async (c) => {
    const answer = await Consent.withdraw(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('json'),
      { traceId: c.get('requestId'), idempotencyKey: c.req.valid('header')['idempotency-key'] }
    )
    return c.json(answer.body, answer.status)
  })

  router.openapi(getConsent, async (c) => {
    const consent = await Consent.read(container, callerOf(c), c.req.valid('param').prospectId)
    return c.json(consent, 200)
  })

  router.openapi(listEvents, async (c) => {
    const page = await Consent.listEvents(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('query')
    )
    return c.json(page, 200)
  })

  router.openapi(listEvidence, async (c) => {
    const wanted = accepts(c, {
      header: 'Accept',
      supports: ['application/json', 'text/csv'],
      default: 'application/json',
    })
    if (wanted === 'text/csv') {
      const body = await Consent.evidenceCsvStream(
        container,
        callerOf(c),
        c.req.valid('param').prospectId,
        c.req.valid('query')
      )
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="consent-evidence-${c.req.valid('param').prospectId}.csv"`,
          'cache-control': 'no-store',
        },
      })
    }
    const page = await Consent.listEvidence(
      container,
      callerOf(c),
      c.req.valid('param').prospectId,
      c.req.valid('query')
    )
    return c.json(page, 200)
  })

  return router
}

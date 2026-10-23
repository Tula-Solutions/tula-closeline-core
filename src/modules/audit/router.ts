import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  AUDIT_ROUTES,
  auditCsvQuerySchema,
  auditEventIdSchema,
  auditEventSchema,
  listAuditEventsQuerySchema,
  listAuditEventsResponseSchema,
  publicApiExtensions,
  verifyAuditQuerySchema,
  verifyAuditResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { errorResponse } from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import * as Audit from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]

const common = {
  400: errorResponse('The query or the cursor is not valid.'),
  401: errorResponse('The access token is missing, expired or not valid.'),
  403: errorResponse('auth.forbidden'),
  404: errorResponse('organization.not_found'),
  410: errorResponse('organization.deleted'),
  500: errorResponse('Something went wrong on our side.'),
} as const

const list = createRoute({
  method: 'get',
  path: '/audit-events',
  ...publicApiExtensions(AUDIT_ROUTES.listAuditEvents),
  tags: ['audit'],
  summary: 'List audit events',
  description:
    "Owner and Admin read every event; a Manager reads events about their Team's Prospects. " +
    'Newest first, narrowed by actor, action, subject, Prospect and time range. A range of more ' +
    'than 366 days is `audit.range_too_large`. Cursor pagination, at most 100 per page.',
  security,
  request: { query: listAuditEventsQuerySchema },
  responses: {
    200: {
      description: 'One page of audit events.',
      content: { 'application/json': { schema: listAuditEventsResponseSchema } },
    },
    422: errorResponse('audit.range_too_large'),
    ...common,
  },
})

const get = createRoute({
  method: 'get',
  path: '/audit-events/{auditEventId}',
  ...publicApiExtensions(AUDIT_ROUTES.getAuditEvent),
  tags: ['audit'],
  summary: 'Get one audit event',
  description:
    "Owner and Admin, or a Manager for an event about their Team's Prospects. An event outside " +
    "the caller's view is `audit.event_not_found`.",
  security,
  request: { params: z.object({ auditEventId: auditEventIdSchema }) },
  responses: {
    200: {
      description: 'The event.',
      content: { 'application/json': { schema: auditEventSchema } },
    },
    ...common,
    404: errorResponse('audit.event_not_found or organization.not_found'),
  },
})

const csv = createRoute({
  method: 'get',
  path: '/audit-csv',
  ...publicApiExtensions(AUDIT_ROUTES.downloadAuditCsv),
  tags: ['audit'],
  summary: 'Download audit events as CSV',
  description:
    'Owner and Admin only. text/csv, oldest first, at most 1,000 rows per page. The next cursor is ' +
    'in the `x-next-cursor` response header and is absent on the last page. A cell that starts ' +
    'with `=`, `+`, `-` or `@` is escaped. The download is itself recorded as an audit event.',
  security,
  request: { query: auditCsvQuerySchema },
  responses: {
    200: {
      description: 'One page of the log as CSV.',
      headers: z.object({
        'x-next-cursor': z.string().optional().openapi({ description: 'The next page, if any.' }),
      }),
      content: { 'text/csv': { schema: z.string() } },
    },
    422: errorResponse('audit.range_too_large'),
    ...common,
  },
})

const verify = createRoute({
  method: 'get',
  path: '/audit-verification',
  ...publicApiExtensions(AUDIT_ROUTES.verifyAuditLog),
  tags: ['audit'],
  summary: 'Verify the audit hash chain',
  description:
    'Owner and Admin only. Checks at most 1,000 events from a sequence number and reports the ' +
    'first broken sequence, or null when the checked events are intact.',
  security,
  request: { query: verifyAuditQuerySchema },
  responses: {
    200: {
      description: 'The result of the check.',
      content: { 'application/json': { schema: verifyAuditResponseSchema } },
    },
    ...common,
  },
})

/** The audit log of the caller's Organization. Mounted behind the access-token middleware. */
export function createAuditRouter(container: Container): OpenAPIHono<AuthedEnv> {
  const router = createRouter<AuthedEnv>()

  router.openapi(list, async (c) =>
    c.json(await Audit.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(get, async (c) =>
    c.json(await Audit.get(container, callerOf(c), c.req.valid('param').auditEventId), 200)
  )
  router.openapi(csv, async (c) => {
    const page = await Audit.csv(container, callerOf(c), c.req.valid('query'))
    return c.body(page.body, 200, {
      'content-type': 'text/csv; charset=utf-8',
      ...(page.nextCursor === null ? {} : { 'x-next-cursor': page.nextCursor }),
    })
  })
  router.openapi(verify, async (c) =>
    c.json(await Audit.verify(container, callerOf(c), c.req.valid('query')), 200)
  )

  return router
}

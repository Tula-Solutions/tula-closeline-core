import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  ERRORS,
  idempotencyKeySchema,
  listProspectImportRowsQuerySchema,
  listProspectImportRowsResponseSchema,
  listProspectImportsQuerySchema,
  listProspectImportsResponseSchema,
  PROSPECT_IMPORT_FILE_FIELD,
  PROSPECT_ROUTES,
  prospectImportParamsSchema,
  prospectImportSchema,
  publicApiExtensions,
  UPLOAD_CONTENT_TYPE,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { capBody } from '~/http/body'
import { domainError } from '~/http/domain-error'
import { IMPORT_BODY_LIMIT } from '~/http/limits'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  optionalIdempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { PUBLIC_SECURITY } from '~/http/security'
import { mayAttempt } from '~/modules/member/permission'
import * as Imports from './service'

const security = [{ [PUBLIC_SECURITY]: [] }]
const tags = ['prospect-imports']
const routes = PROSPECT_ROUTES

/** The route path without the `/v1` prefix the app mounts it under. */
function pathOf(contractPath: string): string {
  return contractPath.replace(/^\/v1/, '')
}

/** The same path in Hono's own `:param` syntax, for routes registered without OpenAPI. */
function honoPathOf(contractPath: string): string {
  return pathOf(contractPath).replace(/\{(\w+)\}/g, ':$1')
}

const uploadRoute = createRoute({
  method: 'post',
  path: pathOf(routes.uploadProspectImport.path),
  ...publicApiExtensions(PROSPECT_ROUTES.uploadProspectImport),
  tags,
  summary: 'Upload a CSV of Prospects',
  description:
    'Owner and Admin. Send `multipart/form-data` with one `file` part: a `.csv` of at most 10 MB ' +
    'whose header names columns of the template (first_name, last_name, email, phone, ' +
    'linkedin_url, job_title, company_name, company_domain, owner_email, tags) and has at ' +
    'least one of email, phone or linkedin_url. Only the header is read now; a queued job parses ' +
    'the rows and every row gets a result in the report. Files over 50,000 rows fail the import ' +
    '(`too_many_rows`). Imported values have the Source `import` and never replace a manual ' +
    'value. Accepts an `Idempotency-Key` header: the same key with the same file returns the ' +
    'first import and creates nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        [UPLOAD_CONTENT_TYPE]: {
          schema: z.object({
            [PROSPECT_IMPORT_FILE_FIELD]: z
              .string()
              .meta({ type: 'string', format: 'binary', description: 'The CSV file.' }),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: 'The import was accepted; follow its state with the get route.',
      content: { 'application/json': { schema: prospectImportSchema } },
    },
    400: errorResponse('The request is not valid, or prospect.import_invalid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden, or organization.suspended.'),
    404: errorResponse('organization.not_found'),
    409: errorResponseWithRetryAfter('request.idempotency_in_progress'),
    410: errorResponse('organization.deleted'),
    413: errorResponse('request.too_large'),
    415: errorResponse('request.unsupported_media_type'),
    422: errorResponse('request.idempotency_key_reused'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: the job could not be queued; retry.'),
    504: errorResponse('server.timeout: the body did not arrive in time.'),
  },
})

const listRoute = createRoute({
  method: 'get',
  path: pathOf(routes.listProspectImports.path),
  ...publicApiExtensions(PROSPECT_ROUTES.listProspectImports),
  tags,
  summary: 'List Prospect imports',
  description: 'Owner and Admin. Newest first, cursor pagination, at most 100 per page.',
  security,
  request: { query: listProspectImportsQuerySchema },
  responses: {
    200: {
      description: 'One page of imports.',
      content: { 'application/json': { schema: listProspectImportsResponseSchema } },
    },
    400: errorResponse('The query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('organization.not_found'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const getRoute = createRoute({
  method: 'get',
  path: pathOf(routes.getProspectImport.path),
  ...publicApiExtensions(PROSPECT_ROUTES.getProspectImport),
  tags,
  summary: 'Get a Prospect import',
  description: 'Owner and Admin. An import of another Organization is `prospect.not_found`.',
  security,
  request: { params: prospectImportParamsSchema },
  responses: {
    200: {
      description: 'The import.',
      content: { 'application/json': { schema: prospectImportSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found (resource import), or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const rowsRoute = createRoute({
  method: 'get',
  path: pathOf(routes.listProspectImportRows.path),
  ...publicApiExtensions(PROSPECT_ROUTES.listProspectImportRows),
  tags,
  summary: 'List the rows of a Prospect import',
  description:
    'Owner and Admin. The result of each row by record number (the header is 1), optionally of ' +
    'one result. Cursor pagination, at most 100 per page.',
  security,
  request: { params: prospectImportParamsSchema, query: listProspectImportRowsQuerySchema },
  responses: {
    200: {
      description: 'One page of rows.',
      content: { 'application/json': { schema: listProspectImportRowsResponseSchema } },
    },
    400: errorResponse('The path, the query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found (resource import), or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const reportRoute = createRoute({
  method: 'get',
  path: pathOf(routes.downloadProspectImportReport.path),
  ...publicApiExtensions(PROSPECT_ROUTES.downloadProspectImportReport),
  tags,
  summary: 'Download the report of a Prospect import as CSV',
  description:
    'Owner and Admin. Columns row_number, result, reason, prospect_id, one line per row, streamed ' +
    'in pages. An import of another Organization is `prospect.not_found`.',
  security,
  request: { params: prospectImportParamsSchema },
  responses: {
    200: {
      description: 'The report.',
      content: { 'text/csv': { schema: z.string() } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('prospect.not_found (resource import), or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/** The validated `Idempotency-Key` of a request, or `undefined`; a malformed one is `request.invalid`. */
function idempotencyKeyOf(c: Context<AuthedEnv>): string | undefined {
  const header = c.req.header('idempotency-key')
  if (header === undefined) {
    return undefined
  }
  const parsed = idempotencyKeySchema.safeParse(header)
  if (!parsed.success) {
    throw domainError(ERRORS['request.invalid'])
  }
  return parsed.data
}

/** Reads the `file` part of the form, within the size and time limits. */
async function readFile(
  container: Container,
  c: Context<AuthedEnv>
): Promise<Imports.UploadedFile> {
  if (!/^multipart\/form-data\s*(;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw domainError(ERRORS['request.unsupported_media_type'])
  }
  const capped = capBody(
    c.req.raw,
    IMPORT_BODY_LIMIT,
    AbortSignal.timeout(container.env.UPLOAD_BODY_TIMEOUT_MS)
  )
  let form: Awaited<ReturnType<Request['formData']>>
  try {
    form = await capped.request.formData()
  } catch {
    if (capped.timedOut()) {
      throw domainError(ERRORS['server.timeout'])
    }
    throw domainError(capped.exceeded() ? ERRORS['request.too_large'] : ERRORS['request.invalid'])
  }
  const keys = [...form.keys()]
  const part = form.get(PROSPECT_IMPORT_FILE_FIELD)
  if (keys.length !== 1 || keys[0] !== PROSPECT_IMPORT_FILE_FIELD || !(part instanceof File)) {
    throw domainError(ERRORS['request.invalid'])
  }
  return { name: part.name, type: part.type, bytes: new Uint8Array(await part.arrayBuffer()) }
}

/** The Prospect import routes under `/v1`. */
export function createProspectImportRouter(container: Container) {
  const router = createRouter<AuthedEnv>()

  // The upload and the download are served by plain handlers: the upload reads its own body, in
  // bounded form, after the role is checked, and the download streams. Both are described here.
  router.openAPIRegistry.registerPath(uploadRoute)
  router.post(pathOf(routes.uploadProspectImport.path), async (c) => {
    const caller = callerOf(c)
    if (!mayAttempt(caller.role, 'prospect_import.create')) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    const key = idempotencyKeyOf(c)
    const file = await readFile(container, c)
    const answer = await Imports.upload(container, caller, file, {
      traceId: c.get('requestId'),
      idempotencyKey: key,
    })
    return c.json(answer.body, 202)
  })

  router.openapi(listRoute, async (c) =>
    c.json(await Imports.list(container, callerOf(c), c.req.valid('query')), 200)
  )
  router.openapi(getRoute, async (c) =>
    c.json(await Imports.get(container, callerOf(c), c.req.valid('param').importId), 200)
  )
  router.openapi(rowsRoute, async (c) =>
    c.json(
      await Imports.listRows(
        container,
        callerOf(c),
        c.req.valid('param').importId,
        c.req.valid('query')
      ),
      200
    )
  )

  router.openAPIRegistry.registerPath(reportRoute)
  router.get(honoPathOf(routes.downloadProspectImportReport.path), async (c) => {
    const params = prospectImportParamsSchema.safeParse(c.req.param())
    if (!params.success) {
      throw domainError(ERRORS['request.invalid'])
    }
    const body = await Imports.reportStream(container, callerOf(c), params.data.importId)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="prospect-import-${params.data.importId}.csv"`,
        'cache-control': 'no-store',
      },
    })
  })
  return router
}

import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import {
  CONSENT_ROUTES,
  ERRORS,
  idempotencyKeySchema,
  listSuppressionImportRowsQuerySchema,
  listSuppressionImportsQuerySchema,
  publicApiExtensions,
  SUPPRESSION_IMPORT_FILE_FIELD,
  suppressionImportPageSchema,
  suppressionImportParamsSchema,
  suppressionImportRowPageSchema,
  suppressionImportSchema,
  UPLOAD_CONTENT_TYPE,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { type AuthedEnv, callerOf } from '~/http/auth'
import { capBody } from '~/http/body'
import { domainError } from '~/http/domain-error'
import { SUPPRESSION_IMPORT_BODY_LIMIT } from '~/http/limits'
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
const tags = ['suppression-imports']
const routes = CONSENT_ROUTES

/** The route path without the `/v1` prefix the app mounts it under. */
function pathOf(contractPath: string): string {
  return contractPath.replace(/^\/v1/, '')
}

const uploadRoute = createRoute({
  method: 'post',
  path: pathOf(routes.uploadSuppressionImport.path),
  ...publicApiExtensions(routes.uploadSuppressionImport),
  tags,
  summary: 'Upload a CSV of addresses to suppress',
  description:
    'Owner and Admin. Send `multipart/form-data` with one `file` part: a `.csv` of at most 10 MB ' +
    'with the single column `address` (an email, a phone number or a LinkedIn profile URL per ' +
    'row). Only the header is read now; a queued job adds the addresses and every row gets a ' +
    'result in the report. Files over 50,000 rows fail the import (`too_many_rows`). Accepts an ' +
    '`Idempotency-Key` header: the same key with the same file returns the first import (200) ' +
    'and creates nothing.',
  security,
  request: {
    headers: optionalIdempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        [UPLOAD_CONTENT_TYPE]: {
          schema: z.object({
            [SUPPRESSION_IMPORT_FILE_FIELD]: z
              .string()
              .meta({ type: 'string', format: 'binary', description: 'The CSV file.' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'A repeat of an earlier upload: the first import.',
      content: { 'application/json': { schema: suppressionImportSchema } },
    },
    202: {
      description: 'The import was accepted; follow its state with the get route.',
      content: { 'application/json': { schema: suppressionImportSchema } },
    },
    400: errorResponse('The request is not valid.'),
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
  path: pathOf(routes.listSuppressionImports.path),
  ...publicApiExtensions(routes.listSuppressionImports),
  tags,
  summary: 'List Suppression imports',
  description: 'Owner and Admin. Newest first, cursor pagination, at most 100 per page.',
  security,
  request: { query: listSuppressionImportsQuerySchema },
  responses: {
    200: {
      description: 'One page of imports.',
      content: { 'application/json': { schema: suppressionImportPageSchema } },
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
  path: pathOf(routes.getSuppressionImport.path),
  ...publicApiExtensions(routes.getSuppressionImport),
  tags,
  summary: 'Get a Suppression import',
  description: 'Owner and Admin. An import of another Organization is `consent.not_found`.',
  security,
  request: { params: suppressionImportParamsSchema },
  responses: {
    200: {
      description: 'The import.',
      content: { 'application/json': { schema: suppressionImportSchema } },
    },
    400: errorResponse('The path is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('consent.not_found, or organization.not_found.'),
    410: errorResponse('organization.deleted'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const rowsRoute = createRoute({
  method: 'get',
  path: pathOf(routes.listSuppressionImportRows.path),
  ...publicApiExtensions(routes.listSuppressionImportRows),
  tags,
  summary: 'List the rows of a Suppression import',
  description:
    'Owner and Admin. The result of each row by record number (the header is 1), optionally of ' +
    'one result. Cursor pagination, at most 100 per page.',
  security,
  request: { params: suppressionImportParamsSchema, query: listSuppressionImportRowsQuerySchema },
  responses: {
    200: {
      description: 'One page of rows.',
      content: { 'application/json': { schema: suppressionImportRowPageSchema } },
    },
    400: errorResponse('The path, the query or the cursor is not valid.'),
    401: errorResponse('The access token is missing, expired or not valid.'),
    403: errorResponse('auth.forbidden'),
    404: errorResponse('consent.not_found, or organization.not_found.'),
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
    SUPPRESSION_IMPORT_BODY_LIMIT,
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
  const part = form.get(SUPPRESSION_IMPORT_FILE_FIELD)
  if (keys.length !== 1 || keys[0] !== SUPPRESSION_IMPORT_FILE_FIELD || !(part instanceof File)) {
    throw domainError(ERRORS['request.invalid'])
  }
  return { name: part.name, type: part.type, bytes: new Uint8Array(await part.arrayBuffer()) }
}

/** The Suppression import routes under `/v1`. */
export function createSuppressionImportRouter(container: Container) {
  const router = createRouter<AuthedEnv>()

  // The upload is a plain handler: it reads its own body, in bounded form, after the role is checked.
  router.openAPIRegistry.registerPath(uploadRoute)
  router.post(pathOf(routes.uploadSuppressionImport.path), async (c) => {
    const caller = callerOf(c)
    if (!mayAttempt(caller.role, 'suppression_import.create')) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    const key = idempotencyKeyOf(c)
    const file = await readFile(container, c)
    const answer = await Imports.upload(container, caller, file, {
      traceId: c.get('requestId'),
      idempotencyKey: key,
    })
    return c.json(answer.body, answer.status)
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
  return router
}

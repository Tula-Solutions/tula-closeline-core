import { createHash } from 'node:crypto'
import {
  CONSENT_ERRORS,
  DEAL_IMPORT_HEADER_PREFIX_CHARS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  firstCsvRecord,
  formatId,
  type listSuppressionImportRowsQuerySchema,
  type listSuppressionImportsQuerySchema,
  MAX_SUPPRESSION_IMPORT_BYTES,
  normaliseMediaType,
  SUPPRESSION_IMPORT_COLUMNS,
  type SuppressionImport,
  type SuppressionImportId,
  suppressionImportIdSchema,
  suppressionImportSchema,
  timestampSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { newOutboxId } from '~/modules/prospect/events'
import type {
  SuppressionImportRecord,
  SuppressionImportRowRecord,
} from '~/ports/suppression-import-store'

type ListQuery = z.infer<typeof listSuppressionImportsQuerySchema>
type RowsQuery = z.infer<typeof listSuppressionImportRowsQuerySchema>

/** What the Suppression import routes need from the container. */
export type SuppressionImportServiceDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'objects'>

/** The file part of an upload, once the router has read it. */
export type UploadedFile = { name: string; type: string; bytes: Uint8Array }

/** The media types an upload may declare for a CSV file; a browser or a spreadsheet picks any of them. */
const CSV_MEDIA_TYPES: ReadonlySet<string> = new Set([
  '',
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
  'application/octet-stream',
])

const importCursorSchema = z.strictObject({
  createdAt: timestampSchema,
  id: suppressionImportIdSchema,
})
const rowCursorSchema = z.strictObject({ rowNumber: z.number().int().positive() })

const notFound = () => domainError(CONSENT_ERRORS['consent.not_found'])

/** Where the original file lives in the object store. */
export const objectKeyOf = (importId: SuppressionImportId): string =>
  `suppression-imports/${importId}/original.csv`

/** Whether a CSV record is the one-column header `address`. */
export function isAddressHeader(record: readonly string[]): boolean {
  return (
    record.length === SUPPRESSION_IMPORT_COLUMNS.length &&
    record[0]?.trim().toLowerCase() === SUPPRESSION_IMPORT_COLUMNS[0]
  )
}

/**
 * The API shape of an import. The database keeps `completed_at` for a completed import only, so
 * a failed one reports the time it failed (`updated_at`), which the contract requires.
 */
export function toSuppressionImportResponse(record: SuppressionImportRecord): SuppressionImport {
  const final = record.state === 'completed' || record.state === 'failed'
  const finishedAt = record.completedAt ?? (final ? record.updatedAt : null)
  return {
    id: record.id,
    state: record.state,
    failureReason: record.failureReason,
    totalRows: record.totalRows,
    addedRows: record.addedRows,
    alreadySuppressedRows: record.alreadySuppressedRows,
    invalidRows: record.invalidRows,
    createdAt: record.createdAt.toISOString(),
    completedAt: finishedAt === null ? null : finishedAt.toISOString(),
    createdByUserId: record.createdByUserId,
  }
}

/** The API shape of a row. */
const toRowResponse = (row: SuppressionImportRowRecord) => ({
  rowNumber: row.rowNumber,
  result: row.result,
  reason: row.reason,
})

/** Refuses a file by its name, declared type, size and header; the rows are judged by the job. */
function checkFile(file: UploadedFile): void {
  if (file.bytes.byteLength > MAX_SUPPRESSION_IMPORT_BYTES) {
    throw domainError(ERRORS['request.too_large'])
  }
  const bad = () => domainError(ERRORS['request.invalid'])
  if (
    !/\.csv$/i.test(file.name.trim()) ||
    !CSV_MEDIA_TYPES.has(normaliseMediaType(file.type)) ||
    file.bytes.byteLength === 0
  ) {
    throw bad()
  }
  // A prefix is enough for the header; a character cut at its end is not an error.
  const prefix = file.bytes.subarray(0, DEAL_IMPORT_HEADER_PREFIX_CHARS * 4)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix, {
      stream: true,
    })
  } catch {
    throw bad()
  }
  const cut =
    file.bytes.byteLength > prefix.byteLength || text.length > DEAL_IMPORT_HEADER_PREFIX_CHARS
  const head = firstCsvRecord(text.slice(0, DEAL_IMPORT_HEADER_PREFIX_CHARS))
  if (!head.ok) {
    if (cut && head.failure === 'unterminated_quote') {
      return
    }
    throw bad()
  }
  if (head.record === undefined) {
    throw bad()
  }
  if (!head.complete && cut) {
    return
  }
  if (!isAddressHeader(head.record)) {
    throw bad()
  }
}

/**
 * Takes an uploaded CSV of addresses: refuses a file of the wrong type, size or header, stores the
 * original in the object store, records the import (`uploaded`) and queues the job that adds the
 * addresses. Nothing is parsed here beyond the header, so the request does no work in proportion to
 * the file. Owner and Admin only. The same `Idempotency-Key` with the same file returns the first
 * import (200) and creates nothing. The job goes to the outbox in the same transaction as the
 * import, so a queue outage or a crash after commit delays it, never loses it.
 */
export async function upload(
  deps: SuppressionImportServiceDeps,
  caller: Caller,
  file: UploadedFile,
  options: { traceId: string; idempotencyKey?: string | undefined }
): Promise<{ status: 200 | 202; body: SuppressionImport; replayed: boolean }> {
  checkFile(file)
  const contentHash = new Uint8Array(createHash('sha256').update(file.bytes).digest())
  const importId = formatId('simp', crypto.randomUUID())
  const objectKey = objectKeyOf(importId)
  const now = deps.clock.now()

  await deps.objects.put(caller.organizationId, objectKey, file.bytes, { contentType: 'text/csv' })
  const dropObject = async () => {
    try {
      await deps.objects.delete(caller.organizationId, objectKey)
    } catch (error) {
      deps.logger.error('an unused suppression import file could not be deleted', {
        organizationId: caller.organizationId,
        importId,
        error: describeError(error),
      })
    }
  }

  let answer: { body: SuppressionImport; replayed: boolean }
  try {
    answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'suppression_imports.create',
          request: { contentHash: Buffer.from(contentHash).toString('hex') },
          status: 202,
          response: suppressionImportSchema,
        },
        async () => {
          const access = await openOrganizationForWrite(scope, caller, 'suppression_import.create')
          const record = await scope.insertSuppressionImport({
            id: importId,
            sizeBytes: file.bytes.byteLength,
            contentHash,
            objectKey,
            createdByUserId: caller.userId,
            now,
          })
          const job = jobRegistry.create({
            type: 'suppression.import_process',
            payload: { importId, actorUserId: caller.userId },
            organizationId: caller.organizationId,
            traceId: options.traceId,
          })
          await scope.enqueueOutbox({
            id: newOutboxId(),
            topic: job.type,
            dedupeKey: `suppression.import_process:${importId}`,
            payload: {
              eventId: job.id,
              occurredAt: job.occurredAt,
              traceId: options.traceId,
              payload: job.payload,
            },
          })
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: access.membershipId },
            action: 'suppression_import.created',
            subject: { type: 'suppression_import', id: importId },
          })
          return toSuppressionImportResponse(record)
        }
      )
    )
  } catch (error) {
    await dropObject()
    throw error
  }
  if (answer.replayed) {
    await dropObject()
  }
  return { status: answer.replayed ? 200 : 202, body: answer.body, replayed: answer.replayed }
}

/** The import, or `consent.not_found`, for a caller who may read imports. */
export async function get(
  deps: Pick<SuppressionImportServiceDeps, 'store'>,
  caller: Caller,
  importId: SuppressionImportId
): Promise<SuppressionImport> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression_import.read')
    const record = await scope.getSuppressionImport(importId)
    if (!record) {
      throw notFound()
    }
    return toSuppressionImportResponse(record)
  })
}

/** Lists the Organization's imports, newest first, one page at a time. */
export async function list(
  deps: Pick<SuppressionImportServiceDeps, 'store'>,
  caller: Caller,
  query: ListQuery
) {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, importCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression_import.read')
    const rows = await scope.listSuppressionImports({
      ...(after === undefined
        ? {}
        : { after: { createdAt: new Date(after.createdAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toSuppressionImportResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/** Lists the per-row report of one import in file order, optionally of one result. */
export async function listRows(
  deps: Pick<SuppressionImportServiceDeps, 'store'>,
  caller: Caller,
  importId: SuppressionImportId,
  query: RowsQuery
) {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, rowCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'suppression_import.read')
    if (!(await scope.getSuppressionImport(importId))) {
      throw notFound()
    }
    const rows = await scope.listSuppressionImportRows({
      importId,
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(after === undefined ? {} : { afterRow: after.rowNumber }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toRowResponse),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ rowNumber: last.rowNumber }) : null,
    }
  })
}

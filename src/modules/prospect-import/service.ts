import { createHash } from 'node:crypto'
import {
  DEAL_IMPORT_HEADER_PREFIX_CHARS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  firstCsvRecord,
  formatId,
  type ListProspectImportRowsQuery,
  type ListProspectImportRowsResponse,
  type ListProspectImportsQuery,
  type ListProspectImportsResponse,
  MAX_PROSPECT_IMPORT_BYTES,
  normaliseMediaType,
  PROSPECT_ERRORS,
  type ProspectImport,
  type ProspectImportId,
  prospectImportCursorSchema,
  prospectImportRowCursorSchema,
  prospectImportSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { domainError } from '~/http/domain-error'
import { jobRegistry } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { newOutboxId } from '~/modules/prospect/events'
import type { ProspectImportRecord } from '~/ports/core-store'
import { readHeader } from './rows'

/** What the Prospect import routes need from the container. */
export type ImportServiceDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'jobs' | 'objects'>

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

/** The most rows of the report one page carries; also the page size of the CSV download. */
export const REPORT_PAGE_ROWS = 100

const invalid = (reason: 'unsupported_type' | 'too_large' | 'header_invalid') =>
  domainError(PROSPECT_ERRORS['prospect.import_invalid'], { reason })

/** Where the original file lives in the object store. */
export const objectKeyOf = (importId: ProspectImportId): string =>
  `prospect-imports/${importId}/original.csv`

/** The API shape of an import. */
export function toImportResponse(record: ProspectImportRecord): ProspectImport {
  return {
    id: record.id,
    state: record.state,
    failureReason: record.failureReason,
    rowCount: record.rowCount,
    createdCount: record.createdCount,
    updatedCount: record.updatedCount,
    skippedCount: record.skippedCount,
    rejectedCount: record.rejectedCount,
    uploadedByUserId: record.uploadedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/** Refuses a file by its name, declared type, size and header; the rest of the file is judged by the job. */
function checkFile(file: UploadedFile): void {
  if (!/\.csv$/i.test(file.name.trim()) || !CSV_MEDIA_TYPES.has(normaliseMediaType(file.type))) {
    throw invalid('unsupported_type')
  }
  if (file.bytes.byteLength > MAX_PROSPECT_IMPORT_BYTES) {
    throw invalid('too_large')
  }
  if (file.bytes.byteLength === 0) {
    throw invalid('header_invalid')
  }
  // A prefix is enough for the header; a character cut at its end is not an error.
  const prefix = file.bytes.subarray(0, DEAL_IMPORT_HEADER_PREFIX_CHARS * 4)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix, {
      stream: true,
    })
  } catch {
    throw invalid('header_invalid')
  }
  const cut =
    file.bytes.byteLength > prefix.byteLength || text.length > DEAL_IMPORT_HEADER_PREFIX_CHARS
  const head = firstCsvRecord(text.slice(0, DEAL_IMPORT_HEADER_PREFIX_CHARS))
  if (!head.ok) {
    if (cut && head.failure === 'unterminated_quote') {
      return
    }
    throw invalid('header_invalid')
  }
  if (head.record === undefined) {
    throw invalid('header_invalid')
  }
  if (!head.complete && cut) {
    return
  }
  if (!readHeader(head.record).ok) {
    throw invalid('header_invalid')
  }
}

/**
 * Takes an uploaded CSV: refuses a file of the wrong type, size or header, stores the original in
 * the object store, records the import (`uploaded`) and queues the job that parses it. Nothing is
 * parsed here beyond the header. Owner and Admin only. The same `Idempotency-Key` with the same
 * file returns the first import and creates nothing. The job is written to the outbox in the
 * same transaction as the import, so a queue outage or a crash after commit delays it, never loses it.
 */
export async function upload(
  deps: ImportServiceDeps,
  caller: Caller,
  file: UploadedFile,
  options: { traceId: string; idempotencyKey?: string | undefined }
): Promise<{ status: 202; body: ProspectImport; replayed: boolean }> {
  checkFile(file)
  const contentHash = new Uint8Array(createHash('sha256').update(file.bytes).digest())
  const importId = formatId('pimp', crypto.randomUUID())
  const objectKey = objectKeyOf(importId)
  const now = deps.clock.now()

  await deps.objects.put(caller.organizationId, objectKey, file.bytes, { contentType: 'text/csv' })
  const dropObject = async () => {
    try {
      await deps.objects.delete(caller.organizationId, objectKey)
    } catch (error) {
      deps.logger.error('an unused import file could not be deleted', {
        organizationId: caller.organizationId,
        importId,
        error: describeError(error),
      })
    }
  }

  let answer: { status: 202; body: ProspectImport; replayed: boolean }
  try {
    answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'prospect_imports.create',
          request: { contentHash: Buffer.from(contentHash).toString('hex') },
          status: 202,
          response: prospectImportSchema,
        },
        async () => {
          const access = await openOrganizationForWrite(scope, caller, 'prospect_import.create')
          const record = await scope.insertProspectImport({
            id: importId,
            sizeBytes: file.bytes.byteLength,
            contentHash,
            objectKey,
            uploadedByUserId: caller.userId,
            now,
          })
          // The job joins this transaction through the outbox, so a crash after commit cannot
          // strand the import at `uploaded`; the drain publishes it.
          const job = jobRegistry.create({
            type: 'prospect.import_process',
            payload: { importId, actorUserId: caller.userId },
            organizationId: caller.organizationId,
            traceId: options.traceId,
          })
          await scope.enqueueOutbox({
            id: newOutboxId(),
            topic: job.type,
            dedupeKey: `prospect.import_process:${importId}`,
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
            action: 'prospect_import.created',
            subject: { type: 'prospect_import', id: importId },
          })
          return toImportResponse(record)
        }
      )
    )
  } catch (error) {
    await dropObject()
    throw error
  }
  if (answer.replayed) {
    await dropObject()
    return answer
  }

  return answer
}

/** The import, or `prospect.not_found` (resource `import`), for a caller who may read imports. */
export async function get(
  deps: Pick<ImportServiceDeps, 'store'>,
  caller: Caller,
  importId: ProspectImportId
): Promise<ProspectImport> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect_import.read')
    const record = await scope.getProspectImport(importId)
    if (!record) {
      throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'import' })
    }
    return toImportResponse(record)
  })
}

/** Lists the Organization's imports, newest first, one page at a time. */
export async function list(
  deps: Pick<ImportServiceDeps, 'store'>,
  caller: Caller,
  query: ListProspectImportsQuery
): Promise<ListProspectImportsResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, prospectImportCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect_import.read')
    const rows = await scope.listProspectImports({
      ...(after === undefined
        ? {}
        : { after: { createdAt: new Date(after.createdAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toImportResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/** Lists the rows of one import by row number, optionally of one result. */
export async function listRows(
  deps: Pick<ImportServiceDeps, 'store'>,
  caller: Caller,
  importId: ProspectImportId,
  query: ListProspectImportRowsQuery
): Promise<ListProspectImportRowsResponse> {
  const after =
    query.cursor === undefined
      ? undefined
      : decodeCursor(query.cursor, prospectImportRowCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'prospect_import.read')
    if (!(await scope.getProspectImport(importId))) {
      throw domainError(PROSPECT_ERRORS['prospect.not_found'], { resource: 'import' })
    }
    const rows = await scope.listProspectImportRows({
      importId,
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(after === undefined ? {} : { afterRow: after.rowNumber }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page,
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ rowNumber: last.rowNumber }) : null,
    }
  })
}

/**
 * The report as a stream of CSV text: the header, then the rows in pages of
 * {@link REPORT_PAGE_ROWS}, each read in a transaction of its own, so nothing is held in memory
 * in proportion to the file. The import is checked (and refused for a foreign Organization)
 * before the first byte.
 */
export async function reportStream(
  deps: Pick<ImportServiceDeps, 'store'>,
  caller: Caller,
  importId: ProspectImportId
): Promise<ReadableStream<Uint8Array>> {
  await get(deps, caller, importId)
  const encoder = new TextEncoder()
  let afterRow: number | undefined
  let started = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true
        controller.enqueue(encoder.encode('row_number,result,reason,prospect_id\r\n'))
        return
      }
      const rows = await deps.store.withOrganization(caller.organizationId, (scope) =>
        scope.listProspectImportRows({
          importId,
          ...(afterRow === undefined ? {} : { afterRow }),
          limit: REPORT_PAGE_ROWS,
        })
      )
      if (rows.length === 0) {
        controller.close()
        return
      }
      controller.enqueue(
        encoder.encode(
          rows
            .map((r) => `${r.rowNumber},${r.result},${r.reason ?? ''},${r.prospectId ?? ''}\r\n`)
            .join('')
        )
      )
      afterRow = rows.at(-1)?.rowNumber
      if (rows.length < REPORT_PAGE_ROWS) {
        controller.close()
      }
    },
  })
}

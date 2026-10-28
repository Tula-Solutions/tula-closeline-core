import type {
  SUPPRESSION_IMPORT_FAILURE_REASONS,
  SUPPRESSION_IMPORT_ROW_RESULTS,
  SuppressionImportId,
  SuppressionImport as SuppressionImportView,
  UserId,
} from 'tula-closeline-contract'

/** Why a bulk Suppression import failed as a whole, as the contract names it. */
export type SuppressionImportFailureReason = (typeof SUPPRESSION_IMPORT_FAILURE_REASONS)[number]

/** What happened to one address of a bulk Suppression import. */
export type SuppressionImportRowResult = (typeof SUPPRESSION_IMPORT_ROW_RESULTS)[number]

/** Why a row was invalid. */
export type SuppressionImportRowReason = 'unreadable_address' | 'unsupported_address'

/** A bulk Suppression import as the store holds it. The counts are `null` until it completes. */
export type SuppressionImportRecord = {
  id: SuppressionImportId
  state: SuppressionImportView['state']
  failureReason: SuppressionImportFailureReason | null
  sizeBytes: number
  /** SHA-256 of the uploaded file. */
  contentHash: Uint8Array
  /** Where the uploaded file is in the object store. */
  objectKey: string
  /** How many data rows are done; a resumed job starts after this row. */
  processedRows: number
  totalRows: number | null
  addedRows: number | null
  alreadySuppressedRows: number | null
  invalidRows: number | null
  createdByUserId: UserId
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

/** The values of a new import, which starts `uploaded`. */
export type NewSuppressionImport = {
  id: SuppressionImportId
  sizeBytes: number
  contentHash: Uint8Array
  objectKey: string
  createdByUserId: UserId
  now: Date
}

/** The columns of an import that change; a missing key is left as it is. */
export type SuppressionImportPatch = {
  state?: SuppressionImportView['state']
  failureReason?: SuppressionImportFailureReason | null
  processedRows?: number
  /** Set only with `state: 'completed'`; the store stamps `completed_at` with the call's `now`. */
  counts?: { total: number; added: number; alreadySuppressed: number; invalid: number }
}

/** The result of one row. The header is row 1 and the first address row 2. */
export type SuppressionImportRowRecord = {
  rowNumber: number
  result: SuppressionImportRowResult
  /** Set exactly when the row is invalid. */
  reason: SuppressionImportRowReason | null
}

/** How many rows of an import have each result. */
export type SuppressionImportRowCounts = Record<SuppressionImportRowResult, number>

/** The bulk Suppression import methods of an Organization scope. */
export interface SuppressionImportScope {
  /** Adds an import in state `uploaded`. */
  insertSuppressionImport(input: NewSuppressionImport): Promise<SuppressionImportRecord>
  /** One import by id, or `null` (also for another Organization's). No lock. */
  getSuppressionImport(id: SuppressionImportId): Promise<SuppressionImportRecord | null>
  /** Like {@link getSuppressionImport}, under a row lock held to the end of the transaction. */
  lockSuppressionImport(id: SuppressionImportId): Promise<SuppressionImportRecord | null>
  /** One page of the Organization's imports, newest first (`created_at` then `id`, both descending). */
  listSuppressionImports(request: {
    after?: { createdAt: Date; id: SuppressionImportId }
    limit: number
  }): Promise<SuppressionImportRecord[]>
  /** Changes the columns in the patch and sets `updated_at`; `null` when the import does not exist. */
  updateSuppressionImport(
    id: SuppressionImportId,
    patch: SuppressionImportPatch,
    now: Date
  ): Promise<SuppressionImportRecord | null>
  /** Stores the result of rows; a row number that already has a result keeps the first one. */
  insertSuppressionImportRows(
    importId: SuppressionImportId,
    rows: readonly SuppressionImportRowRecord[]
  ): Promise<void>
  /** One page of an import's rows by row number, optionally of one result. */
  listSuppressionImportRows(request: {
    importId: SuppressionImportId
    result?: SuppressionImportRowResult
    afterRow?: number
    limit: number
  }): Promise<SuppressionImportRowRecord[]>
  /** How many rows of the import have each result. */
  countSuppressionImportRows(importId: SuppressionImportId): Promise<SuppressionImportRowCounts>
}

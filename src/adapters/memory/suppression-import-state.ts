import type { OrganizationId } from 'tula-closeline-contract'
import { MissingReferenceError } from '~/ports/core-store'
import type {
  SuppressionImportRecord,
  SuppressionImportRowRecord,
  SuppressionImportScope,
} from '~/ports/suppression-import-store'

/** What the in-memory store keeps for bulk Suppression imports. */
export type SuppressionImportState = {
  /** `organization/import` to the import. Replaced, never changed in place. */
  suppressionImports: Map<string, SuppressionImportRecord>
  /** `organization/import` to the rows of that import, ordered by row number. */
  suppressionImportRows: Map<string, readonly SuppressionImportRowRecord[]>
}

/** An empty {@link SuppressionImportState}. */
export function emptySuppressionImportState(): SuppressionImportState {
  return { suppressionImports: new Map(), suppressionImportRows: new Map() }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copySuppressionImportState(state: SuppressionImportState): SuppressionImportState {
  return {
    suppressionImports: new Map(state.suppressionImports),
    suppressionImportRows: new Map(state.suppressionImportRows),
  }
}

const keyOf = (organizationId: OrganizationId, id: string): string => `${organizationId}\u0000${id}`

const copyImport = (record: SuppressionImportRecord): SuppressionImportRecord => ({
  ...record,
  contentHash: new Uint8Array(record.contentHash),
})

/** Builds the bulk Suppression import methods of one transaction's scope, with the database's rules. */
export function createSuppressionImportScope(env: {
  organizationId: OrganizationId
  read: () => SuppressionImportState
  write: () => SuppressionImportState
  requireLock: () => void
}): SuppressionImportScope {
  const { organizationId, read, write, requireLock } = env
  const find = (id: string) => read().suppressionImports.get(keyOf(organizationId, id))

  return {
    insertSuppressionImport: async (input) => {
      requireLock()
      const record: SuppressionImportRecord = {
        id: input.id,
        state: 'uploaded',
        failureReason: null,
        sizeBytes: input.sizeBytes,
        contentHash: new Uint8Array(input.contentHash),
        objectKey: input.objectKey,
        processedRows: 0,
        totalRows: null,
        addedRows: null,
        alreadySuppressedRows: null,
        invalidRows: null,
        createdByUserId: input.createdByUserId,
        createdAt: input.now,
        updatedAt: input.now,
        completedAt: null,
      }
      write().suppressionImports.set(keyOf(organizationId, input.id), record)
      return copyImport(record)
    },

    getSuppressionImport: async (id) => {
      const stored = find(id)
      return stored ? copyImport(stored) : null
    },

    lockSuppressionImport: async (id) => {
      requireLock()
      const stored = find(id)
      return stored ? copyImport(stored) : null
    },

    // shortcut: sorts the Organization's imports per call; the database uses an index. Fine for tests.
    listSuppressionImports: async (request) => {
      const after = request.after
      return [...read().suppressionImports.entries()]
        .filter(([key]) => key.startsWith(`${organizationId}\u0000`))
        .map(([, record]) => record)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )
        .filter(
          (record) =>
            after === undefined ||
            record.createdAt.getTime() < after.createdAt.getTime() ||
            (record.createdAt.getTime() === after.createdAt.getTime() && record.id < after.id)
        )
        .slice(0, request.limit)
        .map(copyImport)
    },

    updateSuppressionImport: async (id, patch, now) => {
      requireLock()
      const stored = find(id)
      if (!stored) {
        return null
      }
      const next: SuppressionImportRecord = {
        ...stored,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.processedRows === undefined ? {} : { processedRows: patch.processedRows }),
        ...(patch.counts === undefined
          ? {}
          : {
              totalRows: patch.counts.total,
              addedRows: patch.counts.added,
              alreadySuppressedRows: patch.counts.alreadySuppressed,
              invalidRows: patch.counts.invalid,
              completedAt: now,
            }),
        updatedAt: now,
      }
      write().suppressionImports.set(keyOf(organizationId, id), next)
      return copyImport(next)
    },

    insertSuppressionImportRows: async (importId, rows) => {
      requireLock()
      if (!find(importId)) {
        throw new MissingReferenceError('The import')
      }
      const key = keyOf(organizationId, importId)
      const existing = read().suppressionImportRows.get(key) ?? []
      const last = existing[existing.length - 1]?.rowNumber ?? 0
      // The job writes ascending batches, so appending skips a re-sort of up to 50,000 rows.
      const ascending = rows.every((row, i) => row.rowNumber > (rows[i - 1]?.rowNumber ?? last))
      if (ascending) {
        write().suppressionImportRows.set(key, [...existing, ...rows.map((row) => ({ ...row }))])
        return
      }
      const known = new Map(existing.map((row) => [row.rowNumber, row]))
      for (const row of rows) {
        if (!known.has(row.rowNumber)) {
          known.set(row.rowNumber, { ...row })
        }
      }
      write().suppressionImportRows.set(
        key,
        [...known.values()].sort((a, b) => a.rowNumber - b.rowNumber)
      )
    },

    listSuppressionImportRows: async (request) => {
      if (!find(request.importId)) {
        return []
      }
      const afterRow = request.afterRow ?? 0
      return (read().suppressionImportRows.get(keyOf(organizationId, request.importId)) ?? [])
        .filter(
          (row) =>
            row.rowNumber > afterRow &&
            (request.result === undefined || row.result === request.result)
        )
        .slice(0, request.limit)
        .map((row) => ({ ...row }))
    },

    countSuppressionImportRows: async (importId) => {
      const counts = { added: 0, already_suppressed: 0, invalid: 0 }
      if (find(importId)) {
        for (const row of read().suppressionImportRows.get(keyOf(organizationId, importId)) ?? []) {
          counts[row.result] += 1
        }
      }
      return counts
    },
  }
}

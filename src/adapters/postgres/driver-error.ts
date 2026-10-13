import { postgresErrorOf } from './retry'

/** The most `cause` links looked through for query detail; also bounds a cyclic chain. */
const MAX_CAUSE_DEPTH = 8

/**
 * A query failed in the driver. It carries the SQLSTATE and nothing else: not the statement, not
 * its parameters (token hashes, addresses), not the driver's message, and no `cause`.
 */
export class DatabaseQueryError extends Error {
  /** The five-character Postgres SQLSTATE, when the failure had one. */
  readonly code?: string

  constructor(code?: string) {
    super('A database query failed')
    this.name = 'DatabaseQueryError'
    if (code !== undefined) {
      this.code = code
    }
  }
}

/** Whether `error` or anything it was caused by is a query failure: it holds the query text and its parameters. */
function carriesQueryDetail(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const detail = current as { query?: unknown; params?: unknown }
    if (typeof detail.query === 'string' && Array.isArray(detail.params)) {
      return true
    }
    current = current.cause
  }
  return false
}

/**
 * The one place a driver failure is made safe to log and report. The query builder's error message
 * holds the statement and every bound parameter, which for the Invitation methods are token hashes
 * and email addresses, and the log keeps up to 200 characters of it. A failure that carries query
 * detail is replaced by a {@link DatabaseQueryError}; any other error is returned unchanged. Call
 * it on what leaves the store, after the retry has had its chance to read the failure.
 */
export function withoutQueryDetail(error: unknown): unknown {
  return carriesQueryDetail(error) ? new DatabaseQueryError(postgresErrorOf(error)?.code) : error
}

/** Runs `work` and throws what it throws through {@link withoutQueryDetail}. */
export async function guardQueryDetail<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw withoutQueryDetail(error)
  }
}

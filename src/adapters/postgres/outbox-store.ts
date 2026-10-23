import { type SQL, sql } from 'drizzle-orm'
import { type OrganizationId, organizationIdSchema } from 'tula-closeline-contract'
import {
  type Database,
  OUTBOX_CLAIM,
  OUTBOX_COMPLETE,
  OUTBOX_ENQUEUE,
  OUTBOX_FAIL,
  type Transaction,
} from 'tula-closeline-db'
import type { OrganizationScope } from '~/ports/core-store'
import type { ClaimedOutboxRow, OutboxStore } from '~/ports/outbox'

/**
 * Binds the positional parameters (`$1`, `$2`, ...) of one of the db library's statements through
 * drizzle, so the statement text stays the library's own and every value travels as a parameter.
 */
export function bindStatement(text: string, params: readonly (string | number)[]): SQL {
  const parts = text.split(/(\$\d+)/).map((piece) => {
    const index = /^\$(\d+)$/.exec(piece)?.[1]
    if (index === undefined) {
      return sql.raw(piece)
    }
    const value = params[Number(index) - 1]
    if (value === undefined) {
      throw new Error(`outbox statement: parameter ${index} was not given`)
    }
    return sql`${value}`
  })
  return sql.join(parts, sql.raw(''))
}

/** The outbox method of the Postgres scope. */
export type OutboxScopeMethods = Pick<OrganizationScope, 'enqueueOutbox'>

/** Builds the outbox method of one transaction's scope: an insert under the transaction's row-level security. */
export function createOutboxScope(
  tx: Transaction,
  organizationId: OrganizationId
): OutboxScopeMethods {
  return {
    enqueueOutbox: async (entry) => {
      const result = await tx.execute(
        bindStatement(OUTBOX_ENQUEUE, [
          entry.id,
          organizationId,
          entry.topic,
          JSON.stringify(entry.payload),
          entry.dedupeKey,
        ])
      )
      return result.rows.length > 0
    },
  }
}

type ClaimRow = {
  organization_id: string
  id: string
  topic: string
  payload: Record<string, unknown>
  attempts: number
}

/** A Postgres text-array literal of ids; the ids are hex and underscore only, so nothing needs quoting. */
function arrayLiteral(values: readonly string[]): string {
  return `{${values.join(',')}}`
}

/**
 * The drain's store over the pooled handle. The three functions it calls run in the database as the
 * outbox drain role, so they need no Organization scope: a claim spans every Organization.
 */
export function createPostgresOutboxStore(db: Pick<Database, 'execute'>): OutboxStore {
  return {
    claim: async (limit, leaseMs) => {
      const result = await db.execute<ClaimRow>(bindStatement(OUTBOX_CLAIM, [limit, leaseMs]))
      return result.rows.map(
        (row: ClaimRow): ClaimedOutboxRow => ({
          organizationId: organizationIdSchema.parse(row.organization_id),
          id: row.id,
          topic: row.topic,
          payload: row.payload,
          attempts: row.attempts,
        })
      )
    },
    complete: async (rows) => {
      if (rows.length === 0) {
        return
      }
      await db.execute(
        bindStatement(OUTBOX_COMPLETE, [
          arrayLiteral(rows.map((row) => row.organizationId)),
          arrayLiteral(rows.map((row) => row.id)),
        ])
      )
    },
    fail: async (row, errorCode, retryAfterMs) => {
      await db.execute(
        bindStatement(OUTBOX_FAIL, [row.organizationId, row.id, errorCode, retryAfterMs])
      )
    },
  }
}

import type { OrganizationId } from 'tula-closeline-contract'
import type { OrganizationScope } from '~/ports/core-store'
import type { ClaimedOutboxRow, OutboxStore } from '~/ports/outbox'

/** How many times the database lets a row be claimed before it parks it. */
const MAX_ATTEMPTS = 50

/** The largest payload the database accepts, in bytes of its JSON text. */
const MAX_PAYLOAD_BYTES = 16_384

const ROW_ID = /^obx_[0-9a-f]{32}$/
const TOPIC = /^[a-z][a-z0-9_.-]*$/

/** One outbox row as the memory store keeps it: the database's columns, one for one. */
export type MemoryOutboxRow = {
  organizationId: OrganizationId
  id: string
  topic: string
  payload: Record<string, unknown>
  dedupeKey: string
  availableAt: Date
  attempts: number
  publishedAt: Date | null
  lastErrorCode: string | null
}

/** What the in-memory store keeps for the outbox. The maps are replaced, never changed in place, once a transaction has taken its copy. */
export type OutboxState = {
  /** `organization/id` to the row. */
  outbox: Map<string, MemoryOutboxRow>
  /** `organization/dedupe key` to the row id: the unique index `(organization_id, dedupe_key)`. */
  outboxKeys: Map<string, string>
}

/** An empty {@link OutboxState}. */
export function emptyOutboxState(): OutboxState {
  return { outbox: new Map(), outboxKeys: new Map() }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copyOutboxState(state: OutboxState): OutboxState {
  return { outbox: new Map(state.outbox), outboxKeys: new Map(state.outboxKeys) }
}

const rowKey = (organizationId: OrganizationId, id: string): string =>
  `${organizationId}\u0000${id}`

/** Builds the outbox method of one transaction's scope, with the database's own checks. */
export function createOutboxScope(env: {
  organizationId: OrganizationId
  now: () => Date
  write: () => OutboxState
}): Pick<OrganizationScope, 'enqueueOutbox'> {
  const { organizationId, now, write } = env
  return {
    enqueueOutbox: async (entry) => {
      const text = JSON.stringify(entry.payload)
      if (
        !ROW_ID.test(entry.id) ||
        !TOPIC.test(entry.topic) ||
        entry.topic.length > 120 ||
        entry.dedupeKey.length < 1 ||
        entry.dedupeKey.length > 200 ||
        new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES
      ) {
        throw new Error('outbox: the entry breaks a check constraint of core.outbox')
      }
      const state = write()
      const keyed = rowKey(organizationId, entry.dedupeKey)
      if (state.outboxKeys.has(keyed)) {
        return false
      }
      state.outboxKeys.set(keyed, entry.id)
      state.outbox.set(rowKey(organizationId, entry.id), {
        organizationId,
        id: entry.id,
        topic: entry.topic,
        payload: JSON.parse(text) as Record<string, unknown>,
        dedupeKey: entry.dedupeKey,
        availableAt: now(),
        attempts: 0,
        publishedAt: null,
        lastErrorCode: null,
      })
      return true
    },
  }
}

/** The memory outbox store, plus a read a test uses to see every row. */
export interface MemoryOutbox extends OutboxStore {
  /** A snapshot of every row, oldest first, published or not. */
  rows(): MemoryOutboxRow[]
}

/**
 * The drain side over the committed state. Each call runs between transactions (`serialised`), the
 * way a lease taken by the database's functions never sees a half-written transaction, and applies
 * the same rules: due means unpublished, available and under 50 attempts; a claim counts the attempt
 * and pushes `availableAt` out by the lease.
 */
export function createMemoryOutbox(env: {
  state: () => OutboxState
  now: () => Date
  serialised: <T>(work: () => Promise<T>) => Promise<T>
}): MemoryOutbox {
  const { state, now, serialised } = env
  return {
    claim: (limit, leaseMs) =>
      serialised(async () => {
        const at = now()
        const due = [...state().outbox.values()]
          .filter(
            (row) =>
              row.publishedAt === null &&
              row.availableAt.getTime() <= at.getTime() &&
              row.attempts < MAX_ATTEMPTS
          )
          .sort(
            (a, b) =>
              a.availableAt.getTime() - b.availableAt.getTime() ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          )
          .slice(0, Math.min(Math.max(limit, 0), 100))
        const lease = Math.min(Math.max(leaseMs, 1_000), 3_600_000)
        return due.map((row): ClaimedOutboxRow => {
          row.attempts += 1
          row.availableAt = new Date(at.getTime() + lease)
          return {
            organizationId: row.organizationId,
            id: row.id,
            topic: row.topic,
            payload: JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>,
            attempts: row.attempts,
          }
        })
      }),
    complete: (refs) =>
      serialised(async () => {
        for (const ref of refs) {
          const row = state().outbox.get(rowKey(ref.organizationId, ref.id))
          if (row && row.publishedAt === null) {
            row.publishedAt = now()
            row.lastErrorCode = null
          }
        }
      }),
    fail: (ref, errorCode, retryAfterMs) =>
      serialised(async () => {
        const row = state().outbox.get(rowKey(ref.organizationId, ref.id))
        if (row && row.publishedAt === null) {
          row.lastErrorCode = errorCode
          row.availableAt = new Date(
            now().getTime() + Math.min(Math.max(retryAfterMs, 0), 86_400_000)
          )
        }
      }),
    rows: () =>
      [...state().outbox.values()]
        .map((row) => ({ ...row, payload: { ...row.payload } }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

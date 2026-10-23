import type { Clock } from 'tula-closeline-kit'
import type {
  ClaimedDemoNotice,
  DemoRequestInput,
  DemoRequestStore,
  NoticeOutcome,
} from '~/ports/demo-request-store'

/** How long a Demo Request is kept, in months. */
const RETENTION_MONTHS = 12

/** A Demo Request as the memory store holds it. */
type Row = DemoRequestInput & {
  submittedAt: Date
  status: 'pending' | NoticeOutcome
  attempts: number
  lastAttemptAt: Date | null
}

/** A Demo Request store a test can look inside. */
export type MemoryDemoRequestStore = DemoRequestStore & {
  /** Every stored Demo Request, oldest first. */
  rows(): readonly Readonly<Row>[]
}

/** Builds the in-memory Demo Request store; `clock` stamps submissions and attempts. */
export function createMemoryDemoRequestStore(clock: Pick<Clock, 'now'>): MemoryDemoRequestStore {
  const rows: Row[] = []

  const same = (row: Row, input: DemoRequestInput): boolean =>
    row.name === input.name &&
    row.workEmail === input.workEmail &&
    row.companyName === input.companyName &&
    row.message === input.message &&
    row.sourcePage === input.sourcePage

  return {
    rows: () => rows,
    submit: async (input) => {
      const existing = rows.find((row) => row.idempotencyKey === input.idempotencyKey)
      if (existing) {
        return { id: existing.id, replayed: true, sameFields: same(existing, input) }
      }
      rows.push({
        ...input,
        submittedAt: clock.now(),
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
      })
      return { id: input.id, replayed: false, sameFields: true }
    },
    claimNotices: async (limit, backoffSeconds) => {
      const now = clock.now()
      const claimed: ClaimedDemoNotice[] = []
      for (const row of rows) {
        if (claimed.length >= limit) {
          break
        }
        const rested =
          row.lastAttemptAt === null ||
          now.getTime() - row.lastAttemptAt.getTime() >= backoffSeconds * 1000
        if (row.status !== 'pending' || !rested) {
          continue
        }
        row.attempts += 1
        row.lastAttemptAt = now
        claimed.push({
          id: row.id,
          name: row.name,
          workEmail: row.workEmail,
          companyName: row.companyName,
          message: row.message,
          sourcePage: row.sourcePage,
          submittedAt: row.submittedAt,
          attempts: row.attempts,
        })
      }
      return claimed
    },
    settleNotice: async (id, outcome) => {
      const row = rows.find((candidate) => candidate.id === id)
      if (row?.status !== 'pending') {
        return false
      }
      row.status = outcome
      return true
    },
    purgeExpired: async (limit) => {
      const cutoff = clock.now()
      cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS)
      let removed = 0
      for (let index = 0; index < rows.length && removed < limit; ) {
        const row = rows[index]
        if (row && row.submittedAt < cutoff) {
          rows.splice(index, 1)
          removed += 1
        } else {
          index += 1
        }
      }
      return removed
    },
  }
}

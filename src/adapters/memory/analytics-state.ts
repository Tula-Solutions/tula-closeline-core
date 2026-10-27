import type { AnalyticsMetric, MembershipId, OrganizationId } from 'tula-closeline-contract'
import { ANALYTICS_METRICS } from 'tula-closeline-contract'
import type {
  AnalyticsEventEntry,
  AnalyticsScope,
  RollupGroupKind,
  RollupTableRow,
} from '~/ports/analytics-store'
import { mayOwn, type ProspectStateView } from './prospect-state'

type LedgerRow = AnalyticsEventEntry & { organizationId: OrganizationId }

type RollupCell = {
  organizationId: OrganizationId
  metric: AnalyticsMetric
  groupKind: RollupGroupKind
  day: string
  groupKey: string
  count: number
}

/** What the in-memory store keeps for analytics: the event ledger and the daily rollup cells. */
export type AnalyticsState = {
  /** Keyed by Organization, metric and dedupe key. */
  analyticsLedger: Map<string, LedgerRow>
  /** Keyed by Organization, metric, group kind, day and group key. */
  rollupCells: Map<string, RollupCell>
}

/** An empty {@link AnalyticsState}. */
export function emptyAnalyticsState(): AnalyticsState {
  return { analyticsLedger: new Map(), rollupCells: new Map() }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyAnalyticsState(state: AnalyticsState): AnalyticsState {
  return {
    analyticsLedger: new Map(state.analyticsLedger),
    rollupCells: new Map(state.rollupCells),
  }
}

const ledgerKey = (organizationId: string, metric: string, dedupeKey: string) =>
  `${organizationId}|${metric}|${dedupeKey}`
const cellKey = (c: Omit<RollupCell, 'count'>) =>
  `${c.organizationId}|${c.metric}|${c.groupKind}|${c.day}|${c.groupKey}`

/** Builds the analytics methods of one transaction's scope, with the database's own rules. */
export function createAnalyticsScope(env: {
  organizationId: OrganizationId
  read: () => AnalyticsState & ProspectStateView
  write: () => AnalyticsState
  requireLock: () => void
}): AnalyticsScope {
  const { organizationId, read, write, requireLock } = env

  const add = (
    state: AnalyticsState,
    metric: AnalyticsMetric,
    groupKind: RollupGroupKind,
    groupKey: string,
    day: string
  ) => {
    const base = { organizationId, metric, groupKind, day, groupKey }
    const key = cellKey(base)
    const existing = state.rollupCells.get(key)
    // Replaced, never changed in place: a copy of the map shares its values with the original.
    state.rollupCells.set(key, { ...base, count: (existing?.count ?? 0) + 1 })
  }

  return {
    recordAnalyticsEvent: async (entry) => {
      requireLock()
      const state = write()
      const key = ledgerKey(organizationId, entry.metric, entry.dedupeKey)
      if (state.analyticsLedger.has(key)) {
        return false
      }
      state.analyticsLedger.set(key, { ...entry, organizationId })
      add(state, entry.metric, 'total', '', entry.day)
      if (entry.channel !== null) {
        add(state, entry.metric, 'channel', entry.channel, entry.day)
      }
      if (entry.repMembershipId !== undefined) {
        add(state, entry.metric, 'rep', entry.repMembershipId, entry.day)
      }
      return true
    },

    dealOutcome: async (dealRecordId) => {
      let latest: { day: string; outcome: 'won' | 'lost' } | null = null
      for (const row of read().analyticsLedger.values()) {
        const outcome =
          row.metric === 'outcomes_won' ? 'won' : row.metric === 'outcomes_lost' ? 'lost' : null
        if (
          row.organizationId === organizationId &&
          row.dedupeKey === dealRecordId &&
          outcome !== null &&
          (latest === null || row.day >= latest.day)
        ) {
          latest = { day: row.day, outcome }
        }
      }
      return latest?.outcome ?? null
    },

    listRollupSeries: async (request) => {
      const view = read()
      const allowed =
        request.groupKind === 'rep' && request.visibility
          ? mayOwn(view, organizationId, request.visibility)
          : () => true
      const lines = new Map<string, Map<string, number>>()
      for (const cell of view.rollupCells.values()) {
        if (
          cell.organizationId !== organizationId ||
          !request.metrics.includes(cell.metric) ||
          cell.groupKind !== request.groupKind ||
          cell.day < request.from ||
          cell.day > request.to ||
          (request.groupKey !== undefined && cell.groupKey !== request.groupKey) ||
          (request.groupKeys !== undefined && !request.groupKeys.includes(cell.groupKey)) ||
          (request.afterKey !== undefined && cell.groupKey <= request.afterKey) ||
          !allowed(cell.groupKey as MembershipId)
        ) {
          continue
        }
        const key = request.sumGroups ? '' : cell.groupKey
        const days = lines.get(key) ?? new Map<string, number>()
        days.set(cell.day, (days.get(cell.day) ?? 0) + cell.count)
        lines.set(key, days)
      }
      return [...lines.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, request.limit)
        .map(([groupKey, days]) => ({
          groupKey,
          points: [...days.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([day, count]) => ({ day, count })),
        }))
    },

    listRollupTable: async (request) => {
      const view = read()
      const allowed =
        request.groupKind === 'rep' && request.visibility
          ? mayOwn(view, organizationId, request.visibility)
          : () => true
      const rows = new Map<string, RollupTableRow>()
      for (const cell of view.rollupCells.values()) {
        if (
          cell.organizationId !== organizationId ||
          cell.groupKind !== request.groupKind ||
          (request.groupKey !== undefined && cell.groupKey !== request.groupKey) ||
          cell.day < request.from ||
          cell.day > request.to ||
          (request.afterKey !== undefined && cell.groupKey <= request.afterKey) ||
          !allowed(cell.groupKey as MembershipId)
        ) {
          continue
        }
        const row = rows.get(cell.groupKey) ?? {
          groupKey: cell.groupKey,
          totals: Object.fromEntries(
            ANALYTICS_METRICS.map((m) => [m, 0])
          ) as RollupTableRow['totals'],
        }
        row.totals[cell.metric] += cell.count
        rows.set(cell.groupKey, row)
      }
      return [...rows.values()]
        .sort((a, b) => (a.groupKey < b.groupKey ? -1 : 1))
        .slice(0, request.limit)
    },

    repVisible: async (visibility, membershipId) => {
      const view = read()
      const found = view.memberships.get(membershipId as MembershipId)
      return (
        found?.organizationId === organizationId &&
        mayOwn(view, organizationId, visibility)(membershipId as MembershipId)
      )
    },

    reconcileRollups: async ({ from, to }) => {
      requireLock()
      const state = write()
      const expected = new Map<string, RollupCell>()
      const bump = (
        metric: AnalyticsMetric,
        groupKind: RollupGroupKind,
        groupKey: string,
        day: string
      ) => {
        const base = { organizationId, metric, groupKind, day, groupKey }
        const key = cellKey(base)
        expected.set(key, { ...base, count: (expected.get(key)?.count ?? 0) + 1 })
      }
      for (const row of state.analyticsLedger.values()) {
        if (row.organizationId !== organizationId || row.day < from || row.day > to) {
          continue
        }
        bump(row.metric, 'total', '', row.day)
        if (row.channel !== null) {
          bump(row.metric, 'channel', row.channel, row.day)
        }
      }
      const kinds: RollupGroupKind[] = ['total', 'channel']
      const actual = [...state.rollupCells.entries()].filter(
        ([, c]) =>
          c.organizationId === organizationId &&
          kinds.includes(c.groupKind) &&
          c.day >= from &&
          c.day <= to
      )
      let cells = 0
      let repaired = 0
      for (const [key, cell] of actual) {
        cells += 1
        const want = expected.get(key)?.count ?? 0
        if (cell.count !== want) {
          repaired += 1
          if (want === 0) {
            state.rollupCells.delete(key)
          } else {
            state.rollupCells.set(key, { ...cell, count: want })
          }
        }
      }
      const present = new Set(actual.map(([key]) => key))
      for (const [key, cell] of expected) {
        if (!present.has(key)) {
          cells += 1
          repaired += 1
          state.rollupCells.set(key, cell)
        }
      }
      return { cells, repaired }
    },
  }
}

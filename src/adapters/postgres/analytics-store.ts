import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm'
import type { AnalyticsMetric, OrganizationId } from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { analyticsEvents, rollupDaily } from 'tula-closeline-db/schema'
import type { AnalyticsScope, RollupGroupKind } from '~/ports/analytics-store'

type Cell = {
  metric: AnalyticsMetric
  groupKind: RollupGroupKind
  groupKey: string
  day: string
  count: number
}

const cellId = (c: Pick<Cell, 'metric' | 'groupKind' | 'groupKey' | 'day'>) =>
  `${c.metric}|${c.groupKind}|${c.day}|${c.groupKey}`

/** Builds the analytics methods of one Organization's transaction; every statement names the Organization as well as relying on row-level security. */
export function createAnalyticsStore(
  tx: Transaction,
  organizationId: OrganizationId
): AnalyticsScope {
  const bump = (
    metric: AnalyticsMetric,
    groupKind: RollupGroupKind,
    groupKey: string,
    day: string
  ) =>
    tx
      .insert(rollupDaily)
      .values({ organizationId, metric, groupKind, groupKey, day, count: 1 })
      .onConflictDoUpdate({
        target: [
          rollupDaily.organizationId,
          rollupDaily.metric,
          rollupDaily.groupKind,
          rollupDaily.day,
          rollupDaily.groupKey,
        ],
        set: { count: sql`${rollupDaily.count} + 1`, updatedAt: sql`now()` },
      })

  return {
    recordAnalyticsEvent: async (entry) => {
      const inserted = await tx
        .insert(analyticsEvents)
        .values({
          organizationId,
          metric: entry.metric,
          dedupeKey: entry.dedupeKey,
          day: entry.day,
          channel: entry.channel,
        })
        .onConflictDoNothing()
        .returning({ dedupeKey: analyticsEvents.dedupeKey })
      if (inserted.length === 0) {
        return false
      }
      await bump(entry.metric, 'total', '', entry.day)
      if (entry.channel !== null) {
        await bump(entry.metric, 'channel', entry.channel, entry.day)
      }
      return true
    },

    listRollupSeries: async (request) => {
      const inRange = and(
        eq(rollupDaily.organizationId, organizationId),
        eq(rollupDaily.metric, request.metric),
        eq(rollupDaily.groupKind, request.groupKind),
        gte(rollupDaily.day, request.from),
        lte(rollupDaily.day, request.to),
        request.groupKey === undefined ? undefined : eq(rollupDaily.groupKey, request.groupKey),
        request.afterKey === undefined ? undefined : gt(rollupDaily.groupKey, request.afterKey)
      )
      const keys = await tx
        .selectDistinct({ groupKey: rollupDaily.groupKey })
        .from(rollupDaily)
        .where(inRange)
        .orderBy(asc(rollupDaily.groupKey))
        .limit(request.limit)
      if (keys.length === 0) {
        return []
      }
      const rows = await tx
        .select({ groupKey: rollupDaily.groupKey, day: rollupDaily.day, count: rollupDaily.count })
        .from(rollupDaily)
        .where(
          and(
            inRange,
            inArray(
              rollupDaily.groupKey,
              keys.map((k) => k.groupKey)
            )
          )
        )
        .orderBy(asc(rollupDaily.groupKey), asc(rollupDaily.day))
      return keys.map(({ groupKey }) => ({
        groupKey,
        points: rows
          .filter((r) => r.groupKey === groupKey)
          .map((r) => ({ day: r.day, count: Number(r.count) })),
      }))
    },

    reconcileRollups: async ({ from, to }) => {
      const counted = await tx
        .select({
          metric: analyticsEvents.metric,
          day: analyticsEvents.day,
          channel: analyticsEvents.channel,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEvents)
        .where(
          and(
            eq(analyticsEvents.organizationId, organizationId),
            gte(analyticsEvents.day, from),
            lte(analyticsEvents.day, to)
          )
        )
        .groupBy(analyticsEvents.metric, analyticsEvents.day, analyticsEvents.channel)
      const expected = new Map<string, Cell>()
      const add = (c: Omit<Cell, 'count'>, count: number) => {
        const id = cellId(c)
        expected.set(id, { ...c, count: (expected.get(id)?.count ?? 0) + count })
      }
      for (const row of counted) {
        add({ metric: row.metric, groupKind: 'total', groupKey: '', day: row.day }, row.count)
        if (row.channel !== null) {
          add(
            { metric: row.metric, groupKind: 'channel', groupKey: row.channel, day: row.day },
            row.count
          )
        }
      }
      const stored = await tx
        .select()
        .from(rollupDaily)
        .where(
          and(
            eq(rollupDaily.organizationId, organizationId),
            inArray(rollupDaily.groupKind, ['total', 'channel']),
            gte(rollupDaily.day, from),
            lte(rollupDaily.day, to)
          )
        )
      let cells = 0
      let repaired = 0
      const seen = new Set<string>()
      for (const row of stored) {
        cells += 1
        const id = cellId(row)
        seen.add(id)
        const want = expected.get(id)?.count ?? 0
        if (Number(row.count) !== want) {
          repaired += 1
          await tx
            .update(rollupDaily)
            .set({ count: want, updatedAt: sql`now()` })
            .where(
              and(
                eq(rollupDaily.organizationId, organizationId),
                eq(rollupDaily.metric, row.metric),
                eq(rollupDaily.groupKind, row.groupKind),
                eq(rollupDaily.day, row.day),
                eq(rollupDaily.groupKey, row.groupKey)
              )
            )
        }
      }
      for (const [id, cell] of expected) {
        if (!seen.has(id)) {
          cells += 1
          repaired += 1
          await tx
            .insert(rollupDaily)
            .values({ organizationId, ...cell })
            .onConflictDoUpdate({
              target: [
                rollupDaily.organizationId,
                rollupDaily.metric,
                rollupDaily.groupKind,
                rollupDaily.day,
                rollupDaily.groupKey,
              ],
              set: { count: cell.count, updatedAt: sql`now()` },
            })
        }
      }
      return { cells, repaired }
    },
  }
}

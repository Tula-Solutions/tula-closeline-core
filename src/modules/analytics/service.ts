import {
  ANALYTICS_RATE_METRICS,
  type AnalyticsGroupBy,
  type AnalyticsMetric,
  analyticsMetricSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type GetSeriesQuery,
  type GetSeriesResponse,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization } from '~/modules/organization/access'
import type { RollupGroupKind } from '~/ports/analytics-store'
import { seriesCursorSchema } from './schema'

/** What the analytics read needs from the container. */
export type AnalyticsReadDeps = Pick<Container, 'store'>

/** The metric when it is a count the rollups hold, else `undefined` (a ratio metric). */
function countMetric(metric: GetSeriesQuery['metric']): AnalyticsMetric | undefined {
  return ANALYTICS_RATE_METRICS.some((rate) => rate === metric)
    ? undefined
    : analyticsMetricSchema.safeParse(metric).data
}

/** The one group a query filters on, if any; more than one filter is not supported yet. */
function filterOf(query: GetSeriesQuery): { kind: AnalyticsGroupBy; key: string } | undefined {
  const filters: { kind: AnalyticsGroupBy; key: string }[] = []
  if (query.channel !== undefined) {
    filters.push({ kind: 'channel', key: query.channel })
  }
  if (query.agentKind !== undefined) {
    filters.push({ kind: 'agent_kind', key: query.agentKind })
  }
  if (query.campaignId !== undefined) {
    filters.push({ kind: 'campaign', key: query.campaignId })
  }
  if (query.repMembershipId !== undefined) {
    filters.push({ kind: 'rep', key: query.repMembershipId })
  }
  if (filters.length > 1) {
    throw domainError(ERRORS['request.invalid'])
  }
  return filters[0]
}

/**
 * The raw daily series of one metric over a range, read from the rollups and never from history.
 * With no `groupBy` it is one line (the total, or the one filtered group); with `groupBy` it is
 * one line per group, in key order, cursor-paged by group. Only days that have a count appear.
 * A filter on a different dimension than `groupBy`, or more than one filter, is `request.invalid`.
 * Owner and Admin only; Manager and Rep scoping comes with the dashboard.
 */
export async function series(
  deps: AnalyticsReadDeps,
  caller: Caller,
  query: GetSeriesQuery
): Promise<GetSeriesResponse> {
  // The contract also names ratio metrics; the rollups hold counts only, so refuse them here.
  const metric = countMetric(query.metric)
  if (metric === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, seriesCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const filter = filterOf(query)
  if (filter && query.groupBy !== undefined && filter.kind !== query.groupBy) {
    throw domainError(ERRORS['request.invalid'])
  }
  const groupKind: RollupGroupKind = query.groupBy ?? filter?.kind ?? 'total'
  const grouped = query.groupBy !== undefined
  const limit = grouped ? query.limit : 1
  const lines = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'analytics.read')
    return scope.listRollupSeries({
      metric,
      groupKind,
      ...(filter ? { groupKey: filter.key } : {}),
      ...(after ? { afterKey: after.key } : {}),
      from: query.from,
      to: query.to,
      limit: limit + 1,
    })
  })
  const page = lines.slice(0, limit)
  const last = page.at(-1)
  const toPoints = (points: { day: string; count: number }[]) =>
    points.map((p) => ({
      kind: 'count' as const,
      value: p.count,
      recordCount: p.count,
      day: p.day,
    }))
  const series = grouped
    ? page.map((line) => ({ group: line.groupKey, points: toPoints(line.points) }))
    : [{ group: null, points: toPoints(page[0]?.points ?? []) }]
  return {
    from: query.from,
    to: query.to,
    metric: query.metric,
    groupBy: query.groupBy ?? null,
    series,
    nextCursor:
      grouped && lines.length > limit && last ? encodeCursor({ key: last.groupKey }) : null,
  }
}

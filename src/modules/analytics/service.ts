import {
  type AnalyticsGroupBy,
  type AnalyticsMetric,
  type AnalyticsSeriesMetric,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type GetSeriesQuery,
  type GetSeriesResponse,
  type ListTableQuery,
  MIN_RATE_SAMPLE,
  type TableRow,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { csvCell } from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { openOrganization } from '~/modules/organization/access'
import type { RollupGroupKind, RollupLine, RollupTableRow } from '~/ports/analytics-store'
import type { OrganizationScope, ProspectVisibility } from '~/ports/core-store'
import { seriesCursorSchema } from './schema'

/** What the analytics read needs from the container. */
export type AnalyticsReadDeps = Pick<Container, 'store'>

type Filter = { kind: AnalyticsGroupBy; key: string }

type Filters = Pick<GetSeriesQuery, 'channel' | 'agentKind' | 'campaignId' | 'repMembershipId'>

/** The one group a query filters on, if any; more than one filter is not supported yet. */
function filterOf(query: Filters): Filter | undefined {
  const filters: Filter[] = []
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

/** How a ratio metric is made: what it counts over what, and what it is a share of. */
const RATIOS = {
  reply_rate: { numerator: ['replies'], denominator: ['sends'] },
  positive_reply_rate: { numerator: ['positive_replies'], denominator: ['replies'] },
  meeting_rate: { numerator: ['meetings'], denominator: ['sends'] },
  win_rate: { numerator: ['outcomes_won'], denominator: ['outcomes_won', 'outcomes_lost'] },
} as const satisfies Record<
  string,
  { numerator: readonly AnalyticsMetric[]; denominator: readonly AnalyticsMetric[] }
>

type RatioMetric = keyof typeof RATIOS

const isRatio = (metric: AnalyticsSeriesMetric): metric is RatioMetric => metric in RATIOS

type Rate = Extract<TableRow['replyRate'], { kind: 'rate' }>

/**
 * A rate from its two counts: no value (only the sample size) below the minimum sample, else the
 * share, held at 1 when the numerator outran the denominator (counts of different events can
 * arrive in any order, and a share over 1 is never shown).
 */
function rateOf(numerator: number, denominator: number): Rate {
  if (denominator < MIN_RATE_SAMPLE) {
    return {
      kind: 'rate',
      state: 'not_enough_data',
      value: null,
      recordCount: denominator,
    } as Rate
  }
  return {
    kind: 'rate',
    state: 'ok',
    value: Math.min(1, numerator / denominator),
    recordCount: denominator,
  } as Rate
}

const count = (value: number) => ({ kind: 'count' as const, value, recordCount: value })

/** What a caller may see of the rollups, taken from their role and their own Membership. */
type Access = {
  /** Whether the view is cut down to a Rep or a Team (a Manager or a Rep). */
  restricted: boolean
  role: Caller['role']
  visibility: ProspectVisibility
  /** The caller's own Membership; set for a restricted caller. */
  own: string | null
}

async function accessOf(scope: OrganizationScope, caller: Caller): Promise<Access> {
  if (caller.role !== 'manager' && caller.role !== 'rep') {
    return { restricted: false, role: caller.role, visibility: { kind: 'all' }, own: null }
  }
  const own = await scope.getMembershipByUser(caller.userId)
  if (!own) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  return {
    restricted: true,
    role: caller.role,
    visibility:
      caller.role === 'manager'
        ? { kind: 'team', managerMembershipId: own.id }
        : { kind: 'owner', membershipId: own.id },
    own: own.id,
  }
}

/** Where in the rollups a request reads, once the caller's view is applied. */
type Plan = {
  groupKind: RollupGroupKind
  groupKey?: string
  visibility?: ProspectVisibility
  /** A Manager's total: the Reps of their view added into one line. */
  sumGroups?: boolean
}

/** Whether the caller may see the Rep's rows: their own, or (a Manager) one on their Team. */
async function repAllowed(scope: OrganizationScope, access: Access, key: string): Promise<boolean> {
  return access.role === 'rep' ? key === access.own : scope.repVisible(access.visibility, key)
}

/**
 * Turns the caller's `groupBy` and filter into where to read. A Manager or Rep may group or
 * filter only by Rep, because the other rollups hold no breakdown per Rep: anything else is
 * `auth.forbidden`. A Rep outside their view is `request.not_found`, never `auth.forbidden`.
 */
async function planOf(
  scope: OrganizationScope,
  access: Access,
  groupBy: AnalyticsGroupBy | undefined,
  filter: Filter | undefined
): Promise<Plan> {
  if (filter && groupBy !== undefined && filter.kind !== groupBy) {
    throw domainError(ERRORS['request.invalid'])
  }
  if (!access.restricted) {
    return {
      groupKind: groupBy ?? filter?.kind ?? 'total',
      ...(filter ? { groupKey: filter.key } : {}),
    }
  }
  if ((groupBy !== undefined && groupBy !== 'rep') || (filter && filter.kind !== 'rep')) {
    throw domainError(ERRORS['auth.forbidden'])
  }
  if (filter) {
    if (!(await repAllowed(scope, access, filter.key))) {
      throw domainError(ERRORS['request.not_found'])
    }
    return { groupKind: 'rep', groupKey: filter.key }
  }
  if (groupBy === 'rep') {
    return { groupKind: 'rep', visibility: access.visibility }
  }
  return access.role === 'rep' && access.own
    ? { groupKind: 'rep', groupKey: access.own }
    : { groupKind: 'rep', visibility: access.visibility, sumGroups: true }
}

type Day = { day: string; numerator: number; denominator: number }
type DayLine = { groupKey: string; days: Day[] }

/**
 * The lines of a series metric: a count's own, or a ratio's days that have a denominator, each
 * with both counts. The groups of a ratio page are those that have a denominator, and the
 * numerator is then read for exactly those groups.
 */
async function readLines(
  scope: OrganizationScope,
  plan: Plan,
  metric: AnalyticsSeriesMetric,
  range: { from: string; to: string; afterKey?: string; limit: number }
): Promise<DayLine[]> {
  const request = {
    groupKind: plan.groupKind,
    ...(plan.groupKey === undefined ? {} : { groupKey: plan.groupKey }),
    ...(plan.visibility ? { visibility: plan.visibility } : {}),
    ...(plan.sumGroups ? { sumGroups: true } : {}),
    from: range.from,
    to: range.to,
  }
  if (!isRatio(metric)) {
    const lines = await scope.listRollupSeries({
      ...request,
      metrics: [metric],
      ...(range.afterKey === undefined ? {} : { afterKey: range.afterKey }),
      limit: range.limit,
    })
    return lines.map((line) => ({
      groupKey: line.groupKey,
      days: line.points.map((p) => ({ day: p.day, numerator: p.count, denominator: p.count })),
    }))
  }
  const ratio = RATIOS[metric]
  const bottoms = await scope.listRollupSeries({
    ...request,
    metrics: [...ratio.denominator],
    ...(range.afterKey === undefined ? {} : { afterKey: range.afterKey }),
    limit: range.limit,
  })
  if (bottoms.length === 0) {
    return []
  }
  const tops = await scope.listRollupSeries({
    ...request,
    metrics: [...ratio.numerator],
    ...(plan.sumGroups ? {} : { groupKeys: bottoms.map((l) => l.groupKey) }),
    limit: bottoms.length,
  })
  const topByKey = new Map<string, RollupLine>(tops.map((line) => [line.groupKey, line]))
  return bottoms.map((line) => {
    const top = new Map((topByKey.get(line.groupKey)?.points ?? []).map((p) => [p.day, p.count]))
    return {
      groupKey: line.groupKey,
      days: line.points.map((p) => ({
        day: p.day,
        numerator: top.get(p.day) ?? 0,
        denominator: p.count,
      })),
    }
  })
}

/** Reads a cursor, or refuses it as a bad request. */
function cursorKey(cursor: string | undefined): string | undefined {
  if (cursor === undefined) {
    return undefined
  }
  const decoded = decodeCursor(cursor, seriesCursorSchema)
  if (decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return decoded.key
}

/**
 * The daily series of one metric over a range, read from the rollups and never from history. A
 * count has its raw value; a ratio has, for each day with a denominator, a rate, or "not enough
 * data" below {@link MIN_RATE_SAMPLE} records. With no `groupBy` it is one line (the total, or
 * the one filtered group); with `groupBy` one line per group in key order, cursor-paged by group.
 * Only days that have a count appear. A filter on a different dimension than `groupBy`, or more
 * than one filter, is `request.invalid`.
 *
 * Every role may read, scoped by the caller's own view: Owner and Admin read everything, a
 * Manager the Reps on their Teams (their total is the sum of those Reps' rows) and a Rep only
 * their own row. A Manager or Rep may only group or filter by Rep.
 */
export async function series(
  deps: AnalyticsReadDeps,
  caller: Caller,
  query: GetSeriesQuery
): Promise<GetSeriesResponse> {
  const afterKey = cursorKey(query.cursor)
  const filter = filterOf(query)
  const grouped = query.groupBy !== undefined
  if (afterKey !== undefined && !grouped) {
    // An ungrouped series is one line; a cursor would only cut it short.
    throw domainError(ERRORS['request.invalid'])
  }
  const limit = grouped ? query.limit : 1
  const lines = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'analytics.read')
    const access = await accessOf(scope, caller)
    const plan = await planOf(scope, access, query.groupBy, filter)
    return readLines(scope, plan, query.metric, {
      from: query.from,
      to: query.to,
      ...(afterKey === undefined ? {} : { afterKey }),
      limit: limit + 1,
    })
  })
  const page = lines.slice(0, limit)
  const last = page.at(-1)
  const toPoints = (days: Day[]) =>
    days.map(({ day, numerator, denominator }) =>
      isRatio(query.metric)
        ? { ...rateOf(numerator, denominator), day }
        : { ...count(numerator), day }
    )
  const result = grouped
    ? page.map((line) => ({ group: line.groupKey, points: toPoints(line.days) }))
    : [{ group: null, points: toPoints(page[0]?.days ?? []) }]
  return {
    from: query.from,
    to: query.to,
    metric: query.metric,
    groupBy: query.groupBy ?? null,
    series: result,
    nextCursor:
      grouped && lines.length > limit && last ? encodeCursor({ key: last.groupKey }) : null,
  } as GetSeriesResponse
}

type TableQuery = Pick<ListTableQuery, 'groupBy' | 'from' | 'to' | 'cursor'> &
  Filters & { limit: number }

/** The row of a table: every count, and the four rates from them. */
function tableRowOf(row: RollupTableRow): TableRow {
  const t = row.totals
  return {
    group: row.groupKey,
    sends: count(t.sends),
    replies: count(t.replies),
    positiveReplies: count(t.positive_replies),
    meetings: count(t.meetings),
    outcomesWon: count(t.outcomes_won),
    outcomesLost: count(t.outcomes_lost),
    replyRate: rateOf(t.replies, t.sends),
    positiveReplyRate: rateOf(t.positive_replies, t.replies),
    meetingRate: rateOf(t.meetings, t.sends),
    winRate: rateOf(t.outcomes_won, t.outcomes_won + t.outcomes_lost),
  }
}

async function tablePage(
  deps: AnalyticsReadDeps,
  caller: Caller,
  query: TableQuery
): Promise<{ items: TableRow[]; nextCursor: string | null }> {
  const afterKey = cursorKey(query.cursor)
  const filter = filterOf(query)
  const group = query.groupBy
  if (filter && filter.kind !== group) {
    throw domainError(ERRORS['request.invalid'])
  }
  const rows = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'analytics.read')
    const access = await accessOf(scope, caller)
    const plan = await planOf(scope, access, group, filter)
    return scope.listRollupTable({
      groupKind: group,
      ...(plan.groupKey === undefined ? {} : { groupKey: plan.groupKey }),
      ...(plan.visibility ? { visibility: plan.visibility } : {}),
      from: query.from,
      to: query.to,
      ...(afterKey === undefined ? {} : { afterKey }),
      limit: query.limit + 1,
    })
  })
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    items: page.map(tableRowOf),
    nextCursor: rows.length > query.limit && last ? encodeCursor({ key: last.groupKey }) : null,
  }
}

/**
 * One cursor page (at most 100 rows) of the comparison table: a row per group over the range,
 * with counts and rates, in group-key order. Scoped like {@link series}: a Manager or Rep may
 * only group by Rep and sees only the Reps in their view. A filter on a different dimension than
 * `groupBy` is `request.invalid` (the rollups hold no cross-breakdown).
 */
export async function table(
  deps: AnalyticsReadDeps,
  caller: Caller,
  query: ListTableQuery
): Promise<{ items: TableRow[]; nextCursor: string | null }> {
  return tablePage(deps, caller, query)
}

const CSV_COLUMNS = [
  'group',
  'sends',
  'replies',
  'positive_replies',
  'meetings',
  'outcomes_won',
  'outcomes_lost',
  'reply_rate',
  'reply_rate_n',
  'positive_reply_rate',
  'positive_reply_rate_n',
  'meeting_rate',
  'meeting_rate_n',
  'win_rate',
  'win_rate_n',
] as const

const rateCells = (rate: Rate): [string | number, number] => [
  rate.state === 'ok' ? rate.value : 'not_enough_data',
  rate.recordCount,
]

/**
 * One page of the table as CSV (at most 1,000 rows) with the cursor of the next page. A rate with
 * too few records reads `not_enough_data`, and each rate is followed by its sample size. Cells
 * are escaped so a spreadsheet never runs one.
 */
export async function tableCsv(
  deps: AnalyticsReadDeps,
  caller: Caller,
  query: Omit<TableQuery, 'limit'> & { limit: number }
): Promise<{ body: string; nextCursor: string | null }> {
  const page = await tablePage(deps, caller, query)
  const lines = page.items.map((row) =>
    [
      row.group,
      row.sends.value,
      row.replies.value,
      row.positiveReplies.value,
      row.meetings.value,
      row.outcomesWon.value,
      row.outcomesLost.value,
      ...rateCells(row.replyRate as Rate),
      ...rateCells(row.positiveReplyRate as Rate),
      ...rateCells(row.meetingRate as Rate),
      ...rateCells(row.winRate as Rate),
    ]
      .map(csvCell)
      .join(',')
  )
  return {
    body: `${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`,
    nextCursor: page.nextCursor,
  }
}

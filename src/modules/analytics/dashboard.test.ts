import { describe, expect, test } from 'bun:test'
import { formatId, type MembershipId, type OrganizationId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { consumeAnalyticsEvent, reconcileAnalytics } from './consumer'
import { bookingEnvelope, outcomeEnvelope, repliedEnvelope, sentEnvelope } from './testing'

type Point = {
  kind: string
  state?: string
  value: number | null
  recordCount: number
  day: string
}
type Line = { group: string | null; points: Point[] }
type Series = { series: Line[]; nextCursor: string | null }
type Row = Record<
  string,
  { kind: string; state?: string; value: number | null; recordCount: number }
> & {
  group: string
}
type Table = { items: Row[]; nextCursor: string | null }

const RANGE = 'from=2026-01-01&to=2026-01-31'
const teamId = () => formatId('team', crypto.randomUUID().replaceAll('-', ''))

/** Two Teams: A (manager A, reps A1 and A2) and B (manager B, rep B), and a second Organization. */
async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const org = await seedOrganization(store, ['admin', 'manager', 'manager', 'rep', 'rep', 'rep'])
  const other = await seedOrganization(store, ['admin'])
  const of = (role: string, n = 0) => org.members.filter((m) => m.role === role)[n] as SeededMember
  const [managerA, managerB, repA1, repA2, repB] = [
    of('manager', 0),
    of('manager', 1),
    of('rep', 0),
    of('rep', 1),
    of('rep', 2),
  ] as [SeededMember, SeededMember, SeededMember, SeededMember, SeededMember]
  const now = new Date('2026-01-01T00:00:00Z')
  await store.withOrganization(org.organizationId, async (scope) => {
    await scope.lockOrganization()
    const a = await scope.insertTeam({ id: teamId(), name: 'A', now })
    const b = await scope.insertTeam({ id: teamId(), name: 'B', now })
    for (const m of [managerA, repA1, repA2]) {
      await scope.addTeamMember(a.id, m.id, now)
    }
    for (const m of [managerB, repB]) {
      await scope.addTeamMember(b.id, m.id, now)
    }
  })
  const api = publicCaller(harness)
  const get = async (path: string, actor: SeededMember, organizationId = org.organizationId) => {
    const response = await api(actor, organizationId, 'GET', path)
    return { status: response.status, body: response.body }
  }
  const series = async (query: string, actor: SeededMember = org.owner) => {
    const r = await get(`/analytics/series?${RANGE}&${query}`, actor)
    return { ...r, data: r.body as unknown as Series }
  }
  const table = async (query: string, actor: SeededMember = org.owner) => {
    const r = await get(`/analytics/table?${RANGE}&${query}`, actor)
    return { ...r, data: r.body as unknown as Table }
  }
  const consume = (
    organizationId: OrganizationId,
    envelope: Parameters<typeof consumeAnalyticsEvent>[2]
  ) => consumeAnalyticsEvent(harness.deps, organizationId, envelope)
  const meeting = (rep: SeededMember, startsAt: string) =>
    consume(
      org.organizationId,
      bookingEnvelope(org.organizationId, rep.id as MembershipId, startsAt)
    )
  return {
    harness,
    org,
    other,
    managerA,
    managerB,
    repA1,
    repA2,
    repB,
    series,
    table,
    meeting,
    consume,
    get,
    api,
  }
}

const values = (line: Line | undefined) => line?.points.map((p) => [p.day, p.value])

async function withMeetings() {
  const s = await setup()
  await s.meeting(s.repA1, '2026-01-05T10:00:00Z')
  await s.meeting(s.repA1, '2026-01-06T10:00:00Z')
  await s.meeting(s.repA2, '2026-01-05T11:00:00Z')
  await s.meeting(s.repB, '2026-01-05T12:00:00Z')
  return s
}

describe('role scoping of the series', () => {
  test('a booking counts for the Rep it names, and the Owner sees every Rep', async () => {
    const s = await withMeetings()
    const all = await s.series('metric=meetings&groupBy=rep')
    expect(all.status).toBe(200)
    expect(all.data.series.map((l) => l.group).sort()).toEqual(
      [s.repA1.id, s.repA2.id, s.repB.id].sort()
    )
    const total = await s.series('metric=meetings')
    expect(values(total.data.series[0])).toEqual([
      ['2026-01-05', 3],
      ['2026-01-06', 1],
    ])
  })

  test('a Rep reads only their own series', async () => {
    const s = await withMeetings()
    const own = await s.series('metric=meetings', s.repA1)
    expect(own.status).toBe(200)
    expect(values(own.data.series[0])).toEqual([
      ['2026-01-05', 1],
      ['2026-01-06', 1],
    ])
    const grouped = await s.series('metric=meetings&groupBy=rep', s.repA1)
    expect(grouped.data.series.map((l) => l.group)).toEqual([s.repA1.id])
    const sameRep = await s.series(`metric=meetings&repMembershipId=${s.repA1.id}`, s.repA1)
    expect(values(sameRep.data.series[0])).toEqual(values(own.data.series[0]))
  })

  test('a Rep cannot read another Rep, even one on their own Team: request.not_found', async () => {
    const s = await withMeetings()
    for (const other of [s.repA2, s.repB]) {
      const r = await s.series(`metric=meetings&repMembershipId=${other.id}`, s.repA1)
      expect(r.status).toBe(404)
      expect(r.body.error?.code).toBe('request.not_found')
    }
  })

  test('a Manager reads the Reps of their own Team and the total is their sum', async () => {
    const s = await withMeetings()
    const grouped = await s.series('metric=meetings&groupBy=rep', s.managerA)
    expect(grouped.data.series.map((l) => l.group).sort()).toEqual([s.repA1.id, s.repA2.id].sort())
    const total = await s.series('metric=meetings', s.managerA)
    expect(values(total.data.series[0])).toEqual([
      ['2026-01-05', 2],
      ['2026-01-06', 1],
    ])
    const one = await s.series(`metric=meetings&repMembershipId=${s.repA2.id}`, s.managerA)
    expect(values(one.data.series[0])).toEqual([['2026-01-05', 1]])
    const b = await s.series('metric=meetings', s.managerB)
    expect(values(b.data.series[0])).toEqual([['2026-01-05', 1]])
  })

  test('a Manager cannot read another Team: request.not_found', async () => {
    const s = await withMeetings()
    const r = await s.series(`metric=meetings&repMembershipId=${s.repB.id}`, s.managerA)
    expect(r.status).toBe(404)
    expect(r.body.error?.code).toBe('request.not_found')
    const other = await s.series(`metric=meetings&repMembershipId=${s.repA1.id}`, s.managerB)
    expect(other.status).toBe(404)
  })

  test('a Manager or Rep may not group or filter by channel, Agent kind or Campaign', async () => {
    const s = await withMeetings()
    for (const actor of [s.managerA, s.repA1]) {
      for (const query of [
        'metric=sends&groupBy=channel',
        'metric=sends&groupBy=agent_kind',
        'metric=sends&groupBy=campaign',
        'metric=sends&channel=email',
        'metric=sends&agentKind=inbound',
      ]) {
        const r = await s.series(query, actor)
        expect(r.status).toBe(403)
        expect(r.body.error?.code).toBe('auth.forbidden')
      }
    }
  })

  test('an Admin reads every Rep', async () => {
    const s = await withMeetings()
    const admin = s.org.members.find((m) => m.role === 'admin') as SeededMember
    const r = await s.series('metric=meetings', admin)
    expect(values(r.data.series[0])).toEqual([
      ['2026-01-05', 3],
      ['2026-01-06', 1],
    ])
  })
})

describe('Rep cells', () => {
  test('a replayed booking counts once for its Rep, and a reconcile leaves the Rep cells alone', async () => {
    const s = await setup()
    const o = s.org.organizationId
    const booking = bookingEnvelope(o, s.repA1.id as MembershipId, '2026-01-05T10:00:00Z')
    expect(await s.consume(o, booking)).toBe(1)
    expect(await s.consume(o, booking)).toBe(0)
    await reconcileAnalytics(s.harness.deps, o, 400)
    const r = await s.series('metric=meetings&groupBy=rep')
    expect(r.data.series.map((l) => [l.group, values(l)])).toEqual([
      [s.repA1.id, [['2026-01-05', 1]]],
    ])
  })
})

describe('ratio series', () => {
  test('a ratio below the minimum sample is not enough data, not a ratio', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 19; i++) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z'))
    }
    for (let i = 0; i < 5; i++) {
      await s.consume(o, repliedEnvelope(o, '2026-01-05T12:00:00Z'))
    }
    const r = await s.series('metric=reply_rate')
    expect(r.data.series[0]?.points).toEqual([
      {
        kind: 'rate',
        state: 'not_enough_data',
        value: null,
        recordCount: 19,
        day: '2026-01-05',
      },
    ])
  })

  test('twenty records give the ratio, and a day with no denominator has no point', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 20; i++) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z'))
    }
    for (let i = 0; i < 5; i++) {
      await s.consume(o, repliedEnvelope(o, '2026-01-05T12:00:00Z'))
    }
    await s.consume(o, repliedEnvelope(o, '2026-01-06T12:00:00Z'))
    const r = await s.series('metric=reply_rate')
    expect(r.data.series[0]?.points).toEqual([
      { kind: 'rate', state: 'ok', value: 0.25, recordCount: 20, day: '2026-01-05' },
    ])
  })

  test('win rate is won over won plus lost', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 5; i++) {
      await s.consume(o, outcomeEnvelope(o, '2026-01-05T10:00:00Z', 'won'))
    }
    for (let i = 0; i < 15; i++) {
      await s.consume(o, outcomeEnvelope(o, '2026-01-05T10:00:00Z', 'lost'))
    }
    const r = await s.series('metric=win_rate')
    expect(r.data.series[0]?.points).toEqual([
      { kind: 'rate', state: 'ok', value: 0.25, recordCount: 20, day: '2026-01-05' },
    ])
  })

  test('a ratio is clamped to 1 when a count outruns its denominator', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 20; i++) {
      await s.consume(o, repliedEnvelope(o, '2026-01-05T12:00:00Z'))
    }
    for (let i = 0; i < 20; i++) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z'))
    }
    await s.consume(o, repliedEnvelope(o, '2026-01-05T12:00:00Z'))
    const r = await s.series('metric=reply_rate')
    expect(r.data.series[0]?.points[0]?.value).toBe(1)
  })

  test('a ratio grouped by channel pages the same groups', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 20; i++) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'email' }))
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'chat' }))
    }
    for (let i = 0; i < 10; i++) {
      await s.consume(o, repliedEnvelope(o, '2026-01-05T12:00:00Z', { channel: 'email' }))
    }
    const r = await s.series('metric=reply_rate&groupBy=channel')
    expect(r.data.series.map((l) => [l.group, l.points[0]?.value])).toEqual([
      ['chat', 0],
      ['email', 0.5],
    ])
  })
})

describe('range limit', () => {
  test('a range over 13 months is analytics.range_too_large on every route', async () => {
    const s = await setup()
    for (const path of [
      '/analytics/series?from=2026-01-01&to=2027-02-01&metric=sends',
      '/analytics/table?from=2026-01-01&to=2027-02-01&groupBy=channel',
      '/analytics/table.csv?from=2026-01-01&to=2027-02-01&groupBy=channel',
      '/analytics/table?from=2026-01-10&to=2026-01-09&groupBy=channel',
    ]) {
      const r = await s.get(path, s.org.owner)
      expect(r.status).toBe(422)
      expect(r.body.error?.code).toBe('analytics.range_too_large')
    }
  })
})

describe('GET /analytics/table', () => {
  test('one row per group with counts and rates', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (let i = 0; i < 20; i++) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'email' }))
    }
    for (let i = 0; i < 4; i++) {
      await s.consume(o, repliedEnvelope(o, '2026-01-06T10:00:00Z', { channel: 'email' }))
    }
    await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'chat' }))
    const r = await s.table('groupBy=channel')
    expect(r.status).toBe(200)
    expect(r.data.items.map((row) => row.group)).toEqual(['chat', 'email'])
    const email = r.data.items[1] as Row
    expect(email.sends).toEqual({ kind: 'count', value: 20, recordCount: 20 })
    expect(email.replies).toEqual({ kind: 'count', value: 4, recordCount: 4 })
    expect(email.replyRate).toEqual({ kind: 'rate', state: 'ok', value: 0.2, recordCount: 20 })
    expect(email.winRate).toEqual({
      kind: 'rate',
      state: 'not_enough_data',
      value: null,
      recordCount: 0,
    })
    const chat = r.data.items[0] as Row
    expect(chat.replyRate).toEqual({
      kind: 'rate',
      state: 'not_enough_data',
      value: null,
      recordCount: 1,
    })
  })

  test('pages by cursor and refuses a page over 100', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (const channel of ['chat', 'email', 'linkedin'] as const) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel }))
    }
    const p1 = await s.table('groupBy=channel&limit=2')
    expect(p1.data.items.map((r) => r.group)).toEqual(['chat', 'email'])
    expect(p1.data.nextCursor).not.toBeNull()
    const p2 = await s.table(`groupBy=channel&limit=2&cursor=${p1.data.nextCursor}`)
    expect(p2.data.items.map((r) => r.group)).toEqual(['linkedin'])
    expect(p2.data.nextCursor).toBeNull()
    const big = await s.table('groupBy=channel&limit=101')
    expect(big.status).toBe(400)
    const bad = await s.table('groupBy=channel&cursor=nonsense')
    expect(bad.status).toBe(400)
    expect(bad.body.error?.code).toBe('request.invalid')
  })

  test('a filter on another dimension than groupBy is request.invalid, on the same one narrows', async () => {
    const s = await setup()
    const o = s.org.organizationId
    await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'chat' }))
    await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'email' }))
    const cross = await s.table('groupBy=channel&agentKind=inbound')
    expect(cross.status).toBe(400)
    const same = await s.table('groupBy=channel&channel=email')
    expect(same.data.items.map((r) => r.group)).toEqual(['email'])
  })

  test('a Rep sees only their own row, a Manager only their Team, and neither may group by channel', async () => {
    const s = await withMeetings()
    const rep = await s.table('groupBy=rep', s.repA1)
    expect(rep.data.items.map((r) => r.group)).toEqual([s.repA1.id])
    expect(rep.data.items[0]?.meetings?.value).toBe(2)
    const manager = await s.table('groupBy=rep', s.managerA)
    expect(manager.data.items.map((r) => r.group).sort()).toEqual([s.repA1.id, s.repA2.id].sort())
    const owner = await s.table('groupBy=rep')
    expect(owner.data.items).toHaveLength(3)
    for (const actor of [s.repA1, s.managerA]) {
      const r = await s.table('groupBy=channel', actor)
      expect(r.status).toBe(403)
      expect(r.body.error?.code).toBe('auth.forbidden')
    }
    const other = await s.table(`groupBy=rep&repMembershipId=${s.repB.id}`, s.managerA)
    expect(other.status).toBe(404)
    expect(other.body.error?.code).toBe('request.not_found')
  })

  test('a second Organization sees nothing of the first', async () => {
    const s = await withMeetings()
    const o = s.org.organizationId
    await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z'))
    const theirs = await s.get(
      `/analytics/table?${RANGE}&groupBy=rep`,
      s.other.owner,
      s.other.organizationId
    )
    expect((theirs.body as unknown as Table).items).toEqual([])
    const series = await s.get(
      `/analytics/series?${RANGE}&metric=meetings`,
      s.other.owner,
      s.other.organizationId
    )
    expect((series.body as unknown as Series).series[0]?.points).toEqual([])
  })
})

describe('GET /analytics/table.csv', () => {
  const csv = async (s: Awaited<ReturnType<typeof setup>>, query: string, actor = s.org.owner) => {
    const token = await s.harness.bearer({
      userId: actor.userId,
      organizationId: s.org.organizationId,
      role: actor.role,
    })
    const response = await s.harness.app.request(`/v1/analytics/table.csv?${RANGE}&${query}`, {
      headers: token,
    })
    return { response, text: response.text() }
  }

  test('is a text/csv page with a header and the next cursor in a header', async () => {
    const s = await setup()
    const o = s.org.organizationId
    for (const channel of ['chat', 'email', 'linkedin'] as const) {
      await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel }))
    }
    const first = await csv(s, 'groupBy=channel&limit=2')
    expect(first.response.status).toBe(200)
    expect(first.response.headers.get('content-type')).toContain('text/csv')
    const lines = (await first.text).trimEnd().split('\r\n')
    expect(lines[0]).toStartWith('group,sends,replies,positive_replies,meetings')
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['chat', 'email'])
    const cursor = first.response.headers.get('x-next-cursor')
    expect(cursor).not.toBeNull()
    const last = await csv(s, `groupBy=channel&limit=2&cursor=${cursor}`)
    expect(last.response.headers.get('x-next-cursor')).toBeNull()
    expect((await last.text).trimEnd().split('\r\n').slice(1)).toHaveLength(1)
  })

  test('writes not_enough_data for a small sample', async () => {
    const s = await setup()
    const o = s.org.organizationId
    await s.consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'email' }))
    const { text } = await csv(s, 'groupBy=channel')
    expect(await text).toContain('not_enough_data')
  })

  test('a Rep downloads only their own row', async () => {
    const s = await withMeetings()
    const { text } = await csv(s, 'groupBy=rep', s.repA1)
    const rows = (await text).trimEnd().split('\r\n').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toStartWith(s.repA1.id)
    expect((await csv(s, 'groupBy=channel', s.repA1)).response.status).toBe(403)
  })
})

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  formatId,
  type MembershipId,
  type MessageId,
  type OrganizationId,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, service, store } from '~/integration-harness'
import { consumeAnalyticsEvent, reconcileAnalytics, utcDay } from '~/modules/analytics/consumer'
import { bookingEnvelope, repliedEnvelope, sentEnvelope } from '~/modules/analytics/testing'
import { publicCaller, type SeededMember, seedOrganization } from '~/testing'

type Series = { series: { group: string | null; points: { day: string; value: number }[] }[] }

const DAY_MS = 86_400_000

describe('The analytics rollups, over Postgres', () => {
  test('replay is counted once, a late event lands on its day, and another Organization is separate', async () => {
    const h = await harness()
    const a = await h.signUp()
    const b = await h.signUp()
    const now = Date.now()
    const today = new Date(now).toISOString()
    const lastWeek = new Date(now - 7 * DAY_MS).toISOString()
    const consume = (org: OrganizationId, envelope: Parameters<typeof consumeAnalyticsEvent>[2]) =>
      consumeAnalyticsEvent(h.deps, org, envelope)

    const first = sentEnvelope(a.organizationId, today, { channel: 'email' })
    expect(await consume(a.organizationId, first)).toBe(1)
    expect(await consume(a.organizationId, first)).toBe(0)
    // A late event: arrives now, happened a week ago.
    expect(
      await consume(a.organizationId, sentEnvelope(a.organizationId, lastWeek, { channel: 'chat' }))
    ).toBe(1)
    // The other Organization counts its own events, with the same Message id as one of ours.
    const sameMessage = sentEnvelope(b.organizationId, today, {
      messageId: (first.payload as { messageId: MessageId }).messageId,
    })
    expect(await consume(b.organizationId, sameMessage)).toBe(1)
    await consume(b.organizationId, sentEnvelope(b.organizationId, today))
    await consume(b.organizationId, repliedEnvelope(b.organizationId, today))

    const range = `from=${utcDay(new Date(now - 14 * DAY_MS).toISOString())}&to=${utcDay(today)}`
    const api = publicCaller(h)
    const read = async (who: typeof a, query: string) =>
      (
        await api(
          { userId: who.userId, role: 'owner' },
          who.organizationId,
          'GET',
          `/analytics/series?${range}&${query}`
        )
      ).body as unknown as Series
    const mine = await read(a, 'metric=sends')
    expect(mine.series[0]?.points).toEqual([
      expect.objectContaining({ day: utcDay(lastWeek), value: 1 }),
      expect.objectContaining({ day: utcDay(today), value: 1 }),
    ])
    const byChannel = await read(a, 'metric=sends&groupBy=channel')
    expect(byChannel.series.map((l) => l.group)).toEqual(['chat', 'email'])
    expect((await read(a, 'metric=replies')).series[0]?.points).toEqual([])
    expect((await read(b, 'metric=sends')).series[0]?.points).toEqual([
      expect.objectContaining({ day: utcDay(today), value: 2 }),
    ])
  })

  test('reconcile repairs a drifted cell and a missing one, and only in its own Organization', async () => {
    const h = await harness()
    const a = await h.signUp()
    const b = await h.signUp()
    const now = new Date().toISOString()
    for (const org of [a.organizationId, b.organizationId]) {
      await consumeAnalyticsEvent(h.deps, org, sentEnvelope(org, now, { channel: 'email' }))
      await consumeAnalyticsEvent(h.deps, org, sentEnvelope(org, now, { channel: 'email' }))
    }
    const cells = (org: OrganizationId) =>
      withOrganization(service.db, org, async (tx) => {
        const { rows } = await tx.execute(
          sql`select group_kind, count::text as count from core.rollup_daily order by group_kind`
        )
        return rows.map((r: Record<string, unknown>) => [r.group_kind, Number(r.count)])
      })
    expect(await cells(a.organizationId)).toEqual([
      ['channel', 2],
      ['total', 2],
    ])
    // Break the first Organization's rollups: one cell too high, one cell missing.
    await withOrganization(service.db, a.organizationId, async (tx) => {
      await tx.execute(sql`update core.rollup_daily set count = 99 where group_kind = 'total'`)
      await tx.execute(sql`delete from core.rollup_daily where group_kind = 'channel'`)
    })
    await withOrganization(service.db, b.organizationId, async (tx) => {
      await tx.execute(sql`update core.rollup_daily set count = 77 where group_kind = 'total'`)
    })
    expect(await reconcileAnalytics(h.deps, a.organizationId, 3)).toEqual({ cells: 2, repaired: 2 })
    expect(await cells(a.organizationId)).toEqual([
      ['channel', 2],
      ['total', 2],
    ])
    // The second Organization's drift is untouched: reconcile works one Organization at a time.
    expect(await cells(b.organizationId)).toEqual([
      ['channel', 2],
      ['total', 77],
    ])
    expect(await reconcileAnalytics(h.deps, a.organizationId, 3)).toEqual({ cells: 2, repaired: 0 })
  })

  test('a Rep reads only their own row, a Manager only their Team, and another Organization sees nothing', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['manager', 'manager', 'rep', 'rep'])
    const other = await seedOrganization(store, ['rep'])
    const of = (role: string, n: number) =>
      org.members.filter((m) => m.role === role)[n] as SeededMember
    const [mgrA, mgrB, repA, repB] = [
      of('manager', 0),
      of('manager', 1),
      of('rep', 0),
      of('rep', 1),
    ]
    const now = new Date()
    await store.withOrganization(org.organizationId, async (scope) => {
      await scope.lockOrganization()
      const a = await scope.insertTeam({
        id: formatId('team', crypto.randomUUID()),
        name: 'A',
        now,
      })
      const b = await scope.insertTeam({
        id: formatId('team', crypto.randomUUID()),
        name: 'B',
        now,
      })
      for (const m of [mgrA, repA]) {
        await scope.addTeamMember(a.id, m.id, now)
      }
      for (const m of [mgrB, repB]) {
        await scope.addTeamMember(b.id, m.id, now)
      }
    })
    const when = now.toISOString()
    const book = (o: OrganizationId, rep: SeededMember) =>
      consumeAnalyticsEvent(h.deps, o, bookingEnvelope(o, rep.id as MembershipId, when))
    await book(org.organizationId, repA)
    await book(org.organizationId, repA)
    await book(org.organizationId, repB)
    await book(other.organizationId, other.members[1] as SeededMember)
    const day = utcDay(when)
    const api = publicCaller(h)
    const get = (who: SeededMember, o: OrganizationId, path: string) =>
      api(who, o, 'GET', `${path}${path.includes('?') ? '&' : '?'}from=${day}&to=${day}`)
    const total = async (who: SeededMember, query: string) =>
      (
        (await get(who, org.organizationId, `/analytics/series?metric=meetings&${query}`))
          .body as unknown as Series
      ).series.map((l) => [l.group, l.points.map((p) => p.value)])

    expect(await total(repA, '')).toEqual([[null, [2]]])
    expect(await total(mgrA, '')).toEqual([[null, [2]]])
    expect(await total(mgrA, 'groupBy=rep')).toEqual([[repA.id, [2]]])
    expect(
      (
        await get(
          repA,
          org.organizationId,
          `/analytics/series?metric=meetings&repMembershipId=${repB.id}`
        )
      ).status
    ).toBe(404)
    expect(
      (
        await get(
          mgrA,
          org.organizationId,
          `/analytics/series?metric=meetings&repMembershipId=${repB.id}`
        )
      ).status
    ).toBe(404)
    expect(
      (await get(mgrA, org.organizationId, '/analytics/series?metric=meetings&groupBy=channel'))
        .status
    ).toBe(403)
    expect(await total(org.owner, 'groupBy=rep')).toEqual(
      [
        [repA.id, [2]],
        [repB.id, [1]],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0])))
    )
    const rows = (await get(org.owner, org.organizationId, '/analytics/table?groupBy=rep&limit=1'))
      .body as unknown as {
      items: { group: string }[]
      nextCursor: string | null
    }
    expect(rows.items).toHaveLength(1)
    expect(rows.nextCursor).not.toBeNull()
    // The other Organization's Rep is invisible here, and ours there.
    expect(
      (
        await get(
          other.members[1] as SeededMember,
          other.organizationId,
          `/analytics/series?metric=meetings&repMembershipId=${repA.id}`
        )
      ).status
    ).toBe(404)
    expect(
      await total(org.owner, `repMembershipId=${(other.members[1] as SeededMember).id}`)
    ).toEqual([[null, []]])
  })
})

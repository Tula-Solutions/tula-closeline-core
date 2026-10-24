import { describe, expect, test } from 'bun:test'
import type { MessageId, OrganizationId, Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { jobRegistry } from '~/messages'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { consumeAnalyticsEvent, reconcileAnalytics, reconcileWindow } from './consumer'
import { outcomeEnvelope, repliedEnvelope, sentEnvelope } from './testing'

type Line = { group: string | null; points: { day: string; value: number }[] }
type Series = { series: Line[]; nextCursor: string | null; groupBy: string | null }

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const first = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const second = await seedOrganization(store, ['admin'])
  const api = publicCaller(harness)
  const read = async (query: string, actor: SeededMember = first.owner) => {
    const response = await api(actor, first.organizationId, 'GET', `/analytics/series?${query}`)
    return {
      status: response.status,
      body: response.body,
      series: response.body as unknown as Series,
    }
  }
  const consume = (
    organizationId: OrganizationId,
    envelope: Parameters<typeof consumeAnalyticsEvent>[2]
  ) => consumeAnalyticsEvent(harness.deps, organizationId, envelope)
  const byRole = (role: Role) => first.members.find((m) => m.role === role) as SeededMember
  return { store, harness, first, second, read, consume, api, byRole }
}

const RANGE = 'from=2025-12-01&to=2026-01-31'
const days = (s: Series) => s.series[0]?.points.map((p) => [p.day, p.value])

describe('the rollups', () => {
  test('replaying an event stream leaves the counts unchanged', async () => {
    const { first, consume, read } = await setup()
    const events = [
      sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z'),
      sentEnvelope(first.organizationId, '2026-01-05T11:00:00Z'),
      sentEnvelope(first.organizationId, '2026-01-06T11:00:00Z', { channel: 'linkedin' }),
    ]
    for (const e of events) {
      expect(await consume(first.organizationId, e)).toBe(1)
    }
    for (const e of [...events, ...events]) {
      expect(await consume(first.organizationId, e)).toBe(0)
    }
    expect(days((await read(`${RANGE}&metric=sends`)).series)).toEqual([
      ['2026-01-05', 2],
      ['2026-01-06', 1],
    ])
  })

  test('a late event counts on the day it happened, not the day it arrived', async () => {
    const { first, consume, read } = await setup()
    await consume(first.organizationId, sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z'))
    await consume(first.organizationId, sentEnvelope(first.organizationId, '2025-12-20T23:59:59Z'))
    expect(days((await read(`${RANGE}&metric=sends`)).series)).toEqual([
      ['2025-12-20', 1],
      ['2026-01-05', 1],
    ])
  })

  test('another Organization never changes the counts, and cannot see them', async () => {
    const { first, second, consume, read, api } = await setup()
    await consume(first.organizationId, sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z'))
    const before = days((await read(`${RANGE}&metric=sends`)).series)
    // The same Message id in another Organization is its own thing.
    const shared = sentEnvelope(second.organizationId, '2026-01-05T10:00:00Z')
    await consume(second.organizationId, shared)
    await consume(
      second.organizationId,
      sentEnvelope(second.organizationId, '2026-01-05T10:00:00Z')
    )
    expect(days((await read(`${RANGE}&metric=sends`)).series)).toEqual(before)
    const theirs = await api(
      second.owner,
      second.organizationId,
      'GET',
      `/analytics/series?${RANGE}&metric=sends`
    )
    expect((theirs.body as unknown as Series).series[0]?.points[0]?.value).toBe(2)
  })

  test('counts a reply once, a positive reply twice over, and a won or lost Deal once', async () => {
    const { first, consume, read } = await setup()
    const o = first.organizationId
    const reply = repliedEnvelope(o, '2026-01-07T09:00:00Z')
    await consume(o, reply)
    await consume(o, reply)
    await consume(o, repliedEnvelope(o, '2026-01-07T09:00:00Z', { label: 'negative' }))
    const deal = outcomeEnvelope(o, '2026-01-08T09:00:00Z', 'won')
    await consume(o, deal)
    await consume(o, deal)
    await consume(o, outcomeEnvelope(o, '2026-01-08T09:00:00Z', 'open'))
    expect(days((await read(`${RANGE}&metric=replies`)).series)).toEqual([['2026-01-07', 2]])
    expect(days((await read(`${RANGE}&metric=positive_replies`)).series)).toEqual([
      ['2026-01-07', 1],
    ])
    expect(days((await read(`${RANGE}&metric=outcomes_won`)).series)).toEqual([['2026-01-08', 1]])
    expect(days((await read(`${RANGE}&metric=outcomes_lost`)).series)).toEqual([])
  })

  test('an event for an Organization that does not exist counts nothing', async () => {
    const { consume, first } = await setup()
    const gone = `org_${'0'.repeat(32)}` as OrganizationId
    expect(await consume(gone, sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z'))).toBe(0)
  })

  test('reconcile leaves correct rollups alone and the window ends today', async () => {
    const { first, consume, harness } = await setup()
    await consume(first.organizationId, sentEnvelope(first.organizationId, '2026-01-01T01:00:00Z'))
    expect(await reconcileAnalytics(harness.deps, first.organizationId, 30)).toEqual({
      cells: 2,
      repaired: 0,
    })
    expect(reconcileWindow(new Date('2026-03-01T05:00:00Z'), 3)).toEqual({
      from: '2026-02-27',
      to: '2026-03-01',
    })
  })
})

describe('the job queue', () => {
  test('counts queued events once, even when the queue delivers them twice', async () => {
    const { first, harness, read } = await setup()
    const message = sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z')
    // A producer that retries sends the same Message again in a new envelope.
    const again = sentEnvelope(first.organizationId, '2026-01-05T10:00:00Z', {
      messageId: (message.payload as { messageId: MessageId }).messageId,
    })
    const reconcile = jobRegistry.create({
      type: 'analytics.reconcile',
      organizationId: first.organizationId,
      traceId: 'trace',
      payload: { days: 30 },
    })
    await harness.deps.jobs.publishBatch([message, again, reconcile])
    const signal = new AbortController().signal
    let received = 0
    for (let n = await processAssignJobs(harness.deps, signal); n > 0; ) {
      received += n
      n = await processAssignJobs(harness.deps, signal)
    }
    expect(received).toBe(3)
    expect(days((await read(`${RANGE}&metric=sends`)).series)).toEqual([['2026-01-05', 1]])
  })

  test('refuses a reconcile job for more days than the limit', () => {
    expect(() =>
      jobRegistry.create({
        type: 'analytics.reconcile',
        organizationId: 'org_x' as OrganizationId,
        traceId: 't',
        payload: { days: 63 },
      })
    ).toThrow()
  })
})

describe('GET /analytics/series', () => {
  test('answers one line with no days for a metric with no events', async () => {
    const { read } = await setup()
    const { status, series } = await read(`${RANGE}&metric=meetings`)
    expect(status).toBe(200)
    expect(series).toMatchObject({
      groupBy: null,
      nextCursor: null,
      series: [{ group: null, points: [] }],
    })
  })

  test('splits by channel, pages the groups by cursor, and filters on one channel', async () => {
    const { first, consume, read } = await setup()
    const o = first.organizationId
    await consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'chat' }))
    await consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'email' }))
    await consume(o, sentEnvelope(o, '2026-01-06T10:00:00Z', { channel: 'email' }))
    await consume(o, sentEnvelope(o, '2026-01-05T10:00:00Z', { channel: 'linkedin' }))
    const page1 = await read(`${RANGE}&metric=sends&groupBy=channel&limit=2`)
    expect(page1.series.series.map((l) => l.group)).toEqual(['chat', 'email'])
    expect(page1.series.series[1]?.points.map((p) => p.value)).toEqual([1, 1])
    expect(page1.series.nextCursor).not.toBeNull()
    const page2 = await read(
      `${RANGE}&metric=sends&groupBy=channel&limit=2&cursor=${page1.series.nextCursor}`
    )
    expect(page2.series.series.map((l) => l.group)).toEqual(['linkedin'])
    expect(page2.series.nextCursor).toBeNull()
    const filtered = await read(`${RANGE}&metric=sends&channel=email`)
    expect(filtered.series.series).toHaveLength(1)
    expect(days(filtered.series)).toEqual([
      ['2026-01-05', 1],
      ['2026-01-06', 1],
    ])
    const total = await read(`${RANGE}&metric=sends`)
    expect(days(total.series)).toEqual([
      ['2026-01-05', 3],
      ['2026-01-06', 1],
    ])
  })

  test('refuses a bad cursor, two filters and a filter beside another grouping with request.invalid', async () => {
    const { read } = await setup()
    for (const query of [
      `${RANGE}&metric=sends&groupBy=channel&cursor=nonsense`,
      `${RANGE}&metric=sends&channel=email&agentKind=inbound`,
      `${RANGE}&metric=sends&groupBy=agent_kind&channel=email`,
      `${RANGE}&metric=sold`,
      `${RANGE}&metric=sends&limit=21`,
    ]) {
      const response = await read(query)
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('request.invalid')
    }
  })

  test('refuses a range wider than 13 months, or backwards, with analytics.range_too_large', async () => {
    const { read } = await setup()
    for (const range of ['from=2026-01-01&to=2027-02-01', 'from=2026-01-10&to=2026-01-09']) {
      const response = await read(`${range}&metric=sends`)
      expect(response.status).toBe(422)
      expect(response.body.error?.code).toBe('analytics.range_too_large')
    }
    expect((await read('from=2026-01-01&to=2027-01-31&metric=sends')).status).toBe(200)
  })

  test('is open to every role, each scoped by its own view', async () => {
    const { read, byRole } = await setup()
    for (const role of ['admin', 'manager', 'rep'] as const) {
      const response = await read(`${RANGE}&metric=sends`, byRole(role))
      expect(response.status).toBe(200)
    }
  })

  test('refuses a request with no access token', async () => {
    const { harness } = await setup()
    const response = await harness.app.request(`/v1/analytics/series?${RANGE}&metric=sends`)
    expect(response.status).toBe(401)
  })
})

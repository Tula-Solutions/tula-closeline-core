import { describe, expect, test } from 'bun:test'
import {
  type CallId,
  type CitationRef,
  type DealRecordId,
  formatId,
  type MessageId,
  type OrganizationId,
  type ProspectId,
  type Role,
  type TouchId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { CITED_OFTEN_LOST_BELOW } from '~/ports/attribution-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { consumeAnalyticsEvent } from './consumer'
import { outcomeEnvelope } from './testing'

const id = (prefix: Parameters<typeof formatId>[0]) =>
  formatId(prefix, crypto.randomUUID().replaceAll('-', ''))

type Page<T> = { items: T[]; nextCursor: string | null }
type Attribution = {
  dealRecordId: string
  outcome: string
  firstTouchId: string | null
  lastTouchId: string | null
  touches: Page<{ id: string; messageId: string }>
}
type Performance = { source: CitationRef; dealsTouched: number; winRate: { state: string } }

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const first = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const second = await seedOrganization(store, ['admin'])
  const api = publicCaller(harness)
  const get = (path: string, actor: SeededMember = first.owner, org = first.organizationId) =>
    api(actor, org, 'GET', path)

  /** A decided Deal with `count` touches an hour apart, crediting one Moment each. */
  const decide = async (
    organizationId: OrganizationId,
    count: number,
    outcome: 'won' | 'lost' = 'won'
  ) => {
    const dealRecordId = id('deal') as DealRecordId
    const prospectId = id('prs') as ProspectId
    const moment = {
      kind: 'moment' as const,
      callId: id('call') as CallId,
      dealRecordId: id('deal') as DealRecordId,
    }
    const start = Date.parse('2026-01-01T00:00:00Z')
    const touches = Array.from({ length: count }, (_, i) => ({
      id: id('tch') as TouchId,
      messageId: id('msg') as MessageId,
      prospectId,
      channel: 'email' as const,
      repMembershipId: null,
      occurredAt: new Date(start + i * 3_600_000),
      firstTouch: i === 0,
      lastTouch: i === count - 1,
      citedSources: [moment],
    }))
    await consumeAnalyticsEvent(
      harness.deps,
      organizationId,
      outcomeEnvelope(organizationId, '2026-02-01T00:00:00Z', outcome, dealRecordId)
    )
    await store.withOrganization(organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.attributeTouches(dealRecordId, touches)
      await scope.creditSources(
        [{ kind: 'moment', key: `${moment.callId}:${moment.dealRecordId}` }],
        outcome === 'won',
        { minSample: 20, winRateBelow: CITED_OFTEN_LOST_BELOW }
      )
    })
    return { dealRecordId, touches }
  }
  const role = (r: Role) => first.members.find((m) => m.role === r) as SeededMember
  return { first, second, get, decide, role }
}

describe('GET /analytics/deals/{dealRecordId}/attribution', () => {
  test('Owner and Admin read it; Manager and Rep are forbidden', async () => {
    const { first, get, decide, role } = await setup()
    const { dealRecordId, touches } = await decide(first.organizationId, 3)
    const path = `/analytics/deals/${dealRecordId}/attribution`
    for (const actor of [first.owner, role('admin')]) {
      const response = await get(path, actor)
      expect(response.status).toBe(200)
      const body = response.body as unknown as Attribution
      expect(body.outcome).toBe('won')
      expect(body.firstTouchId).toBe(touches[0]?.id as string)
      expect(body.lastTouchId).toBe(touches[2]?.id as string)
      expect(body.touches.items.map((t) => t.id)).toEqual(touches.map((t) => t.id))
    }
    for (const actor of [role('manager'), role('rep')]) {
      const response = await get(path, actor)
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('auth.forbidden')
    }
  })

  test('pages oldest first, and the last touch is named on the first page', async () => {
    const { first, get, decide } = await setup()
    const { dealRecordId, touches } = await decide(first.organizationId, 5, 'lost')
    const base = `/analytics/deals/${dealRecordId}/attribution`
    const one = (await get(`${base}?limit=2`)).body as unknown as Attribution
    expect(one.outcome).toBe('lost')
    expect(one.lastTouchId).toBe(touches[4]?.id as string)
    expect(one.touches.items.map((t) => t.id)).toEqual([touches[0]?.id, touches[1]?.id] as string[])
    const two = (await get(`${base}?limit=2&cursor=${one.touches.nextCursor}`))
      .body as unknown as Attribution
    expect(two.touches.items.map((t) => t.id)).toEqual([touches[2]?.id, touches[3]?.id] as string[])
    const three = (await get(`${base}?limit=2&cursor=${two.touches.nextCursor}`))
      .body as unknown as Attribution
    expect(three.touches.items.map((t) => t.id)).toEqual([touches[4]?.id] as string[])
    expect(three.touches.nextCursor).toBeNull()
  })

  test('an unknown (or open) or other-Organization Deal is not found; a bad cursor or limit is invalid', async () => {
    const { first, second, get, decide } = await setup()
    const mine = await decide(first.organizationId, 1)
    // An open Deal leaves nothing in the ledger, so it reads like an unknown one.
    for (const deal of [id('deal')]) {
      const response = await get(`/analytics/deals/${deal}/attribution`)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('request.not_found')
    }
    const theirs = await get(
      `/analytics/deals/${mine.dealRecordId}/attribution`,
      second.owner,
      second.organizationId
    )
    expect(theirs.status).toBe(404)
    const base = `/analytics/deals/${mine.dealRecordId}/attribution`
    expect((await get(`${base}?cursor=garbage`)).status).toBe(400)
    expect((await get(`${base}?limit=101`)).status).toBe(400)
    expect((await get('/analytics/deals/not-an-id/attribution')).status).toBe(400)
  })
})

describe('GET /analytics/source-performance', () => {
  test('Owner and Admin read it; Manager and Rep are forbidden', async () => {
    const { first, get, decide, role } = await setup()
    await decide(first.organizationId, 1)
    for (const actor of [first.owner, role('admin')]) {
      const response = await get('/analytics/source-performance', actor)
      expect(response.status).toBe(200)
      const body = response.body as unknown as Page<Performance>
      expect(body.items).toHaveLength(1)
      expect(body.items[0]?.dealsTouched).toBe(1)
      expect(body.items[0]?.winRate.state).toBe('not_enough_data')
    }
    for (const actor of [role('manager'), role('rep')]) {
      expect((await get('/analytics/source-performance', actor)).status).toBe(403)
    }
  })

  test('pages most touched first, and filters by flag', async () => {
    const { first, get, decide } = await setup()
    for (let i = 0; i < 3; i += 1) {
      await decide(first.organizationId, 1)
    }
    const one = (await get('/analytics/source-performance?limit=2'))
      .body as unknown as Page<Performance>
    expect(one.items).toHaveLength(2)
    const two = (await get(`/analytics/source-performance?limit=2&cursor=${one.nextCursor}`))
      .body as unknown as Page<Performance>
    expect(two.items).toHaveLength(1)
    expect(two.nextCursor).toBeNull()
    const flagged = (await get('/analytics/source-performance?flag=cited_often_lost'))
      .body as unknown as Page<Performance>
    expect(flagged.items).toEqual([])
    expect((await get('/analytics/source-performance?flag=nope')).status).toBe(400)
    expect((await get('/analytics/source-performance?cursor=garbage')).status).toBe(400)
  })

  test('another Organization sees nothing of ours', async () => {
    const { first, second, get, decide } = await setup()
    await decide(first.organizationId, 1)
    const theirs = await get('/analytics/source-performance', second.owner, second.organizationId)
    expect(theirs.status).toBe(200)
    expect((theirs.body as unknown as Page<Performance>).items).toEqual([])
  })
})

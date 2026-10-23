import { describe, expect, test } from 'bun:test'
import {
  type AuditEventId,
  formatId,
  type MembershipId,
  type OrganizationId,
  type ProspectId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import * as Audit from './service'

const newEventId = () => formatId('aud', crypto.randomUUID().replaceAll('-', '')) as AuditEventId
const subjectId = () => formatId('prs', crypto.randomUUID().replaceAll('-', ''))

type Page = { items: { id: string; sequence: number; action: string }[]; nextCursor: string | null }

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    organizationId: OrganizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body)
  const deps = harness.deps
  /** Records an event the way the consumer does, at a given time. */
  const record = (
    over: Partial<Parameters<typeof Audit.consume>[1]['data']> = {},
    organizationId: OrganizationId = seeded.organizationId
  ) =>
    Audit.consume(deps, {
      organizationId,
      data: {
        auditEventId: newEventId(),
        occurredAt: new Date('2026-03-01T10:00:00Z').toISOString(),
        actor: { kind: 'system' },
        action: 'thing.done',
        subject: null,
        prospectId: null,
        instructionVersion: null,
        requestId: null,
        metadata: {},
        ...over,
      } as Parameters<typeof Audit.consume>[1]['data'],
    })
  const csv = async (actor: SeededMember, query = '') => {
    const response = await harness.app.request(`/v1/audit-csv${query}`, {
      headers: await harness.bearer({
        userId: actor.userId,
        organizationId: seeded.organizationId,
        role: actor.role,
      }),
    })
    return { status: response.status, text: await response.text(), headers: response.headers }
  }
  const list = async (query = '', actor = seeded.owner) =>
    (await call(actor, 'GET', `/audit-events${query}`)).body as unknown as Page
  return { memory, harness, seeded, byRole, call, record, csv, list }
}

describe('consume', () => {
  test('replaying an event writes one row', async () => {
    const { record, list } = await setup()
    const id = newEventId()
    expect(await record({ auditEventId: id })).toBe('written')
    expect(await record({ auditEventId: id })).toBe('replayed')
    expect((await list()).items).toHaveLength(1)
  })

  test('chains events per Organization, each linked to the one before', async () => {
    const { record, call, seeded } = await setup()
    await record()
    await record()
    await record()
    const verified = await call(seeded.owner, 'GET', '/audit-verification')
    expect(verified.body).toEqual({ checked: 3, firstBrokenSequence: null, nextSequence: null })
  })

  test('drops an event for an Organization that does not exist', async () => {
    const { record } = await setup()
    expect(await record({}, `org_${'0'.repeat(32)}` as OrganizationId)).toBe('dropped')
  })
})

describe('access', () => {
  test('a Rep is refused every audit route', async () => {
    const { call, byRole, record } = await setup()
    const id = newEventId()
    await record({ auditEventId: id })
    for (const path of [
      '/audit-events',
      `/audit-events/${id}`,
      '/audit-csv',
      '/audit-verification',
    ]) {
      const response = await call(byRole('rep'), 'GET', path)
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('auth.forbidden')
    }
  })

  test('a Manager may list but not download or verify', async () => {
    const { call, byRole } = await setup()
    expect((await call(byRole('manager'), 'GET', '/audit-events')).status).toBe(200)
    expect((await call(byRole('manager'), 'GET', '/audit-csv')).status).toBe(403)
    expect((await call(byRole('manager'), 'GET', '/audit-verification')).status).toBe(403)
  })

  test('a Manager reads only events about their Team’s Prospects', async () => {
    const { call, byRole, record, seeded, list } = await setup()
    const team = await call(seeded.owner, 'POST', '/teams', { name: 'North' })
    const teamId = team.body.id as string
    for (const role of ['manager', 'rep'] as const) {
      await call(seeded.owner, 'POST', `/teams/${teamId}/members`, {
        membershipId: byRole(role).id as MembershipId,
      })
    }
    const mine = (await call(byRole('rep'), 'POST', '/prospects', { firstName: 'Ada' })).body
      .id as ProspectId
    const theirs = (await call(seeded.owner, 'POST', '/prospects', { firstName: 'Bo' })).body
      .id as ProspectId
    await record({ action: 'a.mine', prospectId: mine })
    await record({ action: 'a.theirs', prospectId: theirs })
    await record({ action: 'a.none' })
    const seen = (await list('', byRole('manager'))).items.map((item) => item.action)
    expect(seen).toEqual(['a.mine'])
    const all = (await list()).items.map((item) => item.action)
    expect(all).toHaveLength(3)
    const hidden = (await list()).items.find((item) => item.action === 'a.theirs')
    const response = await call(byRole('manager'), 'GET', `/audit-events/${hidden?.id}`)
    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('audit.event_not_found')
  })

  test('a second Organization cannot list, get or verify the first one’s log', async () => {
    const { call, record, memory, seeded } = await setup()
    const other = await seedOrganization(memory, [])
    const id = newEventId()
    await record({ auditEventId: id })
    const asOther = (path: string) =>
      call(other.owner, 'GET', path, undefined, other.organizationId)
    expect(((await asOther('/audit-events')).body as unknown as Page).items).toHaveLength(0)
    const got = await asOther(`/audit-events/${id}`)
    expect(got.status).toBe(404)
    expect(got.body.error?.code).toBe('audit.event_not_found')
    expect((await asOther('/audit-verification')).body).toEqual({
      checked: 0,
      firstBrokenSequence: null,
      nextSequence: null,
    })
    expect(seeded.organizationId).not.toBe(other.organizationId)
  })
})

describe('list', () => {
  test('filters by actor, action, subject, Prospect and range', async () => {
    const { record, list, byRole, call, seeded } = await setup()
    const subject = { type: 'prospect', id: subjectId() }
    const prospect = (await call(seeded.owner, 'POST', '/prospects', { firstName: 'Ada' })).body
      .id as ProspectId
    const member = byRole('admin').id
    await record({
      action: 'a.one',
      actor: { kind: 'member', membershipId: member },
      subject,
      prospectId: prospect,
      occurredAt: '2026-01-10T00:00:00.000Z',
    } as never)
    await record({ action: 'a.two', occurredAt: '2026-02-10T00:00:00.000Z' })
    const actions = async (query: string) => (await list(query)).items.map((e) => e.action)
    expect(await actions(`?actorKind=member`)).toEqual(['a.one'])
    expect(await actions(`?actorId=${member}`)).toEqual(['a.one'])
    expect(await actions(`?action=a.two`)).toEqual(['a.two'])
    expect(await actions(`?subjectType=prospect&subjectId=${subject.id}`)).toEqual(['a.one'])
    expect(await actions(`?prospectId=${prospect}`)).toEqual(['a.one'])
    expect(await actions(`?from=2026-02-01T00:00:00Z`)).toEqual(['a.two'])
    expect(await actions(`?to=2026-02-01T00:00:00Z`)).toEqual(['a.one'])
    expect(await actions('')).toEqual(['a.two', 'a.one'])
  })

  test('a range over the cap, or backwards, is audit.range_too_large', async () => {
    const { call, seeded } = await setup()
    for (const query of [
      '?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
    ]) {
      const response = await call(seeded.owner, 'GET', `/audit-events${query}`)
      expect(response.status).toBe(422)
      expect(response.body.error?.code).toBe('audit.range_too_large')
    }
    const csv = await call(
      seeded.owner,
      'GET',
      '/audit-csv?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'
    )
    expect(csv.body.error?.code).toBe('audit.range_too_large')
    const ok = await call(
      seeded.owner,
      'GET',
      '/audit-events?from=2025-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'
    )
    expect(ok.status).toBe(200)
  })

  test('pages newest first with a cursor, and refuses a page over the cap', async () => {
    const { record, list, call, seeded } = await setup()
    for (let day = 1; day <= 5; day += 1) {
      await record({ action: `a.d${day}`, occurredAt: `2026-03-0${day}T00:00:00.000Z` })
    }
    const first = await list('?limit=2')
    expect(first.items.map((e) => e.action)).toEqual(['a.d5', 'a.d4'])
    const second = await list(`?limit=2&cursor=${first.nextCursor}`)
    expect(second.items.map((e) => e.action)).toEqual(['a.d3', 'a.d2'])
    const third = await list(`?limit=2&cursor=${second.nextCursor}`)
    expect(third.items.map((e) => e.action)).toEqual(['a.d1'])
    expect(third.nextCursor).toBeNull()
    expect((await call(seeded.owner, 'GET', '/audit-events?limit=101')).status).toBe(400)
    expect((await call(seeded.owner, 'GET', '/audit-events?cursor=nonsense')).status).toBe(400)
  })

  test('pages events with the same time by sequence without skipping', async () => {
    const { record, list } = await setup()
    for (let n = 1; n <= 3; n += 1) {
      await record({ action: `a.s${n}` })
    }
    const first = await list('?limit=2')
    const second = await list(`?limit=2&cursor=${first.nextCursor}`)
    expect([...first.items, ...second.items].map((e) => e.action)).toEqual(['a.s3', 'a.s2', 'a.s1'])
  })
})

describe('csv', () => {
  test('pages oldest first, escapes formulas, and is itself audited', async () => {
    const { record, csv, seeded, list } = await setup()
    await record({ action: 'a.cmd', metadata: { note: '=a,b' } })
    await record({ action: 'a.plain' })
    const first = await csv(seeded.owner, '?limit=1')
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toContain('text/csv')
    const lines = first.text.trim().split('\r\n')
    expect(lines[0]).toStartWith('sequence,id,occurred_at')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(',a.cmd,')
    expect(lines[1]).toContain('"{""note"":""=a,b""}"')
    const cursor = first.headers.get('x-next-cursor')
    expect(cursor).not.toBeNull()
    const second = await csv(seeded.owner, `?limit=1&cursor=${cursor}`)
    expect(second.text).toContain(',a.plain,')
    expect(second.headers.get('x-next-cursor')).toBeNull()
    const exported = (await list('?action=audit.exported')).items
    expect(exported).toHaveLength(2)
  })

  test('paging one row at a time ends, though each page is itself audited', async () => {
    const { record, csv, seeded } = await setup()
    await record()
    await record()
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await csv(seeded.owner, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      cursor = page.headers.get('x-next-cursor')
      pages += 1
    } while (cursor && pages < 10)
    expect(pages).toBe(2)
  })

  test('the last page has no next cursor', async () => {
    const { record, csv, seeded } = await setup()
    await record()
    const only = await csv(seeded.owner)
    expect(only.headers.get('x-next-cursor')).toBeNull()
  })
})

describe('verify', () => {
  test('reports the first tampered row and stops there', async () => {
    const { record, call, seeded, memory } = await setup()
    for (let n = 0; n < 4; n += 1) {
      await record({ action: `a.e${n}` })
    }
    memory.tamperAuditEvent(seeded.organizationId, 3, { action: 'a.forged' })
    const verified = await call(seeded.owner, 'GET', '/audit-verification')
    expect(verified.body).toEqual({ checked: 3, firstBrokenSequence: 3, nextSequence: null })
  })

  test('a broken link and a missing row are found too', async () => {
    const { record, call, seeded, memory } = await setup()
    for (let n = 0; n < 3; n += 1) {
      await record()
    }
    memory.tamperAuditEvent(seeded.organizationId, 2, { previousHash: 'f'.repeat(64) })
    const verified = await call(seeded.owner, 'GET', '/audit-verification')
    expect((verified.body as { firstBrokenSequence: number }).firstBrokenSequence).toBe(2)
  })

  test('checks a window and says where to continue', async () => {
    const { record, call, seeded } = await setup()
    for (let n = 0; n < 5; n += 1) {
      await record()
    }
    const first = await call(seeder(seeded), 'GET', '/audit-verification?count=2')
    expect(first.body).toEqual({ checked: 2, firstBrokenSequence: null, nextSequence: 3 })
    const next = await call(seeded.owner, 'GET', '/audit-verification?fromSequence=3&count=10')
    expect(next.body).toEqual({ checked: 3, firstBrokenSequence: null, nextSequence: null })
  })
})

const seeder = (seeded: { owner: SeededMember }) => seeded.owner

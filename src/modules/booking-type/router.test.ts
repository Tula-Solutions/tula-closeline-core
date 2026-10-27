import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import type { Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(memory, ['admin'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    member: SeededMember,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => api(member, seeded.organizationId, method, path, body, headers)
  return { harness, seeded, other, byRole, call, api }
}

const body = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  lengthMinutes: 30,
  bufferBeforeMinutes: 5,
  bufferAfterMinutes: 5,
  minimumNoticeMinutes: 60,
  mode: 'phone',
  ...extra,
})

type Created = { id: string; name: string; state: string; publicToken: string | null }

describe('Booking Type routes', () => {
  test('the link token comes from BOOKING_LINK_KEY alone, never the unsubscribe key', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    const { id, publicToken } = (
      await t.call(t.byRole('admin'), 'POST', '/booking-types', body('K'))
    ).body as Created
    const under = (key: string) =>
      createHmac('sha256', key).update(`booking-link|${org}|${id}`).digest('base64url')
    expect(publicToken).toBe(under(t.harness.deps.env.BOOKING_LINK_KEY))
    expect(publicToken).not.toBe(under(t.harness.deps.env.UNSUBSCRIBE_TOKEN_KEY))
  })

  test('an Admin creates, reads, changes and retires; the link token is stable', async () => {
    const t = await setup()
    const admin = t.byRole('admin')
    const made = await t.call(admin, 'POST', '/booking-types', body('Intro call'))
    expect(made.status).toBe(201)
    const created = made.body as Created
    expect(created.state).toBe('active')
    expect(created.publicToken).toMatch(/^[A-Za-z0-9_-]{32,64}$/)

    const read = await t.call(admin, 'GET', `/booking-types/${created.id}`)
    expect(read.body).toMatchObject({ id: created.id, publicToken: created.publicToken })

    const changed = await t.call(admin, 'PATCH', `/booking-types/${created.id}`, {
      lengthMinutes: 45,
    })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({ lengthMinutes: 45, publicToken: created.publicToken })

    const retired = await t.call(admin, 'POST', `/booking-types/${created.id}/retire`)
    expect(retired.status).toBe(200)
    expect(retired.body).toMatchObject({ state: 'retired' })
    expect((await t.call(admin, 'POST', `/booking-types/${created.id}/retire`)).status).toBe(200)
  })

  test('a Manager and a Rep read but cannot create, change or retire; they never see the token', async () => {
    const t = await setup()
    const { id } = (await t.call(t.byRole('admin'), 'POST', '/booking-types', body('A')))
      .body as Created
    for (const role of ['manager', 'rep'] as const) {
      const member = t.byRole(role)
      for (const [method, path, payload] of [
        ['POST', '/booking-types', body('B')],
        ['PATCH', `/booking-types/${id}`, { mode: 'video' }],
        ['POST', `/booking-types/${id}/retire`, undefined],
      ] as const) {
        const denied = await t.call(member, method, path, payload)
        expect(denied.status).toBe(403)
        expect(denied.body).toMatchObject({ error: { code: 'auth.forbidden' } })
      }
      const read = await t.call(member, 'GET', `/booking-types/${id}`)
      expect(read.status).toBe(200)
      expect((read.body as Created).publicToken).toBeNull()
      const listed = await t.call(member, 'GET', '/booking-types')
      expect((listed.body as { items: Created[] }).items[0]?.publicToken).toBeNull()
    }
  })

  test('out-of-range values and an empty change are request.invalid', async () => {
    const t = await setup()
    const admin = t.byRole('admin')
    const tooLong = await t.call(
      admin,
      'POST',
      '/booking-types',
      body('X', { lengthMinutes: 100000 })
    )
    expect(tooLong.status).toBe(400)
    const { id } = (await t.call(admin, 'POST', '/booking-types', body('Y'))).body as Created
    expect((await t.call(admin, 'PATCH', `/booking-types/${id}`, {})).status).toBe(400)
  })

  test('a name taken ignoring case is a 409 request.conflict, on create and update', async () => {
    const t = await setup()
    const admin = t.byRole('admin')
    await t.call(admin, 'POST', '/booking-types', body('Demo'))
    const dup = await t.call(admin, 'POST', '/booking-types', body('dEMO'))
    expect(dup.status).toBe(409)
    expect(dup.body).toMatchObject({ error: { code: 'request.conflict' } })
    const { id } = (await t.call(admin, 'POST', '/booking-types', body('Other'))).body as Created
    const rename = await t.call(admin, 'PATCH', `/booking-types/${id}`, { name: 'DEMO' })
    expect(rename.status).toBe(409)
    expect(rename.body).toMatchObject({ error: { code: 'request.conflict' } })
  })

  test('the same Idempotency-Key creates once: 201 then 200 with the same Booking Type', async () => {
    const t = await setup()
    const admin = t.byRole('admin')
    const headers = { 'idempotency-key': 'booking-type-key-0001' }
    const first = await t.call(admin, 'POST', '/booking-types', body('Once'), headers)
    const again = await t.call(admin, 'POST', '/booking-types', body('Once'), headers)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const reused = await t.call(admin, 'POST', '/booking-types', body('Different'), headers)
    expect(reused.status).toBe(422)
    expect(reused.body).toMatchObject({ error: { code: 'request.idempotency_key_reused' } })
  })

  test('the list pages by cursor, newest first, and filters by state', async () => {
    const t = await setup()
    const admin = t.byRole('admin')
    const ids: string[] = []
    for (const name of ['One', 'Two', 'Three']) {
      ids.push(((await t.call(admin, 'POST', '/booking-types', body(name))).body as Created).id)
      t.harness.deps.clock.advance('1m')
    }
    const first = await t.call(admin, 'GET', '/booking-types?limit=2')
    const page1 = first.body as { items: Created[]; nextCursor: string | null }
    expect(page1.items.map((i) => i.name)).toEqual(['Three', 'Two'])
    expect(page1.nextCursor).not.toBeNull()
    const second = await t.call(admin, 'GET', `/booking-types?limit=2&cursor=${page1.nextCursor}`)
    const page2 = second.body as { items: Created[]; nextCursor: string | null }
    expect(page2.items.map((i) => i.name)).toEqual(['One'])
    expect(page2.nextCursor).toBeNull()

    await t.call(admin, 'POST', `/booking-types/${ids[0]}/retire`)
    const retired = await t.call(admin, 'GET', '/booking-types?state=retired')
    expect((retired.body as { items: Created[] }).items.map((i) => i.name)).toEqual(['One'])
    expect((await t.call(admin, 'GET', '/booking-types?limit=101')).status).toBe(400)
    expect((await t.call(admin, 'GET', '/booking-types?cursor=garbage')).status).toBe(400)
  })

  test('another Organization sees none of it and cannot change it', async () => {
    const t = await setup()
    const { id } = (await t.call(t.byRole('admin'), 'POST', '/booking-types', body('Mine')))
      .body as Created
    const outsider = t.other.members[0] as SeededMember
    const call = (method: string, path: string, payload?: unknown) =>
      t.api(outsider, t.other.organizationId, method, path, payload)
    expect(((await call('GET', '/booking-types')).body as { items: unknown[] }).items).toEqual([])
    for (const [method, path, payload] of [
      ['GET', `/booking-types/${id}`, undefined],
      ['PATCH', `/booking-types/${id}`, { mode: 'video' }],
      ['POST', `/booking-types/${id}/retire`, undefined],
    ] as const) {
      const res = await call(method, path, payload)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: { code: 'booking.type_not_found' } })
    }
    // The same name is free in the other Organization.
    expect((await call('POST', '/booking-types', body('Mine'))).status).toBe(201)
  })
})

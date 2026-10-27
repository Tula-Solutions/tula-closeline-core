import { describe, expect, test } from 'bun:test'
import type { Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'rep'])
  const other = await seedOrganization(memory, ['rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (member: SeededMember, method: string, path: string, payload?: unknown) =>
    api(member, seeded.organizationId, method, path, payload)
  return { seeded, other, byRole, call, api }
}

const hours = (extra: Record<string, unknown> = {}) => ({
  timeZone: 'Europe/London',
  hours: [
    {
      day: 'mon',
      windows: [
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '17:30' },
      ],
    },
    { day: 'fri', windows: [{ start: '10:00', end: '14:00' }] },
  ],
  dailyCap: 6,
  awayUntil: null,
  ...extra,
})

describe('availability routes', () => {
  test('a Rep with nothing set reads UTC with no windows', async () => {
    const t = await setup()
    const res = await t.call(t.byRole('rep'), 'GET', '/availability')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ timeZone: 'UTC', hours: [], dailyCap: null, awayUntil: null })
  })

  test('a Rep sets and reads back their hours; the same body again answers 200 unchanged', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const set = await t.call(rep, 'PUT', '/availability', hours())
    expect(set.status).toBe(200)
    expect(set.body).toEqual(hours())
    expect((await t.call(rep, 'GET', '/availability')).body).toEqual(hours())
    const again = await t.call(rep, 'PUT', '/availability', hours())
    expect(again.status).toBe(200)
    expect(again.body).toEqual(hours())
    const away = await t.call(
      rep,
      'PUT',
      '/availability',
      hours({ awayUntil: '2030-01-01T00:00:00.000Z' })
    )
    expect((away.body as { awayUntil: string }).awayUntil).toBe('2030-01-01T00:00:00.000Z')
  })

  test('an unknown time zone is calendar.hours_invalid', async () => {
    const t = await setup()
    const res = await t.call(
      t.byRole('rep'),
      'PUT',
      '/availability',
      hours({ timeZone: 'Mars/Olympus' })
    )
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: { code: 'calendar.hours_invalid' } })
  })

  test('overlapping windows, start not before end and a repeated day are request.invalid', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const bad = [
      [
        {
          day: 'mon',
          windows: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '13:00' },
          ],
        },
      ],
      [{ day: 'mon', windows: [{ start: '12:00', end: '12:00' }] }],
      [
        { day: 'mon', windows: [{ start: '09:00', end: '10:00' }] },
        { day: 'mon', windows: [{ start: '11:00', end: '12:00' }] },
      ],
    ]
    for (const days of bad) {
      const res = await t.call(rep, 'PUT', '/availability', hours({ hours: days }))
      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ error: { code: 'request.invalid' } })
    }
  })

  test('an Admin sets only their own hours, never a Rep', async () => {
    const t = await setup()
    await t.call(t.byRole('rep'), 'PUT', '/availability', hours())
    const admin = t.byRole('admin')
    expect((await t.call(admin, 'GET', '/availability')).body).toMatchObject({ hours: [] })
    await t.call(admin, 'PUT', '/availability', hours({ timeZone: 'Asia/Tokyo' }))
    expect((await t.call(t.byRole('rep'), 'GET', '/availability')).body).toMatchObject({
      timeZone: 'Europe/London',
    })
  })

  test('another Organization sees none of it', async () => {
    const t = await setup()
    await t.call(t.byRole('rep'), 'PUT', '/availability', hours())
    const outsider = t.other.members[0] as SeededMember
    const res = await t.api(outsider, t.other.organizationId, 'GET', '/availability')
    expect(res.body).toEqual({ timeZone: 'UTC', hours: [], dailyCap: null, awayUntil: null })
  })
})

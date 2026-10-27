import { describe, expect, test } from 'bun:test'
import { harness, store } from '~/integration-harness'
import { seedTeam } from '~/modules/routing/fixtures'
import { publicCaller, type SeededMember, seedOrganization } from '~/testing'

type Slot = { startsAt: string; repMembershipId: string }
type Booked = { id: string; state: string; repMembershipId: string }

describe('booking over Postgres', () => {
  test('simultaneous books for one time: one confirmed, the rest slot_taken; B sees nothing', async () => {
    const h = await harness()
    const api = publicCaller(h)
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const admin = org.members.find((m) => m.role === 'admin') as SeededMember
    const rep = org.members.find((m) => m.role === 'rep') as SeededMember
    const id = org.organizationId
    await seedTeam(store, id, [rep.id])
    h.deps.memoryCalendar.allowGrant('code-1')
    const started = await api(rep, id, 'POST', '/calendar-connection/start', { provider: 'google' })
    await api(rep, id, 'POST', '/calendar-connection/complete', {
      state: started.body.state,
      code: 'code-1',
    })
    const rule = await api(admin, id, 'POST', '/routing-rules', {
      name: 'Default',
      conditions: {},
      isDefault: true,
      target: { kind: 'rep', membershipId: rep.id },
    })
    expect(rule.status).toBe(201)
    const type = await api(admin, id, 'POST', '/booking-types', {
      name: 'Intro',
      lengthMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
      mode: 'phone',
    })
    const prospect = await api(admin, id, 'POST', '/prospects', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
    })
    const from = new Date(h.deps.clock.now().getTime() + 60_000)
    const to = new Date(from.getTime() + 3 * 86_400_000)
    const slots = await api(
      admin,
      id,
      'GET',
      `/booking-slots?bookingTypeId=${type.body.id}&prospectId=${prospect.body.id}&from=${from.toISOString()}&to=${to.toISOString()}`
    )
    expect(slots.status).toBe(200)
    const slot = (slots.body.items as Slot[])[0] as Slot

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api(
          admin,
          id,
          'POST',
          '/bookings',
          {
            bookingTypeId: type.body.id,
            prospectId: prospect.body.id,
            startsAt: slot.startsAt,
            repMembershipId: slot.repMembershipId,
          },
          { 'idempotency-key': `concurrent-key-${String(i).padStart(8, '0')}` }
        )
      )
    )
    const codes = results.map((r) => (r.body as { error?: { code: string } }).error?.code)
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    for (const [i, r] of results.entries()) {
      if (r.status !== 201) {
        expect(codes[i]).toMatch(/^booking\.slot_taken$|^request\.idempotency_in_progress$/)
      }
    }
    const listed = await api(admin, id, 'GET', '/bookings')
    const rows = listed.body.items as Booked[]
    expect(rows.map((b) => b.state)).toEqual(['confirmed'])

    const otherAdmin = other.members[0] as SeededMember
    const theirs = await api(otherAdmin, other.organizationId, 'GET', `/bookings/${rows[0]?.id}`)
    expect(theirs.status).toBe(404)
  })
})

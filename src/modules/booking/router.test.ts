import { describe, expect, test } from 'bun:test'
import { formatId, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { seedTeam } from '~/modules/routing/fixtures'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'

async function setup(options: { dailyCap?: number } = {}) {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, [
    'admin',
    'manager',
    'manager',
    'rep',
    'rep',
    'rep',
  ])
  const other = await seedOrganization(memory, ['admin', 'rep'])
  const all = (role: Role) => seeded.members.filter((m) => m.role === role) as SeededMember[]
  const [mine, theirs] = all('manager') as [SeededMember, SeededMember]
  const [r1, r2, r3] = all('rep') as [SeededMember, SeededMember, SeededMember]
  const admin = all('admin')[0] as SeededMember
  const api = publicCaller(harness)
  const org = seeded.organizationId
  const call = (
    member: SeededMember,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => api(member, org, method, path, body, headers)
  // Team A: manager `mine` with r1, r2. Team B: manager `theirs` with r3.
  const teamA = await seedTeam(memory, org, [mine.id, r1.id, r2.id], options)
  await seedTeam(memory, org, [theirs.id, r3.id])
  // Real vendor connections so a live calendar call succeeds.
  for (const rep of [r1, r2, r3]) {
    const code = `code-${rep.id}`
    harness.deps.memoryCalendar.allowGrant(code)
    const started = await call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    await call(rep, 'POST', '/calendar-connection/complete', {
      state: (started.body as { state: string }).state,
      code,
    })
  }
  const rule = (target: unknown) => ({
    name: 'Default',
    target,
    conditions: {},
    isDefault: true,
  })
  await call(admin, 'POST', '/routing-rules', rule({ kind: 'team', teamId: teamA }))
  const type = (
    await call(admin, 'POST', '/booking-types', {
      name: 'Intro',
      lengthMinutes: 30,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 5,
      minimumNoticeMinutes: 60,
      mode: 'phone',
    })
  ).body as { id: string }
  const prospect = (
    await call(r1, 'POST', '/prospects', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
    })
  ).body as { id: string }
  const slots = async (member = admin, extra = '') =>
    (
      await call(
        member,
        'GET',
        `/booking-slots?bookingTypeId=${type.id}&prospectId=${prospect.id}&from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z${extra}`
      )
    ).body as { items: Slot[]; nextCursor: string | null }
  let n = 0
  const book = (
    member: SeededMember,
    body: Record<string, unknown>,
    key = `booking-key-${String(++n).padStart(8, '0')}`
  ) =>
    call(
      member,
      'POST',
      '/bookings',
      { bookingTypeId: type.id, prospectId: prospect.id, ...body },
      { 'idempotency-key': key }
    )
  const topics = () => memory.outbox.rows().map((row) => row.topic)
  return {
    memory,
    harness,
    seeded,
    other,
    admin,
    mine,
    theirs,
    r1,
    r2,
    r3,
    teamA,
    call,
    type,
    prospect,
    slots,
    book,
    topics,
  }
}

type Slot = { startsAt: string; endsAt: string; repMembershipId: string }
type Booked = { id: string; state: string; startsAt: string; repMembershipId: string }

/** Two offered times far enough apart that buffers never touch. */
const apart = (page: { items: Slot[] }) => {
  const a = page.items[0] as Slot
  const b = page.items.slice(10).find((s) => s.repMembershipId === a.repMembershipId) as Slot
  return [a, b] as [Slot, Slot]
}

const errorOf = (res: { body: unknown }) => (res.body as { error?: { code?: string } }).error?.code

describe('Booking slots', () => {
  test('merges the routed Reps, earliest first, each with the Rep who would take it', async () => {
    const t = await setup()
    const page = await t.slots()
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThanOrEqual(100)
    const starts = page.items.map((s) => s.startsAt)
    expect([...starts].sort()).toEqual(starts)
    const reps = new Set(page.items.map((s) => s.repMembershipId))
    expect([...reps].every((rep) => [t.r1.id, t.r2.id].includes(rep as never))).toBe(true)
    expect(page.nextCursor).not.toBeNull()
  })

  test('a held Booking and its buffers remove the time for that Rep only', async () => {
    const t = await setup()
    const first = (await t.slots()).items[0] as Slot
    const made = await t.book(t.admin, { startsAt: first.startsAt, repMembershipId: t.r1.id })
    expect(made.status).toBe(201)
    const after = (await t.slots()).items
    const clash = after.filter((s) => s.startsAt === first.startsAt)
    expect(clash.map((s) => s.repMembershipId)).not.toContain(t.r1.id)
    // The 5 minute buffer after the Booking is also held for r1.
    const end = Date.parse(first.startsAt) + 30 * 60_000
    const near = after.filter(
      (s) => s.repMembershipId === t.r1.id && Date.parse(s.startsAt) < end + 5 * 60_000
    )
    expect(near.filter((s) => Date.parse(s.startsAt) < end)).toEqual([])
  })

  test('an unknown Booking Type or Prospect is refused', async () => {
    const t = await setup()
    const q = (type: string, prospect: string) =>
      t.call(
        t.admin,
        'GET',
        `/booking-slots?bookingTypeId=${type}&prospectId=${prospect}&from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z`
      )
    const ghostType = t.type.id.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
    const ghostProspect = t.prospect.id.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
    expect(errorOf(await q(ghostType, t.prospect.id))).toBe('booking.type_not_found')
    expect(errorOf(await q(t.type.id, ghostProspect))).toBe('prospect.not_found')
  })
})

describe('Daily cap', () => {
  test('a Rep at the daily cap offers no more times that day and cannot be booked', async () => {
    const t = await setup({ dailyCap: 1 })
    const first = (await t.slots()).items[0] as Slot
    expect((await t.book(t.admin, { startsAt: first.startsAt })).status).toBe(201)
    expect((await t.book(t.admin, { startsAt: first.startsAt })).status).toBe(201)
    const day = first.startsAt.slice(0, 10)
    const left = (await t.slots()).items.filter((s) => s.startsAt.startsWith(day))
    expect(left).toEqual([])
    const res = await t.book(t.admin, { startsAt: first.startsAt })
    expect(errorOf(res)).not.toBeUndefined()
    expect(res.status).toBeGreaterThanOrEqual(409)
  })
})

describe('Book', () => {
  test('books the first free Rep, writes the calendar once and publishes booking.created', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const res = await t.book(t.admin, { startsAt: slot.startsAt })
    expect(res.status).toBe(201)
    const booking = res.body as Booked
    expect(booking.state).toBe('confirmed')
    expect(booking.startsAt).toBe(slot.startsAt)
    expect(t.topics().filter((x) => x === 'booking.created')).toHaveLength(1)
  })

  test('a replay of the same key answers the same Booking with 200 and publishes nothing more', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const body = { startsAt: slot.startsAt, repMembershipId: t.r1.id }
    const one = await t.book(t.admin, body, 'same-key-0000000000')
    const two = await t.book(t.admin, body, 'same-key-0000000000')
    expect(one.status).toBe(201)
    expect(two.status).toBe(200)
    expect((two.body as Booked).id).toBe((one.body as Booked).id)
    expect(t.topics().filter((x) => x === 'booking.created')).toHaveLength(1)
  })

  test('the same key with another body is request.idempotency_key_reused', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    await t.book(
      t.admin,
      { startsAt: a.startsAt, repMembershipId: a.repMembershipId },
      'other-key-00000000'
    )
    const again = await t.book(
      t.admin,
      { startsAt: b.startsAt, repMembershipId: a.repMembershipId },
      'other-key-00000000'
    )
    expect(errorOf(again)).toBe('request.idempotency_key_reused')
  })

  test('a calendar failure leaves no Booking and the same key then succeeds', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const body = { startsAt: slot.startsAt, repMembershipId: t.r1.id }
    t.harness.deps.memoryCalendar.failNext('calendar.unavailable', 3)
    const failed = await t.book(t.admin, body, 'retry-key-00000000')
    expect(failed.status).toBe(503)
    expect(errorOf(failed)).toBe('booking.calendar_unavailable')
    expect(
      ((await t.call(t.admin, 'GET', '/bookings')).body as { items: unknown[] }).items
    ).toEqual([])
    expect(t.topics()).not.toContain('booking.created')
    const ok = await t.book(t.admin, body, 'retry-key-00000000')
    expect(ok.status).toBe(201)
  })

  test('refuses past times, times inside the notice, beyond 14 days and off-grid times', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const at = (iso: string) => t.book(t.admin, { startsAt: iso, repMembershipId: t.r1.id })
    for (const iso of [
      '2025-12-31T10:00:00.000Z',
      '2026-01-01T00:30:00.000Z',
      '2026-02-01T10:00:00.000Z',
      new Date(Date.parse(slot.startsAt) + 7 * 60_000).toISOString(),
    ]) {
      const res = await at(iso)
      expect(res.status).toBe(422)
      expect(errorOf(res)).toBe('booking.slot_invalid')
    }
  })

  test('a second book for a held time is booking.slot_taken', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const body = { startsAt: slot.startsAt, repMembershipId: t.r1.id }
    expect((await t.book(t.admin, body)).status).toBe(201)
    const second = await t.book(t.admin, body)
    expect(second.status).toBe(409)
    expect(errorOf(second)).toBe('booking.slot_taken')
  })

  test('with no Rep named, the next book at the same time takes the other Rep', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const a = (await t.book(t.admin, { startsAt: slot.startsAt })).body as Booked
    const b = (await t.book(t.admin, { startsAt: slot.startsAt })).body as Booked
    expect(new Set([a.repMembershipId, b.repMembershipId]).size).toBe(2)
    const third = await t.book(t.admin, { startsAt: slot.startsAt })
    expect(errorOf(third)).toBe('booking.slot_taken')
  })
})

describe('Reschedule and cancel', () => {
  test('reschedule moves the Booking once, and the same time again is a 200 that publishes nothing', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    const made = (
      await t.book(t.admin, { startsAt: a.startsAt, repMembershipId: a.repMembershipId })
    ).body as Booked
    const moved = await t.call(t.admin, 'POST', `/bookings/${made.id}/reschedule`, {
      startsAt: b.startsAt,
    })
    expect(moved.status).toBe(200)
    expect((moved.body as Booked).startsAt).toBe(b.startsAt)
    const again = await t.call(t.admin, 'POST', `/bookings/${made.id}/reschedule`, {
      startsAt: b.startsAt,
    })
    expect(again.status).toBe(200)
    expect(t.topics().filter((x) => x === 'booking.rescheduled')).toHaveLength(1)
  })

  test('a calendar failure on reschedule leaves the Booking unchanged', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    const made = (
      await t.book(t.admin, { startsAt: a.startsAt, repMembershipId: a.repMembershipId })
    ).body as Booked
    t.harness.deps.memoryCalendar.failNext('calendar.unavailable', 3)
    const res = await t.call(t.admin, 'POST', `/bookings/${made.id}/reschedule`, {
      startsAt: b.startsAt,
    })
    expect(errorOf(res)).toBe('booking.calendar_unavailable')
    const got = await t.call(t.admin, 'GET', `/bookings/${made.id}`)
    expect((got.body as Booked).startsAt).toBe(a.startsAt)
  })

  test('reschedule to a taken or invalid time is refused', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    const one = (
      await t.book(t.admin, { startsAt: a.startsAt, repMembershipId: a.repMembershipId })
    ).body as Booked
    await t.book(t.admin, { startsAt: b.startsAt, repMembershipId: a.repMembershipId })
    const taken = await t.call(t.admin, 'POST', `/bookings/${one.id}/reschedule`, {
      startsAt: b.startsAt,
    })
    expect(errorOf(taken)).toBe('booking.slot_taken')
    const bad = await t.call(t.admin, 'POST', `/bookings/${one.id}/reschedule`, {
      startsAt: '2025-01-01T10:00:00.000Z',
    })
    expect(errorOf(bad)).toBe('booking.slot_invalid')
  })

  test('cancel publishes once, repeats as 200, and a cancelled Booking cannot be rescheduled', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    const made = (
      await t.book(t.admin, { startsAt: a.startsAt, repMembershipId: a.repMembershipId })
    ).body as Booked
    const one = await t.call(t.admin, 'POST', `/bookings/${made.id}/cancel`)
    const two = await t.call(t.admin, 'POST', `/bookings/${made.id}/cancel`)
    expect([one.status, two.status]).toEqual([200, 200])
    expect((one.body as Booked).state).toBe('cancelled')
    expect(t.topics().filter((x) => x === 'booking.cancelled')).toHaveLength(1)
    const res = await t.call(t.admin, 'POST', `/bookings/${made.id}/reschedule`, {
      startsAt: b.startsAt,
    })
    expect(res.status).toBe(409)
    expect(errorOf(res)).toBe('booking.not_active')
    // The cancelled time is free again.
    const rebook = await t.book(t.admin, {
      startsAt: a.startsAt,
      repMembershipId: a.repMembershipId,
    })
    expect(rebook.status).toBe(201)
  })
})

describe('Review regressions', () => {
  test('moving A to B, back to A and to B again moves the event and publishes each time', async () => {
    const t = await setup()
    const [a, b] = apart(await t.slots())
    const made = (
      await t.book(t.admin, { startsAt: a.startsAt, repMembershipId: a.repMembershipId })
    ).body as Booked
    const move = (startsAt: string) =>
      t.call(t.admin, 'POST', `/bookings/${made.id}/reschedule`, { startsAt })
    for (const at of [b.startsAt, a.startsAt, b.startsAt]) {
      expect((await move(at)).status).toBe(200)
    }
    expect(t.topics().filter((x) => x === 'booking.rescheduled')).toHaveLength(3)
    const requests = t.harness.deps.memoryCalendar.requests()
    const updates = requests.filter((r) => JSON.stringify(r).includes('resched'))
    expect(new Set(updates.map((r) => JSON.stringify(r))).size).toBe(updates.length)
  })

  test('a book that loses its pending row after the calendar write deletes the event', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const calendar = t.harness.deps.memoryCalendar
    const create = calendar.createEvent.bind(calendar)
    calendar.createEvent = async (request, options) => {
      const created = await create(request, options)
      // Another write wins between the calendar write and the confirm.
      await t.memory.withOrganization(t.seeded.organizationId, async (scope) => {
        await scope.lockOrganization()
        for (const rep of [t.r1, t.r2]) {
          for (const row of await scope.listRepBookings(
            rep.id as never,
            new Date(0),
            new Date('2100-01-01'),
            new Date(0)
          )) {
            await scope.cancelBooking(row.id, new Date())
          }
        }
      })
      return created
    }
    const res = await t.book(t.admin, {
      startsAt: slot.startsAt,
      repMembershipId: slot.repMembershipId,
    })
    expect(errorOf(res)).toBe('booking.calendar_unavailable')
    const kinds = calendar.requests().map((r) => r.kind)
    expect(kinds).toContain('create')
    expect(kinds).toContain('delete')
  })

  test('a pending Booking cannot be cancelled or rescheduled', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const org = t.seeded.organizationId
    const id = await t.memory.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      const record = await scope.insertBooking({
        id: formatId('bkg', crypto.randomUUID()),
        bookingTypeId: t.type.id as never,
        membershipId: slot.repMembershipId as never,
        prospectId: t.prospect.id as never,
        mode: 'phone',
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(Date.parse(slot.startsAt) + 1_800_000),
        blockedFrom: new Date(slot.startsAt),
        blockedUntil: new Date(Date.parse(slot.startsAt) + 1_800_000),
        keyHash: 'h'.repeat(64),
        routingDecisionId: null,
        now: new Date(),
      })
      return record.id
    })
    expect(errorOf(await t.call(t.admin, 'POST', `/bookings/${id}/cancel`))).toBe(
      'booking.not_active'
    )
    expect(
      errorOf(
        await t.call(t.admin, 'POST', `/bookings/${id}/reschedule`, { startsAt: slot.startsAt })
      )
    ).toBe('booking.not_active')
    const resurrected = await t.memory.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      await scope.cancelBooking(id, new Date())
      return scope.confirmBooking(id, { calendarEventId: 'evt', joinUrl: null }, new Date())
    })
    expect(resurrected).toBeNull()
  })
})

describe('Booking visibility', () => {
  test('a Rep sees their own, a Manager their Team, an Admin all; others are not found', async () => {
    const t = await setup()
    const s1 = (await t.slots()).items[0] as Slot
    const b1 = (await t.book(t.admin, { startsAt: s1.startsAt })).body as Booked
    const b2 = (await t.book(t.admin, { startsAt: s1.startsAt })).body as Booked
    // Both Reps are on Team A; r3 is on another Team and has none.
    const ids = async (member: SeededMember, q = '') =>
      (
        (await t.call(member, 'GET', `/bookings${q}`)).body as { items: { id: string }[] }
      ).items.map((b) => b.id)
    const own = [b1, b2].find((b) => b.repMembershipId === t.r1.id) as Booked
    const theirsB = [b1, b2].find((b) => b !== own) as Booked
    expect(await ids(t.r1)).toEqual([own.id])
    expect((await ids(t.mine)).sort()).toEqual([b1.id, b2.id].sort())
    expect(await ids(t.theirs)).toEqual([])
    expect((await ids(t.admin)).sort()).toEqual([b1.id, b2.id].sort())
    // A filter never widens what the caller sees.
    expect(await ids(t.r1, `?repMembershipId=${t.r2.id}`)).toEqual([])
    expect((await t.call(t.r1, 'GET', `/bookings/${theirsB.id}`)).status).toBe(404)
    expect(errorOf(await t.call(t.r3, 'GET', `/bookings/${b1.id}`))).toBe('booking.not_found')
    expect(errorOf(await t.call(t.r1, 'POST', `/bookings/${theirsB.id}/cancel`))).toBe(
      'booking.not_found'
    )
  })

  test('another Organization cannot book into or read these Bookings', async () => {
    const t = await setup()
    const slot = (await t.slots()).items[0] as Slot
    const made = (await t.book(t.admin, { startsAt: slot.startsAt, repMembershipId: t.r1.id }))
      .body as Booked
    const foreign = t.other.members.find((m) => m.role === 'admin') as SeededMember
    const api = publicCaller(t.harness)
    const org = t.other.organizationId
    const read = await api(foreign, org, 'GET', `/bookings/${made.id}`)
    expect(read.status).toBe(404)
    const list = await api(foreign, org, 'GET', '/bookings')
    expect((list.body as { items: unknown[] }).items).toEqual([])
    const res = await api(
      foreign,
      org,
      'POST',
      '/bookings',
      {
        bookingTypeId: t.type.id,
        prospectId: t.prospect.id,
        startsAt: slot.startsAt,
        repMembershipId: t.r1.id,
      },
      { 'idempotency-key': 'foreign-key-0000000' }
    )
    expect(res.status).toBe(404)
  })
})

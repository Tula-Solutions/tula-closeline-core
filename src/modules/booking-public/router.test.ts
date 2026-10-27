import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { redactedPath } from '~/http/errors'
import { createTestApp, publicCaller, type SeededMember } from '~/testing'
import { bookingWorld } from './fixtures'
import { BOOKING_ADDRESS_LIMIT } from './service'

type Slots = { items: { startsAt: string; endsAt: string }[]; nextCursor: string | null }

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const mine = await bookingWorld(memory, harness)
  const theirs = await bookingWorld(memory, harness)
  const slotsUrl = (token: string, extra = '') =>
    `/v1/public/booking-types/${token}/slots?from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z${extra}`
  const getSlots = (token: string, extra = '') => harness.app.request(slotsUrl(token, extra))
  const bookUrl = (token: string) => `/v1/public/booking-types/${token}/bookings`
  let n = 0
  const book = (
    token: string,
    body: Record<string, unknown>,
    key = `public-key-${String(++n).padStart(8, '0')}`
  ) =>
    harness.app.request(bookUrl(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        name: 'Grace Hopper',
        email: 'grace@example.test',
        timeZone: 'Europe/Berlin',
        ...body,
      }),
    })
  const firstSlot = async (token: string, skip = 0) =>
    ((await (await getSlots(token)).json()) as Slots).items[skip]?.startsAt as string
  return { memory, harness, mine, theirs, getSlots, book, firstSlot }
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code

describe('Public Booking Type link', () => {
  test('lists pooled times with only a start and an end, never a Rep or an id', async () => {
    const t = await setup()
    const res = await t.getSlots(t.mine.token)
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    const page = JSON.parse(text) as Slots & { bookingType: unknown }
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThanOrEqual(100)
    expect(page.items.every((s) => Object.keys(s).sort().join() === 'endsAt,startsAt')).toBe(true)
    expect(page.bookingType).toEqual({ name: 'Intro', lengthMinutes: 30, mode: 'phone' })
    for (const rep of t.mine.reps) {
      expect(text).not.toContain(rep.id)
    }
    expect(text).not.toContain(t.mine.type.id)
    expect(page.nextCursor).not.toBeNull()
  })

  test('a token of another Organization never lists or books this one’s Reps', async () => {
    const t = await setup()
    const slot = await t.firstSlot(t.theirs.token)
    const res = await t.book(t.theirs.token, { startsAt: slot })
    expect(res.status).toBe(201)
    const stored = await t.memory.withOrganization(t.theirs.org, (s) =>
      s.listBookings({ limit: 10 })
    )
    expect(stored).toHaveLength(1)
    expect(t.theirs.reps.map((r) => r.id)).toContain(stored[0]?.membershipId as never)
    const mineStored = await t.memory.withOrganization(t.mine.org, (s) =>
      s.listBookings({ limit: 10 })
    )
    expect(mineStored).toHaveLength(0)
  })

  test('an unknown, malformed or retired token is booking.type_not_found', async () => {
    const t = await setup()
    for (const token of ['x'.repeat(40), 'short', 'not%20a%20token']) {
      const res = await t.getSlots(token)
      expect(res.status).toBe(404)
      expect(await codeOf(res)).toBe('booking.type_not_found')
    }
    const retired = await t.mine.call(
      t.mine.admin,
      'POST',
      `/booking-types/${t.mine.type.id}/retire`
    )
    expect(retired.status).toBe(200)
    const slots = await t.getSlots(t.mine.token)
    expect(slots.status).toBe(404)
    expect(await codeOf(slots)).toBe('booking.type_not_found')
    const slot = await t.firstSlot(t.theirs.token)
    const booked = await t.book(t.mine.token, { startsAt: slot })
    expect(booked.status).toBe(404)
    expect(await codeOf(booked)).toBe('booking.type_not_found')
  })

  test('books with origin public, answers only the confirmation, and replays with 200', async () => {
    const t = await setup()
    const startsAt = await t.firstSlot(t.mine.token)
    const first = await t.book(t.mine.token, { startsAt }, 'public-replay-key-1')
    expect(first.status).toBe(201)
    const confirmation = (await first.json()) as Record<string, unknown>
    expect(Object.keys(confirmation).sort()).toEqual([
      'endsAt',
      'id',
      'joinUrl',
      'mode',
      'startsAt',
    ])
    expect(confirmation.mode).toBe('phone')
    const replay = await t.book(t.mine.token, { startsAt }, 'public-replay-key-1')
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(confirmation)
    const stored = await t.memory.withOrganization(t.mine.org, (s) => s.listBookings({ limit: 10 }))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.origin).toBe('public')
    const other = await t.book(
      t.mine.token,
      { startsAt: await t.firstSlot(t.mine.token, 20) },
      'public-replay-key-1'
    )
    expect(other.status).toBe(422)
    expect(await codeOf(other)).toBe('request.idempotency_key_reused')
  })

  test('a booking made while signed in has origin member', async () => {
    const t = await setup()
    const api = publicCaller(t.harness)
    const rep = t.mine.reps[0] as SeededMember
    const prospect = (
      await api(rep, t.mine.org, 'POST', '/prospects', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
      })
    ).body as { id: string }
    const slots = (
      await api(
        t.mine.admin,
        t.mine.org,
        'GET',
        `/booking-slots?bookingTypeId=${t.mine.type.id}&prospectId=${prospect.id}&from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z`
      )
    ).body as { items: { startsAt: string }[] }
    const made = await api(
      t.mine.admin,
      t.mine.org,
      'POST',
      '/bookings',
      {
        bookingTypeId: t.mine.type.id,
        prospectId: prospect.id,
        startsAt: slots.items[0]?.startsAt,
      },
      { 'idempotency-key': 'member-origin-key-1' }
    )
    expect(made.status).toBe(201)
    const stored = await t.memory.withOrganization(t.mine.org, (s) => s.listBookings({ limit: 10 }))
    expect(stored[0]?.origin).toBe('member')
  })

  test('a second book of a held time is booking.slot_taken', async () => {
    const t = await setup()
    const startsAt = await t.firstSlot(t.mine.token)
    expect((await t.book(t.mine.token, { startsAt })).status).toBe(201)
    expect((await t.book(t.mine.token, { startsAt, email: 'b@example.test' })).status).toBe(201)
    const third = await t.book(t.mine.token, { startsAt, email: 'c@example.test' })
    expect(third.status).toBe(409)
    expect(await codeOf(third)).toBe('booking.slot_taken')
  })

  test('a filled honeypot looks booked but stores nothing and calls no calendar', async () => {
    const t = await setup()
    const startsAt = await t.firstSlot(t.mine.token)
    const before = t.harness.deps.memoryCalendar.requests().length
    const res = await t.book(t.mine.token, { startsAt, website: 'https://spam.example' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ mode: 'phone', joinUrl: null })
    const stored = await t.memory.withOrganization(t.mine.org, (s) => s.listBookings({ limit: 10 }))
    expect(stored).toHaveLength(0)
    expect(t.harness.deps.memoryCalendar.requests().length).toBe(before)
    const prospects = await t.mine.call(t.mine.admin, 'GET', '/prospects')
    expect(JSON.stringify(prospects.body)).not.toContain('grace@example.test')
  })

  test('the rate limit answers 429 with Retry-After', async () => {
    const t = await setup()
    let last = new Response()
    for (let i = 0; i <= BOOKING_ADDRESS_LIMIT; i++) {
      last = await t.getSlots(t.mine.token, '&limit=1')
    }
    expect(last.status).toBe(429)
    expect(await codeOf(last)).toBe('rate.limited')
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('the token never reaches a log line or an error report', async () => {
    const t = await setup()
    const store = t.harness.deps.store
    const lookup = store.bookingTypeForToken.bind(store)
    store.bookingTypeForToken = async () => {
      throw new Error('store down')
    }
    const failed = await t.getSlots(t.mine.token)
    expect(failed.status).toBe(500)
    store.bookingTypeForToken = lookup
    await t.getSlots('y'.repeat(40))
    const seen = JSON.stringify([t.harness.deps.logLines, t.harness.deps.reported])
    expect(seen).not.toContain(t.mine.token)
    expect(t.harness.deps.reported).toHaveLength(1)
    expect(seen).toContain('/v1/public/booking-types/:token')
  })

  test('redactedPath hides only the booking link token', () => {
    expect(redactedPath('/v1/public/booking-types/secret/slots')).toBe(
      '/v1/public/booking-types/:token/slots'
    )
    expect(redactedPath('/v1/bookings')).toBe('/v1/bookings')
    expect(formatId('bkg', crypto.randomUUID())).toMatch(/^bkg_/)
  })
})

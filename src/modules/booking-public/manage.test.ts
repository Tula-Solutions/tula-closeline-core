import { describe, expect, test } from 'bun:test'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { redactedPath } from '~/http/errors'
import { createTestApp } from '~/testing'
import { bookingWorld } from './fixtures'
import { BOOKING_ADDRESS_LIMIT } from './service'

type Slots = { items: { startsAt: string; endsAt: string }[]; nextCursor: string | null }
type Confirmation = { id: string; startsAt: string; manageToken: string }

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const mine = await bookingWorld(memory, harness)
  const theirs = await bookingWorld(memory, harness)
  const json = { 'content-type': 'application/json' }
  let n = 0
  const key = () => `manage-key-${String(++n).padStart(8, '0')}`
  const slotsOf = async (token: string) =>
    (
      (await (
        await harness.app.request(
          `/v1/public/booking-types/${token}/slots?from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z`
        )
      ).json()) as Slots
    ).items.map((s) => s.startsAt)
  const book = async (world: typeof mine, skip = 0, email = 'grace@example.test', k = key()) =>
    harness.app.request(`/v1/public/booking-types/${world.token}/bookings`, {
      method: 'POST',
      headers: { ...json, 'idempotency-key': k },
      body: JSON.stringify({
        name: 'Grace Hopper',
        email,
        timeZone: 'Europe/Berlin',
        startsAt: (await slotsOf(world.token))[skip],
      }),
    })
  const booked = async (world = mine, skip = 0) =>
    (await (await book(world, skip)).json()) as Confirmation
  const url = (token: string, tail = '') => `/v1/public/bookings/manage/${token}${tail}`
  const get = (token: string) => harness.app.request(url(token))
  const cancel = (token: string) => harness.app.request(url(token, '/cancel'), { method: 'POST' })
  const move = (token: string, startsAt: string, k = key()) =>
    harness.app.request(url(token, '/reschedule'), {
      method: 'POST',
      headers: { ...json, 'idempotency-key': k },
      body: JSON.stringify({ startsAt, timeZone: 'Europe/Berlin' }),
    })
  const topics = () => memory.outbox.rows().map((row) => row.topic)
  return { memory, harness, mine, theirs, book, booked, slotsOf, get, cancel, move, topics, url }
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code

describe('Public manage link', () => {
  test('book returns a manage token, and a replay returns the same one', async () => {
    const t = await setup()
    const startsAt = (await t.slotsOf(t.mine.token))[0]
    const send = () =>
      t.harness.app.request(`/v1/public/booking-types/${t.mine.token}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'manage-replay-key-1' },
        body: JSON.stringify({
          name: 'Grace Hopper',
          email: 'grace@example.test',
          timeZone: 'Europe/Berlin',
          startsAt,
        }),
      })
    const first = (await (await send()).json()) as Confirmation
    expect(first.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const replay = await send()
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as Confirmation).manageToken).toBe(first.manageToken)
  })

  test('a filled honeypot answer carries a token too, and it opens nothing', async () => {
    const t = await setup()
    const res = await t.harness.app.request(`/v1/public/booking-types/${t.mine.token}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'honeypot-key-0001' },
      body: JSON.stringify({
        name: 'Bot',
        email: 'bot@example.test',
        timeZone: 'UTC',
        startsAt: (await t.slotsOf(t.mine.token))[0],
        website: 'https://spam.example',
      }),
    })
    const body = (await res.json()) as Confirmation
    expect(body.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await t.get(body.manageToken)).status).toBe(404)
  })

  test('reads the Booking without a Rep, a Prospect or an email', async () => {
    const t = await setup()
    const made = await t.booked()
    const res = await t.get(made.manageToken)
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.clone().json())
    expect(await res.json()).toMatchObject({
      id: made.id,
      state: 'confirmed',
      bookingType: { name: 'Intro', lengthMinutes: 30, mode: 'phone' },
    })
    expect(text).not.toContain('grace@example.test')
    for (const rep of t.mine.reps) {
      expect(text).not.toContain(rep.id)
    }
  })

  test('an unknown token, another Organization’s Booking under a wrong token and a suspended Organization are all 404 booking.not_found', async () => {
    const t = await setup()
    const made = await t.booked()
    const unknown = await t.get('A'.repeat(43))
    expect(unknown.status).toBe(404)
    expect(await codeOf(unknown)).toBe('booking.not_found')
    expect(await codeOf(await t.get('short'))).toBe('booking.not_found')
    // A token from Organization B's Booking never opens, cancels or moves A's.
    const other = await t.booked(t.theirs)
    expect(((await (await t.get(other.manageToken)).json()) as { id: string }).id).toBe(other.id)
    expect(other.id).not.toBe(made.id)
    t.memory.setOrganizationStatus(t.mine.org, 'suspended')
    for (const res of [
      await t.get(made.manageToken),
      await t.cancel(made.manageToken),
      await t.move(made.manageToken, (await t.slotsOf(t.theirs.token))[5] as string),
    ]) {
      expect(res.status).toBe(404)
      expect(await codeOf(res)).toBe('booking.not_found')
    }
  })

  test('cancel twice answers 200 both times and publishes one booking.cancelled', async () => {
    const t = await setup()
    const made = await t.booked()
    const one = await t.cancel(made.manageToken)
    const two = await t.cancel(made.manageToken)
    expect([one.status, two.status]).toEqual([200, 200])
    expect(((await one.json()) as { state: string }).state).toBe('cancelled')
    expect(t.topics().filter((x) => x === 'booking.cancelled')).toHaveLength(1)
    expect(((await (await t.get(made.manageToken)).json()) as { state: string }).state).toBe(
      'cancelled'
    )
  })

  test('cancel after the start is booking.already_started and changes nothing', async () => {
    const t = await setup()
    const made = await t.booked()
    t.harness.deps.clock.advance('9000h')
    const res = await t.cancel(made.manageToken)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('booking.already_started')
    expect(t.topics()).not.toContain('booking.cancelled')
  })

  test('reschedule moves the Booking, publishes once, and replays by key', async () => {
    const t = await setup()
    const made = await t.booked()
    const to = (await t.slotsOf(t.mine.token))[10] as string
    const first = await t.move(made.manageToken, to, 'resched-replay-key-1')
    expect(first.status).toBe(200)
    expect(((await first.json()) as { startsAt: string }).startsAt).toBe(to)
    const again = await t.move(made.manageToken, to, 'resched-replay-key-1')
    expect(again.status).toBe(200)
    expect(t.topics().filter((x) => x === 'booking.rescheduled')).toHaveLength(1)
    const reused = await t.move(
      made.manageToken,
      (await t.slotsOf(t.mine.token))[20] as string,
      'resched-replay-key-1'
    )
    expect(reused.status).toBe(422)
    expect(await codeOf(reused)).toBe('request.idempotency_key_reused')
  })

  test('a replayed reschedule answers the Booking as it is now, not the stored first answer', async () => {
    const t = await setup()
    const made = await t.booked()
    const to = (await t.slotsOf(t.mine.token))[10] as string
    await t.move(made.manageToken, to, 'resched-stale-key-1')
    await t.cancel(made.manageToken)
    const replay = await t.move(made.manageToken, to, 'resched-stale-key-1')
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { state: string }).state).toBe('cancelled')
  })

  test('reschedule to a held time is slot_taken, to a past time slot_invalid', async () => {
    const t = await setup()
    const made = await t.booked()
    const reps = t.mine.reps.length
    const taken = (await t.slotsOf(t.mine.token))[3] as string
    // Fill that time for every Rep so nobody is left.
    for (let i = 0; i < reps; i++) {
      await t.book(t.mine, 3, `fill${i}@example.test`)
    }
    const res = await t.move(made.manageToken, taken)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('booking.slot_taken')
    const past = await t.move(made.manageToken, '2025-12-01T10:00:00.000Z')
    expect(past.status).toBe(422)
    expect(await codeOf(past)).toBe('booking.slot_invalid')
  })

  test('reschedule of a cancelled Booking is not_active; after the start already_started', async () => {
    const t = await setup()
    const made = await t.booked()
    const to = (await t.slotsOf(t.mine.token))[10] as string
    const second = await t.booked(t.mine, 12)
    t.harness.deps.clock.advance('9000h')
    const started = await t.move(second.manageToken, to)
    expect(started.status).toBe(409)
    expect(await codeOf(started)).toBe('booking.already_started')
    const t2 = await setup()
    const m2 = await t2.booked()
    await t2.cancel(m2.manageToken)
    const res = await t2.move(m2.manageToken, (await t2.slotsOf(t2.mine.token))[10] as string)
    expect(res.status).toBe(409)
    expect(await codeOf(res)).toBe('booking.not_active')
    expect(made.id).not.toBe(second.id)
  })

  test('managed slots list free times; a cancelled Booking is not_active', async () => {
    const t = await setup()
    const made = await t.booked()
    const url = `${t.url(made.manageToken, '/slots')}?from=2026-01-01T00:00:00.000Z&to=2026-01-08T00:00:00.000Z`
    const res = await t.harness.app.request(url)
    expect(res.status).toBe(200)
    const page = (await res.json()) as Slots & { bookingType: { name: string } }
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.bookingType.name).toBe('Intro')
    await t.cancel(made.manageToken)
    const after = await t.harness.app.request(url)
    expect(after.status).toBe(409)
    expect(await codeOf(after)).toBe('booking.not_active')
  })

  test('the rate limit answers 429 with Retry-After', async () => {
    const t = await setup()
    let last = new Response()
    for (let i = 0; i <= BOOKING_ADDRESS_LIMIT; i++) {
      last = await t.get('A'.repeat(43))
    }
    expect(last.status).toBe(429)
    expect(await codeOf(last)).toBe('rate.limited')
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('the manage token never reaches a log line or an error report', async () => {
    const t = await setup()
    const made = await t.booked()
    const store = t.harness.deps.store
    const lookup = store.bookingForManageToken.bind(store)
    store.bookingForManageToken = async () => {
      throw new Error('store down')
    }
    expect((await t.get(made.manageToken)).status).toBe(500)
    store.bookingForManageToken = lookup
    const seen = JSON.stringify([t.harness.deps.logLines, t.harness.deps.reported])
    expect(seen).not.toContain(made.manageToken)
    expect(t.harness.deps.reported).toHaveLength(1)
    expect(seen).toContain('/v1/public/bookings/manage/:token')
  })

  test('redactedPath hides the manage token on every manage path', () => {
    for (const tail of ['', '/slots', '/cancel', '/reschedule']) {
      expect(redactedPath(`/v1/public/bookings/manage/secret${tail}`)).toBe(
        `/v1/public/bookings/manage/:token${tail}`
      )
    }
  })
})

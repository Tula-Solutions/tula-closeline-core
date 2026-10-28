import { afterAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { type ConsentWordingId, consentWordingSchema, formatId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { consentWordings, contactConsentEvents, organizations } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import * as Bookings from '~/modules/booking/service'
import { bookingWorld } from '~/modules/booking-public/fixtures'
import { hashLinkToken } from '~/modules/booking-type/schema'
import { LastOwnerError } from '~/ports/core-store'
import {
  describeAbandon,
  describeAgentInstructions,
  describeBookingStore,
  describeCalendarConnections,
  describeConsentForms,
  describeConsentLedger,
  describeCoreStore,
  describeCrmConnections,
  describeIdempotencyKeys,
  describeInvitationsAndTeams,
  describeOutbox,
} from '~/ports/core-store.behaviour'
import { createTestApp, publicCaller, seedOrganization, TEST_BOOKING_LINK_KEY } from '~/testing'
import { createPostgresCoreStore } from './core-store'
import { createPostgresOutboxStore } from './outbox-store'
import { postgresErrorOf } from './retry'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresCoreStore(db)
// A second connection pool, so a test can ask for a lock while the first holds one.
const other = createDb(integrationUrls().service)

afterAll(async () => {
  await close()
  await other.close()
})

describeCoreStore('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeOutbox('postgres', async () => ({
  store,
  outbox: createPostgresOutboxStore(db),
  advance: (ms) => Bun.sleep(ms),
}))

describeAgentInstructions('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeBookingStore('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeCalendarConnections('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeCrmConnections('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeConsentLedger('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
  seedConsent: (organizationId, prospectId, channel, kind) =>
    withOrganization(db, organizationId, async (tx) => {
      const wordingId = formatId('cwd', crypto.randomUUID())
      await tx.insert(consentWordings).values({
        id: wordingId,
        organizationId,
        version: 1,
        text: `I agree ${wordingId}`,
        channels: ['phone', 'sms', 'whatsapp', 'email', 'linkedin'],
        supersedesId: null,
        createdByUserId: formatId('usr', crypto.randomUUID()),
      })
      await tx.insert(contactConsentEvents).values({
        id: formatId('cev', crypto.randomUUID()),
        organizationId,
        prospectId,
        channel,
        kind,
        source: 'manual',
        wordingId: kind === 'granted' ? wordingId : null,
        evidenceRef: kind === 'granted' ? 'test' : null,
        occurredAt: new Date(),
      })
    }),
  seedWording: (organizationId, channels) =>
    withOrganization(db, organizationId, async (tx) => {
      const id = formatId('cwd', crypto.randomUUID()) as ConsentWordingId
      await tx.insert(consentWordings).values({
        id,
        organizationId,
        version: 1,
        text: `I agree ${id}`,
        channels,
        supersedesId: null,
        createdByUserId: formatId('usr', crypto.randomUUID()),
      })
      return id
    }),
}))

describeConsentForms('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeInvitationsAndTeams('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeAbandon('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeIdempotencyKeys('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describe('CoreStore: postgres, the consent wording lock trigger', () => {
  test('an update that skips the store pre-check is refused by the database with 23001', async () => {
    const seeded = await seedOrganization(store)
    const wordingId = formatId('cwd', crypto.randomUUID())
    const formId = formatId('cfm', crypto.randomUUID())
    const now = new Date()
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertConsentWording({
        id: wordingId,
        version: 1,
        text: 'I agree.',
        channels: ['email'],
        supersedesId: null,
        createdByUserId: seeded.owner.userId,
        now,
      })
      await scope.insertConsentForm({
        id: formId,
        wordingId,
        name: 'Form',
        channels: ['email'],
        createdByUserId: seeded.owner.userId,
        now,
      })
      await scope.publishConsentForm(formId, {
        token: crypto.randomUUID().replaceAll('-', '').padEnd(43, 'Z'),
        now,
      })
    })

    const code = await failureCode(
      withOrganization(db, seeded.organizationId, (tx) =>
        tx.update(consentWordings).set({ text: 'Sneaky' }).where(eq(consentWordings.id, wordingId))
      )
    )
    expect(code).toBe('23001')
  })
})

describe('CoreStore: postgres, Booking Type names', () => {
  test('a taken name, on create and on rename, answers 409 request.conflict, never 500', async () => {
    const seeded = await seedOrganization(store)
    const call = publicCaller(await createTestApp({ store }))
    const make = (name: string) =>
      call(seeded.owner, seeded.organizationId, 'POST', '/booking-types', {
        name,
        lengthMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        mode: 'phone',
      })
    expect((await make('Demo')).status).toBe(201)
    const dup = await make('DEMO')
    expect(dup.status).toBe(409)
    expect(dup.body.error?.code).toBe('request.conflict')
    const other = await make('Other')
    const rename = await call(
      seeded.owner,
      seeded.organizationId,
      'PATCH',
      `/booking-types/${(other.body as { id: string }).id}`,
      { name: 'demo' }
    )
    expect(rename.status).toBe(409)
    expect(rename.body.error?.code).toBe('request.conflict')
  })
})

describe('CoreStore: postgres, public booking', () => {
  test('stores origin public, and a concurrent book of one time leaves two Bookings, one per Rep, and one refusal', async () => {
    const harness = await createTestApp({ store, clockStart: new Date().toISOString() })
    const mine = await bookingWorld(store, harness)
    const where = { organizationId: mine.org, bookingTypeId: mine.type.id as never }
    const from = new Date(harness.deps.clock.now().getTime() + 60_000)
    const to = new Date(from.getTime() + 7 * 86_400_000)
    const page = await Bookings.listPublicSlots(harness.deps, where, {
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 100,
    })
    const startsAt = page.items[0]?.startsAt as string
    const attempt = (key: string, email: string) =>
      Bookings.bookPublic(
        harness.deps,
        where,
        key,
        { name: 'Grace Hopper', email, startsAt, timeZone: 'UTC', website: '' },
        TEST_BOOKING_LINK_KEY
      )
    // Two Reps share the Team, so two bookings fit; the third attempt is refused.
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((n) => attempt(`public-race-key-${n}-0001`, `${n}@example.test`))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const stored = await store.withOrganization(mine.org, (s) => s.listBookings({ limit: 10 }))
    expect(stored).toHaveLength(2)
    expect(stored.every((b) => b.origin === 'public')).toBe(true)
  })
})

describe('CoreStore: postgres, manage token', () => {
  test('a public Booking stores the hash of its token, which finds it only while its Organization is active', async () => {
    const harness = await createTestApp({ store, clockStart: new Date().toISOString() })
    const mine = await bookingWorld(store, harness)
    const theirs = await bookingWorld(store, harness)
    const book = async (world: typeof mine) => {
      const where = { organizationId: world.org, bookingTypeId: world.type.id as never }
      const from = new Date(harness.deps.clock.now().getTime() + 60_000)
      const page = await Bookings.listPublicSlots(harness.deps, where, {
        from: from.toISOString(),
        to: new Date(from.getTime() + 7 * 86_400_000).toISOString(),
        limit: 100,
      })
      return Bookings.bookPublic(
        harness.deps,
        where,
        `manage-key-${world.org.slice(-8)}-0001`,
        {
          name: 'Grace Hopper',
          email: 'grace@example.test',
          startsAt: page.items[0]?.startsAt as string,
          timeZone: 'UTC',
          website: '',
        },
        TEST_BOOKING_LINK_KEY
      )
    }
    const one = await book(mine)
    const two = await book(theirs)
    const hash = (token: string) => hashLinkToken(token)
    expect(await store.bookingForManageToken(hash(one.body.manageToken))).toEqual({
      organizationId: mine.org,
      bookingId: one.body.id as never,
    })
    expect((await store.bookingForManageToken(hash(two.body.manageToken)))?.organizationId).toBe(
      theirs.org
    )
    const stored = await store.withOrganization(mine.org, (s) =>
      s.findBooking(one.body.id as never)
    )
    expect(stored?.manageTokenHash).toBe(hash(one.body.manageToken))
    expect(await store.bookingForManageToken(hash('A'.repeat(43)))).toBeNull()
    expect(await store.bookingForManageToken('not-a-hash')).toBeNull()
    await withOrganization(db, mine.org, async (tx) => {
      await tx
        .update(organizations)
        .set({ status: 'suspended' })
        .where(eq(organizations.organizationId, mine.org))
    })
    expect(await store.bookingForManageToken(hash(one.body.manageToken))).toBeNull()
  })
})

describe('CoreStore: postgres, Booking list order', () => {
  test('asc pages by (starts_at, id) forward with ties broken by id, and desc is its mirror', async () => {
    const harness = await createTestApp({ store, clockStart: new Date().toISOString() })
    const mine = await bookingWorld(store, harness)
    const theirs = await bookingWorld(store, harness)
    const where = { organizationId: mine.org, bookingTypeId: mine.type.id as never }
    const from = new Date(harness.deps.clock.now().getTime() + 60_000)
    const to = new Date(from.getTime() + 7 * 86_400_000)
    const slots = (
      await Bookings.listPublicSlots(harness.deps, where, {
        from: from.toISOString(),
        to: to.toISOString(),
        limit: 100,
      })
    ).items
    // Two Reps share the first start (a tie), then two later starts.
    const starts = [slots[0], slots[0], slots[10], slots[15]].map((s) => s?.startsAt as string)
    for (const [i, startsAt] of starts.entries()) {
      await Bookings.bookPublic(
        harness.deps,
        where,
        `order-key-${i}-000000001`,
        {
          name: 'Grace Hopper',
          email: `o${i}@example.test`,
          startsAt,
          timeZone: 'UTC',
          website: '',
        },
        TEST_BOOKING_LINK_KEY
      )
    }
    const walk = async (order: 'asc' | 'desc') => {
      const ids: string[] = []
      let after: { startsAt: Date; id: never } | undefined
      for (;;) {
        const rows = await store.withOrganization(mine.org, (s) =>
          s.listBookings({ limit: 2, order, ...(after ? { after } : {}) })
        )
        ids.push(...rows.map((r) => r.id))
        const last = rows.at(-1)
        if (rows.length < 2 || !last) {
          return ids
        }
        after = { startsAt: last.startsAt, id: last.id as never }
      }
    }
    const asc = await walk('asc')
    const all = await store.withOrganization(mine.org, (s) =>
      s.listBookings({ limit: 10, order: 'asc' })
    )
    expect(asc).toHaveLength(4)
    expect(asc).toEqual(all.map((r) => r.id))
    expect(all.map((r) => r.startsAt.getTime())).toEqual(
      all.map((r) => r.startsAt.getTime()).sort((a, b) => a - b)
    )
    expect((all[0]?.id as string) < (all[1]?.id as string)).toBe(true)
    expect(await walk('desc')).toEqual([...asc].reverse())
    // Another Organization still reads none of them.
    expect(
      await store.withOrganization(theirs.org, (s) => s.listBookings({ limit: 10, order: 'asc' }))
    ).toHaveLength(0)
  })
})

describe('CoreStore: postgres, public booking by link token', () => {
  test('the token opens its own Type: lists, books with origin public, and stays out of other Organizations', async () => {
    const harness = await createTestApp({ store, clockStart: new Date().toISOString() })
    const mine = await bookingWorld(store, harness)
    const theirs = await bookingWorld(store, harness)
    const range = () => {
      const from = new Date(harness.deps.clock.now().getTime() + 60_000)
      const to = new Date(from.getTime() + 7 * 86_400_000)
      return `from=${from.toISOString()}&to=${to.toISOString()}`
    }
    const slots = (token: string) =>
      harness.app.request(`/v1/public/booking-types/${token}/slots?${range()}`)
    const listed = await slots(mine.token)
    expect(listed.status).toBe(200)
    const page = (await listed.json()) as { items: { startsAt: string }[] }
    const startsAt = page.items[0]?.startsAt as string
    const book = (token: string) =>
      harness.app.request(`/v1/public/booking-types/${token}/bookings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          name: 'Grace Hopper',
          email: 'grace@example.test',
          startsAt,
          timeZone: 'UTC',
        }),
      })
    expect((await book(mine.token)).status).toBe(201)
    const own = await store.withOrganization(mine.org, (s) => s.listBookings({ limit: 10 }))
    expect(own).toHaveLength(1)
    expect(own[0]?.origin).toBe('public')
    expect(mine.reps.map((r) => r.id)).toContain(own[0]?.membershipId as never)
    const other = await store.withOrganization(theirs.org, (s) => s.listBookings({ limit: 10 }))
    expect(other).toHaveLength(0)

    const retired = await mine.call(mine.admin, 'POST', `/booking-types/${mine.type.id}/retire`)
    expect(retired.status).toBe(200)
    for (const res of [
      await slots(mine.token),
      await book(mine.token),
      await slots('z'.repeat(43)),
    ]) {
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'booking.type_not_found'
      )
    }
    expect((await slots(theirs.token)).status).toBe(200)
  })
})

describe('CoreStore: postgres, under concurrency', () => {
  test('two versions of one wording at once answer 201 and 409 request.conflict, never 500', async () => {
    const seeded = await seedOrganization(store)
    const harness = await createTestApp({ store })
    const call = publicCaller(harness)
    const made = await call(seeded.owner, seeded.organizationId, 'POST', '/consent-wordings', {
      text: 'We may email you.',
      channels: ['email'],
    })
    expect(made.status).toBe(201)
    const path = `/consent-wordings/${consentWordingSchema.parse(made.body).id}/versions`
    const results = await Promise.all(
      ['Version two.', 'Other two.'].map((text) =>
        call(seeded.owner, seeded.organizationId, 'POST', path, { text, channels: ['email'] })
      )
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(results.find((r) => r.status === 409)?.body.error?.code).toBe('request.conflict')
  })

  test('two Owners demoting each other at once leave one Owner and one refusal', async () => {
    const seeded = await seedOrganization(store, ['owner'])
    const [first, second] = seeded.members
    if (!first || !second) {
      throw new Error('seed made no pair of Owners')
    }
    const now = new Date()

    const results = await Promise.allSettled([
      store.withOrganization(seeded.organizationId, (s) => s.setRole(first.id, 'rep', now)),
      store.withOrganization(seeded.organizationId, (s) => s.setRole(second.id, 'rep', now)),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(LastOwnerError)
    const owners = await store.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    expect(owners.filter((m) => m.role === 'owner')).toHaveLength(1)
  })

  test('a failure other than a rule is thrown as it came, not as a rule error', async () => {
    const seeded = await seedOrganization(store)

    await expect(
      store.withOrganization(seeded.organizationId, (s) =>
        s.insertOrganization({ name: 'Again', region: 'us', now: new Date() })
      )
    ).rejects.not.toBeInstanceOf(LastOwnerError)
  })
})

/** The SQLSTATE of the failure of `attempt`, or `undefined` when it succeeded. */
async function failureCode(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt
    return undefined
  } catch (error) {
    return postgresErrorOf(error)?.code
  }
}

describe('CoreStore: postgres, the lock modes', () => {
  /** Asks, from another connection and without waiting, for a row lock of `mode` on one row. */
  const ask = (organizationId: string, table: string, key: string, id: string, mode: string) =>
    failureCode(
      withOrganization(other.db, organizationId as never, (tx) =>
        tx.execute(sql.raw(`select 1 from core.${table} where ${key} = '${id}' for ${mode} nowait`))
      )
    )

  test('lockOrganization holds the row FOR NO KEY UPDATE: it excludes writers and sharers, not the key-share check of a member write', async () => {
    const seeded = await seedOrganization(store, ['rep'])
    const org = seeded.organizationId
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      locked()
      await released
    })
    await holding

    try {
      const noKeyUpdate = await ask(org, 'organizations', 'organization_id', org, 'no key update')
      const share = await ask(org, 'organizations', 'organization_id', org, 'share')
      const keyShare = await ask(org, 'organizations', 'organization_id', org, 'key share')

      expect(noKeyUpdate).toBe('55P03')
      expect(share).toBe('55P03')
      expect(keyShare).toBeUndefined()
    } finally {
      release()
      await holder
    }
  })

  test('hasOtherOwner counts only this Organization’s other Owners', async () => {
    const seeded = await seedOrganization(store, ['admin'])
    const other = await seedOrganization(store, ['admin'])
    const admin = seeded.members[1]
    if (!admin) {
      throw new Error('seed made no member')
    }

    const alone = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.hasOtherOwner(seeded.owner.id)
    )
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.setRole(admin.id, 'owner', new Date())
    })
    const withSecond = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.hasOtherOwner(seeded.owner.id)
    )
    const otherAlone = await store.withOrganization(other.organizationId, (scope) =>
      scope.hasOtherOwner(other.owner.id)
    )

    expect([alone, withSecond, otherAlone]).toEqual([false, true, false])
  })

  test('lockMembership holds the row FOR UPDATE: even a key-share check waits', async () => {
    const seeded = await seedOrganization(store, ['rep'])
    const org = seeded.organizationId
    const rep = seeded.members[1]
    if (!rep) {
      throw new Error('seed made no member')
    }
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      await scope.lockMembership(rep.id)
      locked()
      await released
    })
    await holding

    try {
      const keyShare = await ask(org, 'memberships', 'id', rep.id, 'key share')
      const otherMember = await ask(org, 'memberships', 'id', seeded.owner.id, 'update')

      expect(keyShare).toBe('55P03')
      expect(otherMember).toBeUndefined()
    } finally {
      release()
      await holder
    }
  })
})

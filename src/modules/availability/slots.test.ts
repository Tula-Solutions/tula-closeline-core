import { describe, expect, test } from 'bun:test'
import {
  formatId,
  type MembershipId,
  type OrganizationId,
  organizationIdSchema,
} from 'tula-closeline-contract'
import { CalendarConnection } from 'tula-closeline-kit'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { refreshBusy } from '~/modules/calendar/refresh'
import { unpackSealed } from '~/modules/calendar/schema'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { computeSlots, type SlotInput, slots } from './slots'

const at = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()

/** A UTC Rep with one window, 30-minute slots, nothing busy, `now` long before. */
const base = (over: Partial<SlotInput> = {}): SlotInput => ({
  timeZone: 'UTC',
  windows: [{ day: 0, start: 9 * 60, end: 12 * 60 }],
  lengthMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minimumNoticeMinutes: 0,
  now: at('2026-02-20T00:00:00Z'),
  awayUntil: null,
  from: at('2026-03-02T00:00:00Z'),
  to: at('2026-03-03T00:00:00Z'),
  busy: [],
  limit: 100,
  ...over,
})
const starts = (input: SlotInput) => computeSlots(input).map((s) => iso(s.start))

describe('computeSlots', () => {
  test('steps by the length inside the window, in the Rep zone', () => {
    expect(starts(base({ windows: [{ day: 0, start: 540, end: 600 }] }))).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T09:30:00.000Z',
    ])
  })

  test('reads hours in the Rep zone across a DST change and a half-hour zone', () => {
    const window = [{ day: 0, start: 540, end: 570 }]
    const week = { from: at('2026-03-02T00:00:00Z'), to: at('2026-03-10T00:00:00Z') }
    expect(starts(base({ ...week, timeZone: 'America/New_York', windows: window }))).toEqual([
      '2026-03-02T14:00:00.000Z', // EST, UTC-5
      '2026-03-09T13:00:00.000Z', // EDT after 8 March
    ])
    expect(starts(base({ ...week, timeZone: 'Asia/Kolkata', windows: window }))).toEqual([
      '2026-03-02T03:30:00.000Z',
      '2026-03-09T03:30:00.000Z',
    ])
    // Monday morning in Auckland is still Sunday in UTC.
    expect(
      starts(
        base({
          ...week,
          from: at('2026-03-01T00:00:00Z'),
          timeZone: 'Pacific/Auckland',
          windows: window,
        })
      )[0]
    ).toBe('2026-03-01T20:00:00.000Z')
  })

  test('busy times and their buffers are never offered', () => {
    const busy = [{ start: at('2026-03-02T10:00:00Z'), end: at('2026-03-02T10:30:00Z') }]
    expect(starts(base({ busy }))).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T09:30:00.000Z',
      '2026-03-02T10:30:00.000Z',
      '2026-03-02T11:00:00.000Z',
      '2026-03-02T11:30:00.000Z',
    ])
    expect(starts(base({ busy, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }))).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T11:00:00.000Z',
      '2026-03-02T11:30:00.000Z',
    ])
  })

  test('notice and time away push the first slot later', () => {
    const now = at('2026-03-02T08:00:00Z')
    expect(starts(base({ now, minimumNoticeMinutes: 125 }))[0]).toBe('2026-03-02T10:30:00.000Z')
    expect(starts(base({ awayUntil: at('2026-03-02T11:00:00Z') }))[0]).toBe(
      '2026-03-02T11:00:00.000Z'
    )
  })

  test('overlapping windows never repeat a start, and the limit holds', () => {
    const windows = [
      { day: 0, start: 540, end: 660 },
      { day: 0, start: 600, end: 720 },
    ]
    const all = starts(base({ windows }))
    expect(new Set(all).size).toBe(all.length)
    expect(starts(base({ windows, limit: 2 }))).toHaveLength(2)
  })
})

describe('busy refresh and slots', () => {
  async function setup() {
    const memory = createMemoryCoreStore()
    const harness = await createTestApp({ store: memory, clockStart: '2026-03-01T00:00:00Z' })
    const seeded = await seedOrganization(memory, ['rep'])
    const other = await seedOrganization(memory, ['rep'])
    const rep = seeded.members[0] as SeededMember
    const api = publicCaller(harness)
    const connect = async (member: SeededMember, org: OrganizationId, code = 'code-1') => {
      harness.deps.memoryCalendar.allowGrant(code)
      const started = await api(member, org, 'POST', '/calendar-connection/start', {
        provider: 'google',
      })
      return api(member, org, 'POST', '/calendar-connection/complete', {
        state: (started.body as { state: string }).state,
        code,
      })
    }
    const vendorOf = async (org: OrganizationId, membershipId: MembershipId) => {
      const found = await memory.withOrganization(org, async (scope) => ({
        record: await scope.getCalendarConnection(membershipId),
        sealed: await scope.getCalendarSealedCredential(membershipId),
      }))
      const plain = JSON.parse(
        await harness.deps.secretBox.open(
          unpackSealed(found.sealed as Uint8Array) as NonNullable<ReturnType<typeof unpackSealed>>,
          {
            organizationId: org,
            connectionId: (found.record as { id: string }).id,
            purpose: 'calendar_credential',
          }
        )
      ) as { provider: string; connectionId: string; credential: string }
      return new CalendarConnection({ organizationId: org, ...plain })
    }
    const bookingTypeId = formatId('bkt', crypto.randomUUID())
    const prepare = async (org: OrganizationId, membershipId: MembershipId) => {
      await memory.withOrganization(org, async (scope) => {
        await scope.lockOrganization()
        await scope.insertBookingType({
          id: bookingTypeId,
          name: 'Intro',
          lengthMinutes: 30,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          minimumNoticeMinutes: 0,
          mode: 'video',
          publicTokenHash: null,
          now: harness.deps.clock.now(),
        })
        await scope.putWorkingHours(
          {
            membershipId,
            timeZone: 'UTC',
            windows: [{ day: 0, start: 9 * 60, end: 11 * 60 }],
            dailyCap: null,
            awayUntil: null,
          },
          harness.deps.clock.now()
        )
      })
    }
    const runJobs = async () => {
      const signal = new AbortController().signal
      do {
        await drainTestOutbox(harness.deps)
      } while ((await processAssignJobs(harness.deps, signal)) > 0)
    }
    const ask = (org: OrganizationId, membershipId: MembershipId) =>
      slots(harness.deps, org, {
        membershipId,
        bookingTypeId,
        from: new Date('2026-03-02T00:00:00Z'),
        to: new Date('2026-03-03T00:00:00Z'),
      })
    return {
      memory,
      harness,
      seeded,
      other,
      rep,
      connect,
      vendorOf,
      prepare,
      runJobs,
      ask,
      bookingTypeId,
    }
  }

  test('connecting queues a refresh; the Rep own busy time then never shows as a slot, with no calendar call', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    await t.prepare(org, t.rep.id)
    await t.connect(t.rep, org)
    const vendor = await t.vendorOf(org, t.rep.id)
    t.harness.deps.memoryCalendar.addBusy(vendor, {
      start: '2026-03-02T09:30:00.000Z',
      end: '2026-03-02T10:00:00.000Z',
    })
    await t.runJobs()
    const calls = t.harness.deps.memoryCalendar.requests().length
    const found = (await t.ask(org, t.rep.id)).map((s) => s.startsAt)
    expect(found).toEqual([
      '2026-03-02T09:00:00.000Z',
      '2026-03-02T10:00:00.000Z',
      '2026-03-02T10:30:00.000Z',
    ])
    expect(t.harness.deps.memoryCalendar.requests().length).toBe(calls)
  })

  test('no slots are offered past the days the busy times were loaded for', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    await t.prepare(org, t.rep.id)
    await t.connect(t.rep, org)
    await t.runJobs()
    const ask = (from: string, to: string) =>
      slots(t.harness.deps, org, {
        membershipId: t.rep.id,
        bookingTypeId: t.bookingTypeId,
        from: new Date(from),
        to: new Date(to),
      })
    // Clock is 2026-03-01; the loaded horizon ends 2026-03-15. Mondays: 03-09, 03-16, 03-23.
    const inside = await ask('2026-03-09T00:00:00Z', '2026-03-31T00:00:00Z')
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.every((x) => x.startsAt < '2026-03-15')).toBe(true)
    expect(await ask('2026-03-16T00:00:00Z', '2026-03-31T00:00:00Z')).toEqual([])
  })

  test('a repeated or duplicate refresh changes nothing, and a gone busy time is dropped', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    await t.prepare(org, t.rep.id)
    await t.connect(t.rep, org)
    await t.runJobs()
    await refreshBusy(t.harness.deps, org, t.rep.id)
    await refreshBusy(t.harness.deps, org, t.rep.id)
    expect(await t.ask(org, t.rep.id)).toHaveLength(4)
    const vendor = await t.vendorOf(org, t.rep.id)
    t.harness.deps.memoryCalendar.addBusy(vendor, {
      start: '2026-03-02T09:00:00.000Z',
      end: '2026-03-02T11:00:00.000Z',
    })
    await refreshBusy(t.harness.deps, org, t.rep.id)
    await refreshBusy(t.harness.deps, org, t.rep.id)
    expect(await t.ask(org, t.rep.id)).toHaveLength(0)
  })

  test('a grant revoked at the vendor marks the connection and keeps no new blocks', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    await t.connect(t.rep, org)
    t.harness.deps.memoryCalendar.revokeAtProvider(await t.vendorOf(org, t.rep.id))
    await refreshBusy(t.harness.deps, org, t.rep.id)
    const record = await t.memory.withOrganization(org, (s) => s.getCalendarConnection(t.rep.id))
    expect(record?.state).toBe('needs_reconnect')
  })

  test('another vendor failure is thrown so the queue delivers the job again', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    await t.connect(t.rep, org)
    t.harness.deps.memoryCalendar.failNext('calendar.rejected', 1)
    await expect(refreshBusy(t.harness.deps, org, t.rep.id)).rejects.toThrow()
  })

  test('busy times never cross Organizations, and disconnecting clears them', async () => {
    const t = await setup()
    const org = t.seeded.organizationId
    const otherOrg = organizationIdSchema.parse(t.other.organizationId)
    const outsider = t.other.members[0] as SeededMember
    await t.prepare(org, t.rep.id)
    await t.connect(t.rep, org)
    t.harness.deps.memoryCalendar.addBusy(await t.vendorOf(org, t.rep.id), {
      start: '2026-03-02T09:00:00.000Z',
      end: '2026-03-02T11:00:00.000Z',
    })
    await t.runJobs()
    const seen = await t.memory.withOrganization(otherOrg, (s) =>
      s.listBusyBlocks(t.rep.id, new Date(0), new Date(8.64e15))
    )
    expect(seen).toEqual([])
    expect(outsider.id).not.toBe(t.rep.id)
    const api = publicCaller(t.harness)
    await api(t.rep, org, 'DELETE', '/calendar-connection')
    expect(await t.ask(org, t.rep.id)).toHaveLength(4)
  })
})

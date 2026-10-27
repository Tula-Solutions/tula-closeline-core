import { describe, expect, test } from 'bun:test'
import {
  formatId,
  type MembershipId,
  type OrganizationId,
  type Role,
} from 'tula-closeline-contract'
import { CalendarConnection } from 'tula-closeline-kit'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createUnconfiguredSecretBox } from '~/adapters/unconfigured/secret-box'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { unpackSealed } from './schema'

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory, ...overrides })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(memory, ['rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    member: SeededMember,
    method: string,
    path: string,
    body?: unknown,
    organizationId: OrganizationId = seeded.organizationId
  ) => api(member, organizationId, method, path, body)
  /** Runs start and complete the way the portal does, with a code the vendor accepts. */
  const connect = async (member: SeededMember, code = 'code-1') => {
    harness.deps.memoryCalendar.allowGrant(code)
    const started = await call(member, 'POST', '/calendar-connection/start', { provider: 'google' })
    const done = await call(member, 'POST', '/calendar-connection/complete', {
      state: (started.body as { state: string }).state,
      code,
    })
    return { started, done }
  }
  const sealedOf = (organizationId: OrganizationId, membershipId: MembershipId) =>
    memory.withOrganization(organizationId, (scope) =>
      scope.getCalendarSealedCredential(membershipId)
    )
  return { harness, memory, seeded, other, byRole, call, connect, sealedOf }
}

describe('calendar connection routes', () => {
  test('every role connects, reads and disconnects its own calendar', async () => {
    const t = await setup()
    for (const member of t.seeded.members) {
      const { started, done } = await t.connect(member, `code-${member.role}`)
      expect(started.status).toBe(200)
      expect((started.body as { authorizationUrl: string }).authorizationUrl).toContain(
        'accounts.google.com'
      )
      expect(done.status).toBe(200)
      const read = await t.call(member, 'GET', '/calendar-connection')
      expect(read.status).toBe(200)
      expect(read.body).toMatchObject({ provider: 'google', state: 'healthy' })
      expect((await t.call(member, 'DELETE', '/calendar-connection')).status).toBe(204)
      const gone = await t.call(member, 'GET', '/calendar-connection')
      expect(gone.status).toBe(404)
      expect(gone.body).toMatchObject({ error: { code: 'calendar.not_connected' } })
    }
  })

  test('disconnecting with nothing connected still answers 204', async () => {
    const t = await setup()
    expect((await t.call(t.byRole('rep'), 'DELETE', '/calendar-connection')).status).toBe(204)
  })

  test('the credential is stored sealed and never appears in a response', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const { started, done } = await t.connect(rep, 'secret-grant-code')
    const read = await t.call(rep, 'GET', '/calendar-connection')
    const all = JSON.stringify([started.body, done.body, read.body])
    expect(all).not.toContain('secret-grant-code')
    expect(all).not.toContain('credential')
    const membershipId = (done.body as { membershipId: MembershipId }).membershipId
    const bytes = await t.sealedOf(t.seeded.organizationId, membershipId)
    expect(bytes).not.toBeNull()
    const text = Buffer.from(bytes as Uint8Array).toString('utf8')
    expect(text).not.toContain('secret-grant-code')
    expect(text).not.toContain('"credential"')
    expect(unpackSealed(bytes as Uint8Array)).not.toBeNull()
  })

  test('a grant revoked at the vendor reads as needs_reconnect', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const { done } = await t.connect(rep)
    const membershipId = (done.body as { membershipId: MembershipId }).membershipId
    const sealed = unpackSealed(
      (await t.sealedOf(t.seeded.organizationId, membershipId)) as Uint8Array
    )
    const plain = JSON.parse(
      await t.harness.deps.secretBox.open(sealed as NonNullable<typeof sealed>, {
        organizationId: t.seeded.organizationId,
        connectionId: await t.memory
          .withOrganization(t.seeded.organizationId, (s) => s.getCalendarConnection(membershipId))
          .then((r) => (r as { id: string }).id),
        purpose: 'calendar_credential',
      })
    ) as { provider: string; connectionId: string; credential: string }
    t.harness.deps.memoryCalendar.revokeAtProvider(
      new CalendarConnection({ organizationId: t.seeded.organizationId, ...plain })
    )
    t.harness.deps.clock.advance('16m')
    const read = await t.call(rep, 'GET', '/calendar-connection')
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ state: 'needs_reconnect' })
    const again = await t.call(rep, 'GET', '/calendar-connection')
    expect(again.body).toMatchObject({ state: 'needs_reconnect' })
  })

  test('a Rep reads only their own connection, and another Organization sees none', async () => {
    const t = await setup()
    await t.connect(t.byRole('rep'))
    expect((await t.call(t.byRole('manager'), 'GET', '/calendar-connection')).status).toBe(404)
    const outsider = t.other.members[0] as SeededMember
    const res = await t.call(
      outsider,
      'GET',
      '/calendar-connection',
      undefined,
      t.other.organizationId
    )
    expect(res.status).toBe(404)
  })

  test('a bad, expired or other-Rep state is calendar.authorization_failed', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    t.harness.deps.memoryCalendar.allowGrant('code-x')
    const started = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    const state = (started.body as { state: string }).state
    const complete = (member: SeededMember, s: string) =>
      t.call(member, 'POST', '/calendar-connection/complete', { state: s, code: 'code-x' })
    for (const res of [
      await complete(rep, 'not-a-state'),
      await complete(t.byRole('manager'), state),
    ]) {
      expect(res.status).toBe(422)
      expect(res.body).toMatchObject({ error: { code: 'calendar.authorization_failed' } })
    }
    t.harness.deps.clock.advance('11m')
    const expired = await complete(rep, state)
    expect(expired.status).toBe(422)
    expect(expired.body).toMatchObject({ error: { code: 'calendar.authorization_failed' } })
  })

  test('a code the vendor refuses is calendar.authorization_failed', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const started = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    const res = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state: (started.body as { state: string }).state,
      code: 'never-allowed',
    })
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: { code: 'calendar.authorization_failed' } })
  })

  test('without a sealing key the routes answer 503', async () => {
    const t = await setup({ secretBox: createUnconfiguredSecretBox() })
    const res = await t.call(t.byRole('rep'), 'POST', '/calendar-connection/start', {
      provider: 'google',
    })
    expect(res.status).toBe(503)
  })

  test('a stored credential that cannot be opened leaves the state alone instead of failing', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    await t.connect(rep)
    const own = (await t.memory.withOrganization(t.seeded.organizationId, (s) =>
      s.getMembershipByUser(rep.userId)
    )) as { id: MembershipId }
    await t.memory.withOrganization(t.seeded.organizationId, async (s) => {
      await s.lockOrganization()
      await s.upsertCalendarConnection({
        id: formatId('cal', crypto.randomUUID()),
        membershipId: own.id,
        provider: 'google',
        credentialSealed: new Uint8Array([3, 1, 2, 3, 4]),
        now: new Date(),
      })
    })
    t.harness.deps.clock.advance('16m')
    const read = await t.call(rep, 'GET', '/calendar-connection')
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ state: 'healthy' })
  })

  test('two reads in a row make at most one vendor call', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    await t.connect(rep)
    const calls = () => t.harness.deps.memoryCalendar.requests().length
    const before = calls()
    await t.call(rep, 'GET', '/calendar-connection')
    await t.call(rep, 'GET', '/calendar-connection')
    expect(calls() - before).toBe(0)
    t.harness.deps.clock.advance('16m')
    const mid = calls()
    await t.call(rep, 'GET', '/calendar-connection')
    expect(calls() - mid).toBe(1)
  })

  test('completing again with the same state answers the existing connection, once at the vendor', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    t.harness.deps.memoryCalendar.allowGrant('code-1')
    const started = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    const state = (started.body as { state: string }).state
    const first = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state,
      code: 'code-1',
    })
    const calls = t.harness.deps.memoryCalendar.requests().length
    const retry = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state,
      code: 'code-1',
    })
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual(first.body)
    expect(t.harness.deps.memoryCalendar.requests().length).toBe(calls)
    // A different state is still refused with a code the vendor does not know.
    const other = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    const refused = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state: (other.body as { state: string }).state,
      code: 'unknown',
    })
    expect(refused.status).toBe(422)
  })

  test('a vendor that cannot be reached is booking.calendar_unavailable (503)', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    const started = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    t.harness.deps.memoryCalendar.allowGrant('code-1')
    t.harness.deps.memoryCalendar.failNext('calendar.unavailable', 20)
    const res = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state: (started.body as { state: string }).state,
      code: 'code-1',
    })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: { code: 'booking.calendar_unavailable' } })
  })

  test('with no calendar configured every route that needs one answers 503', async () => {
    const t = await setup({ calendar: null })
    const rep = t.byRole('rep')
    const started = await t.call(rep, 'POST', '/calendar-connection/start', { provider: 'google' })
    expect(started.status).toBe(503)
    const done = await t.call(rep, 'POST', '/calendar-connection/complete', {
      state: 'x',
      code: 'y',
    })
    expect(done.status).toBe(503)
  })

  test('a failing vendor is asked once per interval, not on every read', async () => {
    const t = await setup()
    const rep = t.byRole('rep')
    await t.connect(rep)
    t.harness.deps.clock.advance('16m')
    t.harness.deps.memoryCalendar.failNext('calendar.unavailable', 50)
    const calls = () => t.harness.deps.memoryCalendar.requests().length
    const before = calls()
    const first = await t.call(rep, 'GET', '/calendar-connection')
    const mid = calls()
    await t.call(rep, 'GET', '/calendar-connection')
    expect(first.body).toMatchObject({ state: 'healthy' })
    expect(mid).toBeGreaterThan(before)
    expect(calls()).toBe(mid)
  })
})

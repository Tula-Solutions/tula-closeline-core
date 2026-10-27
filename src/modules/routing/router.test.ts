import { describe, expect, test } from 'bun:test'
import { formatId, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { seedTeam } from './fixtures'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, [
    'admin',
    'manager',
    'manager',
    'rep',
    'rep',
    'rep',
    'rep',
    'rep',
  ])
  const other = await seedOrganization(memory, ['admin', 'rep'])
  const all = (role: Role) => seeded.members.filter((m) => m.role === role) as SeededMember[]
  const [mine, theirs] = all('manager') as [SeededMember, SeededMember]
  const [r1, r2, r3, r4, r5] = all('rep') as [
    SeededMember,
    SeededMember,
    SeededMember,
    SeededMember,
    SeededMember,
  ]
  const admin = all('admin')[0] as SeededMember
  const api = publicCaller(harness)
  const call = (
    member: SeededMember,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => api(member, seeded.organizationId, method, path, body, headers)
  // Team A: manager `mine` with r1, r2. Team B: manager `theirs` with r3.
  const teamA = await seedTeam(memory, seeded.organizationId, [mine.id, r1.id, r2.id])
  const teamB = await seedTeam(memory, seeded.organizationId, [theirs.id, r3.id])
  const teamC = await seedTeam(memory, seeded.organizationId, [r4.id, r5.id], { dailyCap: 1 })
  return {
    memory,
    r4,
    r5,
    teamC,
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
    teamB,
    call,
    api,
  }
}

const rule = (name: string, target: unknown, conditions: Record<string, unknown> = {}) => ({
  name,
  target,
  conditions,
  isDefault: Object.keys(conditions).length === 0,
})

type Rule = { id: string; position: number; isDefault: boolean; name: string }
type Result = {
  decisionId: string | null
  matchedRuleId: string | null
  candidates: { membershipId: string; reason: string }[]
  skipped: { membershipId: string; reason: string }[]
}

describe('Routing Rule routes', () => {
  test('rules are ordered; the default rule stays last and a second default is refused', async () => {
    const t = await setup()
    const team = { kind: 'team', teamId: t.teamA }
    const dflt = await t.call(t.admin, 'POST', '/routing-rules', rule('Default', team))
    expect(dflt.status).toBe(201)
    const one = (
      await t.call(t.admin, 'POST', '/routing-rules', rule('UK', team, { countries: ['GB'] }))
    ).body as Rule
    const two = (
      await t.call(t.admin, 'POST', '/routing-rules', rule('US', team, { countries: ['US'] }))
    ).body as Rule
    const list = (await t.call(t.admin, 'GET', '/routing-rules')).body as { items: Rule[] }
    expect(list.items.map((r) => r.name)).toEqual(['UK', 'US', 'Default'])
    expect(list.items.map((r) => r.position)).toEqual([1, 2, 3])
    expect(list.items[2]?.isDefault).toBe(true)

    const second = await t.call(t.admin, 'POST', '/routing-rules', rule('Default 2', team))
    expect(second.status).toBe(422)
    expect(second.body).toMatchObject({ error: { code: 'routing.rule_invalid' } })

    const defaultId = (dflt.body as Rule).id
    const swapped = await t.call(t.admin, 'POST', '/routing-rules/reorder', {
      ruleIds: [two.id, one.id, defaultId],
    })
    expect(swapped.status).toBe(200)
    expect((swapped.body as { items: Rule[] }).items.map((r) => r.name)).toEqual([
      'US',
      'UK',
      'Default',
    ])
    for (const ruleIds of [
      [defaultId, one.id, two.id],
      [one.id, defaultId],
      [one.id, two.id, formatId('rrl', crypto.randomUUID())],
    ]) {
      const bad = await t.call(t.admin, 'POST', '/routing-rules/reorder', { ruleIds })
      expect(bad.status).toBe(422)
      expect(bad.body).toMatchObject({ error: { code: 'routing.rule_invalid' } })
    }
  })

  test('update keeps the position; delete renumbers and is idempotent', async () => {
    const t = await setup()
    const team = { kind: 'team', teamId: t.teamA }
    const a = (
      await t.call(t.admin, 'POST', '/routing-rules', rule('A', team, { countries: ['GB'] }))
    ).body as Rule
    const b = (
      await t.call(t.admin, 'POST', '/routing-rules', rule('B', team, { countries: ['US'] }))
    ).body as Rule
    const put = await t.call(
      t.admin,
      'PUT',
      `/routing-rules/${a.id}`,
      rule('A2', team, { countries: ['FR'] })
    )
    expect(put.body).toMatchObject({ name: 'A2', position: 1 })
    expect((await t.call(t.admin, 'DELETE', `/routing-rules/${a.id}`)).status).toBe(204)
    expect((await t.call(t.admin, 'DELETE', `/routing-rules/${a.id}`)).status).toBe(204)
    expect((await t.call(t.admin, 'GET', `/routing-rules/${b.id}`)).body).toMatchObject({
      position: 1,
    })
    expect((await t.call(t.admin, 'GET', `/routing-rules/${a.id}`)).status).toBe(404)
  })

  test('an Idempotency-Key replays the first create', async () => {
    const t = await setup()
    const body = rule('UK', { kind: 'team', teamId: t.teamA }, { countries: ['GB'] })
    const headers = { 'idempotency-key': 'key-routing-0001' }
    const first = await t.call(t.admin, 'POST', '/routing-rules', body, headers)
    const again = await t.call(t.admin, 'POST', '/routing-rules', body, headers)
    expect([first.status, again.status]).toEqual([201, 200])
    expect(again.body).toEqual(first.body)
    expect(
      ((await t.call(t.admin, 'GET', '/routing-rules')).body as { items: Rule[] }).items
    ).toHaveLength(1)
  })

  test('a rule naming a missing Team, a non-Rep, or a missing Booking Type is invalid', async () => {
    const t = await setup()
    for (const body of [
      rule('x', { kind: 'team', teamId: formatId('team', crypto.randomUUID()) }),
      rule('x', { kind: 'rep', membershipId: t.mine.id }),
      rule('x', { kind: 'rep', membershipId: t.other.members[1]?.id }),
      rule(
        'x',
        { kind: 'team', teamId: t.teamA },
        { bookingTypeIds: [formatId('bkt', crypto.randomUUID())] }
      ),
    ]) {
      const res = await t.call(t.admin, 'POST', '/routing-rules', body)
      expect(res.status).toBe(422)
      expect(res.body).toMatchObject({ error: { code: 'routing.rule_invalid' } })
    }
  })

  test('a Manager changes only rules on their own Team; another Team looks absent', async () => {
    const t = await setup()
    const own = await t.call(
      t.mine,
      'POST',
      '/routing-rules',
      rule('Mine', { kind: 'team', teamId: t.teamA }, { countries: ['GB'] })
    )
    expect(own.status).toBe(201)
    const foreign = await t.call(
      t.mine,
      'POST',
      '/routing-rules',
      rule('Theirs', { kind: 'team', teamId: t.teamB }, { countries: ['US'] })
    )
    expect(foreign.status).toBe(404)
    expect(foreign.body).toMatchObject({ error: { code: 'routing.rule_not_found' } })

    const theirRule = (
      await t.call(
        t.admin,
        'POST',
        '/routing-rules',
        rule('B team', { kind: 'team', teamId: t.teamB }, { countries: ['FR'] })
      )
    ).body as Rule
    // A Manager sees every rule, but cannot change, retarget onto, or delete another Team's.
    expect((await t.call(t.mine, 'GET', `/routing-rules/${theirRule.id}`)).status).toBe(200)
    for (const [method, body] of [
      ['PUT', rule('z', { kind: 'team', teamId: t.teamA })],
      ['DELETE', undefined],
    ] as const) {
      const res = await t.call(t.mine, method, `/routing-rules/${theirRule.id}`, body)
      expect(res.status).toBe(404)
      expect(res.body).toMatchObject({ error: { code: 'routing.rule_not_found' } })
    }
    const retarget = await t.call(
      t.mine,
      'PUT',
      `/routing-rules/${(own.body as Rule).id}`,
      rule('Mine', { kind: 'team', teamId: t.teamB }, { countries: ['GB'] })
    )
    expect(retarget.status).toBe(404)
    const reorder = await t.call(t.mine, 'POST', '/routing-rules/reorder', {
      ruleIds: [(own.body as Rule).id, theirRule.id],
    })
    expect(reorder.status).toBe(403)
    expect((await t.call(t.r1, 'GET', '/routing-rules')).status).toBe(403)
  })

  test('lists are paged by cursor and Organization B sees none of A', async () => {
    const t = await setup()
    const team = { kind: 'team', teamId: t.teamA }
    for (const country of ['GB', 'US', 'FR']) {
      await t.call(t.admin, 'POST', '/routing-rules', rule(country, team, { countries: [country] }))
    }
    const first = (await t.call(t.admin, 'GET', '/routing-rules?limit=2')).body as {
      items: Rule[]
      nextCursor: string
    }
    expect(first.items.map((r) => r.name)).toEqual(['GB', 'US'])
    const next = (await t.call(t.admin, 'GET', `/routing-rules?limit=2&cursor=${first.nextCursor}`))
      .body as { items: Rule[]; nextCursor: string | null }
    expect(next.items.map((r) => r.name)).toEqual(['FR'])
    expect(next.nextCursor).toBeNull()
    expect((await t.call(t.admin, 'GET', '/routing-rules?cursor=garbage')).status).toBe(400)

    const otherAdmin = t.other.members[1] as SeededMember
    const theirs = await t.api(otherAdmin, t.other.organizationId, 'GET', '/routing-rules')
    expect((theirs.body as { items: Rule[] }).items).toEqual([])
    const id = first.items[0]?.id
    expect(
      (await t.api(otherAdmin, t.other.organizationId, 'GET', `/routing-rules/${id}`)).status
    ).toBe(404)
  })
})

describe('routing', () => {
  const prospect = async (t: Awaited<ReturnType<typeof setup>>) =>
    (
      (
        await t.call(t.admin, 'POST', '/prospects', {
          firstName: 'Ada',
          lastName: 'L',
          email: 'ada@example.test',
        })
      ).body as { id: string }
    ).id

  test('a matched rule orders the Team round-robin and stores the decision', async () => {
    const t = await setup()
    const made = (
      await t.call(
        t.admin,
        'POST',
        '/routing-rules',
        rule('Any', { kind: 'team', teamId: t.teamA })
      )
    ).body as Rule
    const id = await prospect(t)
    const picks: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const res = await t.call(t.admin, 'POST', '/routing/route', { prospectId: id })
      expect(res.status).toBe(200)
      const body = res.body as Result
      expect(body.matchedRuleId).toBe(made.id)
      expect(body.decisionId).toMatch(/^rdc_/)
      expect(body.candidates.map((c) => c.reason)).toEqual(['default_rule', 'default_rule'])
      picks.push(body.candidates[0]?.membershipId as string)
    }
    // Two Reps alternate.
    expect(new Set(picks.slice(0, 2)).size).toBe(2)
    expect(picks[2]).toBe(picks[0] as string)
    expect(picks[3]).toBe(picks[1] as string)
    const decisions = await t.memory.withOrganization(t.seeded.organizationId, (s) =>
      s.listRoutingDecisions({ limit: 10 })
    )
    expect(decisions).toHaveLength(4)
    expect(decisions[0]).toMatchObject({ ruleId: made.id })
  })

  test('test stores nothing and does not advance the round-robin', async () => {
    const t = await setup()
    await t.call(
      t.admin,
      'POST',
      '/routing-rules',
      rule('UK', { kind: 'team', teamId: t.teamA }, { countries: ['GB'] })
    )
    const attributes = {
      country: 'GB',
      region: null,
      companySizeBand: null,
      accountOwnerMembershipId: null,
      source: null,
    }
    const a = (await t.call(t.mine, 'POST', '/routing-rules/test', { attributes })).body as Result
    const b = (await t.call(t.mine, 'POST', '/routing-rules/test', { attributes })).body as Result
    expect(a.decisionId).toBeNull()
    expect(b.candidates).toEqual(a.candidates)
    expect(a.candidates.map((c) => c.reason)).toEqual(['round_robin_team', 'round_robin_team'])
    const decisions = await t.memory.withOrganization(t.seeded.organizationId, (s) =>
      s.listRoutingDecisions({ limit: 10 })
    )
    expect(decisions).toEqual([])
    const noMatch = (
      await t.call(t.mine, 'POST', '/routing-rules/test', {
        attributes: { ...attributes, country: 'FR' },
      })
    ).body as Result
    expect(noMatch).toMatchObject({ matchedRuleId: null, candidates: [], skipped: [] })
    expect((await t.call(t.r1, 'POST', '/routing-rules/test', { attributes })).status).toBe(403)
  })

  test('skipped Reps carry a reason: on leave, off shift, no calendar, reconnect, daily cap', async () => {
    const t = await setup()
    const now = new Date('2026-01-01T00:00:00Z')
    const [onLeave, offShift, noCal, reconnect, capped] = [t.r1, t.r2, t.r3, t.r4, t.r5]
    await seedTeam(t.memory, t.seeded.organizationId, [
      onLeave.id,
      offShift.id,
      noCal.id,
      reconnect.id,
    ])
    await t.memory.withOrganization(t.seeded.organizationId, async (s) => {
      await s.lockOrganization()
      const hours = async (m: SeededMember) =>
        (await s.getWorkingHours(m.id)) as NonNullable<
          Awaited<ReturnType<typeof s.getWorkingHours>>
        >
      await s.putWorkingHours(
        { ...(await hours(onLeave)), awayUntil: new Date('2026-02-01T00:00:00Z') },
        now
      )
      await s.putWorkingHours({ ...(await hours(offShift)), windows: [] }, now)
      await s.deleteCalendarConnection(noCal.id)
      const connection = await s.getCalendarConnection(reconnect.id)
      await s.setCalendarConnectionState(reconnect.id, connection?.id ?? '', 'needs_reconnect', now)
    })
    t.memory.seedBooking({
      organizationId: t.seeded.organizationId,
      membershipId: capped.id,
      startsAt: new Date('2026-01-01T09:00:00Z'),
      status: 'confirmed',
    })
    const pool = [onLeave, offShift, noCal, capped].map((m) => m.id)
    await t.call(
      t.admin,
      'POST',
      '/routing-rules',
      rule('Pool', { kind: 'pool', membershipIds: [...pool, reconnect.id] }, { countries: ['GB'] })
    )
    const attributes = {
      country: 'GB',
      region: null,
      companySizeBand: null,
      accountOwnerMembershipId: null,
      source: null,
    }
    const res = (await t.call(t.admin, 'POST', '/routing-rules/test', { attributes }))
      .body as Result
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.membershipId, s.reason]))
    expect(reasons[onLeave.id]).toBe('on_leave')
    expect(reasons[offShift.id]).toBe('off_shift')
    expect(reasons[noCal.id]).toBe('calendar_not_connected')
    expect(reasons[reconnect.id]).toBe('needs_reconnect')
    expect(reasons[capped.id]).toBe('daily_cap_reached')
    expect(res.candidates).toEqual([])
  })

  test('route refuses a Prospect the caller cannot see, and another Organization is not routed to', async () => {
    const t = await setup()
    await t.call(t.admin, 'POST', '/routing-rules', rule('Any', { kind: 'team', teamId: t.teamA }))
    const missing = await t.call(t.admin, 'POST', '/routing/route', {
      prospectId: formatId('prs', crypto.randomUUID()),
    })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'prospect.not_found' } })
    const otherAdmin = t.other.members[1] as SeededMember
    const id = (
      (
        await t.api(otherAdmin, t.other.organizationId, 'POST', '/prospects', {
          firstName: 'B',
          lastName: 'B',
          email: 'b@example.test',
        })
      ).body as { id: string }
    ).id
    const res = (
      await t.api(otherAdmin, t.other.organizationId, 'POST', '/routing/route', { prospectId: id })
    ).body as Result
    expect(res).toMatchObject({ matchedRuleId: null, candidates: [], skipped: [] })
  })
})

import { describe, expect, test } from 'bun:test'
import { harness, store } from '~/integration-harness'
import { seedTeam } from '~/modules/routing/fixtures'
import { publicCaller, seedOrganization } from '~/testing'

type Result = { decisionId: string | null; candidates: { membershipId: string }[] }

describe('routing over Postgres', () => {
  test('100 concurrent routes spread across a Team within one of even; B never sees A', async () => {
    const h = await harness()
    const api = publicCaller(h)
    const org = await seedOrganization(store, ['admin', 'rep', 'rep', 'rep', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const admin = org.members[1]
    const reps = org.members.filter((m) => m.role === 'rep')
    if (!admin) {
      throw new Error('no admin seeded')
    }
    const teamId = await seedTeam(
      store,
      org.organizationId,
      reps.map((m) => m.id)
    )
    const made = await api(admin, org.organizationId, 'POST', '/routing-rules', {
      name: 'Everyone',
      conditions: {},
      isDefault: true,
      target: { kind: 'team', teamId },
    })
    expect(made.status).toBe(201)
    const prospect = await api(admin, org.organizationId, 'POST', '/prospects', {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
    })

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        api(admin, org.organizationId, 'POST', '/routing/route', { prospectId: prospect.body.id })
      )
    )
    expect(results.map((r) => r.status)).toEqual(Array(100).fill(200))
    const firsts = new Map<string, number>()
    for (const r of results) {
      const first = (r.body as unknown as Result).candidates[0]?.membershipId
      firsts.set(first ?? 'none', (firsts.get(first ?? 'none') ?? 0) + 1)
    }
    expect([...firsts.keys()].sort()).toEqual(reps.map((m) => m.id).sort())
    const counts = [...firsts.values()]
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)

    const stored = await store.withOrganization(org.organizationId, (s) =>
      s.listRoutingDecisions({ limit: 200 })
    )
    expect(stored).toHaveLength(100)

    const otherAdmin = other.members[1]
    if (!otherAdmin) {
      throw new Error('no admin seeded')
    }
    const theirProspect = await api(otherAdmin, other.organizationId, 'POST', '/prospects', {
      firstName: 'Bo',
      lastName: 'B',
      email: 'bo@example.test',
    })
    const theirs = await api(otherAdmin, other.organizationId, 'POST', '/routing/route', {
      prospectId: theirProspect.body.id,
    })
    expect(theirs.body).toMatchObject({ matchedRuleId: null, candidates: [], skipped: [] })
  })
})

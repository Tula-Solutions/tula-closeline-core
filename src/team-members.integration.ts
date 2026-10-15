import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  listTeamMembersResponseSchema,
  type MembershipId,
  membershipIdSchema,
  type OrganizationId,
  type TeamId,
  teamSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { teamMemberPageQuery } from '~/adapters/postgres/core-store'
import { harness, owner, service, store } from '~/integration-harness'
import { publicCaller, seedOrganization } from '~/testing'

/** Makes a Team and puts the given members in it, as the Organization's Owner over HTTP. */
async function teamWith(
  h: Awaited<ReturnType<typeof harness>>,
  org: Awaited<ReturnType<typeof seedOrganization>>,
  name: string,
  members: readonly MembershipId[]
) {
  const api = publicCaller(h)
  const made = await api(org.owner, org.organizationId, 'POST', '/teams', { name })
  const team = teamSchema.parse(made.body)
  for (const membershipId of members) {
    const added = await api(org.owner, org.organizationId, 'POST', `/teams/${team.id}/members`, {
      membershipId,
    })
    expect(added.status).toBe(200)
  }
  return team
}

describe("a Team's members, over Postgres", () => {
  test('lists only the Team, with the Organization list shape, and pages by cursor', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep'])
    const api = publicCaller(h)
    const [, admin, manager, rep1, rep2] = org.members
    const inTeam = [admin, manager, rep1].flatMap((m) => (m ? [m.id] : []))
    const team = await teamWith(h, org, 'Sales', inTeam)
    await teamWith(h, org, 'Support', rep2 ? [rep2.id] : [])

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`
      const page = await api(
        org.owner,
        org.organizationId,
        'GET',
        `/teams/${team.id}/members?${query}`
      )
      expect(page.status).toBe(200)
      const parsed = listTeamMembersResponseSchema.parse(page.body)
      seen.push(...parsed.items.map((item) => item.id))
      cursor = parsed.nextCursor
    } while (cursor !== null)

    expect(seen).toEqual([...inTeam].sort())
    const first = await api(org.owner, org.organizationId, 'GET', `/teams/${team.id}/members`)
    const item = listTeamMembersResponseSchema
      .parse(first.body)
      .items.find((entry) => entry.id === rep1?.id)
    expect(item).toMatchObject({ email: rep1?.email, role: 'rep', userId: rep1?.userId })
  })

  test('each role gets what the contract says, and a Rep is refused before the Team is looked up', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'manager', 'rep'])
    const api = publicCaller(h)
    const team = await teamWith(h, org, 'Sales', [])

    const answers = await Promise.all(
      org.members.map(async (m) => [
        m.role,
        (await api(m, org.organizationId, 'GET', `/teams/${team.id}/members`)).status,
      ])
    )
    const repOnMissing = await api(
      org.members[3] ?? org.owner,
      org.organizationId,
      'GET',
      `/teams/team_${'0'.repeat(32)}/members`
    )

    expect(Object.fromEntries(answers)).toEqual({ owner: 200, admin: 200, manager: 200, rep: 403 })
    expect(repOnMissing.body.error?.code).toBe('auth.forbidden')
  })

  test("another Organization's Team is team.not_found and none of its members appear", async () => {
    const h = await harness()
    const mine = await seedOrganization(store, [])
    const theirs = await seedOrganization(store, ['rep'])
    const theirRep = theirs.members[1]
    const theirTeam = await teamWith(h, theirs, 'Theirs', theirRep ? [theirRep.id] : [])
    const api = publicCaller(h)

    const crossed = await api(
      mine.owner,
      mine.organizationId,
      'GET',
      `/teams/${theirTeam.id}/members`
    )
    const missing = await api(
      mine.owner,
      mine.organizationId,
      'GET',
      `/teams/team_${'0'.repeat(32)}/members`
    )

    expect(crossed.status).toBe(404)
    expect(crossed.body.error?.code).toBe('team.not_found')
    expect(crossed).toEqual(missing)
    expect(JSON.stringify(crossed.body)).not.toContain(theirRep?.email ?? 'x')
  })

  test('a page is served by the Team primary key and the unique Membership key, whatever the size of other Teams', async () => {
    const h = await harness()
    const org = await seedOrganization(store, [])
    const team = await teamWith(h, org, 'Big', [])
    const other = await teamWith(h, org, 'Other', [])
    const organizationId: OrganizationId = org.organizationId
    await withOrganization(service.db, organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.memberships
          (id, organization_id, user_id, email, name, role, created_at, updated_at)
        select 'mem_' || md5(${organizationId} || g::text), ${organizationId},
               'usr_' || md5(${organizationId} || 'u' || g::text),
               'member' || g::text || '@example.test', null, 'rep', now(), now()
        from generate_series(1, 2000) g`)
      await tx.execute(sql`
        insert into core.team_members (organization_id, team_id, membership_id, created_at)
        select ${organizationId}, case when g % 2 = 0 then ${team.id} else ${other.id} end,
               'mem_' || md5(${organizationId} || g::text), now()
        from generate_series(1, 2000) g`)
    })
    await owner.db.execute(sql`analyze core.team_members`)
    await owner.db.execute(sql`analyze core.memberships`)

    const explained = await withOrganization(service.db, organizationId, async (tx) => {
      const afterId = membershipIdSchema.parse(`mem_${'0'.repeat(32)}`)
      const query = teamMemberPageQuery(tx, organizationId, team.id as TeamId, afterId, 101)
      const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql`explain (analyze, buffers, format json) ${query}`
      )
      return JSON.stringify(rows[0]?.['QUERY PLAN'])
    })

    expect(explained).toContain('team_members_pkey')
    expect(explained).toContain('memberships_organization_id_id_key')
    expect(explained).not.toContain('Seq Scan')
    expect(explained).not.toContain('"Node Type":"Sort"')
  })
})

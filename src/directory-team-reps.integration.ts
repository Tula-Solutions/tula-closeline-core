import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  internalDirectoryTeamRepsResponseSchema,
  MAX_DIRECTORY_TEAM_REPS,
  type OrganizationId,
  teamSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, service, store } from '~/integration-harness'
import { publicCaller, seedOrganization } from '~/testing'

describe('the directory team-reps lookup, over Postgres', () => {
  test('answers the Reps of a Manager across Teams, scoped to the Organization, and caps the list', async () => {
    const h = await harness()
    const api = publicCaller(h)
    const org = await seedOrganization(store, ['manager', 'rep', 'rep', 'rep'])
    const other = await seedOrganization(store, ['manager', 'rep'])
    const [, manager, rep1, rep2, rep3] = org.members
    if (!manager || !rep1 || !rep2 || !rep3) {
      throw new Error('seed')
    }
    const make = async (name: string) =>
      teamSchema.parse((await api(org.owner, org.organizationId, 'POST', '/teams', { name })).body)
    const put = async (teamId: string, ...ids: string[]) => {
      for (const membershipId of ids) {
        const added = await api(org.owner, org.organizationId, 'POST', `/teams/${teamId}/members`, {
          membershipId,
        })
        expect(added.status).toBe(200)
      }
    }
    const alpha = await make('Alpha')
    const beta = await make('Beta')
    await put(alpha.id, manager.id, rep1.id, rep2.id)
    await put(beta.id, manager.id, rep2.id, rep3.id)
    const ask = async (organizationId: OrganizationId, membershipId: string) => {
      const response = await h.app.request('/internal/v1/directory/team-reps', {
        method: 'POST',
        headers: h.internal(),
        body: JSON.stringify({ organizationId, membershipId }),
      })
      expect(response.status).toBe(200)
      return internalDirectoryTeamRepsResponseSchema.parse(await response.json()).membershipIds
    }

    expect(await ask(org.organizationId, manager.id)).toEqual([rep1.id, rep2.id, rep3.id].sort())
    expect(await ask(org.organizationId, rep1.id)).toEqual([])
    expect(await ask(org.organizationId, org.owner.id)).toEqual([])
    expect(await ask(other.organizationId, manager.id)).toEqual([])
    expect(await ask(other.organizationId, other.members[1]?.id ?? '')).toEqual([])

    const organizationId: OrganizationId = org.organizationId
    await withOrganization(service.db, organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.memberships
          (id, organization_id, user_id, email, name, role, created_at, updated_at)
        select 'mem_' || md5(${organizationId} || g::text), ${organizationId},
               'usr_' || md5(${organizationId} || 'u' || g::text),
               'bulk' || g::text || '@example.test', null, 'rep', now(), now()
        from generate_series(1, ${MAX_DIRECTORY_TEAM_REPS + 20}) g`)
      await tx.execute(sql`
        insert into core.team_members (organization_id, team_id, membership_id, created_at)
        select ${organizationId}, ${alpha.id}, 'mem_' || md5(${organizationId} || g::text), now()
        from generate_series(1, ${MAX_DIRECTORY_TEAM_REPS + 20}) g`)
    })
    const capped = await ask(org.organizationId, manager.id)
    expect(capped).toHaveLength(MAX_DIRECTORY_TEAM_REPS)
    expect([...capped].sort()).toEqual(capped)
  })
})

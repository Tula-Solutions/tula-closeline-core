import { describe, expect, test } from 'bun:test'
import {
  internalDirectoryMemberCheckResponseSchema,
  internalDirectoryRoleMembersResponseSchema,
  internalDirectoryTeamsOfResponseSchema,
  type OrganizationId,
  teamSchema,
} from 'tula-closeline-contract'
import { harness, store } from '~/integration-harness'
import { publicCaller, seedOrganization } from '~/testing'

describe('the directory member-check, role-members and teams-of lookups, over Postgres', () => {
  test('answer for the named Organization only', async () => {
    const h = await harness()
    const api = publicCaller(h)
    const org = await seedOrganization(store, ['manager', 'rep', 'rep'])
    const other = await seedOrganization(store, ['manager', 'rep'])
    const [, manager, rep1, rep2] = org.members
    if (!manager || !rep1 || !rep2) {
      throw new Error('seed')
    }
    const ask = async (path: string, body: object) => {
      const response = await h.app.request(`/internal/v1/directory/${path}`, {
        method: 'POST',
        headers: h.internal(),
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const memberOf = async (organizationId: OrganizationId, membershipId: string) =>
      internalDirectoryMemberCheckResponseSchema.parse(
        await ask('member-check', { organizationId, membershipId })
      ).isMember

    expect(await memberOf(org.organizationId, manager.id)).toBe(true)
    expect(await memberOf(org.organizationId, org.owner.id)).toBe(true)
    expect(await memberOf(other.organizationId, manager.id)).toBe(false)
    expect(await memberOf(org.organizationId, other.owner.id)).toBe(false)

    const reps = internalDirectoryRoleMembersResponseSchema.parse(
      await ask('role-members', { organizationId: org.organizationId, role: 'rep' })
    )
    expect(reps).toEqual({ membershipIds: [rep1.id, rep2.id].sort(), next: null })
    const elsewhere = internalDirectoryRoleMembersResponseSchema.parse(
      await ask('role-members', { organizationId: other.organizationId, role: 'rep' })
    )
    expect(elsewhere.membershipIds).not.toContain(rep1.id)
    expect(elsewhere.membershipIds).toHaveLength(1)

    const made = async (name: string) =>
      teamSchema.parse((await api(org.owner, org.organizationId, 'POST', '/teams', { name })).body)
    const alpha = await made('Alpha')
    const beta = await made('Beta')
    for (const team of [alpha, beta]) {
      const added = await api(org.owner, org.organizationId, 'POST', `/teams/${team.id}/members`, {
        membershipId: rep1.id,
      })
      expect(added.status).toBe(200)
    }
    const teamsOf = async (organizationId: OrganizationId, membershipId: string) =>
      internalDirectoryTeamsOfResponseSchema.parse(
        await ask('teams-of', { organizationId, membershipId })
      ).teamIds
    expect(await teamsOf(org.organizationId, rep1.id)).toEqual([alpha.id, beta.id].sort())
    expect(await teamsOf(org.organizationId, rep2.id)).toEqual([])
    expect(await teamsOf(other.organizationId, rep1.id)).toEqual([])
  })
})

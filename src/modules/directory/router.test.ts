import { describe, expect, test } from 'bun:test'
import {
  formatId,
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryTeamCheckResponseSchema,
  internalDirectoryTeamRepsResponseSchema,
  internalDirectoryTeamRingMembersResponseSchema,
  MAX_DIRECTORY_TEAM_REPS,
  MAX_DIRECTORY_TEAM_RING_MEMBERS,
  type Role,
  type TeamId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newMembershipId,
  newOrganizationId,
  newUserId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const first = await seedOrganization(memory, ['admin', 'manager', 'rep'], 'First')
  const second = await seedOrganization(memory, ['rep'], 'Second')
  const byRole = (role: Role) => first.members.find((m) => m.role === role) as SeededMember
  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = harness.internal()
  ) => {
    const response = await harness.app.request(`/internal/v1/directory/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const team = async (organization: typeof first, name: string) => {
    const made = await publicCaller(harness)(
      organization.owner,
      organization.organizationId,
      'POST',
      '/teams',
      { name }
    )
    return made.body.id as TeamId
  }
  const call = publicCaller(harness)
  return { ...harness, memory, first, second, byRole, post, team, call }
}

describe('POST /internal/v1/directory/membership', () => {
  test('answers the Membership, its role and the Organization status', async () => {
    const { post, first, byRole } = await setup()
    const manager = byRole('manager')

    const { status, body } = await post('membership', {
      organizationId: first.organizationId,
      userId: manager.userId,
    })

    expect(status).toBe(200)
    expect(internalDirectoryMembershipResponseSchema.parse(body)).toEqual({
      found: true,
      membershipId: manager.id,
      role: 'manager',
      organizationStatus: 'active',
    })
  })

  test('a user of another Organization, or of none, is found: false', async () => {
    const { post, first, second } = await setup()
    const other = second.owner

    const elsewhere = await post('membership', {
      organizationId: first.organizationId,
      userId: other.userId,
    })
    const nobody = await post('membership', {
      organizationId: first.organizationId,
      userId: newUserId(),
    })
    const noOrganization = await post('membership', {
      organizationId: newOrganizationId(),
      userId: first.owner.userId,
    })

    for (const answer of [elsewhere, nobody, noOrganization]) {
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ found: false })
    }
  })

  test('refuses a request with no token, a wrong token or a user token', async () => {
    const { post, app, bearer, first } = await setup()
    const body = { organizationId: first.organizationId, userId: first.owner.userId }

    const none = await post('membership', body, { 'content-type': 'application/json' })
    const wrong = await post('membership', body, {
      authorization: 'Bearer not-the-secret-0123456789abcdef-0123',
      'content-type': 'application/json',
    })
    const user = await app.request('/internal/v1/directory/membership', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await bearer({ ...first.owner, organizationId: first.organizationId, role: 'owner' })),
      },
      body: JSON.stringify(body),
    })

    expect(none.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(user.status).toBe(401)
  })

  test('a malformed body is request.invalid', async () => {
    const { post, first } = await setup()

    for (const bad of [
      {},
      { organizationId: first.organizationId },
      { organizationId: 'nope', userId: first.owner.userId },
      { organizationId: first.organizationId, userId: first.owner.userId, extra: 1 },
    ]) {
      const { status, body } = await post('membership', bad)
      expect(status).toBe(400)
      expect((body.error as { code: string }).code).toBe('request.invalid')
    }
  })
})

describe('POST /internal/v1/directory/rep-check', () => {
  test('is true only for a Rep of that Organization', async () => {
    const { post, first, byRole } = await setup()
    const ask = async (member: SeededMember) =>
      post('rep-check', { organizationId: first.organizationId, membershipId: member.id })

    const rep = await ask(byRole('rep'))
    expect(rep.status).toBe(200)
    expect(internalDirectoryRepCheckResponseSchema.parse(rep.body)).toEqual({ isRep: true })
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect((await ask(byRole(role))).body).toEqual({ isRep: false })
    }
  })

  test('a Rep of another Organization, or an unknown Membership, is false', async () => {
    const { post, first, second } = await setup()
    const foreignRep = second.members.find((m) => m.role === 'rep') as SeededMember

    const elsewhere = await post('rep-check', {
      organizationId: first.organizationId,
      membershipId: foreignRep.id,
    })
    const unknown = await post('rep-check', {
      organizationId: first.organizationId,
      membershipId: newMembershipId(),
    })

    expect(elsewhere.status).toBe(200)
    expect(elsewhere.body).toEqual({ isRep: false })
    expect(unknown.body).toEqual({ isRep: false })
  })

  test('refuses a missing or wrong token, and a malformed body is request.invalid', async () => {
    const { post, first, byRole } = await setup()
    const body = { organizationId: first.organizationId, membershipId: byRole('rep').id }

    expect((await post('rep-check', body, { 'content-type': 'application/json' })).status).toBe(401)
    expect(
      (
        await post('rep-check', body, {
          authorization: 'Bearer not-the-secret-0123456789abcdef-0123',
          'content-type': 'application/json',
        })
      ).status
    ).toBe(401)
    const bad = await post('rep-check', { organizationId: first.organizationId })
    expect(bad.status).toBe(400)
    expect((bad.body.error as { code: string }).code).toBe('request.invalid')
  })
})

describe('POST /internal/v1/directory/team-check', () => {
  test('is true for a Team of that Organization', async () => {
    const { post, first, team } = await setup()
    const teamId = await team(first, 'Closers')

    const { status, body } = await post('team-check', {
      organizationId: first.organizationId,
      teamId,
    })

    expect(status).toBe(200)
    expect(internalDirectoryTeamCheckResponseSchema.parse(body)).toEqual({ exists: true })
  })

  test('a Team of another Organization, or an unknown Team, is false', async () => {
    const { post, first, second, team } = await setup()
    const foreign = await team(second, 'Closers')

    const elsewhere = await post('team-check', {
      organizationId: first.organizationId,
      teamId: foreign,
    })
    const unknown = await post('team-check', {
      organizationId: first.organizationId,
      teamId: `team_${'0'.repeat(32)}`,
    })

    expect(elsewhere.status).toBe(200)
    expect(elsewhere.body).toEqual({ exists: false })
    expect(unknown.body).toEqual({ exists: false })
  })

  test('refuses a missing or wrong token, and a malformed body is request.invalid', async () => {
    const { post, first, team } = await setup()
    const body = { organizationId: first.organizationId, teamId: await team(first, 'Closers') }

    expect((await post('team-check', body, { 'content-type': 'application/json' })).status).toBe(
      401
    )
    expect(
      (
        await post('team-check', body, {
          authorization: 'Bearer not-the-secret-0123456789abcdef-0123',
          'content-type': 'application/json',
        })
      ).status
    ).toBe(401)
    const bad = await post('team-check', { teamId: body.teamId })
    expect(bad.status).toBe(400)
    expect((bad.body.error as { code: string }).code).toBe('request.invalid')
  })
})

describe('POST /internal/v1/directory/team-reps', () => {
  /** An Organization with two Managers and four Reps, and a helper that puts members on a Team. */
  async function reps() {
    const base = await setup()
    const organization = await seedOrganization(
      base.memory,
      ['manager', 'manager', 'rep', 'rep', 'rep', 'rep'],
      'Reps'
    )
    const of = (role: Role) => organization.members.filter((m) => m.role === role)
    const [managerA, managerB] = of('manager') as [SeededMember, SeededMember]
    const repList = of('rep')
    const place = async (teamId: TeamId, ...members: SeededMember[]) => {
      for (const member of members) {
        const added = await base.call(
          organization.owner,
          organization.organizationId,
          'POST',
          `/teams/${teamId}/members`,
          { membershipId: member.id }
        )
        expect(added.status).toBeLessThan(300)
      }
    }
    const ask = (membershipId: string, organizationId: string = organization.organizationId) =>
      base.post('team-reps', { organizationId, membershipId })
    return { ...base, organization, managerA, managerB, repList, place, ask }
  }

  test('a Manager of two Teams gets the union of their Reps, once each, in a stable order', async () => {
    const { organization, team, place, managerA, managerB, repList, ask } = await reps()
    const [r1, r2, r3, r4] = repList as [SeededMember, SeededMember, SeededMember, SeededMember]
    const alpha = await team(organization, 'Alpha')
    const beta = await team(organization, 'Beta')
    await place(alpha, managerA, r1, r2)
    await place(beta, managerA, r2, r3)
    await place(await team(organization, 'Gamma'), managerB, r4)

    const { status, body } = await ask(managerA.id)

    expect(status).toBe(200)
    const { membershipIds } = internalDirectoryTeamRepsResponseSchema.parse(body)
    expect(membershipIds).toEqual([r1.id, r2.id, r3.id].sort())
    expect((await ask(managerA.id)).body).toEqual(body)
    expect(internalDirectoryTeamRepsResponseSchema.parse((await ask(managerB.id)).body)).toEqual({
      membershipIds: [r4.id],
    })
  })

  test('leaves out Managers and other non-Reps who share the Team', async () => {
    const { organization, team, place, managerA, managerB, repList, ask } = await reps()
    const [r1] = repList as [SeededMember]
    const alpha = await team(organization, 'Alpha')
    await place(alpha, managerA, managerB, r1)

    expect((await ask(managerA.id)).body).toEqual({ membershipIds: [r1.id] })
  })

  test('a non-Manager, a Manager with no Team and an unknown Membership get []', async () => {
    const { organization, team, place, managerA, repList, ask } = await reps()
    const [r1, r2] = repList as [SeededMember, SeededMember]
    const alpha = await team(organization, 'Alpha')
    await place(alpha, managerA, r1, r2)

    for (const asker of [r1.id, organization.owner.id, newMembershipId()]) {
      const answer = await ask(asker)
      expect(answer.status).toBe(200)
      expect(answer.body).toEqual({ membershipIds: [] })
    }
    const other = await reps()
    const lone = other.managerB
    expect((await other.ask(lone.id)).body).toEqual({ membershipIds: [] })
  })

  test('another Organization sees nothing, in either direction', async () => {
    const { organization, second, team, place, managerA, repList, ask } = await reps()
    const [r1] = repList as [SeededMember]
    const alpha = await team(organization, 'Alpha')
    await place(alpha, managerA, r1)

    const asOtherOrganization = await ask(managerA.id, second.organizationId)
    const foreign = await ask(second.owner.id)

    expect(asOtherOrganization.status).toBe(200)
    expect(asOtherOrganization.body).toEqual({ membershipIds: [] })
    expect(foreign.body).toEqual({ membershipIds: [] })
  })

  test('answers at most MAX_DIRECTORY_TEAM_REPS Reps', async () => {
    const { memory, organization, team, managerA, ask } = await reps()
    const alpha = await team(organization, 'Alpha')
    const extra = MAX_DIRECTORY_TEAM_REPS + 5
    const now = new Date('2026-01-02T00:00:00Z')
    await memory.withOrganization(organization.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.addTeamMember(alpha, managerA.id, now)
      for (let i = 0; i < extra; i += 1) {
        const id = newMembershipId()
        await scope.insertMembership({
          id,
          userId: newUserId(),
          email: `${crypto.randomUUID()}@example.test`,
          name: null,
          role: 'rep',
          now,
        })
        await scope.addTeamMember(alpha, id, now)
      }
    })

    const { status, body } = await ask(managerA.id)

    expect(status).toBe(200)
    const { membershipIds } = internalDirectoryTeamRepsResponseSchema.parse(body)
    expect(membershipIds).toHaveLength(MAX_DIRECTORY_TEAM_REPS)
    expect(new Set(membershipIds).size).toBe(MAX_DIRECTORY_TEAM_REPS)
    expect([...membershipIds].sort()).toEqual(membershipIds)
  })

  test('refuses a missing or wrong token, and a user token', async () => {
    const { post, app, bearer, organization, managerA } = await reps()
    const body = { organizationId: organization.organizationId, membershipId: managerA.id }

    expect((await post('team-reps', body, { 'content-type': 'application/json' })).status).toBe(401)
    expect(
      (
        await post('team-reps', body, {
          authorization: 'Bearer not-the-secret-0123456789abcdef-0123',
          'content-type': 'application/json',
        })
      ).status
    ).toBe(401)
    const user = await app.request('/internal/v1/directory/team-reps', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await bearer({
          ...organization.owner,
          organizationId: organization.organizationId,
          role: 'owner',
        })),
      },
      body: JSON.stringify(body),
    })
    expect(user.status).toBe(401)
  })

  test('a malformed body is request.invalid', async () => {
    const { post, organization, managerA } = await reps()

    for (const bad of [
      {},
      { organizationId: organization.organizationId },
      { membershipId: managerA.id },
      { organizationId: 'nope', membershipId: managerA.id },
      { organizationId: organization.organizationId, membershipId: 'nope' },
      { organizationId: organization.organizationId, membershipId: managerA.id, extra: 1 },
    ]) {
      const { status, body } = await post('team-reps', bad)
      expect(status).toBe(400)
      expect((body.error as { code: string }).code).toBe('request.invalid')
    }
  })
})

describe('POST /internal/v1/directory/team-ring-members', () => {
  async function ring() {
    const base = await setup()
    const organization = await seedOrganization(
      base.memory,
      ['admin', 'manager', 'rep', 'rep', 'rep'],
      'Ring'
    )
    const teamId = await base.team(organization, 'Alpha')
    const ask = (
      id: string = teamId,
      organizationId: string = organization.organizationId,
      headers?: Record<string, string>
    ) => base.post('team-ring-members', { organizationId, teamId: id }, headers)
    return { ...base, organization, teamId, ask }
  }

  test('answers only the Reps of the Team, in Membership id order', async () => {
    const { organization, teamId, ask, call } = await ring()
    for (const member of organization.members) {
      await call(
        organization.owner,
        organization.organizationId,
        'POST',
        `/teams/${teamId}/members`,
        {
          membershipId: member.id,
        }
      )
    }
    const expected = organization.members
      .filter((m) => m.role === 'rep')
      .map((m) => m.id)
      .sort()

    const { status, body } = await ask()

    expect(status).toBe(200)
    expect(internalDirectoryTeamRingMembersResponseSchema.parse(body).membershipIds).toEqual(
      expected
    )
    expect(expected).toHaveLength(3)
  })

  test('answers at most MAX_DIRECTORY_TEAM_RING_MEMBERS Reps', async () => {
    const { memory, organization, teamId, ask } = await ring()
    const now = new Date('2026-01-02T00:00:00Z')
    await memory.withOrganization(organization.organizationId, async (scope) => {
      await scope.lockOrganization()
      for (let i = 0; i < MAX_DIRECTORY_TEAM_RING_MEMBERS + 5; i += 1) {
        const id = newMembershipId()
        await scope.insertMembership({
          id,
          userId: newUserId(),
          email: `${crypto.randomUUID()}@example.test`,
          name: null,
          role: 'rep',
          now,
        })
        await scope.addTeamMember(teamId, id, now)
      }
    })

    const { body } = await ask()
    const { membershipIds } = internalDirectoryTeamRingMembersResponseSchema.parse(body)

    expect(membershipIds).toHaveLength(MAX_DIRECTORY_TEAM_RING_MEMBERS)
    expect([...membershipIds].sort()).toEqual(membershipIds)
  })

  test('an unknown Team, or a Team asked about by another Organization, is empty', async () => {
    const { organization, teamId, ask, second, call } = await ring()
    const rep = organization.members.find((m) => m.role === 'rep') as SeededMember
    await call(
      organization.owner,
      organization.organizationId,
      'POST',
      `/teams/${teamId}/members`,
      {
        membershipId: rep.id,
      }
    )

    expect((await ask(teamId, second.organizationId)).body).toEqual({ membershipIds: [] })
    expect((await ask(formatId('team', crypto.randomUUID()))).body).toEqual({ membershipIds: [] })
  })

  test('refuses a missing or wrong token, and a malformed body', async () => {
    const { ask, post, organization, teamId } = await ring()

    expect(
      (await ask(teamId, organization.organizationId, { 'content-type': 'application/json' }))
        .status
    ).toBe(401)
    expect(
      (
        await ask(teamId, organization.organizationId, {
          authorization: 'Bearer not-the-secret-0123456789abcdef-0123',
          'content-type': 'application/json',
        })
      ).status
    ).toBe(401)
    for (const bad of [
      {},
      { organizationId: organization.organizationId },
      { organizationId: organization.organizationId, teamId, extra: 1 },
    ]) {
      const { status, body } = await post('team-ring-members', bad)
      expect(status).toBe(400)
      expect((body.error as { code: string }).code).toBe('request.invalid')
    }
  })
})

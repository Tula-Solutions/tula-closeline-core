import { describe, expect, test } from 'bun:test'
import {
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryTeamCheckResponseSchema,
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
  return { ...harness, memory, first, second, byRole, post, team }
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

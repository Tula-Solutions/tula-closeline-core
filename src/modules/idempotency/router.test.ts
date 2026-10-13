import { describe, expect, test } from 'bun:test'
import {
  formatId,
  type OrganizationId,
  type Role,
  teamMemberSchema,
  teamSchema,
  type UserId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import type { CoreStore, OrganizationScope } from '~/ports/core-store'
import { IdempotencyInProgressError } from '~/ports/core-store'
import {
  type ApiResponse,
  createTestApp,
  newMembershipId,
  newOrganizationId,
  seedOrganization,
  type TestDepsOverrides,
} from '~/testing'
import { IDEMPOTENCY_TTL_MS } from './service'

const KEY = 'order-0001-abcdefgh'
type Actor = { userId: UserId; role: Role }

async function setup(
  store: CoreStore = createMemoryCoreStore(),
  overrides: TestDepsOverrides = {}
) {
  const harness = await createTestApp({ store, ...overrides })
  const seeded = await seedOrganization(store, ['admin', 'rep'])
  const owner = seeded.owner
  const admin = seeded.members[1] as Actor
  const rep = seeded.members[2] as Actor
  /** A public POST with an optional `Idempotency-Key`, as `actor` of `organizationId`. */
  const post = async (
    actor: Actor,
    organizationId: OrganizationId,
    path: string,
    body: unknown,
    key?: string
  ): Promise<ApiResponse & { text: string }> => {
    const token = await harness.bearer({ userId: actor.userId, organizationId, role: actor.role })
    const response = await harness.app.request(`/v1${path}`, {
      method: 'POST',
      headers: {
        ...token,
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
      retryAfter: response.headers.get('retry-after'),
      text,
    }
  }
  const asOwner = (path: string, body: unknown, key?: string) =>
    post(owner, seeded.organizationId, path, body, key)
  const teamCount = async () =>
    (await store.withOrganization(seeded.organizationId, (s) => s.listTeams({ limit: 100 }))).length
  const pendingCount = async () =>
    (
      await store.withOrganization(seeded.organizationId, (s) =>
        s.listInvitations({ state: 'pending', limit: 100 })
      )
    ).length
  return { ...harness, store, seeded, owner, admin, rep, post, asOwner, teamCount, pendingCount }
}

describe('create a Team with an Idempotency-Key', () => {
  test('the same key and body twice returns the first Team and creates one', async () => {
    const { asOwner, teamCount, deps } = await setup()

    const first = await asOwner('/teams', { name: 'Sales' }, KEY)
    deps.clock.advance('1h')
    const second = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect(second.text).toBe(first.text)
    expect(await teamCount()).toBe(1)
  })

  test('the same key with a different body is request.idempotency_key_reused and changes nothing', async () => {
    const { asOwner, teamCount } = await setup()
    await asOwner('/teams', { name: 'Sales' }, KEY)

    const reused = await asOwner('/teams', { name: 'Support' }, KEY)

    expect(reused.status).toBe(422)
    expect(reused.body.error?.code).toBe('request.idempotency_key_reused')
    expect(await teamCount()).toBe(1)
  })

  test('the order of the keys in the body does not make another request', async () => {
    const { asOwner, teamCount } = await setup()
    const first = await asOwner('/teams', { name: 'Sales' }, KEY)

    const again = await asOwner('/teams', { name: 'Sales', ...{} }, KEY)

    expect(again.body).toEqual(first.body)
    expect(await teamCount()).toBe(1)
  })

  test('without a key a repeat behaves as before: team.name_taken', async () => {
    const { asOwner } = await setup()
    await asOwner('/teams', { name: 'Sales' })

    const again = await asOwner('/teams', { name: 'Sales' })

    expect(again.status).toBe(409)
    expect(again.body.error?.code).toBe('team.name_taken')
  })

  test('a request that failed leaves the key free for the same request', async () => {
    const { asOwner, teamCount, store, seeded } = await setup()
    const taken = await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      return s.insertTeam({
        id: formatId('team', crypto.randomUUID()),
        name: 'Sales',
        now: new Date(),
      })
    })
    const refused = await asOwner('/teams', { name: 'Sales' }, KEY)
    await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      await s.renameTeam(taken.id, 'Old Sales', new Date())
    })

    const retried = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe('team.name_taken')
    expect(retried.status).toBe(201)
    expect(await teamCount()).toBe(2)
  })

  test('a refused caller leaves the key free, and a later allowed caller with the same key is not told it was used', async () => {
    const { post, rep, seeded, asOwner } = await setup()

    const forbidden = await post(rep, seeded.organizationId, '/teams', { name: 'Sales' }, KEY)
    const allowed = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(forbidden.status).toBe(403)
    expect(allowed.status).toBe(201)
  })

  test('another Organization and another user use the same key independently', async () => {
    const { store, post, owner, admin, seeded, asOwner } = await setup()
    const other = await seedOrganization(store)
    const first = await asOwner('/teams', { name: 'Sales' }, KEY)

    const otherOrganization = await post(
      other.owner,
      other.organizationId,
      '/teams',
      {
        name: 'Sales',
      },
      KEY
    )
    const otherUser = await post(admin, seeded.organizationId, '/teams', { name: 'Support' }, KEY)
    const firstAgain = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(otherOrganization.status).toBe(201)
    expect(teamSchema.parse(otherOrganization.body).id).not.toBe(teamSchema.parse(first.body).id)
    expect(otherUser.status).toBe(201)
    expect(teamSchema.parse(otherUser.body).name).toBe('Support')
    expect(firstAgain.body).toEqual(first.body)
    expect(owner.userId).not.toBe(admin.userId)
  })

  test('a second Organization cannot replay the first one’s answer, even with the same body', async () => {
    const { store, post, asOwner } = await setup()
    const other = await seedOrganization(store)
    const first = await asOwner('/teams', { name: 'Sales' }, KEY)

    const theirs = await post(other.owner, other.organizationId, '/teams', { name: 'Sales' }, KEY)

    expect(theirs.text).not.toBe(first.text)
    const others = await store.withOrganization(other.organizationId, (s) =>
      s.listTeams({ limit: 10 })
    )
    expect(others).toHaveLength(1)
  })

  test('an answer older than 24 hours counts as absent and the key is used again', async () => {
    const { asOwner, deps, teamCount } = await setup()
    await asOwner('/teams', { name: 'Sales' }, KEY)

    deps.clock.advance(`${IDEMPOTENCY_TTL_MS / 1000 + 1}s`)
    const next = await asOwner('/teams', { name: 'Support' }, KEY)
    const replay = await asOwner('/teams', { name: 'Support' }, KEY)

    expect(next.status).toBe(201)
    expect(replay.body).toEqual(next.body)
    expect(await teamCount()).toBe(2)
  })

  test('an answer just under 24 hours old is still replayed', async () => {
    const { asOwner, deps, teamCount } = await setup()
    const first = await asOwner('/teams', { name: 'Sales' }, KEY)

    deps.clock.advance(`${IDEMPOTENCY_TTL_MS / 1000 - 1}s`)
    const replay = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(replay.body).toEqual(first.body)
    expect(await teamCount()).toBe(1)
  })

  test.each([
    ['too short', 'short-key'],
    ['too long', 'k'.repeat(129)],
    ['with a space', 'a key with spaces!!'],
  ])('a key that is %s is request.invalid and creates nothing', async (_why, key) => {
    const { asOwner, teamCount } = await setup()

    const refused = await asOwner('/teams', { name: 'Sales' }, key)

    expect(refused.status).toBe(400)
    expect(refused.body.error?.code).toBe('request.invalid')
    expect(await teamCount()).toBe(0)
  })

  test('a key held by a request still running is request.idempotency_in_progress with Retry-After', async () => {
    const inner = createMemoryCoreStore()
    const store: typeof inner = {
      ...inner,
      withOrganization: (organizationId, fn) =>
        inner.withOrganization(organizationId, (scope) =>
          fn({
            ...scope,
            reserveIdempotencyKey: async () => {
              throw new IdempotencyInProgressError(3)
            },
          })
        ),
    }
    const { asOwner, teamCount } = await setup(store)

    const busy = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(busy.status).toBe(409)
    expect(busy.body.error).toMatchObject({
      code: 'request.idempotency_in_progress',
      details: { retryAfter: 3 },
    })
    expect(busy.retryAfter).toBe('3')
    expect(await teamCount()).toBe(0)
  })

  test('an Organization that does not exist is organization.not_found, not a failure', async () => {
    const { post, owner } = await setup()

    const missing = await post(owner, newOrganizationId(), '/teams', { name: 'Sales' }, KEY)

    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('organization.not_found')
  })
})

describe('add a Team member with an Idempotency-Key', () => {
  async function withTeam() {
    const s = await setup()
    const team = teamSchema.parse((await s.asOwner('/teams', { name: 'Sales' })).body)
    const other = teamSchema.parse((await s.asOwner('/teams', { name: 'Support' })).body)
    const repId = s.seeded.members[2]?.id
    const adminId = s.seeded.members[1]?.id
    if (!repId || !adminId) {
      throw new Error('seed made no members')
    }
    return { ...s, team, other, repId, adminId }
  }

  test('the same key and request twice returns the first answer and does not run again', async () => {
    const { asOwner, team, repId: rep, store, seeded } = await withTeam()

    const first = await asOwner(`/teams/${team.id}/members`, { membershipId: rep }, KEY)
    // Someone takes the member out; a replay must not put them back.
    await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      await s.removeTeamMember(team.id, rep)
    })
    const second = await asOwner(`/teams/${team.id}/members`, { membershipId: rep }, KEY)

    expect(first.status).toBe(200)
    expect(teamMemberSchema.parse(first.body).membershipId).toBe(rep)
    expect(second.text).toBe(first.text)
    const inTeam = await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      return s.removeTeamMember(team.id, rep)
    })
    expect(inTeam).toBe(false)
  })

  test('the same key on another Team, or for another member, is a different request', async () => {
    const { asOwner, team, other, repId: rep, adminId: admin } = await withTeam()
    await asOwner(`/teams/${team.id}/members`, { membershipId: rep }, KEY)

    const otherTeam = await asOwner(`/teams/${other.id}/members`, { membershipId: rep }, KEY)
    const otherMember = await asOwner(`/teams/${team.id}/members`, { membershipId: admin }, KEY)

    for (const refused of [otherTeam, otherMember]) {
      expect(refused.status).toBe(422)
      expect(refused.body.error?.code).toBe('request.idempotency_key_reused')
    }
  })

  test('a request that failed leaves the key free: the member added afterwards is added', async () => {
    const { asOwner, team, store, seeded } = await withTeam()
    const later = newMembershipId()
    const refused = await asOwner(`/teams/${team.id}/members`, { membershipId: later }, KEY)
    await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      await s.insertMembership({
        id: later,
        userId: formatId('usr', crypto.randomUUID()),
        role: 'rep',
        now: new Date(),
      })
    })

    const retried = await asOwner(`/teams/${team.id}/members`, { membershipId: later }, KEY)

    expect(refused.status).toBe(404)
    expect(refused.body.error?.code).toBe('member.not_found')
    expect(retried.status).toBe(200)
  })

  test('the same key for two users is two requests', async () => {
    const { post, admin, team, repId: rep, adminId, seeded, asOwner } = await withTeam()
    const first = await asOwner(`/teams/${team.id}/members`, { membershipId: rep }, KEY)

    const second = await post(
      admin,
      seeded.organizationId,
      `/teams/${team.id}/members`,
      { membershipId: adminId },
      KEY
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(teamMemberSchema.parse(second.body).membershipId).toBe(adminId)
  })

  test('without a key a repeat is answered as before', async () => {
    const { asOwner, team, repId: rep } = await withTeam()

    const first = await asOwner(`/teams/${team.id}/members`, { membershipId: rep })
    const second = await asOwner(`/teams/${team.id}/members`, { membershipId: rep })

    expect([first.status, second.status]).toEqual([200, 200])
  })
})

describe('create an Invitation with an Idempotency-Key', () => {
  const body = { email: 'new.person@example.com', role: 'rep' }

  test('the same key and body twice returns the first Invitation and sends one email', async () => {
    const { asOwner, deps, pendingCount } = await setup()

    const first = await asOwner('/invitations', body, KEY)
    deps.clock.advance('1h')
    const second = await asOwner('/invitations', body, KEY)

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.text).toBe(first.text)
    expect(deps.mail.outbox).toHaveLength(1)
    expect(await pendingCount()).toBe(1)
  })

  test('the stored answer holds no token: the replay body is the Invitation without one', async () => {
    const { asOwner, deps } = await setup()

    await asOwner('/invitations', body, KEY)
    const replay = await asOwner('/invitations', body, KEY)

    const { token } = deps.mail.last()
    expect(replay.text).not.toContain(token)
    expect(Object.keys(replay.body).sort()).toEqual([
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedByUserId',
      'role',
      'state',
      'teamId',
    ])
  })

  test('the same key with a different body is request.idempotency_key_reused and sends nothing', async () => {
    const { asOwner, deps } = await setup()
    await asOwner('/invitations', body, KEY)

    const reused = await asOwner('/invitations', { ...body, role: 'manager' }, KEY)

    expect(reused.status).toBe(422)
    expect(reused.body.error?.code).toBe('request.idempotency_key_reused')
    expect(deps.mail.outbox).toHaveLength(1)
  })

  test('an address in another letter case is the same request', async () => {
    const { asOwner, deps } = await setup()
    const first = await asOwner('/invitations', body, KEY)

    const again = await asOwner('/invitations', { ...body, email: 'New.Person@Example.com' }, KEY)

    expect(again.text).toBe(first.text)
    expect(deps.mail.outbox).toHaveLength(1)
  })

  test('without a key a repeat behaves as before: invitation.already_pending', async () => {
    const { asOwner } = await setup()
    await asOwner('/invitations', body)

    const again = await asOwner('/invitations', body)

    expect(again.status).toBe(409)
    expect(again.body.error?.code).toBe('invitation.already_pending')
  })

  test('a request refused by a rule leaves the key free', async () => {
    const { asOwner, deps, pendingCount, store, seeded } = await setup()
    const first = await asOwner('/invitations', body)
    const refused = await asOwner('/invitations', body, KEY)
    await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      await s.revokeInvitation((first.body as { id: never }).id, new Date())
    })

    const retried = await asOwner('/invitations', body, KEY)

    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe('invitation.already_pending')
    expect(retried.status).toBe(201)
    expect(deps.mail.outbox).toHaveLength(2)
    expect(await pendingCount()).toBe(1)
  })

  test('a delivery that failed frees the key: the retry with it is a new attempt and sends the email', async () => {
    const { asOwner, deps, pendingCount } = await setup()
    deps.mail.failing = true
    const failed = await asOwner('/invitations', body, KEY)
    deps.mail.failing = false

    const retried = await asOwner('/invitations', body, KEY)
    const replay = await asOwner('/invitations', body, KEY)

    expect(failed.status).toBe(503)
    expect(retried.status).toBe(201)
    expect(replay.text).toBe(retried.text)
    expect(deps.mail.outbox).toHaveLength(1)
    expect(await pendingCount()).toBe(1)
  })

  test('another Organization and another user use the same key independently', async () => {
    const { store, post, admin, seeded, asOwner, deps } = await setup()
    const other = await seedOrganization(store)
    const first = await asOwner('/invitations', body, KEY)

    const otherOrganization = await post(
      other.owner,
      other.organizationId,
      '/invitations',
      body,
      KEY
    )
    const otherUser = await post(
      admin,
      seeded.organizationId,
      '/invitations',
      { email: 'second@example.com', role: 'rep' },
      KEY
    )

    expect(first.status).toBe(201)
    expect(otherOrganization.status).toBe(201)
    expect(otherOrganization.text).not.toBe(first.text)
    expect(otherUser.status).toBe(201)
    expect((otherUser.body as { email: string }).email).toBe('second@example.com')
    expect(deps.mail.outbox).toHaveLength(3)
  })

  test('an answer older than 24 hours counts as absent', async () => {
    const { asOwner, deps } = await setup()
    const first = await asOwner('/invitations', body, KEY)

    deps.clock.advance(`${IDEMPOTENCY_TTL_MS / 1000 + 1}s`)
    const next = await asOwner('/invitations', { email: 'later@example.com', role: 'rep' }, KEY)

    expect(first.status).toBe(201)
    expect(next.status).toBe(201)
    expect((next.body as { email: string }).email).toBe('later@example.com')
  })
})

/** A store whose scopes have some methods replaced, for a test that needs one step to fail. */
function withScope(inner: CoreStore, replace: Partial<OrganizationScope>): CoreStore {
  return {
    ...inner,
    withOrganization: (organizationId, fn) =>
      inner.withOrganization(organizationId, (scope) => fn({ ...scope, ...replace })),
  }
}

describe('the purge never fails the request', () => {
  test('a purge that throws is logged with the route and ids and the request still succeeds and is stored', async () => {
    const store = withScope(createMemoryCoreStore(), {
      purgeIdempotencyKeys: async () => {
        throw new TypeError('the purge failed')
      },
    })
    const { asOwner, deps, owner, seeded } = await setup(store)

    const made = await asOwner('/teams', { name: 'Sales' }, KEY)
    const replay = await asOwner('/teams', { name: 'Sales' }, KEY)

    expect(made.status).toBe(201)
    expect(replay.text).toBe(made.text)
    const logged = deps.logLines.join('\n')
    expect(logged).toContain('teams.create')
    expect(logged).toContain('TypeError')
    expect(logged).toContain(owner.userId)
    expect(logged).toContain(seeded.organizationId)
  })
})

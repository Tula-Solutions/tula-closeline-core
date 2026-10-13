import { describe, expect, test } from 'bun:test'
import {
  ABANDON_MAX_AGE_HOURS,
  ERRORS,
  INTERNAL_CALL_ERRORS,
  invitationSchema,
  type OrganizationId,
  type UserId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  type ApiBody,
  createTestApp,
  newOrganizationId,
  newUserId,
  publicCaller,
  recordStore,
  seedOrganization,
  TEST_INTERNAL_SECRET,
} from '~/testing'

const COMMON_CODES: ReadonlySet<string> = new Set(Object.keys(ERRORS))
const HOUR_MS = 3_600_000
const LIMIT_MS = ABANDON_MAX_AGE_HOURS * HOUR_MS

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = harness.internal()
  ) => {
    const response = await harness.app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as ApiBody }
  }

  /** Auth's sign-up call: an Organization with `userId` as its only member. */
  const signUp = async (userId: UserId = newUserId()) => {
    const made = await post('/internal/organizations', {
      userId,
      organizationName: 'Acme',
      email: 'owner@example.test',
      name: 'Olive',
    })
    expect(made.status).toBe(200)
    return { userId, organizationId: made.body.organizationId as OrganizationId }
  }

  const abandon = (
    organizationId: string,
    userId: string,
    headers: Record<string, string> = harness.internal()
  ) => post(`/internal/organizations/${organizationId}/abandon`, { userId }, headers)

  const stateOf = (organizationId: OrganizationId) =>
    store.withOrganization(organizationId, async (scope) => ({
      organization: await scope.getOrganization(),
      members: await scope.listMembers({ limit: 100 }),
    }))

  /** Makes the Organization `ageMs` old by the clock the store judges by. */
  const makeOld = (organizationId: OrganizationId, ageMs: number) =>
    store.setOrganizationCreatedAt(
      organizationId,
      new Date(harness.deps.clock.now().getTime() - ageMs)
    )

  return { ...harness, store, post, signUp, abandon, stateOf, makeOld }
}

const GONE = (organizationId: string) => ({ organizationId, status: 'deleted' })

describe('POST /internal/organizations/{organizationId}/abandon', () => {
  test('abandons an Organization whose only member is the user, and frees the user id at once', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()

    const { status, body } = await t.abandon(organizationId, userId)

    expect(status).toBe(200)
    expect(body).toEqual(GONE(organizationId))
    const after = await t.stateOf(organizationId)
    expect(after.organization?.status).toBe('deleted')
    expect(after.members).toEqual([])
    expect(await t.store.organizationOfUser(userId)).toBeNull()
    // The id is free: the same user can sign up again with a new Organization.
    const again = await t.signUp(userId)
    expect(again.organizationId).not.toBe(organizationId)
  })

  test('a repeat with the same key answers the same and changes nothing', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const headers = t.internal('abandon-key-0123456789')

    const first = await t.abandon(organizationId, userId, headers)
    const again = await t.abandon(organizationId, userId, headers)

    expect(again).toEqual(first)
    expect(again.status).toBe(200)
  })

  test('a repeat with a new key, and with a different user id, after it is gone, is still a success', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    await t.abandon(organizationId, userId)

    const newKey = await t.abandon(organizationId, userId)
    const otherUser = await t.abandon(organizationId, newUserId())

    expect(newKey).toEqual({ status: 200, body: GONE(organizationId) })
    expect(otherUser).toEqual({ status: 200, body: GONE(organizationId) })
  })

  test('an Organization id nobody created is a success and creates nothing', async () => {
    const t = await setup()

    const { status, body } = await t.abandon(newOrganizationId(), newUserId())

    expect(status).toBe(200)
    expect(body.status).toBe('deleted')
    expect(t.store.organizationCount()).toBe(0)
  })

  test('an Organization deleted by someone else, members and all, is a success', async () => {
    const t = await setup()
    const seeded = await seedOrganization(t.store, ['rep'])
    t.store.setOrganizationStatus(seeded.organizationId, 'deleted')

    const { status, body } = await t.abandon(seeded.organizationId, seeded.owner.userId)

    expect(status).toBe(200)
    expect(body).toEqual(GONE(seeded.organizationId))
    expect((await t.stateOf(seeded.organizationId)).members).toHaveLength(2)
  })

  test('refuses an Organization with two members and touches nothing', async () => {
    const t = await setup()
    const seeded = await seedOrganization(t.store, ['rep'])

    const { status, body } = await t.abandon(seeded.organizationId, seeded.owner.userId)

    expect(status).toBe(409)
    expect(body.error?.code).toBe('organization.not_abandonable')
    const after = await t.stateOf(seeded.organizationId)
    expect(after.organization?.status).toBe('active')
    expect(after.members).toHaveLength(2)
  })

  test('refuses when the only member is somebody else', async () => {
    const t = await setup()
    const { organizationId } = await t.signUp()

    const { status, body } = await t.abandon(organizationId, newUserId())

    expect(status).toBe(409)
    expect(body.error?.code).toBe('organization.not_abandonable')
    expect((await t.stateOf(organizationId)).organization?.status).toBe('active')
    expect((await t.stateOf(organizationId)).members).toHaveLength(1)
  })

  test('refuses an Organization a member of another Organization names', async () => {
    const t = await setup()
    const mine = await t.signUp()
    const theirs = await t.signUp()

    const { status } = await t.abandon(theirs.organizationId, mine.userId)

    expect(status).toBe(409)
    expect((await t.stateOf(theirs.organizationId)).organization?.status).toBe('active')
    expect((await t.stateOf(mine.organizationId)).organization?.status).toBe('active')
  })

  test.each([
    ['a day old', LIMIT_MS, 409],
    ['a day and a millisecond old', LIMIT_MS + 1, 409],
    ['a month old', 30 * LIMIT_MS, 409],
    ['a millisecond short of a day old', LIMIT_MS - 1, 200],
    ['an hour old', HOUR_MS, 200],
  ])('an Organization %s answers %i', async (_label, ageMs, expected) => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    t.makeOld(organizationId, ageMs)

    const { status, body } = await t.abandon(organizationId, userId)

    expect(status).toBe(expected)
    if (expected === 409) {
      expect(body.error?.code).toBe('organization.not_abandonable')
      expect((await t.stateOf(organizationId)).organization?.status).toBe('active')
      expect((await t.stateOf(organizationId)).members).toHaveLength(1)
    } else {
      expect((await t.stateOf(organizationId)).organization?.status).toBe('deleted')
    }
  })

  test("an abandoned Organization's pending Invitation can no longer be accepted", async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const api = publicCaller(t)
    const owner = { userId, role: 'owner' as const }
    const invited = await api(owner, organizationId, 'POST', '/invitations', {
      email: 'late@example.test',
      role: 'rep',
    })
    expect(invited.status).toBe(201)
    const token = t.deps.mail.last().token
    expect(invitationSchema.parse(invited.body).state).toBe('pending')
    await t.abandon(organizationId, userId)

    const accepted = await t.post('/internal/invitations/accept', {
      userId: newUserId(),
      email: 'late@example.test',
      invitationToken: token,
    })

    expect(accepted.status).toBe(422)
    expect(accepted.body.error?.code).toBe('invitation.invalid')
    expect((await t.stateOf(organizationId)).members).toEqual([])
  })

  test('an accept that has found its Invitation but loses the Organization to an abandon is invitation.invalid', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const api = publicCaller(t)
    await api({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
      email: 'late@example.test',
      role: 'rep',
    })
    const token = t.deps.mail.last().token
    // The abandon commits in the window between the accept's token lookup and its transaction.
    const racing = recordStore(t.store, {
      afterInvitationLookup: async () => {
        expect((await t.abandon(organizationId, userId)).status).toBe(200)
      },
    })
    const app = await createTestApp({ store: racing.store })

    const accepted = await app.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: app.internal(),
      body: JSON.stringify({
        userId: newUserId(),
        email: 'late@example.test',
        invitationToken: token,
      }),
    })

    expect(accepted.status).toBe(422)
    expect(((await accepted.json()) as ApiBody).error?.code).toBe('invitation.invalid')
    const after = await t.stateOf(organizationId)
    expect(after.organization?.status).toBe('deleted')
    expect(after.members).toEqual([])
  })

  test('an accept that lands first makes the abandon refuse, and the new member stays', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const api = publicCaller(t)
    await api({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
      email: 'early@example.test',
      role: 'rep',
    })
    const joiner = newUserId()
    const accepted = await t.post('/internal/invitations/accept', {
      userId: joiner,
      email: 'early@example.test',
      invitationToken: t.deps.mail.last().token,
    })
    expect(accepted.status).toBe(200)

    const refused = await t.abandon(organizationId, userId)

    expect(refused.status).toBe(409)
    const after = await t.stateOf(organizationId)
    expect(after.organization?.status).toBe('active')
    expect(after.members.map((m) => m.userId).sort()).toEqual([userId, joiner].sort())
  })

  test('an accept and an abandon fired together leave one consistent state', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const api = publicCaller(t)
    await api({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
      email: 'both@example.test',
      role: 'rep',
    })
    const token = t.deps.mail.last().token

    const [accepted, abandoned] = await Promise.all([
      t.post('/internal/invitations/accept', {
        userId: newUserId(),
        email: 'both@example.test',
        invitationToken: token,
      }),
      t.abandon(organizationId, userId),
    ])

    const after = await t.stateOf(organizationId)
    if (accepted.status === 200) {
      expect(abandoned.status).toBe(409)
      expect(after.organization?.status).toBe('active')
      expect(after.members).toHaveLength(2)
    } else {
      expect(accepted.status).toBe(422)
      expect(abandoned.status).toBe(200)
      expect(after.organization?.status).toBe('deleted')
      expect(after.members).toEqual([])
    }
  })

  test('two abandons at once are both a success', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()

    const answers = await Promise.all([
      t.abandon(organizationId, userId),
      t.abandon(organizationId, userId),
    ])

    expect(answers.map((a) => a.status)).toEqual([200, 200])
    expect((await t.stateOf(organizationId)).organization?.status).toBe('deleted')
  })

  test('the check and the change run in one transaction that locks the Organization first', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const recorded = recordStore(t.store)
    const app = await createTestApp({ store: recorded.store })

    const response = await app.app.request(`/internal/organizations/${organizationId}/abandon`, {
      method: 'POST',
      headers: app.internal(),
      body: JSON.stringify({ userId }),
    })

    expect(response.status).toBe(200)
    expect(recorded.transactions()).toBe(1)
    expect(recorded.storeCalls).toEqual(['withOrganization'])
    expect(recorded.calls).toEqual(['lockOrganization', 'abandonOrganization'])
  })

  test('logs only the Organization id and the outcome', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    t.deps.logLines.length = 0

    await t.abandon(organizationId, userId)
    await t.abandon(organizationId, userId)

    const lines = t.deps.logLines.join('\n')
    expect(lines).toContain('"outcome":"abandoned"')
    expect(lines).toContain('"outcome":"already_gone"')
    expect(lines).toContain(organizationId)
    expect(lines).not.toContain('owner@example.test')
    expect(lines).not.toContain('Olive')
  })

  test('the only code it returns is the one the contract lists for it', async () => {
    const t = await setup()
    const seeded = await seedOrganization(t.store, ['rep'])
    const seen = new Set<string>()
    for (const answer of [
      await t.abandon(seeded.organizationId, seeded.owner.userId),
      await t.abandon(newOrganizationId(), newUserId()),
      await t.abandon(seeded.organizationId, 'not-a-user'),
    ]) {
      const code = answer.body.error?.code
      if (code !== undefined && !COMMON_CODES.has(code)) {
        seen.add(code)
      }
    }

    expect([...seen]).toEqual([...INTERNAL_CALL_ERRORS.abandonOrganization])
  })

  test.each([
    ['a user id that is not one', { userId: 'someone' }],
    ['no user id', {}],
    ['an extra key', { userId: `usr_${'a'.repeat(32)}`, force: true }],
  ])('a body with %s is refused', async (_label, body) => {
    const t = await setup()
    const { organizationId } = await t.signUp()

    const { status, body: answer } = await t.post(
      `/internal/organizations/${organizationId}/abandon`,
      body
    )

    expect(status).toBe(400)
    expect(answer.error?.code).toBe('request.invalid')
    expect((await t.stateOf(organizationId)).organization?.status).toBe('active')
  })

  test('an Organization id that is not one is refused', async () => {
    const t = await setup()

    const { status } = await t.post('/internal/organizations/org_1/abandon', {
      userId: newUserId(),
    })

    expect(status).toBe(400)
  })

  test('the Idempotency-Key header is required here too', async () => {
    const t = await setup()
    const { 'idempotency-key': _omitted, ...withoutKey } = t.internal()

    const { status } = await t.abandon(newOrganizationId(), newUserId(), withoutKey)

    expect(status).toBe(400)
  })

  test('refuses a request with no secret, a wrong one and a near one, and abandons nothing', async () => {
    const t = await setup()
    const { userId, organizationId } = await t.signUp()
    const headers = t.internal()

    for (const authorization of [
      undefined,
      'Bearer a-completely-wrong-secret-of-length-ok',
      `Bearer ${TEST_INTERNAL_SECRET.slice(0, -1)}`,
      `Bearer ${TEST_INTERNAL_SECRET}x`,
    ]) {
      const { authorization: _own, ...rest } = headers
      const { status, body } = await t.abandon(organizationId, userId, {
        ...rest,
        ...(authorization === undefined ? {} : { authorization }),
      })
      expect(status).toBe(401)
      expect(body.error?.code).toBe('auth.unauthenticated')
    }
    expect((await t.stateOf(organizationId)).organization?.status).toBe('active')
  })
})

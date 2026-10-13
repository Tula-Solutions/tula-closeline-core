import { describe, expect, test } from 'bun:test'
import {
  CORE_ERRORS,
  ERRORS,
  INTERNAL_CALL_ERRORS,
  internalCreateOrganizationResponseSchema,
  internalMembershipResponseSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newOrganizationId,
  newUserId,
  seedOrganization,
  TEST_INTERNAL_SECRET,
  TEST_INTERNAL_SECRET_NEXT,
} from '~/testing'

const COMMON_CODES: ReadonlySet<string> = new Set(Object.keys(ERRORS))

async function setup() {
  const store = createMemoryCoreStore()
  const test_ = await createTestApp({ store })
  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = test_.internal()
  ) => {
    const response = await test_.app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  return { ...test_, store, post }
}

const create = (userId: string, organizationName = 'Acme Corp') => ({ userId, organizationName })

describe('POST /internal/organizations', () => {
  test('creates the Organization with the user as its Owner and answers with both', async () => {
    const { post, store, deps } = await setup()
    const userId = newUserId()

    const { status, body } = await post('/internal/organizations', create(userId))

    expect(status).toBe(200)
    expect(internalCreateOrganizationResponseSchema.parse(body)).toEqual(body as never)
    expect(Object.keys(body).sort()).toEqual(['organizationId', 'role'])
    expect(body.role).toBe('owner')
    const organizationId = internalCreateOrganizationResponseSchema.parse(body).organizationId
    const stored = await store.withOrganization(organizationId, async (scope) => ({
      organization: await scope.getOrganization(),
      membership: await scope.getMembershipByUser(userId),
    }))
    expect(stored.organization).toMatchObject({
      name: 'Acme Corp',
      status: 'active',
      region: deps.env.REGION,
    })
    expect(stored.membership?.role).toBe('owner')
  })

  test('the Organization name is trimmed by the contract before it is stored', async () => {
    const { post, store } = await setup()

    const { body } = await post('/internal/organizations', create(newUserId(), '  Padded Name  '))

    const id = internalCreateOrganizationResponseSchema.parse(body).organizationId
    const organization = await store.withOrganization(id, (scope) => scope.getOrganization())
    expect(organization?.name).toBe('Padded Name')
  })

  test('a replay with the same key returns the same Organization and creates nothing', async () => {
    const { post, store, internal } = await setup()
    const userId = newUserId()
    const headers = internal('replay-key-0123456789')

    const first = await post('/internal/organizations', create(userId), headers)
    const again = await post('/internal/organizations', create(userId), headers)

    expect(again).toEqual(first)
    expect(again.status).toBe(200)
    expect(store.organizationCount()).toBe(1)
  })

  test('a retry with another key and another name still returns the same Organization', async () => {
    const { post, store } = await setup()
    const userId = newUserId()

    const first = await post('/internal/organizations', create(userId, 'First Name'))
    const retry = await post('/internal/organizations', create(userId, 'Another Name'))

    expect(retry).toEqual(first)
    expect(store.organizationCount()).toBe(1)
  })

  test('two calls at once for one user leave exactly one Organization', async () => {
    const { post, store } = await setup()
    const userId = newUserId()

    const answers = await Promise.all([
      post('/internal/organizations', create(userId)),
      post('/internal/organizations', create(userId)),
      post('/internal/organizations', create(userId)),
    ])

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect(new Set(answers.map((a) => a.body.organizationId)).size).toBe(1)
    expect(store.organizationCount()).toBe(1)
  })

  test.each(['admin', 'manager', 'rep'] as const)(
    'a user who is already a %s of an Organization is refused with membership.already_member',
    async (role) => {
      const { post, store } = await setup()
      const seeded = await seedOrganization(store, [role])
      const member = seeded.members[1]
      const before = store.organizationCount()

      const { status, body } = await post('/internal/organizations', create(member?.userId ?? ''))

      expect(status).toBe(409)
      expect(body).toEqual({
        error: {
          code: 'membership.already_member',
          message: CORE_ERRORS['membership.already_member'].message,
        },
      })
      expect(store.organizationCount()).toBe(before)
    }
  )

  test('a user who owns an Organization that was suspended still gets it back', async () => {
    const { post, store } = await setup()
    const seeded = await seedOrganization(store)
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const { status, body } = await post('/internal/organizations', create(seeded.owner.userId))

    expect(status).toBe(200)
    expect(body.organizationId).toBe(seeded.organizationId)
  })

  test('the Idempotency-Key header is required', async () => {
    const { post, store } = await setup()
    const { 'idempotency-key': _omitted, ...withoutKey } = (await setup()).internal()

    const { status, body } = await post('/internal/organizations', create(newUserId()), withoutKey)

    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('request.invalid')
    expect(store.organizationCount()).toBe(0)
  })

  test.each([
    ['too short', 'short'],
    ['too long', 'k'.repeat(129)],
    ['with a character outside the alphabet', 'not a valid key !!'],
  ])('an Idempotency-Key that is %s is refused', async (_name, key) => {
    const { post, internal, store } = await setup()

    const { status } = await post('/internal/organizations', create(newUserId()), internal(key))

    expect(status).toBe(400)
    expect(store.organizationCount()).toBe(0)
  })

  test.each([
    ['a user id that is not one', { userId: 'usr_1', organizationName: 'A' }],
    ['no user id', { organizationName: 'A' }],
    ['no name', { userId: `usr_${'a'.repeat(32)}` }],
    ['a blank name', { userId: `usr_${'a'.repeat(32)}`, organizationName: '   ' }],
    [
      'a name over 200 characters',
      { userId: `usr_${'a'.repeat(32)}`, organizationName: 'x'.repeat(201) },
    ],
    [
      'a name with a control character',
      { userId: `usr_${'a'.repeat(32)}`, organizationName: 'A\u0007B' },
    ],
    [
      'an email, which core does not store',
      { userId: `usr_${'a'.repeat(32)}`, organizationName: 'A', email: 'a@b.co' },
    ],
    [
      'an Organization id from the caller',
      {
        userId: `usr_${'a'.repeat(32)}`,
        organizationName: 'A',
        organizationId: newOrganizationId(),
      },
    ],
  ])('a body with %s is refused', async (_name, body) => {
    const { post, store } = await setup()

    const { status, body: answer } = await post('/internal/organizations', body)

    expect(status).toBe(400)
    expect((answer.error as { code: string }).code).toBe('request.invalid')
    expect(store.organizationCount()).toBe(0)
  })

  test('a body that is not JSON is refused as invalid, not as a server error', async () => {
    const { app, internal } = await setup()

    const response = await app.request('/internal/organizations', {
      method: 'POST',
      headers: internal(),
      body: '{not json',
    })

    expect(response.status).toBe(400)
  })
})

describe('POST /internal/membership', () => {
  test('a user with no membership is found: false, not an error', async () => {
    const { post } = await setup()

    const { status, body } = await post('/internal/membership', { userId: newUserId() })

    expect(status).toBe(200)
    expect(body).toEqual({ found: false })
  })

  test('a member is found with the Organization, the role and the status', async () => {
    const { post, store } = await setup()
    const seeded = await seedOrganization(store, ['manager'])
    const manager = seeded.members[1]

    const { status, body } = await post('/internal/membership', { userId: manager?.userId })

    expect(status).toBe(200)
    expect(body).toEqual({
      found: true,
      organizationId: seeded.organizationId,
      role: 'manager',
      organizationStatus: 'active',
    })
    expect(internalMembershipResponseSchema.parse(body)).toEqual(body as never)
  })

  test.each(['suspended', 'deleted'] as const)(
    'a member of a %s Organization is found, with that status, for the token hook to decide',
    async (organizationStatus) => {
      const { post, store } = await setup()
      const seeded = await seedOrganization(store)
      store.setOrganizationStatus(seeded.organizationId, organizationStatus)

      const { body } = await post('/internal/membership', { userId: seeded.owner.userId })

      expect(body).toEqual({
        found: true,
        organizationId: seeded.organizationId,
        role: 'owner',
        organizationStatus,
      })
    }
  )

  test('the lookup sees the Organization a sign-up has just created', async () => {
    const { post } = await setup()
    const userId = newUserId()
    const created = await post('/internal/organizations', create(userId))

    const { body } = await post('/internal/membership', { userId })

    expect(body).toMatchObject({
      found: true,
      organizationId: created.body.organizationId,
      role: 'owner',
    })
  })

  test('the Idempotency-Key header is required here too', async () => {
    const { post } = await setup()
    const { 'idempotency-key': _omitted, ...withoutKey } = (await setup()).internal()

    const { status } = await post('/internal/membership', { userId: newUserId() }, withoutKey)

    expect(status).toBe(400)
  })

  test.each([
    ['no user id', {}],
    ['a user id that is not one', { userId: 'someone' }],
    ['an extra key', { userId: `usr_${'a'.repeat(32)}`, organizationId: newOrganizationId() }],
  ])('a body with %s is refused', async (_name, body) => {
    const { post } = await setup()

    expect((await post('/internal/membership', body)).status).toBe(400)
  })
})

describe('the codes the internal calls may return', () => {
  test('every domain code across the scenarios is one the contract lists for that call', async () => {
    const { post, store, internal } = await setup()
    const seeded = await seedOrganization(store, ['rep'])
    const rep = seeded.members[1]
    const seen = { createOrganization: new Set<string>(), membership: new Set<string>() }
    const note = (call: keyof typeof seen, body: Record<string, unknown>) => {
      const code = (body.error as { code?: string } | undefined)?.code
      if (code !== undefined && !COMMON_CODES.has(code)) {
        seen[call].add(code)
      }
    }

    // Creating: fresh, replayed, already a member, owner of a suspended Organization, bad input.
    const fresh = newUserId()
    note('createOrganization', (await post('/internal/organizations', create(fresh))).body)
    note('createOrganization', (await post('/internal/organizations', create(fresh))).body)
    note(
      'createOrganization',
      (await post('/internal/organizations', create(rep?.userId ?? ''))).body
    )
    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    note(
      'createOrganization',
      (await post('/internal/organizations', create(seeded.owner.userId))).body
    )
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    note(
      'createOrganization',
      (await post('/internal/organizations', create(seeded.owner.userId))).body
    )
    note('createOrganization', (await post('/internal/organizations', {})).body)
    note(
      'createOrganization',
      (await post('/internal/organizations', create(fresh), internal('x'))).body
    )

    // Looking up: unknown, active, deleted, bad input.
    note('membership', (await post('/internal/membership', { userId: newUserId() })).body)
    note('membership', (await post('/internal/membership', { userId: fresh })).body)
    note('membership', (await post('/internal/membership', { userId: seeded.owner.userId })).body)
    note('membership', (await post('/internal/membership', {})).body)

    for (const code of seen.createOrganization) {
      expect(INTERNAL_CALL_ERRORS.createOrganization).toContain(code as never)
    }
    for (const code of seen.membership) {
      expect(INTERNAL_CALL_ERRORS.membership).toContain(code as never)
    }
    expect([...seen.createOrganization]).toEqual(['membership.already_member'])
    expect([...seen.membership]).toEqual([])
  })
})

describe('who may call the internal routes', () => {
  const calls = [
    ['/internal/organizations', { userId: `usr_${'a'.repeat(32)}`, organizationName: 'A' }],
    ['/internal/membership', { userId: `usr_${'a'.repeat(32)}` }],
  ] as const

  test.each(calls)('%s refuses a request with no secret', async (path, body) => {
    const { app, store } = await setup()

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k'.repeat(20) },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'auth.unauthenticated'
    )
    expect(store.organizationCount()).toBe(0)
  })

  test.each(calls)('%s refuses a wrong secret and an almost right one', async (path, body) => {
    const { app, internal, store } = await setup()

    for (const secret of [
      'a-completely-wrong-secret-of-length-ok',
      TEST_INTERNAL_SECRET.slice(0, -1),
      `${TEST_INTERNAL_SECRET}x`,
      TEST_INTERNAL_SECRET.toLowerCase().replace('-a', '-z'),
      TEST_INTERNAL_SECRET_NEXT,
    ]) {
      const response = await app.request(path, {
        method: 'POST',
        headers: internal(undefined, secret),
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(401)
    }
    expect(store.organizationCount()).toBe(0)
  })

  test.each(calls)('%s refuses a valid user access token', async (path, body) => {
    const { app, bearer, internal, store } = await setup()
    const seeded = await seedOrganization(store)
    const token = await bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: 'owner',
    })

    const response = await app.request(path, {
      method: 'POST',
      headers: { ...internal(), ...token },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(401)
  })

  test('a secret added for rotation is accepted beside the current one', async () => {
    const rotating = await createTestApp({
      env: { INTERNAL_API_TOKENS: `${TEST_INTERNAL_SECRET},${TEST_INTERNAL_SECRET_NEXT}` },
    })

    for (const secret of [TEST_INTERNAL_SECRET, TEST_INTERNAL_SECRET_NEXT]) {
      const response = await rotating.app.request('/internal/membership', {
        method: 'POST',
        headers: rotating.internal(undefined, secret),
        body: JSON.stringify({ userId: newUserId() }),
      })
      expect(response.status).toBe(200)
    }
  })

  test('accepting an Invitation is not served here yet', async () => {
    const { app, internal } = await setup()

    const response = await app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: internal(),
      body: '{}',
    })

    expect(response.status).toBe(404)
  })
})

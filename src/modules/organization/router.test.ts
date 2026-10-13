import { describe, expect, test } from 'bun:test'
import { organizationSchema, ROLES, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, newUserId, seedOrganization, TEST_INTERNAL_SECRET } from '~/testing'

async function setup(extra: readonly Role[] = ['admin', 'manager', 'rep']) {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, extra, 'Acme')
  const as = async (role: Role, organizationId = seeded.organizationId) => {
    const member = seeded.members.find((m) => m.role === role)
    return harness.bearer({
      userId: member?.userId ?? newUserId(),
      organizationId,
      role,
    })
  }
  const send = async (method: string, headers: Record<string, string>, body?: unknown) => {
    const response = await harness.app.request('/v1/organization', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & { error?: { code: string } },
    }
  }
  return { ...harness, store, seeded, as, send }
}

describe('GET /v1/organization', () => {
  test.each([...ROLES])('a %s reads the Organization in their token', async (role) => {
    const { send, as, seeded } = await setup()

    const { status, body } = await send('GET', await as(role))

    expect(status).toBe(200)
    expect(organizationSchema.parse(body)).toEqual(body as never)
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'id', 'name', 'region', 'status', 'updatedAt'].sort()
    )
    expect(body).toMatchObject({
      id: seeded.organizationId,
      name: 'Acme',
      status: 'active',
      region: 'us',
    })
  })

  test('a suspended Organization can still be read', async () => {
    const { send, as, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const { status, body } = await send('GET', await as('rep'))

    expect(status).toBe(200)
    expect(body.status).toBe('suspended')
  })

  test('a deleted Organization is organization.deleted for everyone', async () => {
    const { send, as, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'deleted')

    const { status, body } = await send('GET', await as('owner'))

    expect(status).toBe(410)
    expect(body.error?.code).toBe('organization.deleted')
  })

  test('a token for an Organization that does not exist is organization.not_found', async () => {
    const { send, as } = await setup()
    const missing = `org_${'0'.repeat(32)}` as never

    const { status, body } = await send('GET', await as('owner', missing))

    expect(status).toBe(404)
    expect(body.error?.code).toBe('organization.not_found')
  })

  test('the Organization comes from the token alone, not from the query or a header', async () => {
    const { app, store, bearer, seeded } = await setup()
    const other = await seedOrganization(store, [], 'Other Co')
    const token = await bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: 'owner',
    })

    const response = await app.request(`/v1/organization?organizationId=${other.organizationId}`, {
      headers: { ...token, 'x-organization-id': other.organizationId },
    })

    expect(((await response.json()) as { id: string }).id).toBe(seeded.organizationId)
  })

  test('a second Organization reads only its own', async () => {
    const { send, store, bearer } = await setup()
    const other = await seedOrganization(store, [], 'Other Co')

    const { body } = await send(
      'GET',
      await bearer({
        userId: other.owner.userId,
        organizationId: other.organizationId,
        role: 'owner',
      })
    )

    expect(body).toMatchObject({ id: other.organizationId, name: 'Other Co' })
  })
})

describe('PATCH /v1/organization', () => {
  test.each(['owner', 'admin'] as const)('a %s renames the Organization', async (role) => {
    const { send, as, deps } = await setup()
    deps.clock.advance('10m')

    const { status, body } = await send('PATCH', await as(role), { name: '  New Name ' })

    expect(status).toBe(200)
    expect(body.name).toBe('New Name')
    expect(body.updatedAt).not.toBe(body.createdAt)
    expect((await send('GET', await as(role))).body.name).toBe('New Name')
  })

  test.each(['manager', 'rep'] as const)('a %s is refused with auth.forbidden', async (role) => {
    const { send, as } = await setup()

    const { status, body } = await send('PATCH', await as(role), { name: 'Nope' })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
    expect((await send('GET', await as('owner'))).body.name).toBe('Acme')
  })

  test('a suspended Organization refuses the rename with organization.suspended', async () => {
    const { send, as, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const { status, body } = await send('PATCH', await as('owner'), { name: 'Nope' })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('organization.suspended')
  })

  test('a deleted Organization refuses the rename with organization.deleted', async () => {
    const { send, as, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'deleted')

    const { status, body } = await send('PATCH', await as('owner'), { name: 'Nope' })

    expect(status).toBe(410)
    expect(body.error?.code).toBe('organization.deleted')
  })

  test('a Rep on a suspended Organization is told they are not allowed, not that it is suspended', async () => {
    const { send, as, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    expect((await send('PATCH', await as('rep'), { name: 'Nope' })).body.error?.code).toBe(
      'auth.forbidden'
    )
  })

  test.each([
    ['a blank name', { name: '   ' }],
    ['a name over 200 characters', { name: 'x'.repeat(201) }],
    ['a name with a control character', { name: 'A\u0000B' }],
    ['no name', {}],
    ['a status', { name: 'Fine', status: 'deleted' }],
    ['a Region', { name: 'Fine', region: 'eu' }],
    ['an id', { name: 'Fine', id: `org_${'a'.repeat(32)}` }],
  ])('a body with %s is refused as invalid', async (_name, body) => {
    const { send, as } = await setup()

    const answer = await send('PATCH', await as('owner'), body)

    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('request.invalid')
    expect((await send('GET', await as('owner'))).body).toMatchObject({
      name: 'Acme',
      region: 'us',
    })
  })

  test('renaming as another Organization changes only that Organization', async () => {
    const { send, as, store, bearer } = await setup()
    const other = await seedOrganization(store, [], 'Other Co')

    await send(
      'PATCH',
      await bearer({
        userId: other.owner.userId,
        organizationId: other.organizationId,
        role: 'owner',
      }),
      { name: 'Other Renamed' }
    )

    expect((await send('GET', await as('owner'))).body.name).toBe('Acme')
  })
})

describe('who may call the public routes', () => {
  test('no token is auth.unauthenticated', async () => {
    const { send } = await setup()

    const { status, body } = await send('GET', {})

    expect(status).toBe(401)
    expect(body.error?.code).toBe('auth.unauthenticated')
  })

  test('the internal secret is not an access token', async () => {
    const { send } = await setup()

    for (const method of ['GET', 'PATCH']) {
      const { status } = await send(
        method,
        { authorization: `Bearer ${TEST_INTERNAL_SECRET}` },
        { name: 'X' }
      )
      expect(status).toBe(401)
    }
  })

  test('a token signed by someone else is auth.token_invalid', async () => {
    const { send } = await setup()
    const stranger = await createTestApp()
    const forged = await stranger.bearer({
      userId: newUserId(),
      organizationId: `org_${'1'.repeat(32)}` as never,
      role: 'owner',
    })

    const { status, body } = await send('GET', forged)

    expect(status).toBe(401)
    expect(body.error?.code).toBe('auth.token_invalid')
  })
})

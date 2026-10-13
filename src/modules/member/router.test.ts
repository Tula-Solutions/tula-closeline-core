import { describe, expect, test } from 'bun:test'
import { listMembersResponseSchema, memberSchema, ROLES, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newMembershipId,
  newUserId,
  type SeededMember,
  seedOrganization,
} from '~/testing'

type Body = Record<string, unknown> & { error?: { code: string; message: string } }

async function setup(extra: readonly Role[] = ['admin', 'manager', 'rep']) {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, extra)
  const member = (role: Role, index = 0): SeededMember => {
    const found = seeded.members.filter((m) => m.role === role)[index]
    if (!found) {
      throw new Error(`no ${role} seeded`)
    }
    return found
  }
  /** Calls a member route as `actor`, who holds the role in their token. */
  const call = async (
    actor: SeededMember | { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    organizationId = seeded.organizationId
  ) => {
    const token = await harness.bearer({ userId: actor.userId, organizationId, role: actor.role })
    const response = await harness.app.request(`/v1${path}`, {
      method,
      headers: { ...token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as Body }
  }
  return { ...harness, store, seeded, member, call }
}

describe('GET /v1/members', () => {
  test.each([
    ['owner', 200],
    ['admin', 200],
    ['manager', 200],
    ['rep', 403],
  ] as const)('a %s gets %i', async (role, expected) => {
    const { call, member } = await setup()

    const { status, body } = await call(member(role), 'GET', '/members')

    expect(status).toBe(expected)
    if (expected === 403) {
      expect(body.error?.code).toBe('auth.forbidden')
    }
  })

  test('members come back in the contract shape and nothing else', async () => {
    const { call, member, seeded } = await setup()

    const { body } = await call(member('owner'), 'GET', '/members')

    const page = listMembersResponseSchema.parse(body)
    expect(page.items).toHaveLength(seeded.members.length)
    expect(page.nextCursor).toBeNull()
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'role', 'updatedAt', 'userId'])
    }
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor'])
  })

  test('pages follow their cursor to the end, once each, in id order', async () => {
    const { call, member, seeded } = await setup(['rep', 'rep', 'rep', 'rep', 'rep'])
    const seen: string[] = []
    let cursor: string | null = null

    for (let guard = 0; guard < 10; guard++) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      const page = listMembersResponseSchema.parse(
        (await call(member('owner'), 'GET', `/members${query}`)).body
      )
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual(seeded.members.map((m) => m.id).sort())
  })

  test('a page of exactly the limit has no next cursor', async () => {
    const { call, member, seeded } = await setup(['rep'])

    const { body } = await call(member('owner'), 'GET', `/members?limit=${seeded.members.length}`)

    expect(listMembersResponseSchema.parse(body).nextCursor).toBeNull()
  })

  test.each([
    ['a limit of 0', '?limit=0'],
    ['a limit over the maximum page size', '?limit=101'],
    ['a limit that is not a number', '?limit=many'],
    ['a cursor that is not one', '?cursor=%25%25%25'],
    ['a cursor that decodes to the wrong thing', `?cursor=${btoa('{"after":1}')}`],
    ['an unknown query key', '?organizationId=org_x'],
  ])('%s is refused as invalid', async (_name, query) => {
    const { call, member } = await setup()

    const { status, body } = await call(member('owner'), 'GET', `/members${query}`)

    expect(status).toBe(400)
    expect(body.error?.code).toBe('request.invalid')
  })

  test('a suspended Organization still lists its members; a deleted one does not', async () => {
    const { call, member, store, seeded } = await setup()

    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    expect((await call(member('owner'), 'GET', '/members')).status).toBe(200)
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await call(member('owner'), 'GET', '/members')

    expect(deleted.status).toBe(410)
    expect(deleted.body.error?.code).toBe('organization.deleted')
  })

  test('a second Organization lists only its own members, even with the first one’s cursor', async () => {
    const { call, store, seeded, member } = await setup()
    const other = await seedOrganization(store, ['rep'])
    const firstPage = await call(member('owner'), 'GET', '/members?limit=1')
    const cursor = (firstPage.body as { nextCursor: string }).nextCursor

    const { body } = await call(
      other.owner,
      'GET',
      `/members?cursor=${cursor}`,
      undefined,
      other.organizationId
    )

    const ids = listMembersResponseSchema.parse(body).items.map((item) => item.id)
    expect(ids.every((id) => other.members.some((m) => m.id === id))).toBe(true)
    expect(ids.some((id) => seeded.members.some((m) => m.id === id))).toBe(false)
  })
})

describe('PATCH /v1/members/{membershipId}', () => {
  // [actor, target, new role, status, code]
  const matrix: [Role, Role, Role, number][] = [
    ['owner', 'admin', 'rep', 200],
    ['owner', 'rep', 'owner', 200],
    ['owner', 'manager', 'admin', 200],
    ['admin', 'manager', 'rep', 200],
    ['admin', 'rep', 'manager', 200],
    ['admin', 'rep', 'admin', 403],
    ['admin', 'rep', 'owner', 403],
    ['admin', 'admin', 'rep', 403],
    ['admin', 'owner', 'rep', 403],
    ['manager', 'rep', 'manager', 403],
    ['rep', 'rep', 'manager', 403],
  ]

  test.each(matrix)(
    'a %s changing a %s to %s answers %i',
    async (actor, target, role, expected) => {
      const { call, member, seeded } = await setup([
        'admin',
        'admin',
        'manager',
        'manager',
        'rep',
        'rep',
      ])
      // Two Admins are seeded so an Admin can act on another Admin; the actor is the first.
      const targetMember = target === actor ? member(target, 1) : member(target)

      const { status, body } = await call(member(actor), 'PATCH', `/members/${targetMember.id}`, {
        role,
      })

      expect(status).toBe(expected)
      if (expected === 200) {
        expect(memberSchema.parse(body)).toEqual(body as never)
        expect(body).toMatchObject({ id: targetMember.id, role })
      } else {
        expect(body.error?.code).toBe('auth.forbidden')
        const list = await call(member('owner'), 'GET', '/members?limit=100')
        const stored = (list.body as { items: { id: string; role: Role }[] }).items.find(
          (item) => item.id === targetMember.id
        )
        expect(stored?.role).toBe(target)
      }
      expect(seeded.organizationId).toBeDefined()
    }
  )

  test('changing to the role a member already has changes nothing and succeeds', async () => {
    const { call, member, deps } = await setup()
    const rep = member('rep')
    const before = (await call(member('owner'), 'PATCH', `/members/${rep.id}`, { role: 'rep' }))
      .body
    deps.clock.advance('1h')

    const { status, body } = await call(member('owner'), 'PATCH', `/members/${rep.id}`, {
      role: 'rep',
    })

    expect(status).toBe(200)
    expect(body).toEqual(before)
  })

  test('an Owner promoting someone to Owner is how ownership passes', async () => {
    const { call, member } = await setup()
    const owner = member('owner')
    const admin = member('admin')

    expect((await call(owner, 'PATCH', `/members/${admin.id}`, { role: 'owner' })).status).toBe(200)
    // Now the first Owner may be demoted by the second.
    const second = { userId: admin.userId, role: 'owner' as const }
    const demoted = await call(second, 'PATCH', `/members/${owner.id}`, { role: 'admin' })

    expect(demoted.status).toBe(200)
    expect(demoted.body).toMatchObject({ id: owner.id, role: 'admin' })
  })

  test.each([...ROLES])('a %s cannot change their own role', async (role) => {
    const { call, member } = await setup()
    const self = member(role)

    const { status, body } = await call(self, 'PATCH', `/members/${self.id}`, { role: 'rep' })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
  })

  test('the last Owner cannot be demoted: a stale token cannot do it', async () => {
    const { call, member, store, seeded } = await setup(['rep'])
    const owner = member('owner')
    const rep = member('rep')
    // The rep's token still says Owner (it is refreshed within minutes of a demotion); the
    // database says rep, and the only real Owner would be left with nobody.
    const staleOwner = { userId: rep.userId, role: 'owner' as const }

    const { status, body } = await call(staleOwner, 'PATCH', `/members/${owner.id}`, {
      role: 'admin',
    })

    expect(status).toBe(409)
    expect(body.error?.code).toBe('member.last_owner')
    const still = await store.withOrganization(seeded.organizationId, (s) =>
      s.getMembership(owner.id)
    )
    expect(still?.role).toBe('owner')
  })

  test('a member that does not exist, and one of another Organization, look the same', async () => {
    const { call, member, store } = await setup()
    const other = await seedOrganization(store, ['rep'])
    const foreign = other.members[1]

    const absent = await call(member('owner'), 'PATCH', `/members/${newMembershipId()}`, {
      role: 'rep',
    })
    const elsewhere = await call(member('owner'), 'PATCH', `/members/${foreign?.id}`, {
      role: 'admin',
    })

    expect(absent.status).toBe(404)
    expect(absent.body.error?.code).toBe('member.not_found')
    expect(elsewhere).toEqual(absent)
    const untouched = await call(other.owner, 'GET', '/members', undefined, other.organizationId)
    const roles = (untouched.body as { items: { id: string; role: Role }[] }).items
    expect(roles.find((m) => m.id === foreign?.id)?.role).toBe('rep')
  })

  test('a Manager asking about a member that does not exist is told they are not allowed', async () => {
    const { call, member } = await setup()

    const { status, body } = await call(
      member('manager'),
      'PATCH',
      `/members/${newMembershipId()}`,
      {
        role: 'rep',
      }
    )

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
  })

  test('a suspended Organization refuses the change; a deleted one says it is deleted', async () => {
    const { call, member, store, seeded } = await setup()
    const rep = member('rep')

    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    const suspended = await call(member('owner'), 'PATCH', `/members/${rep.id}`, {
      role: 'manager',
    })
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await call(member('owner'), 'PATCH', `/members/${rep.id}`, { role: 'manager' })

    expect([suspended.status, suspended.body.error?.code]).toEqual([403, 'organization.suspended'])
    expect([deleted.status, deleted.body.error?.code]).toEqual([410, 'organization.deleted'])
  })

  test.each([
    ['a role that does not exist', { role: 'superuser' }],
    ['no role', {}],
    ['an extra key', { role: 'rep', userId: `usr_${'a'.repeat(32)}` }],
  ])('a body with %s is refused as invalid', async (_name, body) => {
    const { call, member } = await setup()

    const answer = await call(member('owner'), 'PATCH', `/members/${member('rep').id}`, body)

    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('request.invalid')
  })

  test('an id that is not a Membership id is refused as invalid', async () => {
    const { call, member } = await setup()

    const answer = await call(member('owner'), 'PATCH', '/members/not-an-id', { role: 'rep' })

    expect(answer.status).toBe(400)
  })

  test('a user id is not a Membership id', async () => {
    const { call, member } = await setup()

    const answer = await call(member('owner'), 'PATCH', `/members/${newUserId()}`, { role: 'rep' })

    expect(answer.status).toBe(400)
  })
})

describe('DELETE /v1/members/{membershipId}', () => {
  const matrix: [Role, Role, number][] = [
    ['owner', 'admin', 204],
    ['owner', 'manager', 204],
    ['owner', 'rep', 204],
    ['admin', 'manager', 204],
    ['admin', 'rep', 204],
    ['admin', 'admin', 403],
    ['admin', 'owner', 403],
    ['manager', 'rep', 403],
    ['rep', 'rep', 403],
  ]

  test.each(matrix)('a %s removing a %s answers %i', async (actor, target, expected) => {
    const { call, member } = await setup(['admin', 'admin', 'manager', 'manager', 'rep', 'rep'])
    const targetMember = target === actor ? member(target, 1) : member(target)

    const { status, body } = await call(member(actor), 'DELETE', `/members/${targetMember.id}`)

    expect(status).toBe(expected)
    const ids = (
      (await call(member('owner'), 'GET', '/members?limit=100')).body as {
        items: { id: string }[]
      }
    ).items.map((item) => item.id)
    if (expected === 204) {
      expect(body).toBeNull()
      expect(ids).not.toContain(targetMember.id)
    } else {
      expect(body.error?.code).toBe('auth.forbidden')
      expect(ids).toContain(targetMember.id)
    }
  })

  test.each([...ROLES])('a %s cannot remove themselves', async (role) => {
    const { call, member } = await setup()
    const self = member(role)

    const { status, body } = await call(self, 'DELETE', `/members/${self.id}`)

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
  })

  test('the last Owner cannot be removed: a stale token cannot do it', async () => {
    const { call, member, store, seeded } = await setup(['rep'])
    const owner = member('owner')
    const staleOwner = { userId: member('rep').userId, role: 'owner' as const }

    const { status, body } = await call(staleOwner, 'DELETE', `/members/${owner.id}`)

    expect(status).toBe(409)
    expect(body.error?.code).toBe('member.last_owner')
    expect(
      await store.withOrganization(seeded.organizationId, (s) => s.getMembership(owner.id))
    ).not.toBeNull()
  })

  test('a removed member is freed to belong to another Organization', async () => {
    const { call, member, store } = await setup()
    const rep = member('rep')
    await call(member('owner'), 'DELETE', `/members/${rep.id}`)

    expect(await store.organizationOfUser(rep.userId)).toBeNull()
  })

  test('removing twice is not found the second time', async () => {
    const { call, member } = await setup()
    const rep = member('rep')
    await call(member('owner'), 'DELETE', `/members/${rep.id}`)

    const { status, body } = await call(member('owner'), 'DELETE', `/members/${rep.id}`)

    expect(status).toBe(404)
    expect(body.error?.code).toBe('member.not_found')
  })

  test('a member of another Organization is not found, and is not removed', async () => {
    const { call, member, store } = await setup()
    const other = await seedOrganization(store, ['rep'])
    const foreign = other.members[1]

    const { status, body } = await call(member('owner'), 'DELETE', `/members/${foreign?.id}`)

    expect([status, body.error?.code]).toEqual([404, 'member.not_found'])
    expect(await store.organizationOfUser(foreign?.userId ?? newUserId())).not.toBeNull()
  })

  test('a suspended Organization refuses the removal; a deleted one says it is deleted', async () => {
    const { call, member, store, seeded } = await setup()
    const rep = member('rep')

    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    const suspended = await call(member('owner'), 'DELETE', `/members/${rep.id}`)
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await call(member('owner'), 'DELETE', `/members/${rep.id}`)

    expect([suspended.status, suspended.body.error?.code]).toEqual([403, 'organization.suspended'])
    expect([deleted.status, deleted.body.error?.code]).toEqual([410, 'organization.deleted'])
  })
})

describe('the member routes need an access token', () => {
  test.each([
    ['GET', '/v1/members'],
    ['PATCH', `/v1/members/mem_${'a'.repeat(32)}`],
    ['DELETE', `/v1/members/mem_${'a'.repeat(32)}`],
  ])('%s %s without one is auth.unauthenticated', async (method, path) => {
    const { app } = await setup()

    const response = await app.request(path, { method })

    expect(response.status).toBe(401)
    expect(((await response.json()) as Body).error?.code).toBe('auth.unauthenticated')
  })
})

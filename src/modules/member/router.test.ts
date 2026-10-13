import { describe, expect, test } from 'bun:test'
import { listMembersResponseSchema, memberSchema, ROLES, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { type CoreStore, LastOwnerError, LockTimeoutError } from '~/ports/core-store'
import {
  createTestApp,
  newMembershipId,
  newUserId,
  recordStore,
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

  test('a stale Owner token cannot demote anyone: the caller’s role is read again', async () => {
    const { call, member, store, seeded } = await setup(['rep'])
    const owner = member('owner')
    // The rep's token still says Owner (it is refreshed within minutes of a demotion); the
    // database says rep.
    const staleOwner = { userId: member('rep').userId, role: 'owner' as const }

    const { status, body } = await call(staleOwner, 'PATCH', `/members/${owner.id}`, {
      role: 'admin',
    })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
    const still = await store.withOrganization(seeded.organizationId, (s) =>
      s.getMembership(owner.id)
    )
    expect(still?.role).toBe('owner')
  })

  test('the store’s last-Owner refusal is answered member.last_owner', async () => {
    const memory = createMemoryCoreStore()
    const refusing: CoreStore = {
      organizationOfUser: (userId) => memory.organizationOfUser(userId),
      withOrganization: (id, fn) =>
        memory.withOrganization(id, (scope) =>
          fn({
            ...scope,
            setRole: async () => {
              throw new LastOwnerError()
            },
          })
        ),
    }
    const harness = await createTestApp({ store: refusing })
    const seeded = await seedOrganization(memory, ['owner'])
    const [first, second] = seeded.members as [SeededMember, SeededMember]
    const token = await harness.bearer({
      userId: first.userId,
      organizationId: seeded.organizationId,
      role: 'owner',
    })

    const response = await harness.app.request(`/v1/members/${second.id}`, {
      method: 'PATCH',
      headers: { ...token, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    })

    expect(response.status).toBe(409)
    expect(((await response.json()) as Body).error?.code).toBe('member.last_owner')
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

  test('a stale Owner token cannot remove anyone: the caller’s role is read again', async () => {
    const { call, member, store, seeded } = await setup(['rep'])
    const owner = member('owner')
    const staleOwner = { userId: member('rep').userId, role: 'owner' as const }

    const { status, body } = await call(staleOwner, 'DELETE', `/members/${owner.id}`)

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
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

describe('a caller whose Membership changed after their token was issued', () => {
  const writes = (rep: SeededMember, manager: SeededMember) =>
    [
      ['PATCH', '/organization', { name: 'Hijacked' }],
      ['PATCH', `/members/${manager.id}`, { role: 'rep' }],
      ['DELETE', `/members/${rep.id}`, undefined],
    ] as const

  test('a removed Admin is refused on every write and can still read', async () => {
    const { call, member, seeded } = await setup()
    const admin = member('admin')
    await call(member('owner'), 'DELETE', `/members/${admin.id}`)

    for (const [method, path, body] of writes(member('rep'), member('manager'))) {
      const answer = await call(admin, method, path, body)
      expect([method, path, answer.status, answer.body.error?.code]).toEqual([
        method,
        path,
        403,
        'auth.forbidden',
      ])
    }
    expect((await call(admin, 'GET', '/organization')).status).toBe(200)
    expect((await call(admin, 'GET', '/members')).status).toBe(200)
    const stored = await call(member('owner'), 'GET', '/members?limit=100')
    expect((stored.body as { items: unknown[] }).items).toHaveLength(seeded.members.length - 1)
  })

  test('an Admin demoted to Rep is refused on every write', async () => {
    const { call, member } = await setup()
    const admin = member('admin')
    await call(member('owner'), 'PATCH', `/members/${admin.id}`, { role: 'rep' })

    for (const [method, path, body] of writes(member('rep'), member('manager'))) {
      const answer = await call(admin, method, path, body)
      expect([method, path, answer.status]).toEqual([method, path, 403])
    }
    expect((await call(admin, 'GET', '/organization')).status).toBe(200)
  })

  test('an Owner demoted to Admin loses the power over Owners and Admins, not over Reps', async () => {
    const { call, member } = await setup(['owner', 'admin', 'rep'])
    const demoted = member('owner', 1)
    await call(member('owner'), 'PATCH', `/members/${demoted.id}`, { role: 'admin' })

    const overOwner = await call(demoted, 'DELETE', `/members/${member('owner').id}`)
    const overAdmin = await call(demoted, 'PATCH', `/members/${member('admin').id}`, {
      role: 'rep',
    })
    const overRep = await call(demoted, 'DELETE', `/members/${member('rep').id}`)

    expect([overOwner.status, overAdmin.status, overRep.status]).toEqual([403, 403, 204])
  })

  test('a caller named by the token but a member of no one is refused, not found', async () => {
    const { call, member } = await setup()

    const answer = await call(
      { userId: newUserId(), role: 'owner' },
      'DELETE',
      `/members/${member('rep').id}`
    )

    expect([answer.status, answer.body.error?.code]).toEqual([403, 'auth.forbidden'])
  })

  test('a write reads the Organization and the caller before the target, all under the locks', async () => {
    const memory = createMemoryCoreStore()
    const recorded = recordStore(memory)
    const harness = await createTestApp({ store: recorded.store })
    const seeded = await seedOrganization(memory, ['admin', 'rep'])
    const [, admin, rep] = seeded.members as [SeededMember, SeededMember, SeededMember]
    const token = await harness.bearer({
      userId: admin.userId,
      organizationId: seeded.organizationId,
      role: 'admin',
    })
    const headers = { ...token, 'content-type': 'application/json' }

    await harness.app.request(`/v1/members/${rep.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: 'manager' }),
    })
    const change = [...recorded.calls]
    recorded.calls.length = 0
    await harness.app.request(`/v1/members/${rep.id}`, { method: 'DELETE', headers })
    const removal = [...recorded.calls]
    recorded.calls.length = 0
    await harness.app.request('/v1/organization', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Renamed' }),
    })
    const rename = [...recorded.calls]
    recorded.calls.length = 0
    await harness.app.request('/v1/members', { headers })
    const list = [...recorded.calls]

    expect(change).toEqual(['lockOrganization', 'getMembershipByUser', 'lockMembership', 'setRole'])
    expect(removal).toEqual([
      'lockOrganization',
      'getMembershipByUser',
      'lockMembership',
      'deleteMembership',
    ])
    expect(rename).toEqual(['lockOrganization', 'getMembershipByUser', 'renameOrganization'])
    expect(list).toEqual(['getOrganization', 'listMembers'])
  })
})

describe('a caller promoted after their token was issued', () => {
  test('a Manager promoted to Admin has every Admin write, with a Manager token', async () => {
    const { call, member } = await setup(['admin', 'manager', 'manager', 'rep', 'rep'])
    const promoted = member('manager')
    await call(member('owner'), 'PATCH', `/members/${promoted.id}`, { role: 'admin' })
    const stale = { userId: promoted.userId, role: 'manager' as const }

    const rename = await call(stale, 'PATCH', '/organization', { name: 'Renamed' })
    const change = await call(stale, 'PATCH', `/members/${member('rep').id}`, { role: 'manager' })
    const removal = await call(stale, 'DELETE', `/members/${member('rep', 1).id}`)

    expect([rename.status, change.status, removal.status]).toEqual([200, 200, 204])
  })

  test('a Rep made an Owner takes ownership over, with a Rep token', async () => {
    const { call, member } = await setup(['admin', 'rep'])
    const heir = member('rep')
    await call(member('owner'), 'PATCH', `/members/${heir.id}`, { role: 'owner' })
    const stale = { userId: heir.userId, role: 'rep' as const }

    const demoteOld = await call(stale, 'PATCH', `/members/${member('owner').id}`, {
      role: 'admin',
    })
    const removeAdmin = await call(stale, 'DELETE', `/members/${member('admin').id}`)
    const rename = await call(stale, 'PATCH', '/organization', { name: 'Heir Co' })

    expect([demoteOld.status, removeAdmin.status, rename.status]).toEqual([200, 204, 200])
  })

  test('an Admin made an Owner, with an Admin token, may demote the Owner who promoted them', async () => {
    const { call, member } = await setup(['admin'])
    const heir = member('admin')
    await call(member('owner'), 'PATCH', `/members/${heir.id}`, { role: 'owner' })

    const { status } = await call(
      { userId: heir.userId, role: 'admin' },
      'PATCH',
      `/members/${member('owner').id}`,
      { role: 'rep' }
    )

    expect(status).toBe(200)
  })
})

describe('a lock that cannot be had in time', () => {
  test('answers server.unavailable with Retry-After, and is not reported as a server fault', async () => {
    const memory = createMemoryCoreStore()
    const timingOut: CoreStore = {
      organizationOfUser: (userId) => memory.organizationOfUser(userId),
      withOrganization: (id, fn) =>
        memory.withOrganization(id, (scope) =>
          fn({
            ...scope,
            lockOrganization: async () => {
              throw new LockTimeoutError()
            },
          })
        ),
    }
    const harness = await createTestApp({ store: timingOut })
    const seeded = await seedOrganization(memory)
    const token = await harness.bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: 'owner',
    })

    const response = await harness.app.request('/v1/organization', {
      method: 'PATCH',
      headers: { ...token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Slow' }),
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(((await response.json()) as Body).error?.code).toBe('server.unavailable')
    expect(harness.deps.reported).toHaveLength(0)
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

import { describe, expect, test } from 'bun:test'
import {
  formatId,
  listTeamsResponseSchema,
  ROLES,
  type Role,
  teamMemberSchema,
  teamSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { TeamNameTakenError } from '~/ports/core-store'
import {
  createTestApp,
  newMembershipId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

async function setup(extra: readonly Role[] = ['admin', 'manager', 'rep']) {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, extra)
  const member = (role: Role): SeededMember => {
    const found = seeded.members.find((m) => m.role === role)
    if (!found) {
      throw new Error(`no ${role} seeded`)
    }
    return found
  }
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body)
  const owner = member('owner')
  const create = async (name: string) =>
    teamSchema.parse((await call(owner, 'POST', '/teams', { name })).body)
  return { ...harness, store, seeded, member, call, create, owner }
}

describe('who may do what', () => {
  const allowedFor = (roles: readonly Role[], ok: number) =>
    ROLES.map((role) => [role, roles.includes(role) ? ok : 403] as const)

  test.each(allowedFor(['owner', 'admin', 'manager', 'rep'], 200))(
    'a %s listing Teams gets %i',
    async (role, expected) => {
      const { call, member } = await setup()

      expect((await call(member(role), 'GET', '/teams')).status).toBe(expected)
    }
  )

  test.each(allowedFor(['owner', 'admin'], 201))(
    'a %s creating a Team gets %i',
    async (role, expected) => {
      const { call, member } = await setup()

      const { status, body } = await call(member(role), 'POST', '/teams', { name: 'Sales' })

      expect(status).toBe(expected)
      if (expected === 403) {
        expect(body.error?.code).toBe('auth.forbidden')
      }
    }
  )

  test.each(allowedFor(['owner', 'admin'], 200))(
    'a %s renaming a Team gets %i',
    async (role, expected) => {
      const { call, member, create } = await setup()
      const team = await create('Sales')

      const { status } = await call(member(role), 'PATCH', `/teams/${team.id}`, { name: 'Revenue' })

      expect(status).toBe(expected)
    }
  )

  test.each(allowedFor(['owner', 'admin'], 204))(
    'a %s deleting a Team gets %i',
    async (role, expected) => {
      const { call, member, create } = await setup()
      const team = await create('Sales')

      const { status } = await call(member(role), 'DELETE', `/teams/${team.id}`)

      expect(status).toBe(expected)
    }
  )

  test.each(allowedFor(['owner', 'admin'], 200))(
    'a %s adding a Team member gets %i',
    async (role, expected) => {
      const { call, member, create } = await setup()
      const team = await create('Sales')

      const { status } = await call(member(role), 'POST', `/teams/${team.id}/members`, {
        membershipId: member('rep').id,
      })

      expect(status).toBe(expected)
    }
  )

  test.each(allowedFor(['owner', 'admin'], 204))(
    'a %s removing a Team member gets %i',
    async (role, expected) => {
      const { call, member, create, owner } = await setup()
      const team = await create('Sales')
      await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: member('rep').id })

      const { status } = await call(
        member(role),
        'DELETE',
        `/teams/${team.id}/members/${member('rep').id}`
      )

      expect(status).toBe(expected)
    }
  )

  test('the role is read again from the database: a demoted Admin with an old token may not write', async () => {
    const { call, member, store, seeded } = await setup()
    const admin = member('admin')
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.setRole(admin.id, 'rep', new Date())
    })

    const { status, body } = await call(admin, 'POST', '/teams', { name: 'Sales' })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
  })

  test('a suspended Organization refuses every Team write but still lists; a deleted one refuses all', async () => {
    const { call, owner, create, store, seeded, member } = await setup()
    const team = await create('Sales')
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const results = await Promise.all([
      call(owner, 'POST', '/teams', { name: 'New' }),
      call(owner, 'PATCH', `/teams/${team.id}`, { name: 'Renamed' }),
      call(owner, 'DELETE', `/teams/${team.id}`),
      call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: member('rep').id }),
      call(owner, 'DELETE', `/teams/${team.id}/members/${member('rep').id}`),
    ])
    const list = await call(owner, 'GET', '/teams')
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await call(owner, 'GET', '/teams')

    for (const result of results) {
      expect(result.status).toBe(403)
      expect(result.body.error?.code).toBe('organization.suspended')
    }
    expect(list.status).toBe(200)
    expect(deleted.status).toBe(410)
    expect(deleted.body.error?.code).toBe('organization.deleted')
  })
})

describe('Teams', () => {
  test('a Team is created, listed, renamed and deleted, in the contract shape', async () => {
    const { call, owner } = await setup()

    const created = await call(owner, 'POST', '/teams', { name: '  Sales  ' })
    const team = teamSchema.parse(created.body)
    const renamed = await call(owner, 'PATCH', `/teams/${team.id}`, { name: 'Revenue' })
    const listed = await call(owner, 'GET', '/teams')
    const deleted = await call(owner, 'DELETE', `/teams/${team.id}`)
    const after = await call(owner, 'GET', '/teams')

    expect(created.status).toBe(201)
    expect(Object.keys(created.body).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt'])
    expect(team.name).toBe('Sales')
    expect(renamed.body).toMatchObject({ id: team.id, name: 'Revenue' })
    expect(listTeamsResponseSchema.parse(listed.body).items.map((t) => t.name)).toEqual(['Revenue'])
    expect(deleted.status).toBe(204)
    expect(listTeamsResponseSchema.parse(after.body).items).toEqual([])
  })

  test('a name already taken, ignoring ASCII case, is team.name_taken, on create and on rename', async () => {
    const { call, owner, create } = await setup()
    await create('Sales')
    const support = await create('Support')

    const created = await call(owner, 'POST', '/teams', { name: 'SALES' })
    const renamed = await call(owner, 'PATCH', `/teams/${support.id}`, { name: 'sales' })
    const own = await call(owner, 'PATCH', `/teams/${support.id}`, { name: 'SUPPORT' })
    const mixedCase = await call(owner, 'POST', '/teams', { name: 'sAles' })

    expect(created.status).toBe(409)
    expect(created.body.error?.code).toBe('team.name_taken')
    expect(renamed.status).toBe(409)
    expect(renamed.body.error?.code).toBe('team.name_taken')
    expect(own.status).toBe(200)
    expect(mixedCase.status).toBe(409)
  })

  test('letters beyond ASCII are not folded: É and é are different names', async () => {
    const { call, owner } = await setup()

    const first = await call(owner, 'POST', '/teams', { name: 'Équipe' })
    const second = await call(owner, 'POST', '/teams', { name: 'équipe' })

    expect([first.status, second.status]).toEqual([201, 201])
  })

  test('the store’s own refusal of a taken name is answered the same', async () => {
    const { store, seeded, owner } = await setup()
    const real = {
      ...store,
      withOrganization: (id: never, fn: never) =>
        store.withOrganization(id, (scope) =>
          (fn as (s: unknown) => Promise<unknown>)({
            ...scope,
            insertTeam: async () => {
              throw new TeamNameTakenError()
            },
          })
        ),
    }
    const harness = await createTestApp({ store: real as never })

    const { status, body } = await publicCaller(harness)(
      owner,
      seeded.organizationId,
      'POST',
      '/teams',
      { name: 'Sales' }
    )

    expect(status).toBe(409)
    expect(body.error?.code).toBe('team.name_taken')
  })

  test.each([
    ['no name', {}],
    ['an empty name', { name: '   ' }],
    ['a name over 200 characters', { name: 'x'.repeat(201) }],
    ['a name with a control character', { name: 'a\u0000b' }],
    ['an unknown key', { name: 'Sales', organizationId: 'org_x' }],
  ])('creating a Team with %s is refused as invalid', async (_name, payload) => {
    const { call, owner } = await setup()

    const { status, body } = await call(owner, 'POST', '/teams', payload)

    expect(status).toBe(400)
    expect(body.error?.code).toBe('request.invalid')
  })

  test('pages follow their cursor to the end, once each', async () => {
    const { call, owner, create } = await setup()
    const ids = []
    for (let index = 0; index < 5; index++) {
      ids.push((await create(`Team ${index}`)).id)
    }
    const seen: string[] = []
    let cursor: string | null = null

    for (let guard = 0; guard < 10; guard++) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      const page = listTeamsResponseSchema.parse((await call(owner, 'GET', `/teams${query}`)).body)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual([...ids].sort())
  })

  test.each([
    ['a limit of 0', '?limit=0'],
    ['a limit over the maximum', '?limit=101'],
    ['a cursor that is not one', '?cursor=%25%25%25'],
    ['an unknown key', '?name=x'],
  ])('listing with %s is refused as invalid', async (_name, query) => {
    const { call, owner } = await setup()

    expect((await call(owner, 'GET', `/teams${query}`)).status).toBe(400)
  })
})

describe('Team members', () => {
  test('a member is added, and adding again succeeds with the same place', async () => {
    const { call, owner, create, member } = await setup()
    const team = await create('Sales')
    const rep = member('rep')

    const first = await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })
    const again = await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })

    expect(first.status).toBe(200)
    expect(teamMemberSchema.parse(first.body)).toMatchObject({
      teamId: team.id,
      membershipId: rep.id,
    })
    expect(again).toEqual(first)
  })

  test('removing a member who is in the Team succeeds once; one who is not in it is member.not_found', async () => {
    const { call, owner, create, member } = await setup()
    const team = await create('Sales')
    const rep = member('rep')
    await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })

    const removed = await call(owner, 'DELETE', `/teams/${team.id}/members/${rep.id}`)
    const again = await call(owner, 'DELETE', `/teams/${team.id}/members/${rep.id}`)
    const never = await call(owner, 'DELETE', `/teams/${team.id}/members/${member('manager').id}`)

    expect(removed.status).toBe(204)
    expect(again.status).toBe(404)
    expect(again.body.error?.code).toBe('member.not_found')
    expect(never).toEqual(again)
  })

  test('a failed removal changes nothing: the other places stay', async () => {
    const { call, owner, create, member } = await setup()
    const team = await create('Sales')
    const rep = member('rep')
    const manager = member('manager')
    await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })

    const miss = await call(owner, 'DELETE', `/teams/${team.id}/members/${manager.id}`)
    const again = await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })

    expect(miss.status).toBe(404)
    expect(again.status).toBe(200)
  })

  test('deleting a Team with members removes the places and keeps the members', async () => {
    const { call, owner, create, member, store, seeded } = await setup()
    const team = await create('Sales')
    for (const role of ['rep', 'manager'] as const) {
      await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: member(role).id })
    }

    const deleted = await call(owner, 'DELETE', `/teams/${team.id}`)
    const members = await store.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    const again = await create('Sales')
    const readd = await call(owner, 'POST', `/teams/${again.id}/members`, {
      membershipId: member('rep').id,
    })

    expect(deleted.status).toBe(204)
    expect(members).toHaveLength(seeded.members.length)
    expect(readd.status).toBe(200)
  })

  test('removing a member from the Organization takes them out of their Teams', async () => {
    const { call, owner, create, member, store, seeded } = await setup()
    const team = await create('Sales')
    const rep = member('rep')
    await call(owner, 'POST', `/teams/${team.id}/members`, { membershipId: rep.id })

    await call(owner, 'DELETE', `/members/${rep.id}`)

    const left = await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      return s.removeTeamMember(teamIdOf(team.id), rep.id)
    })
    expect(left).toBe(false)
  })

  test('a Team or a member that is not there is team.not_found or member.not_found', async () => {
    const { call, owner, create } = await setup()
    const team = await create('Sales')
    const nobody = newMembershipId()
    const noTeam = formatId('team', crypto.randomUUID())

    const noMember = await call(owner, 'POST', `/teams/${team.id}/members`, {
      membershipId: nobody,
    })
    const noTeamAdd = await call(owner, 'POST', `/teams/${noTeam}/members`, {
      membershipId: nobody,
    })
    const noMemberRemove = await call(owner, 'DELETE', `/teams/${team.id}/members/${nobody}`)
    const noTeamRemove = await call(owner, 'DELETE', `/teams/${noTeam}/members/${nobody}`)
    const noTeamRename = await call(owner, 'PATCH', `/teams/${noTeam}`, { name: 'X' })
    const noTeamDelete = await call(owner, 'DELETE', `/teams/${noTeam}`)

    expect(noMember.status).toBe(404)
    expect(noMember.body.error?.code).toBe('member.not_found')
    expect(noMemberRemove).toEqual(noMember)
    for (const result of [noTeamAdd, noTeamRemove, noTeamRename, noTeamDelete]) {
      expect(result.status).toBe(404)
      expect(result.body.error?.code).toBe('team.not_found')
    }
  })
})

describe('a second Organization can read, change or join nothing of the first', () => {
  test('on every Team route, and indistinguishably from what does not exist', async () => {
    const { call, create, member, store, deps } = await setup()
    const team = await create('Sales')
    const rep = member('rep')
    const other = await seedOrganization(store, ['rep'], 'Other')
    const stranger = other.owner
    const theirs = other.organizationId
    const ghostTeam = formatId('team', crypto.randomUUID())
    const ghostMember = newMembershipId()

    const list = await call(stranger, 'GET', '/teams', undefined, theirs)
    const rename = await call(stranger, 'PATCH', `/teams/${team.id}`, { name: 'Mine' }, theirs)
    const renameGhost = await call(
      stranger,
      'PATCH',
      `/teams/${ghostTeam}`,
      { name: 'Mine' },
      theirs
    )
    const remove = await call(stranger, 'DELETE', `/teams/${team.id}`, undefined, theirs)
    const removeGhost = await call(stranger, 'DELETE', `/teams/${ghostTeam}`, undefined, theirs)
    const join = await call(
      stranger,
      'POST',
      `/teams/${team.id}/members`,
      { membershipId: other.members[1]?.id },
      theirs
    )
    const joinGhost = await call(
      stranger,
      'POST',
      `/teams/${ghostTeam}/members`,
      { membershipId: other.members[1]?.id },
      theirs
    )
    const pullIn = await call(
      stranger,
      'POST',
      `/teams/${team.id}/members`,
      { membershipId: rep.id },
      theirs
    )
    const pullInGhost = await call(
      stranger,
      'POST',
      `/teams/${ghostTeam}/members`,
      { membershipId: ghostMember },
      theirs
    )
    const unjoin = await call(
      stranger,
      'DELETE',
      `/teams/${team.id}/members/${rep.id}`,
      undefined,
      theirs
    )
    const ownTeam = teamSchema.parse(
      (await call(stranger, 'POST', '/teams', { name: 'Sales' }, theirs)).body
    )
    const useOwnTeamForTheirMember = await call(
      stranger,
      'POST',
      `/teams/${ownTeam.id}/members`,
      { membershipId: rep.id },
      theirs
    )

    expect(listTeamsResponseSchema.parse(list.body).items).toEqual([])
    expect(rename).toEqual(renameGhost)
    expect(remove).toEqual(removeGhost)
    expect(join).toEqual(joinGhost)
    expect(pullIn.status).toBe(404)
    expect(pullIn).toEqual(pullInGhost)
    expect(pullIn.body.error?.code).toBe('team.not_found')
    expect(unjoin.body.error?.code).toBe('team.not_found')
    // Their own Team and their own member who never joined it: not found, not a removal.
    const notInOwnTeam = await call(
      stranger,
      'DELETE',
      `/teams/${ownTeam.id}/members/${other.members[1]?.id}`,
      undefined,
      theirs
    )
    expect(notInOwnTeam.status).toBe(404)
    expect(notInOwnTeam.body.error?.code).toBe('member.not_found')
    expect(useOwnTeamForTheirMember.status).toBe(404)
    expect(useOwnTeamForTheirMember.body.error?.code).toBe('member.not_found')
    const mine = await call(member('owner'), 'GET', '/teams')
    expect(listTeamsResponseSchema.parse(mine.body).items).toEqual([team])
    expect(deps.reported).toEqual([])
  })

  test('a cursor from the first Organization lists nothing of it in the second', async () => {
    const { call, create, owner, store } = await setup()
    await create('A')
    await create('B')
    const first = await call(owner, 'GET', '/teams?limit=1')
    const cursor = (first.body as { nextCursor: string }).nextCursor
    const other = await seedOrganization(store, [])

    const { body } = await call(
      other.owner,
      'GET',
      `/teams?cursor=${cursor}`,
      undefined,
      other.organizationId
    )

    expect(listTeamsResponseSchema.parse(body).items).toEqual([])
  })
})

test('the public routes need an access token, and the internal secret is not one', async () => {
  const { app, internal } = await setup()

  expect((await app.request('/v1/teams')).status).toBe(401)
  expect((await app.request('/v1/teams', { headers: internal() })).status).toBe(401)
})

function teamIdOf(id: string) {
  return formatId('team', id.slice('team_'.length))
}

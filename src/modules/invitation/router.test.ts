import { describe, expect, test } from 'bun:test'
import {
  formatId,
  INVITABLE_ROLES,
  type InvitableRole,
  invitationSchema,
  listInvitationsResponseSchema,
  type OrganizationId,
  ROLES,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { type CoreStore, LockTimeoutError } from '~/ports/core-store'
import {
  createTestApp,
  publicCaller,
  recordStore,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { invitationLink } from './link'
import { hashToken, INVITATION_TTL_MS, MAX_PENDING_INVITATIONS } from './token'

const DAY_MS = 24 * 60 * 60 * 1000

async function setup(extra: readonly Role[] = ['admin', 'manager', 'rep'], env = {}) {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store, env })
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
  const invite = (email: string, role: InvitableRole = 'rep', teamId?: string) =>
    call(member('owner'), 'POST', '/invitations', {
      email,
      role,
      ...(teamId === undefined ? {} : { teamId }),
    })
  return { ...harness, store, seeded, member, call, invite }
}

describe('who may do what', () => {
  const create = ROLES.flatMap((actor) =>
    INVITABLE_ROLES.map((offered) => {
      const allowed =
        actor === 'owner' || (actor === 'admin' && (offered === 'manager' || offered === 'rep'))
      return [actor, offered, allowed ? 201 : 403] as const
    })
  )

  test.each(create)('a %s inviting for %s gets %i', async (actor, offered, expected) => {
    const { call, member, deps } = await setup()

    const { status, body } = await call(member(actor), 'POST', '/invitations', {
      email: 'new@example.com',
      role: offered,
    })

    expect(status).toBe(expected)
    if (expected === 403) {
      expect(body.error?.code).toBe('auth.forbidden')
      expect(deps.mail.outbox).toHaveLength(0)
    }
  })

  test.each(
    ROLES.map((actor) => [actor, actor === 'owner' || actor === 'admin' ? 200 : 403] as const)
  )('a %s listing Invitations gets %i', async (actor, expected) => {
    const { call, member } = await setup()

    const { status, body } = await call(member(actor), 'GET', '/invitations')

    expect(status).toBe(expected)
    if (expected === 403) {
      expect(body.error?.code).toBe('auth.forbidden')
    }
  })

  const revoke = ROLES.flatMap((actor) =>
    INVITABLE_ROLES.map((offered) => {
      const allowed =
        actor === 'owner' || (actor === 'admin' && (offered === 'manager' || offered === 'rep'))
      return [actor, offered, allowed ? 204 : 403] as const
    })
  )

  test.each(revoke)(
    'a %s revoking an Invitation for %s gets %i',
    async (actor, offered, expected) => {
      const { call, member, invite } = await setup()
      const made = await invite('target@example.com', offered)
      const id = invitationSchema.parse(made.body).id

      const { status } = await call(member(actor), 'DELETE', `/invitations/${id}`)

      expect(status).toBe(expected)
      const left = await call(member('owner'), 'GET', '/invitations')
      expect(listInvitationsResponseSchema.parse(left.body).items).toHaveLength(
        expected === 204 ? 0 : 1
      )
    }
  )

  test('the role is read again from the database: a demoted Admin with an old token may not invite', async () => {
    const { call, member, store, seeded } = await setup()
    const admin = member('admin')
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.setRole(admin.id, 'rep', new Date())
    })

    const { status, body } = await call(admin, 'POST', '/invitations', {
      email: 'x@example.com',
      role: 'rep',
    })

    expect(status).toBe(403)
    expect(body.error?.code).toBe('auth.forbidden')
  })

  test('a suspended Organization refuses to invite or revoke but still lists; a deleted one refuses all', async () => {
    const { call, member, invite, store, seeded } = await setup()
    const made = await invite('a@example.com')
    const id = invitationSchema.parse(made.body).id

    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    const owner = member('owner')
    const create = await call(owner, 'POST', '/invitations', {
      email: 'b@example.com',
      role: 'rep',
    })
    const revoke = await call(owner, 'DELETE', `/invitations/${id}`)
    const list = await call(owner, 'GET', '/invitations')
    store.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await call(owner, 'GET', '/invitations')

    expect(create.status).toBe(403)
    expect(create.body.error?.code).toBe('organization.suspended')
    expect(revoke.body.error?.code).toBe('organization.suspended')
    expect(list.status).toBe(200)
    expect(deleted.status).toBe(410)
    expect(deleted.body.error?.code).toBe('organization.deleted')
  })
})

describe('POST /v1/invitations', () => {
  test('creates a pending Invitation in the contract shape, valid for 7 days, and nothing else', async () => {
    const { invite, deps, member } = await setup()

    const { status, body } = await invite('New.Person@Example.COM', 'manager')

    expect(status).toBe(201)
    const invitation = invitationSchema.parse(body)
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'email',
      'expiresAt',
      'id',
      'invitedByUserId',
      'role',
      'state',
      'teamId',
    ])
    expect(invitation).toMatchObject({
      email: 'new.person@example.com',
      role: 'manager',
      teamId: null,
      state: 'pending',
      invitedByUserId: member('owner').userId,
    })
    expect(
      new Date(invitation.expiresAt).getTime() - new Date(invitation.createdAt).getTime()
    ).toBe(INVITATION_TTL_MS)
    expect(INVITATION_TTL_MS).toBe(7 * DAY_MS)
    expect(deps.mail.outbox).toHaveLength(1)
  })

  test('hands the mail adapter the address, role, Organization name, token, link and expiry', async () => {
    const { invite, deps } = await setup()

    const { body } = await invite('new@example.com', 'rep')

    const message = deps.mail.last()
    expect(message).toMatchObject({
      email: 'new@example.com',
      role: 'rep',
      organizationName: 'Acme',
      link: invitationLink('https://app.test', message.token),
      expiresAt: new Date(invitationSchema.parse(body).expiresAt),
    })
    expect(message.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new URL(message.link).hash).toBe(`#invitation=${message.token}`)
  })

  test('the token is in no response, no log line and nothing reported, and the store knows only its hash', async () => {
    const { invite, call, member, deps, store, seeded } = await setup()

    const created = await invite('new@example.com')
    const listed = await call(member('owner'), 'GET', '/invitations')
    const second = await invite('new@example.com')
    const { token, link } = deps.mail.last()

    for (const text of [JSON.stringify(created), JSON.stringify(listed), JSON.stringify(second)]) {
      expect(text).not.toContain(token)
    }
    const logged = deps.logLines.join('\n')
    expect(logged).not.toContain(token)
    expect(logged).not.toContain(link)
    expect(JSON.stringify(deps.reported)).not.toContain(token)
    const stored = await store.withOrganization(seeded.organizationId, (s) =>
      s.getInvitationByTokenHash(hashToken(token))
    )
    expect(stored?.email).toBe('new@example.com')
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  test('every Invitation gets a different token', async () => {
    const { invite, deps } = await setup()

    for (let index = 0; index < 5; index++) {
      await invite(`user${index}@example.com`)
    }

    expect(new Set(deps.mail.outbox.map((m) => m.token)).size).toBe(5)
  })

  test('an internationalised domain is converted to its ASCII form', async () => {
    const { invite, deps } = await setup()

    const { status, body } = await invite('Ana@Bücher.example')

    expect(status).toBe(201)
    expect(body.email).toBe('ana@xn--bcher-kva.example')
    expect(deps.mail.last().email).toBe('ana@xn--bcher-kva.example')
  })

  test.each([
    ['no email', { role: 'rep' }],
    ['an email that is not one', { email: 'nobody', role: 'rep' }],
    ['a non-ASCII local part', { email: 'bücher@example.com', role: 'rep' }],
    ['the Owner role', { email: 'a@example.com', role: 'owner' }],
    ['an unknown role', { email: 'a@example.com', role: 'god' }],
    ['an unknown key', { email: 'a@example.com', role: 'rep', organizationId: 'org_x' }],
    ['a team id that is not one', { email: 'a@example.com', role: 'rep', teamId: 'nope' }],
  ])('%s is refused as invalid', async (_name, payload) => {
    const { call, member, deps } = await setup()

    const { status, body } = await call(member('owner'), 'POST', '/invitations', payload)

    expect(status).toBe(400)
    expect(body.error?.code).toBe('request.invalid')
    expect(deps.mail.outbox).toHaveLength(0)
  })

  test('a second pending Invitation for the same email, in any case, is invitation.already_pending', async () => {
    const { invite, deps } = await setup()
    await invite('same@example.com')

    const again = await invite('SAME@example.com', 'manager')

    expect(again.status).toBe(409)
    expect(again.body.error?.code).toBe('invitation.already_pending')
    expect(deps.mail.outbox).toHaveLength(1)
  })

  test('the store’s own refusal of a second pending Invitation is answered the same', async () => {
    const { invite, store, seeded, member } = await setup()
    const racing = {
      ...store,
      withOrganization: (id: never, fn: never) =>
        store.withOrganization(id, (scope) =>
          (fn as (s: unknown) => Promise<unknown>)({
            ...scope,
            lockPendingInvitationByEmail: async () => null,
          })
        ),
    }
    await invite('same@example.com')
    const harness = await createTestApp({ store: racing as never })
    const call = publicCaller(harness)

    const { status, body } = await call(
      member('owner'),
      seeded.organizationId,
      'POST',
      '/invitations',
      {
        email: 'same@example.com',
        role: 'rep',
      }
    )

    expect(status).toBe(409)
    expect(body.error?.code).toBe('invitation.already_pending')
  })

  test('an expired pending Invitation for the email is revoked to make room for a new one', async () => {
    const { invite, call, member, deps } = await setup()
    const first = await invite('again@example.com')
    deps.clock.advance('8d')

    const second = await invite('again@example.com')

    expect(second.status).toBe(201)
    const pending = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations')).body
    )
    expect(pending.items.map((i) => i.id)).toEqual([invitationSchema.parse(second.body).id])
    const revoked = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations?state=revoked')).body
    )
    expect(revoked.items.map((i) => i.id)).toEqual([invitationSchema.parse(first.body).id])
  })

  test('an Invitation names a Team of the Organization, and one that is not there is team.not_found', async () => {
    const { invite, call, member, seeded, store } = await setup()
    const teamId = formatId('team', crypto.randomUUID())
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertTeam({ id: teamId, name: 'Sales', now: new Date() })
    })

    const ok = await invite('a@example.com', 'rep', teamId)
    const missing = await invite('b@example.com', 'rep', formatId('team', crypto.randomUUID()))
    const other = await seedOrganization(store, [])
    const foreignTeam = formatId('team', crypto.randomUUID())
    await store.withOrganization(other.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertTeam({ id: foreignTeam, name: 'Theirs', now: new Date() })
    })
    const foreign = await invite('c@example.com', 'rep', foreignTeam)

    expect(ok.status).toBe(201)
    expect(ok.body.teamId).toBe(teamId)
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('team.not_found')
    expect(foreign).toEqual(missing)
    const left = await call(member('owner'), 'GET', '/invitations')
    expect(listInvitationsResponseSchema.parse(left.body).items).toHaveLength(1)
  })

  test('the 1,001st pending Invitation is rate.limited, and a revoke makes room', async () => {
    const { invite, call, member, store, seeded } = await setup()
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      for (let index = 0; index < MAX_PENDING_INVITATIONS - 1; index++) {
        await scope.insertInvitation({
          id: formatId('inv', crypto.randomUUID()),
          email: `bulk${index}@example.com`,
          role: 'rep',
          teamId: null,
          invitedByUserId: seeded.owner.userId,
          tokenHash: hashToken(`bulk${index}`),
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          now: new Date('2026-01-01T00:00:00Z'),
        })
      }
    })

    const last = await invite('last@example.com')
    const over = await invite('over@example.com')
    const first = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations?limit=1')).body
    ).items[0]
    await call(member('owner'), 'DELETE', `/invitations/${first?.id}`)
    const afterRevoke = await invite('over@example.com')

    expect(last.status).toBe(201)
    expect(over.status).toBe(429)
    expect(over.body.error?.code).toBe('rate.limited')
    expect(afterRevoke.status).toBe(201)
  })

  /** Puts `count` pending Invitations in the Organization, each living until `expiresAt`. */
  async function seedPending(
    store: CoreStore,
    seeded: { organizationId: OrganizationId; owner: SeededMember },
    count: number,
    expiresAt: Date
  ) {
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      for (let index = 0; index < count; index++) {
        await scope.insertInvitation({
          id: formatId('inv', crypto.randomUUID()),
          email: `old${index}@example.com`,
          role: 'rep',
          teamId: null,
          invitedByUserId: seeded.owner.userId,
          tokenHash: hashToken(`old${index}`),
          expiresAt,
          now: new Date('2026-01-01T00:00:00Z'),
        })
      }
    })
  }

  test('1,000 expired pending Invitations do not lock the Organization out: a new address is invited, and at most 100 are revoked to make room', async () => {
    const { invite, store, seeded, deps } = await setup()
    await seedPending(store, seeded, MAX_PENDING_INVITATIONS, new Date('2026-01-08T00:00:00Z'))
    deps.clock.advance('8d')

    const made = await invite('new@example.com')

    expect(made.status).toBe(201)
    const counts = await store.withOrganization(seeded.organizationId, async (scope) => ({
      pending: await scope.countPendingInvitations(10_000),
      revoked: (await scope.listInvitations({ state: 'revoked', limit: 1000 })).length,
    }))
    expect(counts).toEqual({ pending: MAX_PENDING_INVITATIONS - 100 + 1, revoked: 100 })
  })

  test('1,000 unexpired pending Invitations still hold the cap, and nothing is revoked to get round it', async () => {
    const { invite, store, seeded } = await setup()
    await seedPending(store, seeded, MAX_PENDING_INVITATIONS, new Date('2027-01-01T00:00:00Z'))

    const over = await invite('over@example.com')

    expect(over.status).toBe(429)
    expect(over.body.error?.code).toBe('rate.limited')
    const revoked = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.listInvitations({ state: 'revoked', limit: 10 })
    )
    expect(revoked).toEqual([])
  })

  test('if the message cannot be handed over the Invitation is revoked and the answer is server.unavailable', async () => {
    const { invite, call, member, deps } = await setup()
    deps.mail.failing = true

    const failed = await invite('lost@example.com')
    deps.mail.failing = false
    const retried = await invite('lost@example.com')

    expect(failed.status).toBe(503)
    expect(failed.body.error?.code).toBe('server.unavailable')
    expect(retried.status).toBe(201)
    const pending = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations')).body
    )
    const revoked = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations?state=revoked')).body
    )
    expect(pending.items).toHaveLength(1)
    expect(revoked.items).toHaveLength(1)
    expect(revoked.items[0]?.email).toBe('lost@example.com')
    expect(deps.mail.outbox).toHaveLength(1)
  })

  test('a mail system that never answers is given up on, and the Invitation is revoked', async () => {
    const { invite, call, member, deps } = await setup(['admin'], {
      INVITATION_DELIVERY_TIMEOUT_MS: '20',
    })
    deps.mail.hanging = true

    const { status, body } = await invite('slow@example.com')

    expect(status).toBe(503)
    expect(body.error?.code).toBe('server.unavailable')
    const pending = await call(member('owner'), 'GET', '/invitations')
    expect(listInvitationsResponseSchema.parse(pending.body).items).toHaveLength(0)
  })

  /**
   * An Invitation app whose mail system is down, over a store whose transactions after the failed
   * delivery fail `timeouts` times with a lock timeout before they are let through.
   */
  async function appWhoseMailFailsThenLocksTimeOut(timeouts: number) {
    const memory = createMemoryCoreStore()
    let remaining = 0
    const transactions: string[] = []
    const store: CoreStore = {
      ...memory,
      withOrganization: (organizationId, fn) => {
        if (remaining > 0) {
          remaining -= 1
          transactions.push('timed out')
          return Promise.reject(new LockTimeoutError())
        }
        transactions.push('ran')
        return memory.withOrganization(organizationId, fn)
      },
    }
    const harness = await createTestApp({
      store,
      invitationMailer: {
        deliver: async () => {
          remaining = timeouts
          throw new Error('mail system unavailable')
        },
      },
    })
    const seeded = await seedOrganization(memory, [])
    const call = publicCaller(harness)
    const listed = async (state: 'pending' | 'revoked') =>
      listInvitationsResponseSchema.parse(
        (await call(seeded.owner, seeded.organizationId, 'GET', `/invitations?state=${state}`)).body
      ).items
    transactions.length = 0
    const invite = () =>
      call(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
        email: 'lost@example.com',
        role: 'rep',
      })
    return { harness, invite, listed, transactions }
  }

  test('a lock timeout while revoking an Invitation whose delivery failed is retried once, and the Invitation ends revoked', async () => {
    const { invite, listed, transactions } = await appWhoseMailFailsThenLocksTimeOut(1)

    const { status, body } = await invite()

    expect(status).toBe(503)
    expect(body.error?.code).toBe('server.unavailable')
    expect(await listed('pending')).toEqual([])
    expect(await listed('revoked')).toHaveLength(1)
    expect(transactions.slice(0, 3)).toEqual(['ran', 'timed out', 'ran'])
  })

  test('a second lock timeout is logged and the answer is still server.unavailable: two tries, not more', async () => {
    const { harness, invite, listed, transactions } = await appWhoseMailFailsThenLocksTimeOut(2)

    const { status, body } = await invite()

    expect(status).toBe(503)
    expect(body.error?.code).toBe('server.unavailable')
    expect(transactions.slice(0, 3)).toEqual(['ran', 'timed out', 'timed out'])
    expect(harness.deps.logLines.join('\n')).toContain('could not revoke an invitation')
    expect(await listed('pending')).toHaveLength(1)
  })

  test('create takes the Invitation lock before the Team lock, as accept does', async () => {
    const memory = createMemoryCoreStore()
    const recorded = recordStore(memory)
    const harness = await createTestApp({ store: recorded.store })
    memory.useClock(() => harness.deps.clock.now())
    const seeded = await seedOrganization(memory, [])
    const call = publicCaller(harness)
    const team = await call(seeded.owner, seeded.organizationId, 'POST', '/teams', {
      name: 'Sales',
    })
    recorded.calls.length = 0

    const made = await call(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
      email: 'new@example.com',
      role: 'rep',
      teamId: team.body.id,
    })
    const created = [...recorded.calls]
    recorded.calls.length = 0
    await harness.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({
        userId: formatId('usr', crypto.randomUUID()),
        email: 'new@example.com',
        invitationToken: harness.deps.mail.last().token,
      }),
    })

    expect(made.status).toBe(201)
    expect(created.indexOf('lockPendingInvitationByEmail')).toBeGreaterThan(-1)
    expect(created.indexOf('lockTeam')).toBeGreaterThan(
      created.indexOf('lockPendingInvitationByEmail')
    )
    expect(recorded.calls.indexOf('lockTeam')).toBeGreaterThan(
      recorded.calls.indexOf('lockInvitation')
    )
  })

  test('a failed delivery leaks neither the token nor the link into a response, a log or a report', async () => {
    const { invite, deps } = await setup()
    deps.mail.failing = true

    const failed = await invite('lost@example.com')

    const secrets = [...deps.logLines, JSON.stringify(failed), JSON.stringify(deps.reported)].join(
      '\n'
    )
    expect(secrets).not.toContain('invitation=')
    expect(secrets).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })
})

describe('GET /v1/invitations', () => {
  test('pending by default, oldest first, a page at a time to the end, once each', async () => {
    const { invite, call, member, deps } = await setup()
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      deps.clock.advance('1s')
      ids.push(invitationSchema.parse((await invite(`u${index}@example.com`)).body).id)
    }
    const seen: string[] = []
    let cursor: string | null = null

    for (let guard = 0; guard < 10; guard++) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      const page = listInvitationsResponseSchema.parse(
        (await call(member('owner'), 'GET', `/invitations${query}`)).body
      )
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual(ids)
  })

  test('the state filter picks revoked ones, and an expired one is still listed pending', async () => {
    const { invite, call, member, deps } = await setup()
    const a = invitationSchema.parse((await invite('a@example.com')).body)
    await invite('b@example.com')
    await call(member('owner'), 'DELETE', `/invitations/${a.id}`)
    deps.clock.advance('30d')

    const pending = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations')).body
    )
    const revoked = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations?state=revoked')).body
    )
    const accepted = listInvitationsResponseSchema.parse(
      (await call(member('owner'), 'GET', '/invitations?state=accepted')).body
    )

    expect(pending.items.map((i) => i.email)).toEqual(['b@example.com'])
    expect(revoked.items.map((i) => i.id)).toEqual([a.id])
    expect(accepted.items).toEqual([])
  })

  test.each([
    ['a limit of 0', '?limit=0'],
    ['a limit over the maximum page size', '?limit=101'],
    ['a cursor that is not one', '?cursor=%25%25%25'],
    ['a cursor that decodes to the wrong thing', `?cursor=${btoa('{"after":1}')}`],
    ['an unknown state', '?state=expired'],
    ['an unknown query key', '?organizationId=org_x'],
  ])('%s is refused as invalid', async (_name, query) => {
    const { call, member } = await setup()

    const { status, body } = await call(member('owner'), 'GET', `/invitations${query}`)

    expect(status).toBe(400)
    expect(body.error?.code).toBe('request.invalid')
  })
})

describe('DELETE /v1/invitations/{invitationId}', () => {
  test('revokes a pending Invitation, which then opens nothing', async () => {
    const { invite, call, member, store, deps } = await setup()
    const made = invitationSchema.parse((await invite('a@example.com')).body)
    const { token } = deps.mail.last()

    const { status } = await call(member('owner'), 'DELETE', `/invitations/${made.id}`)

    expect(status).toBe(204)
    expect(await store.invitationForToken(hashToken(token))).toBeNull()
  })

  test('revoking one that is revoked, unknown or not an id is not found or invalid', async () => {
    const { invite, call, member } = await setup()
    const made = invitationSchema.parse((await invite('a@example.com')).body)
    await call(member('owner'), 'DELETE', `/invitations/${made.id}`)

    const again = await call(member('owner'), 'DELETE', `/invitations/${made.id}`)
    const unknown = await call(
      member('owner'),
      'DELETE',
      `/invitations/${formatId('inv', crypto.randomUUID())}`
    )
    const malformed = await call(member('owner'), 'DELETE', '/invitations/nope')

    expect(again.status).toBe(404)
    expect(again.body.error?.code).toBe('invitation.not_found')
    expect(unknown).toEqual(again)
    expect(malformed.status).toBe(400)
  })

  test('an expired pending Invitation can be revoked', async () => {
    const { invite, call, member, deps } = await setup()
    const made = invitationSchema.parse((await invite('a@example.com')).body)
    deps.clock.advance('30d')

    const { status } = await call(member('owner'), 'DELETE', `/invitations/${made.id}`)

    expect(status).toBe(204)
  })
})

describe('a second Organization can read, revoke or learn of nothing of the first', () => {
  test('on every Invitation route', async () => {
    const { invite, call, member, store, deps } = await setup()
    const made = invitationSchema.parse((await invite('a@example.com')).body)
    const other = await seedOrganization(store, ['admin'], 'Other')
    const stranger = other.owner

    const list = await call(stranger, 'GET', '/invitations', undefined, other.organizationId)
    const revoke = await call(
      stranger,
      'DELETE',
      `/invitations/${made.id}`,
      undefined,
      other.organizationId
    )
    const missing = await call(
      stranger,
      'DELETE',
      `/invitations/${formatId('inv', crypto.randomUUID())}`,
      undefined,
      other.organizationId
    )
    const sameEmail = await call(
      stranger,
      'POST',
      '/invitations',
      { email: 'a@example.com', role: 'rep' },
      other.organizationId
    )
    const stillThere = await call(member('owner'), 'GET', '/invitations')

    expect(listInvitationsResponseSchema.parse(list.body).items).toEqual([])
    expect(revoke.status).toBe(404)
    expect(revoke).toEqual(missing)
    expect(sameEmail.status).toBe(201)
    expect(listInvitationsResponseSchema.parse(stillThere.body).items.map((i) => i.id)).toEqual([
      made.id,
    ])
    expect(deps.mail.outbox).toHaveLength(2)
  })

  test('a cursor from the first Organization lists nothing of it in the second', async () => {
    const { invite, call, member, store } = await setup()
    await invite('a@example.com')
    await invite('b@example.com')
    const first = await call(member('owner'), 'GET', '/invitations?limit=1')
    const cursor = (first.body as { nextCursor: string }).nextCursor
    const other = await seedOrganization(store, [])

    const { body } = await call(
      other.owner,
      'GET',
      `/invitations?cursor=${cursor}`,
      undefined,
      other.organizationId
    )

    expect(listInvitationsResponseSchema.parse(body).items).toEqual([])
  })
})

test('the public routes need an access token, and the internal secret is not one', async () => {
  const { app, internal } = await setup()

  const none = await app.request('/v1/invitations')
  const secret = await app.request('/v1/invitations', { headers: internal() })

  expect(none.status).toBe(401)
  expect(secret.status).toBe(401)
})

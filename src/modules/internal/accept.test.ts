import { describe, expect, test } from 'bun:test'
import {
  ERRORS,
  INTERNAL_CALL_ERRORS,
  type InvitableRole,
  internalAcceptInvitationResponseSchema,
  invitationSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { membershipIdFor } from '~/modules/invitation/token'
import { InvitationNotAcceptableError } from '~/ports/core-store'
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

async function setup(extra: readonly Role[] = ['admin']) {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, extra)
  const api = publicCaller(harness)

  /** An Owner invites `email`; returns the raw token the mail adapter was handed. */
  const invite = async (email: string, role: InvitableRole = 'rep', teamId?: string) => {
    const made = await api(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
      email,
      role,
      ...(teamId === undefined ? {} : { teamId }),
    })
    expect(made.status).toBe(201)
    return {
      token: harness.deps.mail.last().token,
      invitationId: invitationSchema.parse(made.body).id,
    }
  }

  const accept = async (
    body: { userId?: string; email?: string; invitationToken: string },
    headers: Record<string, string> = harness.internal()
  ) => {
    const response = await harness.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: newUserId(), email: 'new@example.com', ...body }),
    })
    return { status: response.status, body: (await response.json()) as ApiBody }
  }

  const membersOf = (organizationId = seeded.organizationId) =>
    store.withOrganization(organizationId, (scope) => scope.listMembers({ limit: 100 }))

  return { ...harness, store, seeded, api, invite, accept, membersOf }
}

describe('POST /internal/invitations/accept', () => {
  test('creates the Membership with the offered role, marks the Invitation accepted and answers with both', async () => {
    const { invite, accept, membersOf, seeded, store } = await setup()
    const { token, invitationId } = await invite('new@example.com', 'manager')
    const userId = newUserId()

    const { status, body } = await accept({ userId, invitationToken: token })

    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['organizationId', 'role'])
    expect(internalAcceptInvitationResponseSchema.parse(body)).toEqual({
      organizationId: seeded.organizationId,
      role: 'manager',
    })
    const members = await membersOf()
    expect(members.find((m) => m.userId === userId)).toMatchObject({
      role: 'manager',
      id: membershipIdFor(invitationId),
    })
    const accepted = await store.withOrganization(seeded.organizationId, (s) =>
      s.listInvitations({ state: 'accepted', limit: 10 })
    )
    expect(accepted.map((i) => i.id)).toEqual([invitationId])
  })

  test.each(['admin', 'manager', 'rep'] as const)(
    'an Invitation for %s makes a %s',
    async (role) => {
      const { invite, accept, membersOf } = await setup()
      const { token } = await invite('new@example.com', role)
      const userId = newUserId()

      const { body } = await accept({ userId, invitationToken: token })

      expect(body.role).toBe(role)
      expect((await membersOf()).find((m) => m.userId === userId)?.role).toBe(role)
    }
  )

  test('the address is compared folded and with an internationalised domain converted', async () => {
    const { invite, accept } = await setup()
    const plain = await invite('Mixed.Case@Example.com')
    const idn = await invite('ana@bücher.example')

    const first = await accept({ email: 'MIXED.case@EXAMPLE.com', invitationToken: plain.token })
    const second = await accept({ email: 'Ana@Bücher.example', invitationToken: idn.token })

    expect([first.status, second.status]).toEqual([200, 200])
  })

  test('an Invitation into a Team puts the new member in it', async () => {
    const { invite, accept, seeded, store, api } = await setup()
    const team = await api(seeded.owner, seeded.organizationId, 'POST', '/teams', { name: 'Sales' })
    const teamId = team.body.id as string
    const { token, invitationId } = await invite('new@example.com', 'rep', teamId)

    await accept({ invitationToken: token })

    const inTeam = await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.removeTeamMember(teamId as never, membershipIdFor(invitationId))
    })
    expect(inTeam).toBe(true)
  })

  test('an Invitation whose Team was deleted still makes the member, in no Team', async () => {
    const { invite, accept, seeded, api, membersOf } = await setup()
    const team = await api(seeded.owner, seeded.organizationId, 'POST', '/teams', { name: 'Sales' })
    const { token } = await invite('new@example.com', 'rep', team.body.id as string)
    await api(seeded.owner, seeded.organizationId, 'DELETE', `/teams/${team.body.id}`)

    const { status } = await accept({ invitationToken: token })

    expect(status).toBe(200)
    expect(await membersOf()).toHaveLength(seeded.members.length + 1)
  })

  test('the lock order holds: the Organization is locked before the Invitation, before any write', async () => {
    const memory = createMemoryCoreStore()
    const recorded = recordStore(memory)
    const harness = await createTestApp({ store: recorded.store })
    memory.useClock(() => harness.deps.clock.now())
    const seeded = await seedOrganization(memory, [])
    const api = publicCaller(harness)
    await api(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
      email: 'new@example.com',
      role: 'rep',
    })
    const { token } = harness.deps.mail.last()
    recorded.calls.length = 0

    const response = await harness.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({
        userId: newUserId(),
        email: 'new@example.com',
        invitationToken: token,
      }),
    })

    expect(response.status).toBe(200)
    expect(recorded.calls).toEqual([
      'lockOrganization',
      'lockInvitation',
      'insertMembership',
      'acceptInvitation',
    ])
  })
})

describe('invitation.invalid', () => {
  /** Every way an Invitation can be unusable, each producing its own token to try. */
  async function causes() {
    const h = await setup()
    const { invite, seeded, api, deps, store } = h
    const unknown = { name: 'an unknown token', token: 'x'.repeat(43), email: 'new@example.com' }

    const expired = await invite('expired@example.com')
    deps.clock.advance('8d')

    const revoked = await invite('revoked@example.com')
    await api(seeded.owner, seeded.organizationId, 'DELETE', `/invitations/${revoked.invitationId}`)

    const used = await invite('used@example.com')
    await h.accept({ email: 'used@example.com', invitationToken: used.token })

    const wrongEmail = await invite('right@example.com')

    const suspended = await invite('suspended@example.com')
    const other = await seedOrganization(store, [])
    const inactive = await (async () => {
      // An Invitation of a second Organization that is then suspended.
      const made = await api(other.owner, other.organizationId, 'POST', '/invitations', {
        email: 'inactive@example.com',
        role: 'rep',
      })
      expect(made.status).toBe(201)
      const token = deps.mail.last().token
      store.setOrganizationStatus(other.organizationId, 'suspended')
      return token
    })()
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const cases = [
      unknown,
      { name: 'an expired Invitation', token: expired.token, email: 'expired@example.com' },
      { name: 'a revoked Invitation', token: revoked.token, email: 'revoked@example.com' },
      { name: 'a used Invitation', token: used.token, email: 'used@example.com' },
      { name: 'a different address', token: wrongEmail.token, email: 'wrong@example.com' },
      {
        name: 'a suspended Organization',
        token: suspended.token,
        email: 'suspended@example.com',
      },
      { name: 'another suspended Organization', token: inactive, email: 'inactive@example.com' },
    ]
    return { h, cases, wrongEmail }
  }

  test('every cause is answered with the same status and body as an unknown token', async () => {
    const { h, cases } = await causes()
    const baseline = await h.accept({
      invitationToken: cases[0]?.token as string,
      email: cases[0]?.email as string,
    })

    expect(baseline.status).toBe(422)
    expect(baseline.body.error?.code).toBe('invitation.invalid')
    for (const found of cases) {
      const result = await h.accept({
        invitationToken: found.token,
        email: found.email,
      })
      expect({ cause: found.name, ...result }).toEqual({ cause: found.name, ...baseline })
    }
  })

  test('a deleted Organization is the same refusal', async () => {
    const { invite, accept, store, seeded } = await setup()
    const { token } = await invite('new@example.com')
    store.setOrganizationStatus(seeded.organizationId, 'deleted')

    const gone = await accept({ invitationToken: token })
    const unknown = await accept({ invitationToken: 'y'.repeat(43) })

    expect(gone).toEqual(unknown)
  })

  test('a refused accept creates nothing and consumes nothing: the right address still works after a wrong one', async () => {
    const { invite, accept, membersOf, seeded } = await setup()
    const { token } = await invite('right@example.com')
    const intruder = newUserId()

    const wrong = await accept({
      userId: intruder,
      email: 'wrong@example.com',
      invitationToken: token,
    })
    const right = await accept({ email: 'right@example.com', invitationToken: token })

    expect(wrong.status).toBe(422)
    expect(right.status).toBe(200)
    const members = await membersOf()
    expect(members).toHaveLength(seeded.members.length + 1)
    expect(members.some((m) => m.userId === intruder)).toBe(false)
  })

  test('a token that is not a token is a request error, not an Invitation error', async () => {
    const { accept } = await setup()

    const short = await accept({ invitationToken: 'short' })
    const symbols = await accept({ invitationToken: `${'a'.repeat(30)}!!!` })

    expect(short.status).toBe(400)
    expect(symbols.status).toBe(400)
    expect(short.body.error?.code).toBe('request.invalid')
  })
})

describe('a refusal by the store at the last moment', () => {
  test('an Invitation that expired between the lookup and the accept is the same invitation.invalid', async () => {
    const memory = createMemoryCoreStore()
    const racing = {
      ...memory,
      withOrganization: (id: never, fn: never) =>
        memory.withOrganization(id, (scope) =>
          (fn as (s: unknown) => Promise<unknown>)({
            ...scope,
            acceptInvitation: async () => {
              throw new InvitationNotAcceptableError()
            },
          })
        ),
    }
    const harness = await createTestApp({ store: racing as never })
    const seeded = await seedOrganization(memory, [])
    const api = publicCaller(harness)
    await api(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
      email: 'new@example.com',
      role: 'rep',
    })
    const { token } = harness.deps.mail.last()

    const response = await harness.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({
        userId: newUserId(),
        email: 'new@example.com',
        invitationToken: token,
      }),
    })

    expect(response.status).toBe(422)
    expect(((await response.json()) as ApiBody).error?.code).toBe('invitation.invalid')
    const members = await memory.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    expect(members).toHaveLength(1)
  })
})

describe('membership.already_member', () => {
  test('a user who belongs to another Organization is refused, and the Invitation stays usable', async () => {
    const { invite, accept, store, membersOf, seeded } = await setup()
    const { token } = await invite('new@example.com')
    const other = await seedOrganization(store, [])

    const refused = await accept({ userId: other.owner.userId, invitationToken: token })
    const later = await accept({ invitationToken: token })

    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe('membership.already_member')
    expect(later.status).toBe(200)
    expect(await membersOf()).toHaveLength(seeded.members.length + 1)
  })

  test('a user who already belongs to this Organization is refused', async () => {
    const { invite, accept, seeded } = await setup()
    const { token } = await invite('new@example.com')

    const { status, body } = await accept({
      userId: seeded.owner.userId,
      invitationToken: token,
    })

    expect(status).toBe(409)
    expect(body.error?.code).toBe('membership.already_member')
  })

  test('a wrong address is invalid before a member is told they are a member', async () => {
    const { invite, accept, seeded } = await setup()
    const { token } = await invite('new@example.com')

    const { status, body } = await accept({
      userId: seeded.owner.userId,
      email: 'someone.else@example.com',
      invitationToken: token,
    })

    expect(status).toBe(422)
    expect(body.error?.code).toBe('invitation.invalid')
  })
})

describe('the only codes this call returns are those in INTERNAL_CALL_ERRORS', () => {
  test('every domain code seen across success and every failure is in the exported list or is common', async () => {
    const { invite, accept, store, seeded, deps } = await setup()
    const seen = new Set<string>()
    const note = (r: { status: number; body: ApiBody }) => {
      seen.add(r.body.error?.code ?? 'ok')
    }

    const good = await invite('a@example.com')
    note(await accept({ invitationToken: 'z'.repeat(43) }))
    note(await accept({ email: 'other@example.com', invitationToken: good.token }))
    note(
      await accept({
        userId: seeded.owner.userId,
        email: 'a@example.com',
        invitationToken: good.token,
      })
    )
    note(await accept({ email: 'a@example.com', invitationToken: good.token }))
    note(await accept({ email: 'a@example.com', invitationToken: good.token }))
    note(await accept({ invitationToken: 'short' }))
    note(await accept({ invitationToken: good.token }, { 'content-type': 'application/json' }))
    store.setOrganizationStatus(seeded.organizationId, 'suspended')
    note(await accept({ invitationToken: 'z'.repeat(43) }))
    expect(deps.reported).toEqual([])

    const allowed = new Set<string>(INTERNAL_CALL_ERRORS.acceptInvitation)
    expect([...allowed].sort()).toEqual(['invitation.invalid', 'membership.already_member'])
    for (const code of seen) {
      expect(code === 'ok' || allowed.has(code) || COMMON_CODES.has(code)).toBe(true)
    }
    expect(seen.has('invitation.invalid')).toBe(true)
    expect(seen.has('membership.already_member')).toBe(true)
    expect(seen.has('organization.suspended')).toBe(false)
    expect(seen.has('organization.deleted')).toBe(false)
  })
})

describe('a retry by the user the Invitation was accepted for', () => {
  test('answers as the first call did and creates nothing more', async () => {
    const { invite, accept, membersOf, seeded } = await setup()
    const { token } = await invite('new@example.com', 'manager')
    const userId = newUserId()

    const first = await accept({ userId, invitationToken: token })
    const second = await accept({ userId, invitationToken: token })
    const third = await accept({ userId, email: 'NEW@example.com', invitationToken: token })

    expect(first.status).toBe(200)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(await membersOf()).toHaveLength(seeded.members.length + 1)
  })

  test('still answers as before after the member’s role changed', async () => {
    const { invite, accept, api, seeded } = await setup()
    const { token, invitationId } = await invite('new@example.com', 'rep')
    const userId = newUserId()
    const first = await accept({ userId, invitationToken: token })
    await api(
      seeded.owner,
      seeded.organizationId,
      'PATCH',
      `/members/${membershipIdFor(invitationId)}`,
      {
        role: 'admin',
      }
    )

    const again = await accept({ userId, invitationToken: token })

    expect(again).toEqual(first)
  })

  test('is invalid for a different user, a different address, or a member who has since been removed', async () => {
    const { invite, accept, api, seeded } = await setup()
    const { token, invitationId } = await invite('new@example.com')
    const userId = newUserId()
    await accept({ userId, invitationToken: token })

    const stranger = await accept({ invitationToken: token })
    const wrongEmail = await accept({ userId, email: 'other@example.com', invitationToken: token })
    await api(
      seeded.owner,
      seeded.organizationId,
      'DELETE',
      `/members/${membershipIdFor(invitationId)}`
    )
    const removed = await accept({ userId, invitationToken: token })

    for (const result of [stranger, wrongEmail, removed]) {
      expect(result.status).toBe(422)
      expect(result.body.error?.code).toBe('invitation.invalid')
    }
  })

  test('is invalid for an owner of the Organization who holds the token, and for a member of another Organization', async () => {
    const { invite, accept, store, seeded } = await setup()
    const { token } = await invite('new@example.com')
    await accept({ invitationToken: token })
    const other = await seedOrganization(store, [])

    const owner = await accept({ userId: seeded.owner.userId, invitationToken: token })
    const foreign = await accept({ userId: other.owner.userId, invitationToken: token })

    expect(owner.body.error?.code).toBe('invitation.invalid')
    expect(foreign.body.error?.code).toBe('invitation.invalid')
  })
})

describe('two accepts at once', () => {
  test('by different users leave exactly one Membership: one succeeds, the other is invalid', async () => {
    const { invite, accept, membersOf, seeded } = await setup()
    const { token } = await invite('new@example.com')

    const results = await Promise.all([
      accept({ userId: newUserId(), invitationToken: token }),
      accept({ userId: newUserId(), invitationToken: token }),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([200, 422])
    expect(results.find((r) => r.status === 422)?.body.error?.code).toBe('invitation.invalid')
    expect(await membersOf()).toHaveLength(seeded.members.length + 1)
  })

  test('by the same user leave one Membership and both succeed with the same answer', async () => {
    const { invite, accept, membersOf, seeded } = await setup()
    const { token } = await invite('new@example.com')
    const userId = newUserId()

    const [a, b] = await Promise.all([
      accept({ userId, invitationToken: token }),
      accept({ userId, invitationToken: token }),
    ])

    expect(a.status).toBe(200)
    expect(b).toEqual(a)
    expect(await membersOf()).toHaveLength(seeded.members.length + 1)
  })
})

describe('who may call it', () => {
  test('a user token is refused, as is no credential and a wrong secret', async () => {
    const { app, invite, bearer, seeded, internal } = await setup()
    const { token } = await invite('new@example.com')
    const body = JSON.stringify({
      userId: newUserId(),
      email: 'new@example.com',
      invitationToken: token,
    })
    const post = (headers: Record<string, string>) =>
      app.request('/internal/invitations/accept', { method: 'POST', headers, body })

    const user = await post({
      ...(await bearer({ ...seeded.owner, organizationId: seeded.organizationId })),
      'idempotency-key': 'key-0123456789abcdef',
      'content-type': 'application/json',
    })
    const none = await post({ 'content-type': 'application/json' })
    const wrong = await post(internal(undefined, `${TEST_INTERNAL_SECRET}-nope`))

    expect([user.status, none.status, wrong.status]).toEqual([401, 401, 401])
  })

  test('the Idempotency-Key header is required', async () => {
    const { app, internal } = await setup()
    const { 'idempotency-key': _key, ...withoutKey } = internal()

    const response = await app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: withoutKey,
      body: JSON.stringify({
        userId: newUserId(),
        email: 'a@example.com',
        invitationToken: 'a'.repeat(43),
      }),
    })

    expect(response.status).toBe(400)
  })
})

describe('secrecy', () => {
  test('the raw token appears in no response, log line or report of the accept', async () => {
    const { invite, accept, deps } = await setup()
    const { token } = await invite('new@example.com')

    const ok = await accept({ invitationToken: token })
    const replay = await accept({ invitationToken: token })

    for (const text of [
      JSON.stringify(ok),
      JSON.stringify(replay),
      deps.logLines.join('\n'),
      JSON.stringify(deps.reported),
    ]) {
      expect(text).not.toContain(token)
    }
  })

  test('an Organization id the caller has not got is never taken from the request', async () => {
    const { accept, invite } = await setup()
    const { token } = await invite('new@example.com')

    const response = await accept({
      invitationToken: token,
      ...({ organizationId: newOrganizationId() } as object),
    })

    expect(response.status).toBe(400)
  })
})

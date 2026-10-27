import { afterAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { OrganizationId, OrganizationStatus, Role, UserId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { organizations } from 'tula-closeline-db/schema'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { createApp } from '~/app'
import { createContainer } from '~/container'
import { loadEnv } from '~/env'
import { integrationUrls } from '~/integration-support'
import type { CoreStore, OrganizationScope } from '~/ports/core-store'
import {
  createTestApp,
  newMembershipId,
  newUserId,
  type SeededMember,
  seedOrganization,
  TEST_INTERNAL_SECRET,
} from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresCoreStore(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

type Body = Record<string, unknown> & { error?: { code: string } }

async function harness(over: CoreStore = store) {
  const app = await createTestApp({ store: over, env: { DATABASE_URL: urls.service } })

  const asMember = async (
    actor: { userId: UserId; role: Role },
    organizationId: OrganizationId,
    method: string,
    path: string,
    body?: unknown
  ) => {
    const token = await app.bearer({ userId: actor.userId, organizationId, role: actor.role })
    const response = await app.app.request(`/v1${path}`, {
      method,
      headers: { ...token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as Body,
      retryAfter: response.headers.get('retry-after'),
    }
  }

  const callInternal = async (path: string, body: unknown) => {
    const response = await app.app.request(path, {
      method: 'POST',
      headers: app.internal(),
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Body }
  }

  return { ...app, asMember, callInternal }
}

/** How many Organizations exist in the Region, from the status table only the owner can read. */
async function organizationCount(): Promise<number> {
  const { rows } = await owner.db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.organization_state`
  )
  return rows[0]?.n ?? 0
}

async function directoryRows(userId: UserId): Promise<number> {
  const { rows } = await owner.db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.membership_directory where user_id = ${userId}`
  )
  return rows[0]?.n ?? 0
}

function setStatus(organizationId: OrganizationId, status: OrganizationStatus) {
  return withOrganization(service.db, organizationId, async (tx) => {
    await tx
      .update(organizations)
      .set({ status })
      .where(eq(organizations.organizationId, organizationId))
  })
}

describe('a second Organization can read or change nothing of the first, on every public route', () => {
  async function twoOrganizations() {
    const h = await harness()
    const a = await seedOrganization(store, ['admin', 'rep'], 'Org A')
    const b = await seedOrganization(store, ['admin', 'rep'], 'Org B')
    return { h, a, b }
  }

  test('GET /v1/organization returns the caller’s own', async () => {
    const { h, a, b } = await twoOrganizations()

    const { body } = await h.asMember(b.owner, b.organizationId, 'GET', '/organization')

    expect(body).toMatchObject({ id: b.organizationId, name: 'Org B' })
    expect(JSON.stringify(body)).not.toContain(a.organizationId)
  })

  test('PATCH /v1/organization renames only the caller’s own', async () => {
    const { h, a, b } = await twoOrganizations()

    await h.asMember(b.owner, b.organizationId, 'PATCH', '/organization', { name: 'B Renamed' })

    expect((await h.asMember(a.owner, a.organizationId, 'GET', '/organization')).body.name).toBe(
      'Org A'
    )
    expect((await h.asMember(b.owner, b.organizationId, 'GET', '/organization')).body.name).toBe(
      'B Renamed'
    )
  })

  test('GET /v1/members lists only the caller’s own members', async () => {
    const { h, a, b } = await twoOrganizations()

    const { body } = await h.asMember(b.owner, b.organizationId, 'GET', '/members?limit=100')

    const ids = (body.items as { id: string }[]).map((item) => item.id).sort()
    expect(ids).toEqual(b.members.map((m) => m.id).sort())
    expect(ids.some((id) => a.members.some((m) => m.id === id))).toBe(false)
  })

  test.each([
    ['PATCH', { role: 'rep' }],
    ['DELETE', undefined],
  ] as const)(
    '%s /v1/members/{id} cannot reach a member of the first Organization',
    async (method, body) => {
      const { h, a, b } = await twoOrganizations()
      const target = a.members[2] as SeededMember

      const answer = await h.asMember(
        b.owner,
        b.organizationId,
        method,
        `/members/${target.id}`,
        body
      )

      expect(answer.status).toBe(404)
      expect(answer.body.error?.code).toBe('member.not_found')
      const stored = await store.withOrganization(a.organizationId, (s) =>
        s.getMembership(target.id)
      )
      expect(stored).toMatchObject({ id: target.id, role: target.role })
    }
  )

  test('a member id that exists nowhere is answered exactly like one in another Organization', async () => {
    const { h, a, b } = await twoOrganizations()
    const foreign = a.members[2] as SeededMember

    const absent = await h.asMember(
      b.owner,
      b.organizationId,
      'DELETE',
      `/members/${newMembershipId()}`
    )
    const elsewhere = await h.asMember(
      b.owner,
      b.organizationId,
      'DELETE',
      `/members/${foreign.id}`
    )

    expect(elsewhere).toEqual(absent)
  })
})

describe('the last Owner', () => {
  test('a stale Owner token cannot demote or remove the Owner: the caller’s role is read again', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['rep'])
    const stale = { userId: (seeded.members[1] as SeededMember).userId, role: 'owner' as const }

    const demote = await h.asMember(
      stale,
      seeded.organizationId,
      'PATCH',
      `/members/${seeded.owner.id}`,
      { role: 'admin' }
    )
    const remove = await h.asMember(
      stale,
      seeded.organizationId,
      'DELETE',
      `/members/${seeded.owner.id}`
    )

    expect([demote.status, demote.body.error?.code]).toEqual([403, 'auth.forbidden'])
    expect([remove.status, remove.body.error?.code]).toEqual([403, 'auth.forbidden'])
    const stillOwner = await store.withOrganization(seeded.organizationId, (s) =>
      s.getMembership(seeded.owner.id)
    )
    expect(stillOwner?.role).toBe('owner')
  })

  test('ownership passes by promoting first: then the first Owner can be demoted', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['admin'])
    const admin = seeded.members[1] as SeededMember

    const promote = await h.asMember(
      seeded.owner,
      seeded.organizationId,
      'PATCH',
      `/members/${admin.id}`,
      { role: 'owner' }
    )
    const demote = await h.asMember(
      { userId: admin.userId, role: 'owner' },
      seeded.organizationId,
      'PATCH',
      `/members/${seeded.owner.id}`,
      { role: 'admin' }
    )

    expect([promote.status, demote.status]).toEqual([200, 200])
  })

  test('two Owners removing each other at once leave an Organization with an Owner', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['owner'])
    const [first, second] = seeded.members as [SeededMember, SeededMember]

    const answers = await Promise.all([
      h.asMember(first, seeded.organizationId, 'DELETE', `/members/${second.id}`),
      h.asMember(second, seeded.organizationId, 'DELETE', `/members/${first.id}`),
    ])

    // The writes queue on the Organization: the second finds its caller already removed.
    expect(answers.map((a) => a.status).sort()).toEqual([204, 403])
    const left = await store.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    expect(left).toHaveLength(1)
    expect(left[0]?.role).toBe('owner')
  })
})

describe('Organization status', () => {
  test('a suspended Organization reads but refuses writes; a deleted one refuses everything', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['rep'])
    const rep = seeded.members[1] as SeededMember

    await setStatus(seeded.organizationId, 'suspended')
    const read = await h.asMember(seeded.owner, seeded.organizationId, 'GET', '/organization')
    const rename = await h.asMember(seeded.owner, seeded.organizationId, 'PATCH', '/organization', {
      name: 'X',
    })
    const remove = await h.asMember(
      seeded.owner,
      seeded.organizationId,
      'DELETE',
      `/members/${rep.id}`
    )
    await setStatus(seeded.organizationId, 'deleted')
    const gone = await h.asMember(seeded.owner, seeded.organizationId, 'GET', '/members')

    expect(read.status).toBe(200)
    expect([rename.status, rename.body.error?.code]).toEqual([403, 'organization.suspended'])
    expect([remove.status, remove.body.error?.code]).toEqual([403, 'organization.suspended'])
    expect([gone.status, gone.body.error?.code]).toEqual([410, 'organization.deleted'])
  })
})

/** A pause a test places inside a request, to let something else happen while it is held. */
type Gate = { reached: Promise<void>; release: () => void; store: CoreStore }

/**
 * Wraps `inner` so the first read of a member by id inside a transaction pauses, after the read
 * returns and before the caller does anything with it, until `release` is called. This is the
 * moment a check made on a stale read would be acted on.
 */
function gateAfterTargetRead(inner: CoreStore): Gate {
  let reach: () => void = () => undefined
  let release: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let paused = false
  const gated: CoreStore = {
    organizationOfUser: (userId) => inner.organizationOfUser(userId),
    invitationForToken: (tokenHash) => inner.invitationForToken(tokenHash),
    apiKeyForHash: (hash) => inner.apiKeyForHash(hash),
    consentFormForToken: (token) => inner.consentFormForToken(token),
    bookingTypeForToken: (hash) => inner.bookingTypeForToken(hash),
    withOrganization: (organizationId, fn) =>
      inner.withOrganization(organizationId, (scope) => {
        const pauseAfter =
          <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
          async (...args: A): Promise<R> => {
            const found = await read(...args)
            if (!paused) {
              paused = true
              reach()
              await released
            }
            return found
          }
        const wrapped: OrganizationScope = {
          ...scope,
          getMembership: pauseAfter(scope.getMembership),
          lockMembership: pauseAfter(scope.lockMembership),
        }
        return fn(wrapped)
      }),
  }
  return { reached, release, store: gated }
}

/** How many backends are waiting for a lock right now, from the catalog every login may read. */
async function backendsWaitingForALock(): Promise<number> {
  const { rows } = await owner.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_locks where not granted`
  )
  return rows[0]?.n ?? 0
}

/** Polls `condition` (which must query the database, so I/O is served between polls) until true. */
async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`)
    }
  }
}

describe('a write decides on current, locked data', () => {
  test.each([
    ['DELETE', undefined],
    ['PATCH', { role: 'rep' }],
  ] as const)(
    'an Admin’s %s of a Manager whom an Owner promotes to Admin meanwhile never lands on the Admin',
    async (method, body) => {
      const seeded = await seedOrganization(store, ['admin', 'manager'])
      const [, admin, manager] = seeded.members as [SeededMember, SeededMember, SeededMember]
      const gate = gateAfterTargetRead(store)
      const slow = await harness(gate.store)
      const quick = await harness()

      // The Admin has read the target as a Manager and is paused.
      const adminCall = slow.asMember(
        admin,
        seeded.organizationId,
        method,
        `/members/${manager.id}`,
        body
      )
      await gate.reached
      let ownerSettled = false
      const ownerCall = quick
        .asMember(seeded.owner, seeded.organizationId, 'PATCH', `/members/${manager.id}`, {
          role: 'admin',
        })
        .finally(() => {
          ownerSettled = true
        })
      // The Owner either commits at once (no lock stands in its way) or waits behind the Admin.
      await until(
        async () => ownerSettled || (await backendsWaitingForALock()) > 0,
        'the Owner to commit or to wait on a lock'
      )
      gate.release()
      const [adminAnswer, ownerAnswer] = await Promise.all([adminCall, ownerCall])

      const stored = await store.withOrganization(seeded.organizationId, (s) =>
        s.getMembership(manager.id)
      )
      if (adminAnswer.status === 403) {
        // The Owner went first: the Admin was refused on the Admin it found.
        expect(adminAnswer.body.error?.code).toBe('auth.forbidden')
        expect(ownerAnswer.status).toBe(200)
        expect(stored?.role).toBe('admin')
      } else {
        // The Admin went first, while the target still was a Manager.
        expect(adminAnswer.status).toBe(method === 'DELETE' ? 204 : 200)
        if (method === 'DELETE') {
          expect([ownerAnswer.status, ownerAnswer.body.error?.code]).toEqual([
            404,
            'member.not_found',
          ])
          expect(stored).toBeNull()
        } else {
          expect(ownerAnswer.status).toBe(200)
          expect(stored?.role).toBe('admin')
        }
      }
    }
  )

  test('a rename that waits behind an open suspension is refused as suspended', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store)
    let suspendedInside: () => void = () => undefined
    const inside = new Promise<void>((resolve) => {
      suspendedInside = resolve
    })
    let commit: () => void = () => undefined
    const commitSuspension = new Promise<void>((resolve) => {
      commit = resolve
    })
    const suspension = withOrganization(service.db, seeded.organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status: 'suspended' })
        .where(eq(organizations.organizationId, seeded.organizationId))
      suspendedInside()
      await commitSuspension
    })
    await inside

    let renameSettled = false
    const rename = h
      .asMember(seeded.owner, seeded.organizationId, 'PATCH', '/organization', { name: 'Late' })
      .finally(() => {
        renameSettled = true
      })
    await until(
      async () => renameSettled || (await backendsWaitingForALock()) > 0,
      'the rename to wait on the Organization row'
    )
    expect(renameSettled).toBe(false)
    commit()
    await suspension
    const answer = await rename

    expect([answer.status, answer.body.error?.code]).toEqual([403, 'organization.suspended'])
    const organization = await store.withOrganization(seeded.organizationId, (s) =>
      s.getOrganization()
    )
    expect(organization?.name).toBe('Acme')
  })

  test('a write queued behind a slow lock holder gives up with a retryable 503, and the lookup still answers', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['manager'])
    const manager = seeded.members[1] as SeededMember
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      locked()
      await released
    })
    await holding

    try {
      const started = Date.now()
      const rename = await h.asMember(
        seeded.owner,
        seeded.organizationId,
        'PATCH',
        '/organization',
        {
          name: 'Queued',
        }
      )
      const waited = Date.now() - started
      // The Organization row is still held: reads and the token hook's lookup do not wait on it.
      const read = await h.asMember(seeded.owner, seeded.organizationId, 'GET', '/organization')
      const members = await h.asMember(seeded.owner, seeded.organizationId, 'GET', '/members')
      const lookup = await h.callInternal('/internal/membership', { userId: manager.userId })

      expect([rename.status, rename.body.error?.code, rename.retryAfter]).toEqual([
        503,
        'server.unavailable',
        '1',
      ])
      // Gave up on its own, well before the 30 s statement timeout, and was not retried or reported.
      expect(waited).toBeLessThan(10_000)
      expect(h.deps.reported).toHaveLength(0)
      expect([read.status, members.status]).toEqual([200, 200])
      expect(lookup.body).toMatchObject({ found: true, role: 'manager' })
    } finally {
      release()
      await holder
    }
    const name = await store.withOrganization(seeded.organizationId, (s) => s.getOrganization())
    expect(name?.name).toBe('Acme')
  })

  test('two Admins changing one member’s role at once both succeed, with no deadlock', async () => {
    const h = await harness()
    const rounds = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const seeded = await seedOrganization(store, ['admin', 'admin', 'rep'])
        const [, first, second, rep] = seeded.members as [
          SeededMember,
          SeededMember,
          SeededMember,
          SeededMember,
        ]
        const answers = await Promise.all([
          h.asMember(first, seeded.organizationId, 'PATCH', `/members/${rep.id}`, {
            role: 'manager',
          }),
          h.asMember(second, seeded.organizationId, 'PATCH', `/members/${rep.id}`, {
            role: 'rep',
          }),
        ])
        const stored = await store.withOrganization(seeded.organizationId, (s) =>
          s.getMembership(rep.id)
        )
        return { answers, role: stored?.role }
      })
    )

    for (const { answers, role } of rounds) {
      expect(answers.map((a) => a.status)).toEqual([200, 200])
      expect(['manager', 'rep']).toContain(role ?? 'missing')
    }
  })
})

describe('POST /internal/organizations', () => {
  test('creates the Organization and its Owner, and the lookup then finds them', async () => {
    const h = await harness()
    const userId = newUserId()
    const before = await organizationCount()

    const created = await h.callInternal('/internal/organizations', {
      userId,
      organizationName: 'Fresh Co',
      email: `${userId}@example.test`,
    })
    const lookup = await h.callInternal('/internal/membership', { userId })

    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ role: 'owner' })
    expect(lookup.body).toEqual({
      found: true,
      organizationId: created.body.organizationId as never,
      role: 'owner',
      organizationStatus: 'active',
    })
    expect(await organizationCount()).toBe(before + 1)
  })

  test('replayed with the same user id it returns the same Organization and creates nothing', async () => {
    const h = await harness()
    const userId = newUserId()
    const first = await h.callInternal('/internal/organizations', {
      userId,
      organizationName: 'Once',
      email: `${userId}@example.test`,
    })
    const before = await organizationCount()

    const replay = await h.callInternal('/internal/organizations', {
      userId,
      organizationName: 'Once',
      email: `${userId}@example.test`,
    })
    const renamed = await h.callInternal('/internal/organizations', {
      userId,
      organizationName: 'Twice',
      email: `${userId}@example.test`,
    })

    expect(replay).toEqual(first)
    expect(renamed).toEqual(first)
    expect(await organizationCount()).toBe(before)
    expect(await directoryRows(userId)).toBe(1)
  })

  test('several concurrent calls for one user id leave exactly one Organization', async () => {
    const h = await harness()
    const userId = newUserId()
    const before = await organizationCount()

    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        h.callInternal('/internal/organizations', {
          userId,
          organizationName: `Racer ${i}`,
          email: `${userId}@example.test`,
        })
      )
    )

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(new Set(answers.map((a) => a.body.organizationId)).size).toBe(1)
    expect(await organizationCount()).toBe(before + 1)
    expect(await directoryRows(userId)).toBe(1)
  })

  test('a user who is a Rep elsewhere is refused with membership.already_member and nothing is created', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['rep'])
    const rep = seeded.members[1] as SeededMember
    const before = await organizationCount()

    const { status, body } = await h.callInternal('/internal/organizations', {
      userId: rep.userId,
      organizationName: 'Mine',
      email: `${rep.userId}@example.test`,
    })

    expect([status, body.error?.code]).toEqual([409, 'membership.already_member'])
    expect(await organizationCount()).toBe(before)
  })
})

describe('POST /internal/membership', () => {
  test('answers for an unknown user, an active member and a member of a suspended Organization', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['manager'])
    const manager = seeded.members[1] as SeededMember

    const unknown = await h.callInternal('/internal/membership', { userId: newUserId() })
    const active = await h.callInternal('/internal/membership', { userId: manager.userId })
    await setStatus(seeded.organizationId, 'suspended')
    const suspended = await h.callInternal('/internal/membership', { userId: manager.userId })

    expect(unknown.body).toEqual({ found: false })
    expect(active.body).toEqual({
      found: true,
      organizationId: seeded.organizationId as never,
      role: 'manager',
      organizationStatus: 'active',
    })
    expect(suspended.body).toEqual({
      found: true,
      organizationId: seeded.organizationId as never,
      role: 'manager',
      organizationStatus: 'suspended',
    })
  })

  test('a removed member is no longer found', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store, ['rep'])
    const rep = seeded.members[1] as SeededMember
    await h.asMember(seeded.owner, seeded.organizationId, 'DELETE', `/members/${rep.id}`)

    const { body } = await h.callInternal('/internal/membership', { userId: rep.userId })

    expect(body).toEqual({ found: false })
  })
})

describe('the two kinds of caller stay apart, against the real stack', () => {
  test('the public routes refuse the internal secret and the internal routes refuse a user token', async () => {
    const h = await harness()
    const seeded = await seedOrganization(store)
    const token = await h.bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: 'owner',
    })

    const publicWithSecret = await h.app.request('/v1/organization', {
      headers: { authorization: `Bearer ${TEST_INTERNAL_SECRET}` },
    })
    const internalWithToken = await h.app.request('/internal/membership', {
      method: 'POST',
      headers: { ...h.internal(), ...token },
      body: JSON.stringify({ userId: seeded.owner.userId }),
    })

    expect(publicWithSecret.status).toBe(401)
    expect(internalWithToken.status).toBe(401)
  })
})

describe('the real container', () => {
  test('is ready when the database answers, and serves the lookup through the real wiring', async () => {
    const container = createContainer(
      loadEnv({
        ENVIRONMENT: 'local',
        LOG_LEVEL: 'silent',
        DATABASE_URL: urls.service,
        INTERNAL_API_TOKENS: TEST_INTERNAL_SECRET,
      })
    )
    try {
      const app = createApp(container)

      const ready = await app.request('/readyz')
      const lookup = await app.request('/internal/membership', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'idempotency-key': 'k'.repeat(20),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: newUserId() }),
      })

      expect(ready.status).toBe(200)
      expect(await lookup.json()).toEqual({ found: false })
    } finally {
      await container.close()
    }
  })
})

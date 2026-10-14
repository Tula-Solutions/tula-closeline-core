import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  formatId,
  invitationSchema,
  type OrganizationId,
  teamSchema,
  type UserId,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { IDEMPOTENCY_RESPONSE_MAX_BYTES } from 'tula-closeline-db/schema'
import { z } from 'zod'
import { createPostgresCoreStore, purgeIdempotencyKeysQuery } from '~/adapters/postgres/core-store'
import { integrationUrls } from '~/integration-support'
import {
  IDEMPOTENCY_PURGE_BATCH,
  IDEMPOTENCY_TTL_MS,
  idempotent,
  requestHash,
  storedResponseBytes,
} from '~/modules/idempotency/service'
import type { OrganizationScope } from '~/ports/core-store'
import { type ApiBody, createTestApp, seedOrganization } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresCoreStore(service.db)
/** A store that waits only a moment for a held key, so a test sees the in-progress answer quickly. */
const WAIT_MS = 300
const impatient = createPostgresCoreStore(service.db, {}, { idempotencyWaitMs: WAIT_MS })
/** A store whose writes give up waiting for the Organization lock after a moment. */
const shortWrites = createPostgresCoreStore(service.db, {}, { writeLockTimeoutMs: WAIT_MS })

afterAll(async () => {
  await service.close()
  await owner.close()
})

const KEY = 'order-0001-abcdefgh'

/** The app over Postgres, with its clock at the real time so the database and the app agree. */
async function harness(over: { impatient?: boolean; shortWrites?: boolean } = {}) {
  const app = await createTestApp({
    store: over.impatient ? impatient : over.shortWrites ? shortWrites : store,
    env: { DATABASE_URL: urls.service },
    clockStart: new Date().toISOString(),
  })
  const seeded = await seedOrganization(store, ['admin', 'rep'])
  const post = async (
    path: string,
    body: unknown,
    key?: string,
    organizationId = seeded.organizationId,
    actor = seeded.owner
  ) => {
    const token = await app.bearer({ userId: actor.userId, organizationId, role: actor.role })
    const response = await app.app.request(`/v1${path}`, {
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
      text,
      body: (text ? JSON.parse(text) : {}) as ApiBody,
      retryAfter: response.headers.get('retry-after'),
    }
  }
  const del = async (path: string, key?: string) => {
    const token = await app.bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: seeded.owner.role,
    })
    const response = await app.app.request(`/v1${path}`, {
      method: 'DELETE',
      headers: { ...token, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    })
    const text = await response.text()
    return { status: response.status, text, body: (text ? JSON.parse(text) : {}) as ApiBody }
  }
  return { ...app, seeded, post, del }
}

/** The rows of the idempotency table the Organization can see, as the service role reads them. */
type KeyRow = {
  user_id: string
  route: string
  key: string
  status: number | null
  response: unknown
  text: string | null
}

function rowsOf(organizationId: OrganizationId): Promise<KeyRow[]> {
  return withOrganization(service.db, organizationId, async (tx) => {
    const result = await tx.execute<KeyRow>(
      sql`select user_id, route, key, status, response, response::text as text from core.idempotency_keys order by created_at`
    )
    return result.rows
  })
}

/** Waits, by looking at the lock table and not at the clock, until some transaction waits for another. */
async function untilSomeoneWaits(): Promise<void> {
  for (let look = 0; look < 500; look += 1) {
    const result = await owner.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks where not granted and locktype in ('transactionid', 'tuple')`
    )
    if ((result.rows[0]?.waiting ?? 0) > 0) {
      return
    }
    await Bun.sleep(5)
  }
  throw new Error('no transaction ever waited')
}

/** A transaction held open on the key until `release` is called; resolves `held` once the key is claimed. */
function holdKey(
  organizationId: OrganizationId,
  userId: UserId,
  route: string,
  body: unknown,
  finish: (scope: OrganizationScope) => Promise<void>
) {
  let claimed: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    claimed = resolve
  })
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const holder = store.withOrganization(organizationId, async (scope) => {
    await scope.reserveIdempotencyKey({
      userId,
      route,
      key: KEY,
      requestHash: requestHash(route, body),
      now: new Date(),
      expiredBefore: new Date(Date.now() - IDEMPOTENCY_TTL_MS),
    })
    claimed()
    await released
    await finish(scope)
  })
  return { held, release, holder }
}

describe('a keyed request over Postgres', () => {
  test('two Invitation requests with one key at once give one email: one 201, one already_pending, and then the key replays the 201', async () => {
    const h = await harness()
    const body = { email: 'new.person@example.com', role: 'rep' }

    const results = await Promise.all([
      h.post('/invitations', body, KEY),
      h.post('/invitations', body, KEY),
    ])
    const created = results.find((r) => r.status === 201)
    const refused = results.find((r) => r.status === 409)
    const replay = await h.post('/invitations', body, KEY)

    expect(created).toBeDefined()
    expect(refused?.body.error?.code).toBe('invitation.already_pending')
    expect(replay.status).toBe(201)
    expect(replay.text).toBe(created?.text ?? '')
    expect(h.deps.mail.outbox).toHaveLength(1)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(1)
  })

  test('removing a Team member twice with one key is 204 and 204; a new key or none afterwards is 404', async () => {
    const h = await harness()
    const team = teamSchema.parse((await h.post('/teams', { name: 'Sales' })).body)
    const rep = h.seeded.members[2]
    const path = `/teams/${team.id}/members/${rep?.id}`
    await h.post(`/teams/${team.id}/members`, { membershipId: rep?.id })

    const first = await h.del(path, KEY)
    const replay = await h.del(path, KEY)
    const fresh = await h.del(path, 'another-key-0000001')
    const keyless = await h.del(path)

    expect([first.status, replay.status]).toEqual([204, 204])
    expect(first.text).toBe('')
    expect(replay.text).toBe('')
    expect(fresh.status).toBe(404)
    expect(fresh.body.error?.code).toBe('member.not_found')
    expect(keyless.status).toBe(404)
    expect(
      (await rowsOf(h.seeded.organizationId)).filter((row) => row.status === 204)
    ).toHaveLength(1)
  })

  test('two Team requests with one key at once give one effect and the same answer', async () => {
    const h = await harness()
    const body = { name: 'Sales' }

    const [a, b] = await Promise.all([h.post('/teams', body, KEY), h.post('/teams', body, KEY)])

    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.text).toBe(b.text)
    const teams = await store.withOrganization(h.seeded.organizationId, (s) =>
      s.listTeams({ limit: 10 })
    )
    expect(teams).toHaveLength(1)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(1)
  })

  test('a waiter whose first request commits inside the bound is answered with the stored answer and creates nothing', async () => {
    const h = await harness()
    const body = { name: 'Sales' }
    const team = {
      id: formatId('team', crypto.randomUUID()),
      name: 'Sales',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const first = holdKey(
      h.seeded.organizationId,
      h.seeded.owner.userId,
      'teams.create',
      { body },
      async (scope) => {
        await scope.completeIdempotencyKey(
          { userId: h.seeded.owner.userId, route: 'teams.create', key: KEY },
          201,
          team
        )
      }
    )
    await first.held

    const waiting = h.post('/teams', body, KEY)
    await untilSomeoneWaits()
    first.release()
    await first.holder
    const answer = await waiting

    expect(answer.status).toBe(201)
    expect(teamSchema.parse(answer.body)).toEqual(team)
    const teams = await store.withOrganization(h.seeded.organizationId, (s) =>
      s.listTeams({ limit: 10 })
    )
    expect(teams).toHaveLength(0)
  })

  test('a held first transaction makes the second answer 409 with Retry-After at the lock timeout, and nothing is stored by it', async () => {
    const h = await harness({ impatient: true })
    const body = { name: 'Sales' }
    const first = holdKey(
      h.seeded.organizationId,
      h.seeded.owner.userId,
      'teams.create',
      { body },
      async () => {
        throw new Error('rolled back')
      }
    )
    await first.held

    const second = await h.post('/teams', body, KEY)
    first.release()
    await expect(first.holder).rejects.toThrow('rolled back')
    const retried = await h.post('/teams', body, KEY)

    expect(second.status).toBe(409)
    expect(second.body.error).toMatchObject({
      code: 'request.idempotency_in_progress',
      details: { retryAfter: 1 },
    })
    expect(second.retryAfter).toBe('1')
    // The first one rolled back, so the key is free: the retry does the work.
    expect(retried.status).toBe(201)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(1)
  })

  test('a request that fails leaves no row behind, and the same key then works', async () => {
    const h = await harness()
    const other = h.seeded.members[2]
    if (!other) {
      throw new Error('seed made no Rep')
    }

    const forbidden = await h.post('/teams', { name: 'Sales' }, KEY, h.seeded.organizationId, other)

    expect(forbidden.status).toBe(403)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(0)
    expect((await h.post('/teams', { name: 'Sales' }, KEY)).status).toBe(201)
  })

  test('a failed delivery never stores the key, so nothing is left in the database that would replay a failure', async () => {
    const h = await harness()
    h.deps.mail.failing = true

    const failed = await h.post('/invitations', { email: 'a@example.com', role: 'rep' }, KEY)

    expect(failed.status).toBe(503)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(0)
  })

  test('another Organization cannot see a row, and the same key there is its own', async () => {
    const h = await harness()
    const second = await seedOrganization(store)
    const mine = await h.post('/teams', { name: 'Sales' }, KEY)

    const theirs = await h.post(
      '/teams',
      { name: 'Sales' },
      KEY,
      second.organizationId,
      second.owner
    )

    expect(theirs.status).toBe(201)
    expect(theirs.text).not.toBe(mine.text)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(1)
    expect(await rowsOf(second.organizationId)).toHaveLength(1)
  })

  test('nothing stored holds a token: the row for an Invitation has the Invitation and no secret', async () => {
    const h = await harness()

    const made = await h.post('/invitations', { email: 'a@example.com', role: 'rep' }, KEY)
    const { token } = h.deps.mail.last()
    const rows = await rowsOf(h.seeded.organizationId)

    expect(made.status).toBe(201)
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(JSON.stringify(rows)).not.toMatch(/token/i)
    expect(invitationSchema.parse(rows[0]?.response)).toEqual(invitationSchema.parse(made.body))
    expect(rows[0]).toMatchObject({ route: 'invitations.create', key: KEY, status: 201 })
  })
})

describe('what a keyed request waits for', () => {
  test('a write blocked on the Organization lock is 503 with Retry-After, never 409, and leaves no row', async () => {
    const h = await harness({ shortWrites: true })
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(h.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      locked()
      await released
    })
    await holding

    const blocked = await h.post('/teams', { name: 'Sales' }, KEY)
    release()
    await holder
    const retried = await h.post('/teams', { name: 'Sales' }, KEY)

    expect(blocked.status).toBe(503)
    expect(blocked.body.error?.code).toBe('server.unavailable')
    expect(blocked.retryAfter).toBe('1')
    expect(retried.status).toBe(201)
    expect(await rowsOf(h.seeded.organizationId)).toHaveLength(1)
  })

  test('a purge passes over a key row another transaction holds instead of waiting for it, so it cannot deadlock with a replacement', async () => {
    const h = await harness()
    const org = h.seeded.organizationId
    const userId = h.seeded.owner.userId
    const day = IDEMPOTENCY_TTL_MS / 1000
    // Two expired keys: the one X replaces (KEY) and one nobody holds.
    await seedKeys(org, userId, { count: 1, newestAgoSeconds: day + 60, tag: 'spare' })
    await withOrganization(service.db, org, (tx) =>
      tx.execute(sql`
        insert into core.idempotency_keys
          (organization_id, user_id, route, key, request_hash, status, response, created_at)
        values (${org}, ${userId}, 'teams.create', ${KEY}, sha256(convert_to('old', 'UTF8')),
          201, '{"id": "x"}'::jsonb, now() - make_interval(secs => ${day + 120}))
      `)
    )
    let pRuns = 0
    let xRuns = 0
    let pLocked: () => void = () => undefined
    const pHoldsLock = new Promise<void>((resolve) => {
      pLocked = resolve
    })
    let xWaits: () => void = () => undefined
    const xIsWaiting = new Promise<void>((resolve) => {
      xWaits = resolve
    })
    // P holds the Organization lock, then purges once X is known to be waiting for that lock.
    const purger = store.withOrganization(org, async (scope) => {
      pRuns += 1
      await scope.lockOrganization()
      pLocked()
      await xIsWaiting
      return scope.purgeIdempotencyKeys(new Date(Date.now() - IDEMPOTENCY_TTL_MS), 100)
    })
    await pHoldsLock
    // X replaces the expired KEY row (holding it, uncommitted) and then waits for the lock P holds.
    const replacer = store.withOrganization(org, async (scope) => {
      xRuns += 1
      const claimed = await scope.reserveIdempotencyKey({
        userId,
        route: 'teams.create',
        key: KEY,
        requestHash: requestHash('teams.create', { body: { name: 'Sales' } }),
        now: new Date(),
        expiredBefore: new Date(Date.now() - IDEMPOTENCY_TTL_MS),
      })
      await scope.lockOrganization()
      return claimed
    })
    await untilSomeoneWaits()
    xWaits()

    const purged = await purger
    const claimed = await replacer

    // P finished although X held the expired row: it skipped it, took the spare one, and neither
    // transaction was cancelled and run again as a deadlock would have forced.
    expect(purged).toBe(1)
    expect(claimed).toEqual({ outcome: 'reserved' })
    expect([pRuns, xRuns]).toEqual([1, 1])
  })

  test('a keyed commit leaves the connection with the default lock timeout', async () => {
    const single = createDb(urls.service, { max: 1 })
    try {
      const alone = createPostgresCoreStore(single.db)
      const seeded = await seedOrganization(alone)
      const ref = { userId: seeded.owner.userId, route: 'teams.create', key: KEY }
      await alone.withOrganization(seeded.organizationId, async (scope) => {
        await scope.reserveIdempotencyKey({
          ...ref,
          requestHash: 'a'.repeat(64),
          now: new Date(),
          expiredBefore: new Date(0),
        })
        await scope.lockOrganization()
        await scope.completeIdempotencyKey(ref, 201, { id: 'x' })
      })

      // The pool has one connection, so this is the one the transaction used.
      const shown = await single.db.execute<{ lock_timeout: string }>(sql`show lock_timeout`)

      expect(shown.rows[0]?.lock_timeout).toBe('0')
    } finally {
      await single.close()
    }
  })

  test('a purge statement that fails is undone on its own and the transaction goes on', async () => {
    const h = await harness()

    const seen = await store.withOrganization(h.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      const failed = await scope
        .purgeIdempotencyKeys(new Date(), Number.NaN)
        .then(() => 'ok')
        .catch(() => 'failed')
      return { failed, organization: await scope.getOrganization() }
    })

    expect(seen.failed).toBe('failed')
    expect(seen.organization?.id).toBe(h.seeded.organizationId)
  })
})

describe('the size of a stored response', () => {
  test.each([
    ['an object', { id: 'inv_1', role: 'rep', teamId: null, n: -1.5, ok: true }],
    ['nesting', { a: [{ b: 1 }, {}, []], c: { d: { e: ['x', 'y'] } } }],
    ['text with quotes, slashes and non-ASCII', { name: 'Équipe "日本" \\ / \n\t', e: '😀' }],
    ['a long array of integers', { list: Array.from({ length: 2000 }, (_, n) => n) }],
  ])('the service counts %s as the database does', async (_why, value) => {
    const result = await owner.db.execute<{ bytes: number }>(
      sql`select octet_length(${JSON.stringify(value)}::jsonb::text) as bytes`
    )

    expect(storedResponseBytes(value)).toBe(Number(result.rows[0]?.bytes))
  })

  test('an answer over the bound is returned, no row is kept and no constraint is hit', async () => {
    const h = await harness()
    const caller = {
      userId: h.seeded.owner.userId,
      organizationId: h.seeded.organizationId,
      role: h.seeded.owner.role,
    }
    const big = { id: 'x', note: 'n'.repeat(IDEMPOTENCY_RESPONSE_MAX_BYTES) }

    const result = await store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        h.deps,
        scope,
        caller,
        {
          key: KEY,
          route: 'things.create',
          request: {},
          status: 201,
          response: z.object({ id: z.string(), note: z.string() }),
        },
        async () => {
          await scope.lockOrganization()
          return big
        }
      )
    )

    expect(result.body).toEqual(big)
    expect(await rowsOf(caller.organizationId)).toHaveLength(0)
    expect(h.deps.logLines.join('\n')).toContain('things.create')
    expect(h.deps.logLines.join('\n')).not.toContain(big.note)
  })
})

/** Every node type and index name in an `EXPLAIN (FORMAT JSON)` plan, and the buffers its root used when it ran. */
function planParts(explained: unknown) {
  const nodeTypes: string[] = []
  const indexNames: string[] = []
  const walk = (node: { [key: string]: unknown }) => {
    nodeTypes.push(String(node['Node Type']))
    if (typeof node['Index Name'] === 'string') {
      indexNames.push(node['Index Name'])
    }
    for (const child of (node.Plans as { [key: string]: unknown }[] | undefined) ?? []) {
      walk(child)
    }
  }
  const root = (explained as { Plan: { [key: string]: unknown } }[])[0]
  if (root) {
    walk(root.Plan)
  }
  const used = (name: string) => Number(root?.Plan[name] ?? 0)
  return {
    nodeTypes,
    indexNames,
    buffers: used('Shared Hit Blocks') + used('Shared Read Blocks'),
    rows: Number(root?.Plan['Actual Rows'] ?? 0),
  }
}

/** Puts `count` completed keys in an Organization, `agoSeconds` apart, the newest `newestAgoSeconds` old. */
async function seedKeys(
  organizationId: OrganizationId,
  userId: string,
  options: { count: number; newestAgoSeconds: number; tag: string }
) {
  await withOrganization(service.db, organizationId, (tx) =>
    tx.execute(sql`
      insert into core.idempotency_keys
        (organization_id, user_id, route, key, request_hash, status, response, created_at)
      select
        ${organizationId}, ${userId}, 'things.create',
        ${options.tag} || '-' || lpad(g::text, 10, '0'),
        sha256(convert_to(${options.tag} || g::text, 'UTF8')),
        201, '{"id": "x"}'::jsonb,
        now() - make_interval(secs => ${options.newestAgoSeconds} + g)
      from generate_series(1, ${options.count}) g
    `)
  )
}

describe('the purge over Postgres', () => {
  test('one keyed request removes one bounded batch of this Organization’s expired keys and nothing of another', async () => {
    const h = await harness()
    const second = await seedOrganization(store)
    const day = IDEMPOTENCY_TTL_MS / 1000
    await seedKeys(h.seeded.organizationId, h.seeded.owner.userId, {
      count: IDEMPOTENCY_PURGE_BATCH + 40,
      newestAgoSeconds: day + 60,
      tag: 'old',
    })
    await seedKeys(h.seeded.organizationId, h.seeded.owner.userId, {
      count: 3,
      newestAgoSeconds: 3600,
      tag: 'fresh',
    })
    await seedKeys(second.organizationId, second.owner.userId, {
      count: 5,
      newestAgoSeconds: day + 60,
      tag: 'old',
    })

    const made = await h.post('/teams', { name: 'Sales' }, KEY)

    expect(made.status).toBe(201)
    const mine = await rowsOf(h.seeded.organizationId)
    // 140 expired - 100 removed + 3 fresh + the new row.
    expect(mine).toHaveLength(40 + 3 + 1)
    expect(mine.filter((row) => row.key.startsWith('fresh'))).toHaveLength(3)
    // The oldest went first, so what is left of the expired ones is the newest 40.
    expect(
      mine
        .filter((row) => row.key.startsWith('old'))
        .every((row) => Number(row.key.slice(-10)) <= 40)
    ).toBe(true)
    expect(await rowsOf(second.organizationId)).toHaveLength(5)
  })

  test('the purge reads the purge index with no sort and no sequential scan, in a few buffers', async () => {
    const h = await harness()
    const day = IDEMPOTENCY_TTL_MS / 1000
    const noise = await seedOrganization(store)
    await seedKeys(h.seeded.organizationId, h.seeded.owner.userId, {
      count: 20_000,
      newestAgoSeconds: day + 60,
      tag: 'old',
    })
    await seedKeys(h.seeded.organizationId, h.seeded.owner.userId, {
      count: 50,
      newestAgoSeconds: 60,
      tag: 'fresh',
    })
    await seedKeys(noise.organizationId, noise.owner.userId, {
      count: 24_000,
      newestAgoSeconds: day + 60,
      tag: 'noise',
    })
    await owner.db.execute(sql`analyze core.idempotency_keys`)

    const purge = await withOrganization(service.db, h.seeded.organizationId, async (tx) => {
      const query = purgeIdempotencyKeysQuery(
        h.seeded.organizationId,
        new Date(Date.now() - IDEMPOTENCY_TTL_MS),
        IDEMPOTENCY_PURGE_BATCH
      )
      const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql`explain (analyze, buffers, format json) ${query}`
      )
      const plan = planParts(rows[0]?.['QUERY PLAN'])
      // Explain ran the delete; undo it so the test leaves the table as it found it.
      await tx.execute(sql`select 1`)
      throw Object.assign(new Error('roll back'), { plan })
    }).catch((error: Error & { plan?: ReturnType<typeof planParts> }) => {
      if (error.plan) {
        return error.plan
      }
      throw error
    })

    expect(purge.indexNames).toEqual(['idempotency_keys_purge_idx'])
    expect(purge.nodeTypes).not.toContain('Seq Scan')
    expect(purge.nodeTypes.filter((type) => type.includes('Sort'))).toEqual([])
    expect(purge.nodeTypes).toContain('Tid Scan')
    // About two buffers a purged row, not a function of the 20,000 expired or the 44,000 in the table.
    expect(purge.buffers).toBeLessThan(IDEMPOTENCY_PURGE_BATCH * 4 + 50)
  })

  test('the lookup of one key reads the primary key only', async () => {
    const h = await harness()
    await seedKeys(h.seeded.organizationId, h.seeded.owner.userId, {
      count: 1000,
      newestAgoSeconds: 60,
      tag: 'some',
    })
    await owner.db.execute(sql`analyze core.idempotency_keys`)

    const plan = await withOrganization(service.db, h.seeded.organizationId, async (tx) => {
      const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(sql`
        explain (analyze, buffers, format json)
        select status, response from core.idempotency_keys
        where organization_id = ${h.seeded.organizationId} and user_id = ${h.seeded.owner.userId}
          and route = 'things.create' and key = 'some-0000000001'
      `)
      return planParts(rows[0]?.['QUERY PLAN'])
    })

    expect(plan.indexNames).toEqual(['idempotency_keys_pkey'])
    expect(plan.nodeTypes).not.toContain('Seq Scan')
  })
})

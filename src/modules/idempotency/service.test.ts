import { describe, expect, test } from 'bun:test'
import { IDEMPOTENCY_RESPONSE_MAX_BYTES } from 'tula-closeline-db/schema'
import { z } from 'zod'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestDeps, seedOrganization } from '~/testing'
import {
  canonicalJson,
  IDEMPOTENCY_PURGE_BATCH,
  IDEMPOTENCY_TTL_MS,
  idempotent,
  requestHash,
  storedResponseBytes,
} from './service'

describe('the request hash', () => {
  test('is the same for the same request whatever the order of its keys', () => {
    expect(requestHash('teams.create', { body: { a: 1, b: { c: 2, d: [1, 2] } } })).toBe(
      requestHash('teams.create', { body: { b: { d: [1, 2], c: 2 }, a: 1 } })
    )
  })

  test('ignores a key whose value is undefined, as the JSON body does', () => {
    expect(requestHash('invitations.create', { body: { email: 'a@b.c', teamId: undefined } })).toBe(
      requestHash('invitations.create', { body: { email: 'a@b.c' } })
    )
  })

  test.each([
    ['another body', { body: { name: 'B' } }],
    ['another path parameter', { params: { teamId: 'team_2' }, body: { name: 'A' } }],
    ['an array in another order', { body: { name: 'A', ids: [2, 1] } }],
  ])('differs for %s', (_why, other) => {
    const base = { params: { teamId: 'team_1' }, body: { name: 'A', ids: [1, 2] } }

    expect(requestHash('r', other)).not.toBe(requestHash('r', base))
  })

  test('differs for another route and is 64 lowercase hex characters', () => {
    const request = { body: { name: 'A' } }

    expect(requestHash('teams.create', request)).not.toBe(requestHash('teams.rename', request))
    expect(requestHash('teams.create', request)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('canonical text has sorted keys and no spaces', () => {
    expect(canonicalJson({ b: [true, null, 'x'], a: { z: 1, y: undefined } })).toBe(
      '{"a":{"z":1},"b":[true,null,"x"]}'
    )
  })
})

describe('the stored size of a response', () => {
  test.each([
    [
      'an object',
      { id: 'inv_1', role: 'rep', teamId: null },
      '{"id": "inv_1", "role": "rep", "teamId": null}',
    ],
    ['an array', [1, 2, 3], '[1, 2, 3]'],
    ['nesting', { a: [{ b: 1 }, {}], c: [] }, '{"a": [{"b": 1}, {}], "c": []}'],
    ['non-ASCII text', { name: 'Équipe 日本' }, '{"name": "Équipe 日本"}'],
  ])(
    'counts the jsonb text form of %s, with a space after each colon and comma',
    (_why, value, text) => {
      expect(storedResponseBytes(value)).toBe(Buffer.byteLength(text, 'utf8'))
    }
  )

  test('is infinite for a string with a NUL character, which jsonb cannot hold', () => {
    expect(storedResponseBytes({ name: 'a\u0000b' })).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('running a write once per key', () => {
  const answer = z.object({ id: z.string(), note: z.string() })

  async function setup() {
    const store = createMemoryCoreStore()
    const deps = createTestDeps({ store })
    const seeded = await seedOrganization(store)
    const caller = {
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: seeded.owner.role,
    }
    let runs = 0
    const run = (key: string | undefined, request: unknown, note = 'small') =>
      store.withOrganization(caller.organizationId, (scope) =>
        idempotent(
          deps,
          scope,
          caller,
          { key, route: 'things.create', request, status: 201, response: answer },
          async () => {
            await scope.lockOrganization()
            runs += 1
            return { id: `thing_${runs}`, note }
          }
        )
      )
    return { store, deps, seeded, caller, run, runs: () => runs }
  }

  test('without a key it runs every time and stores nothing', async () => {
    const { run, runs } = await setup()

    await run(undefined, {})
    await run(undefined, {})

    expect(runs()).toBe(2)
  })

  test('with a key the second call is replayed and the write runs once', async () => {
    const { run, runs } = await setup()

    const first = await run('k'.repeat(20), { n: 1 })
    const second = await run('k'.repeat(20), { n: 1 })

    expect(first).toEqual({ status: 201, body: { id: 'thing_1', note: 'small' }, replayed: false })
    expect(second).toEqual({ status: 201, body: { id: 'thing_1', note: 'small' }, replayed: true })
    expect(runs()).toBe(1)
  })

  test('a write that throws stores nothing, so the key can be used again', async () => {
    const { store, deps, caller } = await setup()
    const attempt = (fail: boolean) =>
      store.withOrganization(caller.organizationId, (scope) =>
        idempotent(
          deps,
          scope,
          caller,
          {
            key: 'k'.repeat(20),
            route: 'things.create',
            request: {},
            status: 201,
            response: answer,
          },
          async () => {
            await scope.lockOrganization()
            if (fail) {
              throw new Error('the write failed')
            }
            return { id: 'thing_1', note: 'ok' }
          }
        )
      )

    await expect(attempt(true)).rejects.toThrow('the write failed')
    const retried = await attempt(false)

    expect(retried.replayed).toBe(false)
  })

  test('an answer over the table bound is returned, its key is released and only the route and ids are logged', async () => {
    const { run, runs, deps, caller } = await setup()
    const big = 'x'.repeat(IDEMPOTENCY_RESPONSE_MAX_BYTES)

    const first = await run('k'.repeat(20), {}, big)
    const second = await run('k'.repeat(20), {}, big)

    expect(first.body.note).toBe(big)
    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(false)
    expect(runs()).toBe(2)
    const logged = deps.logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const warning = logged.find((line) => String(line.msg ?? line.message).includes('too large'))
    expect(warning).toMatchObject({
      route: 'things.create',
      organizationId: caller.organizationId,
      userId: caller.userId,
    })
    expect(deps.logLines.join('\n')).not.toContain(big)
  })

  test('an answer exactly at the bound is stored', async () => {
    const { run, runs } = await setup()
    // {"id": "thing_1", "note": "<n>"} is 29 bytes without the note's text.
    const note = 'x'.repeat(IDEMPOTENCY_RESPONSE_MAX_BYTES - 29)
    expect(storedResponseBytes({ id: 'thing_1', note })).toBe(IDEMPOTENCY_RESPONSE_MAX_BYTES)

    await run('k'.repeat(20), {}, note)
    const second = await run('k'.repeat(20), {}, note)

    expect(second.replayed).toBe(true)
    expect(runs()).toBe(1)
  })

  test('one keyed write removes at most one batch of this Organization’s expired keys', async () => {
    const { store, deps, caller, run } = await setup()
    const old = new Date(deps.clock.now().getTime() - IDEMPOTENCY_TTL_MS - 1000)
    const extra = IDEMPOTENCY_PURGE_BATCH + 5
    await store.withOrganization(caller.organizationId, async (scope) => {
      for (let n = 0; n < extra; n += 1) {
        const ref = {
          userId: caller.userId,
          route: 'things.create',
          key: `old-key-${n}`.padEnd(20, '-'),
        }
        await scope.reserveIdempotencyKey({
          ...ref,
          requestHash: 'a'.repeat(64),
          now: old,
          expiredBefore: new Date(0),
        })
        await scope.completeIdempotencyKey(ref, 201, { id: 'x', note: 'y' })
      }
    })
    const remaining = () =>
      store.withOrganization(caller.organizationId, async (scope) => {
        await scope.lockOrganization()
        return scope.purgeIdempotencyKeys(new Date(deps.clock.now().getTime() - 1000), 10_000)
      })

    await run('fresh-key-'.padEnd(20, '-'), {})
    const left = await remaining()

    expect(left).toBe(5)
  })
})

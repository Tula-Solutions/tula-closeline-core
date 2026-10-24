import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createApiKeyResponseSchema, listApiKeysResponseSchema } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { integrationUrls } from '~/integration-support'
import { API_KEY_RATE_LIMIT, hashSecret } from '~/modules/api-key/secret'
import { createTestApp, publicCaller, seedOrganization } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const store = createPostgresCoreStore(service.db)

afterAll(async () => {
  await service.close()
})

async function setup() {
  const harness = await createTestApp({
    store,
    env: { DATABASE_URL: urls.service },
    clockStart: new Date().toISOString(),
  })
  const a = await seedOrganization(store, [], 'Org A')
  const b = await seedOrganization(store, [], 'Org B')
  const api = publicCaller(harness)
  const create = async () => {
    const made = await api(
      a.owner,
      a.organizationId,
      'POST',
      '/api-keys',
      {
        name: 'CI',
        scopes: ['prospects:read'],
      },
      { 'idempotency-key': crypto.randomUUID() }
    )
    return { status: made.status, key: createApiKeyResponseSchema.parse(made.body) }
  }
  const verify = async (secret: string) => {
    const response = await harness.app.request('/internal/api-keys/verify', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({ secret }),
    })
    return {
      status: response.status,
      body: (await response.json()) as { error?: { code: string } },
    }
  }
  return { harness, a, b, api, create, verify }
}

describe('API keys over Postgres', () => {
  test('stores only the hash and opens the key by it', async () => {
    const { a, create, verify } = await setup()

    const { status, key } = await create()

    expect(status).toBe(201)
    const secret = key.secret ?? 'missing'
    const { rows } = await withOrganization(service.db, a.organizationId, (tx) =>
      tx.execute<{ hash: string; leaked: number }>(
        sql`select secret_hash as hash, (position(${secret} in secret_hash::text) > 0)::int as leaked
          from core.api_keys where id = ${key.id}`
      )
    )
    expect(rows[0]?.hash).toBe(hashSecret(secret))
    expect(rows[0]?.leaked).toBe(0)
    const ok = await verify(secret)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ apiKeyId: key.id, organizationId: a.organizationId })
    expect((await verify(`clk_${'b'.repeat(43)}`)).body.error?.code).toBe('apikey.invalid')
  })

  test('a second Organization cannot list or revoke the key', async () => {
    const { a, b, api, create } = await setup()
    const { key } = await create()

    const listed = await api(b.owner, b.organizationId, 'GET', '/api-keys')
    const revoked = await api(
      b.owner,
      b.organizationId,
      'POST',
      `/api-keys/${key.id}/revoke`,
      undefined,
      { 'idempotency-key': crypto.randomUUID() }
    )
    const mine = await api(a.owner, a.organizationId, 'GET', '/api-keys')

    expect(listApiKeysResponseSchema.parse(listed.body).items).toEqual([])
    expect(revoked.status).toBe(404)
    expect(listApiKeysResponseSchema.parse(mine.body).items.map((k) => k.id)).toContain(key.id)
  })

  test('revoking makes verify answer apikey.revoked', async () => {
    const { a, api, create, verify } = await setup()
    const { key } = await create()

    const revoked = await api(
      a.owner,
      a.organizationId,
      'POST',
      `/api-keys/${key.id}/revoke`,
      undefined,
      { 'idempotency-key': crypto.randomUUID() }
    )

    expect(revoked.status).toBe(200)
    expect((await verify(key.secret ?? '')).body.error?.code).toBe('apikey.revoked')
  })

  test('counts uses per window and limits past the ceiling', async () => {
    const { create, verify } = await setup()
    const { key } = await create()

    for (let i = 0; i < API_KEY_RATE_LIMIT; i += 1) {
      expect((await verify(key.secret ?? '')).status).toBe(200)
    }
    const limited = await verify(key.secret ?? '')

    expect(limited.status).toBe(429)
    expect(limited.body.error?.code).toBe('apikey.rate_limited')
  })
})

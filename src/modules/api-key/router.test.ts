import { describe, expect, test } from 'bun:test'
import {
  type ApiKeyId,
  apiKeySchema,
  createApiKeyResponseSchema,
  listApiKeysResponseSchema,
  type Role,
  verifyApiKeyResponseSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { API_KEY_RATE_LIMIT, hashesEqual, hashSecret } from './secret'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(store, [], 'Other')
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
    organizationId = seeded.organizationId,
    key: string | null = crypto.randomUUID()
  ) =>
    api(actor, organizationId, method, path, body, key === null ? {} : { 'idempotency-key': key })
  const verify = async (secret: unknown, headers = harness.internal()) => {
    const response = await harness.app.request('/internal/api-keys/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ secret }),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & { error?: { code: string } },
      retryAfter: response.headers.get('retry-after'),
    }
  }
  const input = { name: 'CI', scopes: ['prospects:read'] }
  const make = async (actor = seeded.owner, body: Record<string, unknown> = input) => {
    const made = await call(actor, 'POST', '/api-keys', body)
    const key = createApiKeyResponseSchema.safeParse(made.body).data as ReturnType<
      typeof createApiKeyResponseSchema.parse
    >
    return { ...made, key }
  }
  return { ...harness, store, seeded, other, member, call, verify, make, input }
}

describe('creating a key', () => {
  test('returns the secret once and stores only a hash', async () => {
    const { make, call, seeded, verify } = await setup()

    const { status, key } = await make()

    expect(status).toBe(201)
    expect(key.secret).toMatch(/^clk_[A-Za-z0-9_-]{43}$/)
    expect(key.prefix).toBe((key.secret ?? '').slice(0, 12))
    const listed = await call(seeded.owner, 'GET', '/api-keys')
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).not.toContain(key.secret ?? 'missing')
    expect(listApiKeysResponseSchema.parse(listed.body).items.map((k) => k.id)).toEqual([key.id])
    expect((await verify(key.secret)).status).toBe(200)
  })

  test('puts neither the secret nor its hash in the audit log or the logs', async () => {
    const { make, call, seeded, deps } = await setup()

    const { key } = await make()

    const audit = await call(seeded.owner, 'GET', '/audit-events')
    const secret = key.secret ?? 'missing'
    expect(audit.status).toBe(200)
    expect(JSON.stringify(audit.body)).toContain('api_key.created')
    expect(JSON.stringify(audit.body)).not.toContain(secret)
    expect(JSON.stringify(audit.body)).not.toContain(hashSecret(secret))
    expect(deps.logLines.join('\n')).not.toContain(secret)
    expect(deps.logLines.join('\n')).not.toContain(hashSecret(secret))
  })

  test('a repeat with the same Idempotency-Key is a 200 with no secret and no second key', async () => {
    const { call, seeded, input } = await setup()
    const key = crypto.randomUUID()

    const first = await call(seeded.owner, 'POST', '/api-keys', input, seeded.organizationId, key)
    const again = await call(seeded.owner, 'POST', '/api-keys', input, seeded.organizationId, key)

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body.secret).toBeNull()
    expect(again.body.id).toBe(first.body.id)
    const listed = listApiKeysResponseSchema.parse(
      (await call(seeded.owner, 'GET', '/api-keys')).body
    )
    expect(listed.items).toHaveLength(1)
  })

  test('needs an Idempotency-Key', async () => {
    const { call, seeded, input } = await setup()

    const refused = await call(
      seeded.owner,
      'POST',
      '/api-keys',
      input,
      seeded.organizationId,
      null
    )

    expect(refused.status).toBe(400)
  })

  test('an Admin may not give a role above their own', async () => {
    const { make, member } = await setup()

    const refused = await make(member('admin'), {
      ...{ name: 'x', scopes: ['prospects:read'] },
      roleCeiling: 'owner',
    })
    const allowed = await make(member('admin'), {
      name: 'x',
      scopes: ['prospects:read'],
      roleCeiling: 'admin',
    })

    expect(refused.status).toBe(403)
    expect(refused.body.error?.code).toBe('apikey.scope_not_allowed')
    expect(allowed.status).toBe(201)
  })

  test.each(['manager', 'rep'] as const)('a %s may not create, list or revoke', async (role) => {
    const { call, member, make, seeded } = await setup()
    const { key } = await make()

    const created = await call(member(role), 'POST', '/api-keys', {
      name: 'x',
      scopes: ['prospects:read'],
    })
    const listed = await call(member(role), 'GET', '/api-keys')
    const revoked = await call(member(role), 'POST', `/api-keys/${key.id}/revoke`)

    expect([created.status, listed.status, revoked.status]).toEqual([403, 403, 403])
    expect(seeded.organizationId).toBeDefined()
  })

  test('an expiry in the past is refused', async () => {
    const { make } = await setup()

    const refused = await make(undefined, {
      name: 'x',
      scopes: ['prospects:read'],
      expiresAt: '2025-01-01T00:00:00Z',
    })

    expect(refused.status).toBe(400)
  })
})

describe('listing keys', () => {
  test('pages newest first and hides revoked keys unless asked', async () => {
    const { make, call, seeded, deps } = await setup()
    const ids: ApiKeyId[] = []
    for (let i = 0; i < 3; i += 1) {
      deps.clock.advance('1m')
      ids.push((await make()).key.id)
    }
    await call(seeded.owner, 'POST', `/api-keys/${ids[1]}/revoke`)

    const first = listApiKeysResponseSchema.parse(
      (await call(seeded.owner, 'GET', '/api-keys?limit=1&includeRevoked=true')).body
    )
    const rest = listApiKeysResponseSchema.parse(
      (
        await call(
          seeded.owner,
          'GET',
          `/api-keys?limit=5&includeRevoked=true&cursor=${first.nextCursor}`
        )
      ).body
    )
    const live = listApiKeysResponseSchema.parse(
      (await call(seeded.owner, 'GET', '/api-keys')).body
    )

    expect(first.items.map((k) => k.id)).toEqual([ids[2] as ApiKeyId])
    expect(rest.items.map((k) => k.id)).toEqual([ids[1] as ApiKeyId, ids[0] as ApiKeyId])
    expect(rest.nextCursor).toBeNull()
    expect(live.items.map((k) => k.id)).toEqual([ids[2] as ApiKeyId, ids[0] as ApiKeyId])
  })

  test('a bad cursor is request.invalid', async () => {
    const { call, seeded } = await setup()

    const refused = await call(seeded.owner, 'GET', '/api-keys?cursor=nonsense')

    expect(refused.status).toBe(400)
    expect(refused.body.error?.code).toBe('request.invalid')
  })
})

describe('revoking a key', () => {
  test('revokes once, keeps the first time and audits it', async () => {
    const { make, call, seeded, deps, verify } = await setup()
    const { key } = await make()

    const first = await call(seeded.owner, 'POST', `/api-keys/${key.id}/revoke`)
    deps.clock.advance('5m')
    const again = await call(seeded.owner, 'POST', `/api-keys/${key.id}/revoke`)

    expect(first.status).toBe(200)
    expect(apiKeySchema.parse(first.body).revokedAt).not.toBeNull()
    expect(again.status).toBe(200)
    expect(again.body.revokedAt).toBe(first.body.revokedAt)
    const audit = await call(seeded.owner, 'GET', '/audit-events?action=api_key.revoked')
    expect((audit.body.items as unknown[]).length).toBe(1)
    const refused = await verify(key.secret)
    expect(refused.status).toBe(401)
    expect(refused.body.error?.code).toBe('apikey.revoked')
  })
})

describe('another Organization', () => {
  test('cannot list or revoke the keys, and sees none', async () => {
    const { make, call, other } = await setup()
    const { key } = await make()

    const listed = await call(other.owner, 'GET', '/api-keys', undefined, other.organizationId)
    const revoked = await call(
      other.owner,
      'POST',
      `/api-keys/${key.id}/revoke`,
      undefined,
      other.organizationId
    )

    expect(listApiKeysResponseSchema.parse(listed.body).items).toEqual([])
    expect(revoked.status).toBe(404)
    expect(revoked.body.error?.code).toBe('apikey.not_found')
    const mine = await call(
      other.owner,
      'GET',
      '/api-keys?includeRevoked=true',
      undefined,
      other.organizationId
    )
    expect(JSON.stringify(mine.body)).not.toContain(key.id)
  })
})

describe('verifying a key', () => {
  test('answers the key, its Organization, scopes, ceiling and expiry', async () => {
    const { make, verify, seeded } = await setup()
    const { key } = await make(seeded.owner, {
      name: 'x',
      scopes: ['prospects:read', 'consent:write'],
      roleCeiling: 'manager',
      expiresAt: '2026-06-01T00:00:00.000Z',
    })

    const { status, body } = await verify(key.secret)

    expect(status).toBe(200)
    expect(verifyApiKeyResponseSchema.parse(body)).toEqual({
      apiKeyId: key.id,
      organizationId: seeded.organizationId,
      scopes: ['prospects:read', 'consent:write'],
      roleCeiling: 'manager',
      expiresAt: '2026-06-01T00:00:00.000Z',
    })
  })

  test('refuses an unknown secret as apikey.invalid and a malformed one as request.invalid', async () => {
    const { verify } = await setup()

    const unknown = await verify(`clk_${'a'.repeat(43)}`)
    const malformed = await verify('not-a-key')

    expect(unknown.status).toBe(401)
    expect(unknown.body.error?.code).toBe('apikey.invalid')
    expect(malformed.status).toBe(400)
    expect(malformed.body.error?.code).toBe('request.invalid')
  })

  test('refuses an expired key as apikey.revoked', async () => {
    const { make, verify, seeded, deps } = await setup()
    const { key } = await make(seeded.owner, {
      name: 'x',
      scopes: ['prospects:read'],
      expiresAt: '2026-01-01T01:00:00.000Z',
    })
    expect((await verify(key.secret)).status).toBe(200)

    deps.clock.advance('2h')
    const refused = await verify(key.secret)

    expect(refused.status).toBe(401)
    expect(refused.body.error?.code).toBe('apikey.revoked')
  })

  test('needs the internal secret', async () => {
    const { make, verify } = await setup()
    const { key } = await make()

    const refused = await verify(key.secret, { ...{ 'content-type': 'application/json' } } as never)

    expect(refused.status).toBe(401)
  })

  test('counts uses and answers apikey.rate_limited with Retry-After past the limit', async () => {
    const { make, verify, deps } = await setup()
    const { key } = await make()

    for (let i = 0; i < API_KEY_RATE_LIMIT; i += 1) {
      expect((await verify(key.secret)).status).toBe(200)
    }
    const limited = await verify(key.secret)

    expect(limited.status).toBe(429)
    expect(limited.body.error?.code).toBe('apikey.rate_limited')
    expect(Number(limited.retryAfter)).toBeGreaterThanOrEqual(1)
    deps.clock.advance('1m')
    expect((await verify(key.secret)).status).toBe(200)
  })

  test('stamps lastUsedAt', async () => {
    const { make, verify, call, seeded, deps } = await setup()
    const { key } = await make()
    deps.clock.advance('3m')

    await verify(key.secret)

    const listed = listApiKeysResponseSchema.parse(
      (await call(seeded.owner, 'GET', '/api-keys')).body
    )
    expect(listed.items[0]?.lastUsedAt).toBe('2026-01-01T00:03:00.000Z')
  })
})

describe('comparing hashes', () => {
  test('is true only for equal hashes', () => {
    expect(hashesEqual(hashSecret('a'), hashSecret('a'))).toBe(true)
    expect(hashesEqual(hashSecret('a'), hashSecret('b'))).toBe(false)
    expect(hashesEqual('ab', hashSecret('b'))).toBe(false)
  })
})

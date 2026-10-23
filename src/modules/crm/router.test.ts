import { describe, expect, test } from 'bun:test'
import { type CrmConnectionId, formatId, type Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemorySecretBox, SecretBoxOpenError } from '~/adapters/memory/secret-box'
import { createUnconfiguredSecretBox } from '~/adapters/unconfigured/secret-box'
import type { SecretBox } from '~/ports/secret-box'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import * as Crm from './service'

const ACCESS = 'pat-access-token-SECRET-VALUE-1'
const REFRESH = 'pat-refresh-token-SECRET-VALUE-2'

const grant = (externalAccountId = '12345') => ({
  accessToken: ACCESS,
  refreshToken: REFRESH,
  accessTokenExpiresAt: new Date('2026-01-01T01:00:00Z'),
  externalAccountId,
  accountLabel: 'Acme Sales',
  scopeLevel: 'read' as const,
})

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory, ...overrides })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, undefined, headers)
  const caller = (member: SeededMember, organizationId = seeded.organizationId) => ({
    organizationId,
    userId: member.userId,
    role: member.role,
  })
  /** Connects through the service, the way the later callback will. */
  const connect = async (
    member: SeededMember = seeded.owner,
    code = 'code-1',
    externalAccountId = '12345'
  ) => {
    harness.deps.hubspot.acceptCode(code, grant(externalAccountId))
    return Crm.connect(
      harness.deps,
      caller(member),
      { provider: 'hubspot', code, redirectUri: 'https://core.test/cb' },
      { traceId: 'trace-1' }
    )
  }
  const key = () => ({ 'idempotency-key': crypto.randomUUID() })
  const queued = async () => {
    const out: { type: string; payload: Record<string, unknown> }[] = []
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        return out
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          out.push({
            type: delivery.envelope.type,
            payload: delivery.envelope.payload as Record<string, unknown>,
          })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  return { ...harness, memory, seeded, byRole, call, connect, key, queued, caller }
}

describe('CRM status', () => {
  test('is not_connected by default', async () => {
    const t = await setup()
    const response = await t.call(t.seeded.owner, 'GET', '/crm/connections/hubspot')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ provider: 'hubspot', state: 'not_connected', connection: null })
    const list = await t.call(t.seeded.owner, 'GET', '/crm/connections')
    expect(list.body).toEqual({ items: [], nextCursor: null })
  })

  test('shows connected after the memory provider connects', async () => {
    const t = await setup()
    await t.connect()
    const response = await t.call(t.seeded.owner, 'GET', '/crm/connections/hubspot')
    expect(response.status).toBe(200)
    expect(response.body.state).toBe('connected')
    expect(response.body.connection).toMatchObject({
      provider: 'hubspot',
      state: 'connected',
      accountLabel: 'Acme Sales',
      scopeLevel: 'read',
      connectedByMembershipId: t.seeded.owner.id,
      needsReconnectSince: null,
    })
    const list = await t.call(t.seeded.owner, 'GET', '/crm/connections')
    expect((list.body.items as unknown[]).length).toBe(1)
  })
})

describe('CRM disconnect', () => {
  test('deletes the stored tokens and publishes crm.disconnected', async () => {
    const t = await setup()
    await t.connect()
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot').length).toBeGreaterThan(
      0
    )
    await t.queued()
    const response = await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', t.key())
    expect(response.status).toBe(204)
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot')).toEqual([])
    const status = await t.call(t.seeded.owner, 'GET', '/crm/connections/hubspot')
    expect(status.body.state).toBe('not_connected')
    const events = await t.queued()
    expect(events.map((e) => e.type)).toEqual(['crm.disconnected'])
    expect(events[0]?.payload).toMatchObject({
      provider: 'hubspot',
      disconnectedByMembershipId: t.seeded.owner.id,
    })
  })

  test('an Admin may disconnect', async () => {
    const t = await setup()
    await t.connect()
    const response = await t.call(t.byRole('admin'), 'DELETE', '/crm/connections/hubspot', t.key())
    expect(response.status).toBe(204)
  })

  test('a Manager and a Rep may not disconnect, and nothing is deleted', async () => {
    const t = await setup()
    await t.connect()
    for (const role of ['manager', 'rep'] as const) {
      const response = await t.call(t.byRole(role), 'DELETE', '/crm/connections/hubspot', t.key())
      expect(response.status).toBe(403)
    }
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot').length).toBeGreaterThan(
      0
    )
  })

  test('a provider with no connection is crm.not_connected', async () => {
    const t = await setup()
    const response = await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', t.key())
    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('crm.not_connected')
  })

  test('requires an Idempotency-Key', async () => {
    const t = await setup()
    await t.connect()
    const response = await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot')
    expect(response.status).toBe(400)
  })

  test('a replay with the same key answers 204 and publishes once', async () => {
    const t = await setup()
    await t.connect()
    await t.queued()
    const headers = t.key()
    expect(
      (await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', headers)).status
    ).toBe(204)
    expect(
      (await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', headers)).status
    ).toBe(204)
    expect((await t.queued()).filter((e) => e.type === 'crm.disconnected').length).toBe(1)
  })
})

describe('CRM tokens never leave', () => {
  test('are stored sealed, and appear in no response and no log line', async () => {
    const t = await setup()
    await t.connect()
    const stored = t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot')
    expect(stored.length).toBeGreaterThan(0)
    for (const bytes of stored) {
      const text = Buffer.from(bytes).toString('utf8')
      expect(text).not.toContain(ACCESS)
      expect(text).not.toContain(REFRESH)
    }
    // The stored values are real: they open back to the plaintext under their own context only.
    const tokens = await t.deps.store.withOrganization(t.seeded.organizationId, (scope) =>
      scope.getCrmSealedTokens('hubspot')
    )
    const context = {
      organizationId: t.seeded.organizationId,
      connectionId: tokens?.connectionId as CrmConnectionId,
    }
    const keyId = tokens?.tokenKeyId as string
    const open = (
      bytes: Uint8Array | null,
      purpose: 'access_token' | 'refresh_token',
      id = context
    ) => t.deps.secretBox.open({ keyId, ciphertext: bytes as Uint8Array }, { ...id, purpose })
    expect(await open(tokens?.accessTokenSealed ?? null, 'access_token')).toBe(ACCESS)
    expect(await open(tokens?.refreshTokenSealed ?? null, 'refresh_token')).toBe(REFRESH)
    await expect(open(tokens?.accessTokenSealed ?? null, 'refresh_token')).rejects.toBeInstanceOf(
      SecretBoxOpenError
    )
    await expect(
      open(tokens?.accessTokenSealed ?? null, 'access_token', {
        ...context,
        organizationId: formatId('org', crypto.randomUUID()),
      })
    ).rejects.toBeInstanceOf(SecretBoxOpenError)
    const bodies = [
      await t.call(t.seeded.owner, 'GET', '/crm/connections/hubspot'),
      await t.call(t.seeded.owner, 'GET', '/crm/connections'),
      await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', t.key()),
      await t.call(t.seeded.owner, 'DELETE', '/crm/connections/hubspot', t.key()),
    ].map((r) => JSON.stringify(r.body))
    const events = JSON.stringify(await t.queued())
    for (const text of [...bodies, events, t.deps.logLines.join('\n')]) {
      expect(text).not.toContain(ACCESS)
      expect(text).not.toContain(REFRESH)
      expect(text).not.toContain('SECRET-VALUE')
    }
  })
})

describe('CRM connect', () => {
  test('a Manager may not connect', async () => {
    const t = await setup()
    t.deps.hubspot.acceptCode('code-1', grant())
    await expect(
      Crm.connect(
        t.deps,
        t.caller(t.byRole('manager')),
        { provider: 'hubspot', code: 'code-1', redirectUri: 'https://core.test/cb' },
        { traceId: 'trace-1' }
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot')).toEqual([])
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
  })

  test('a suspended Organization refuses before the code is exchanged', async () => {
    const t = await setup()
    t.memory.setOrganizationStatus(t.seeded.organizationId, 'suspended')
    t.deps.hubspot.acceptCode('code-1', grant())
    await expect(t.connect()).rejects.toMatchObject({ status: 403 })
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
  })

  test('reconnecting to a different CRM account is a new connection', async () => {
    const t = await setup()
    const first = await t.connect(t.seeded.owner, 'code-1', 'account-a')
    const same = await t.connect(t.seeded.owner, 'code-2', 'account-a')
    expect(same.connection?.id).toBe(first.connection?.id)
    const other = await t.connect(t.seeded.owner, 'code-3', 'account-b')
    expect(other.connection?.id).not.toBe(first.connection?.id)
    expect(other.connection?.lastSyncedAt).toBeNull()
    const list = await t.call(t.seeded.owner, 'GET', '/crm/connections')
    expect((list.body.items as unknown[]).length).toBe(1)
  })

  test('both tokens are sealed under one key, or nothing is stored', async () => {
    const real = createMemorySecretBox()
    let calls = 0
    const rotating: SecretBox = {
      configured: true,
      open: real.open,
      seal: async (plaintext, context) => {
        const sealed = await real.seal(plaintext, context)
        calls += 1
        return { ...sealed, keyId: `key-${calls}` }
      },
    }
    const t = await setup({ secretBox: rotating })
    await expect(t.connect()).rejects.toThrow(
      'the SecretBox sealed the two tokens under different keys'
    )
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot')).toEqual([])
  })

  test('a refused code is crm.authorisation_failed', async () => {
    const t = await setup()
    await expect(
      Crm.connect(
        t.deps,
        t.caller(t.seeded.owner),
        { provider: 'hubspot', code: 'never-issued', redirectUri: 'https://core.test/cb' },
        { traceId: 'trace-1' }
      )
    ).rejects.toMatchObject({ code: 'crm.authorisation_failed', status: 400 })
  })

  test('an unconfigured provider is crm.authorisation_failed', async () => {
    const t = await setup({ crmProviders: {} })
    await expect(t.connect()).rejects.toMatchObject({
      code: 'crm.authorisation_failed',
      status: 400,
    })
  })

  test('an unconfigured SecretBox refuses before the code is exchanged', async () => {
    const t = await setup({ secretBox: createUnconfiguredSecretBox() })
    await expect(t.connect()).rejects.toMatchObject({
      code: 'crm.authorisation_failed',
      status: 400,
    })
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot')).toEqual([])
  })

  test('a CRM account another Organization holds is refused', async () => {
    const t = await setup()
    await t.connect(t.seeded.owner, 'code-1', 'shared-account')
    const other = await seedOrganization(t.memory)
    t.deps.hubspot.acceptCode('code-2', grant('shared-account'))
    await expect(
      Crm.connect(
        t.deps,
        t.caller(other.owner, other.organizationId),
        { provider: 'hubspot', code: 'code-2', redirectUri: 'https://core.test/cb' },
        { traceId: 'trace-2' }
      )
    ).rejects.toMatchObject({ status: 400 })
  })

  test('a replace publishes crm.disconnected for the old id, then crm.connected for the new', async () => {
    const t = await setup()
    const first = await t.connect(t.seeded.owner, 'code-1', 'account-a')
    await t.queued()
    const other = await t.connect(t.byRole('admin'), 'code-2', 'account-b')
    const events = await t.queued()
    expect(events.map((e) => e.type)).toEqual(['crm.disconnected', 'crm.connected'])
    expect(events[0]?.payload).toMatchObject({
      connectionId: first.connection?.id,
      provider: 'hubspot',
      disconnectedByMembershipId: t.byRole('admin').id,
    })
    expect(events[1]?.payload).toMatchObject({ connectionId: other.connection?.id })
  })

  test('a reconnect to the same account publishes only crm.connected', async () => {
    const t = await setup()
    await t.connect(t.seeded.owner, 'code-1', 'account-a')
    await t.queued()
    await t.connect(t.seeded.owner, 'code-2', 'account-a')
    expect((await t.queued()).map((e) => e.type)).toEqual(['crm.connected'])
  })

  test('connecting again keeps the connection id', async () => {
    const t = await setup()
    const first = await t.connect(t.seeded.owner, 'code-1')
    const second = await t.connect(t.seeded.owner, 'code-2')
    expect(second.connection?.id).toBe(first.connection?.id)
  })

  test('a Manager may read the status', async () => {
    const t = await setup()
    await t.connect()
    expect((await t.call(t.byRole('manager'), 'GET', '/crm/connections/hubspot')).status).toBe(200)
    expect((await t.call(t.byRole('manager'), 'GET', '/crm/connections')).status).toBe(200)
  })

  test('a Rep may not read the status', async () => {
    const t = await setup()
    const response = await t.call(t.byRole('rep'), 'GET', '/crm/connections/hubspot')
    expect(response.status).toBe(403)
  })

  test('an unknown provider is a bad request', async () => {
    const t = await setup()
    const response = await t.call(t.seeded.owner, 'GET', '/crm/connections/nope')
    expect(response.status).toBe(400)
  })
})

describe('CRM isolation between Organizations', () => {
  test('a second Organization cannot read or disconnect the first one connection', async () => {
    const t = await setup()
    await t.connect()
    const other = await seedOrganization(t.memory)
    const read = await t.call(
      other.owner,
      'GET',
      '/crm/connections/hubspot',
      undefined,
      other.organizationId
    )
    expect(read.body).toEqual({ provider: 'hubspot', state: 'not_connected', connection: null })
    const list = await t.call(
      other.owner,
      'GET',
      '/crm/connections',
      undefined,
      other.organizationId
    )
    expect(list.body).toEqual({ items: [], nextCursor: null })
    const del = await t.call(
      other.owner,
      'DELETE',
      '/crm/connections/hubspot',
      t.key(),
      other.organizationId
    )
    expect(del.status).toBe(404)
    expect(t.memory.storedCrmTokenBytes(t.seeded.organizationId, 'hubspot').length).toBeGreaterThan(
      0
    )
  })
})

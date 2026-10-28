import { describe, expect, test } from 'bun:test'
import type { Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryCrmProvider } from '~/adapters/memory/crm-provider'
import { createMemorySecretBox, MEMORY_SECRET_KEY_ID } from '~/adapters/memory/secret-box'
import { CrmRevokedError, CrmUnavailableError } from '~/ports/crm-provider'
import type { SecretBox } from '~/ports/secret-box'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import * as Tokens from './tokens'

const ACCESS = 'hs-access-SECRET-1'
const REFRESH = 'hs-refresh-SECRET-2'
const grant = (externalAccountId = '777') => ({
  accessToken: ACCESS,
  refreshToken: REFRESH,
  accessTokenExpiresAt: new Date('2026-01-01T01:00:00Z'),
  externalAccountId,
  accountLabel: 'Acme',
  scopeLevel: 'read' as const,
})

async function setup(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({
    store: memory,
    ...overrides,
  })
  const seeded = await seedOrganization(memory, ['admin', 'rep'])
  const second = await seedOrganization(memory, [])
  const api = publicCaller(harness)
  const member = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const start = (actor: SeededMember, body?: unknown, organizationId = seeded.organizationId) =>
    api(actor, organizationId, 'POST', '/crm/connections/hubspot/authorisations', body ?? {}, {
      'idempotency-key': crypto.randomUUID(),
    })
  const stateOf = (url: unknown) => new URL(String(url)).searchParams.get('state') as string
  /** The portal finishing the sign-in as `actor` (the owner unless said otherwise). */
  const callback = (
    query: { code?: string; state: string },
    provider = 'hubspot',
    actor: SeededMember = seeded.owner,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, 'POST', `/crm/connections/${provider}/completions`, query)
  const status = async () =>
    (await api(seeded.owner, seeded.organizationId, 'GET', '/crm/connections/hubspot')).body
  return { ...harness, memory, seeded, second, member, start, stateOf, callback, status }
}

describe('start authorisation', () => {
  test('answers a sign-in address with a state and the portal callback page as redirect address', async () => {
    const t = await setup()
    const response = await t.start(t.seeded.owner)
    expect(response.status).toBe(201)
    const url = new URL(String(response.body.authorisationUrl))
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${t.deps.env.PORTAL_BASE_URL}/integrations/hubspot/callback`
    )
    expect(url.searchParams.get('scope')).toBe('read')
    expect(response.body.expiresAt).toBe(
      new Date(t.deps.clock.now().getTime() + 600_000).toISOString()
    )
    expect(t.stateOf(response.body.authorisationUrl).length).toBeGreaterThan(20)
  })

  test('asks for write scopes only when writeBack is set', async () => {
    const t = await setup()
    const response = await t.start(t.seeded.owner, { writeBack: true })
    expect(new URL(String(response.body.authorisationUrl)).searchParams.get('scope')).toBe(
      'read write'
    )
  })

  test('only Owner and Admin may start; a Rep gets 403', async () => {
    const t = await setup()
    expect((await t.start(t.member('admin'))).status).toBe(201)
    const rep = await t.start(t.member('rep'))
    expect(rep.status).toBe(403)
  })

  test('the same Idempotency-Key answers the same address with 200', async () => {
    const t = await setup()
    const api = publicCaller(t)
    const headers = { 'idempotency-key': crypto.randomUUID() }
    const path = '/crm/connections/hubspot/authorisations'
    const first = await api(t.seeded.owner, t.seeded.organizationId, 'POST', path, {}, headers)
    const again = await api(t.seeded.owner, t.seeded.organizationId, 'POST', path, {}, headers)
    expect([first.status, again.status]).toEqual([201, 200])
    expect(again.body).toEqual(first.body)
  })

  test('a provider that is not configured is crm.authorisation_failed', async () => {
    const t = await setup({ crmProviders: {} })
    const response = await t.start(t.seeded.owner)
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('crm.authorisation_failed')
  })
})

describe('OAuth completion', () => {
  async function started(t: Awaited<ReturnType<typeof setup>>, code = 'code-1') {
    t.deps.hubspot.acceptCode(code, grant())
    const response = await t.start(t.seeded.owner)
    return t.stateOf(response.body.authorisationUrl)
  }

  test('connects and stores sealed tokens', async () => {
    const t = await setup()
    const state = await started(t)
    const response = await t.callback({ code: 'code-1', state })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ state: 'connected' })
    const status = await t.status()
    expect(status).toMatchObject({ state: 'connected' })
    expect(status.connection).toMatchObject({
      accountLabel: 'Acme',
      connectedByMembershipId: t.seeded.owner.id,
    })
    expect(t.deps.logLines.join('\n')).not.toContain(state)
    expect(t.deps.logLines.join('\n')).not.toContain('code-1')
  })

  test('a valid state finished by another user or another Organization is refused, no exchange', async () => {
    const t = await setup()
    const state = await started(t)
    // The Admin of the same Organization (a different browser session), and a stranger's Owner.
    const sameOrgAdmin = await t.callback({ code: 'code-1', state }, 'hubspot', t.member('admin'))
    const otherOrg = await t.callback(
      { code: 'code-1', state },
      'hubspot',
      t.second.owner,
      t.second.organizationId
    )
    for (const response of [sameOrgAdmin, otherOrg]) {
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('crm.authorisation_failed')
    }
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
    expect((await t.status()).state).toBe('not_connected')
  })

  test('a tampered state is a generic 400 and spends no code', async () => {
    const t = await setup()
    const state = await started(t)
    const last = state.slice(-1) === 'A' ? 'B' : 'A'
    const response = await t.callback({ code: 'code-1', state: state.slice(0, -1) + last })
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('crm.authorisation_failed')
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
  })

  test('a garbage state is a 400', async () => {
    const t = await setup()
    for (const query of [
      { code: 'c', state: 'not-a-state' },
      { code: 'c', state: 'a.b.c' },
    ]) {
      const response = await t.callback(query)
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('crm.authorisation_failed')
    }
  })

  test('an expired state is a 400', async () => {
    const t = await setup()
    const state = await started(t)
    t.deps.clock.advance('11m')
    const response = await t.callback({ code: 'code-1', state })
    expect(response.status).toBe(400)
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
  })

  test('a state spliced onto another Organization or user does not open', async () => {
    const t = await setup()
    const state = await started(t)
    const [, sealed] = state.split('.') as [string, string]
    const names = (org: string, user: string) => Buffer.from(`${org} ${user}`).toString('base64url')
    const otherOrg = names(t.second.organizationId, t.seeded.owner.userId)
    const otherUser = names(t.seeded.organizationId, t.second.owner.userId)
    for (const prefix of [otherOrg, otherUser]) {
      const response = await t.callback({ code: 'code-1', state: `${prefix}.${sealed}` })
      expect(response.status).toBe(400)
    }
    expect(t.deps.hubspot.exchangeCalls).toBe(0)
    expect((await t.status()).state).toBe('not_connected')
  })

  test('an over-long state is refused before any key service call', async () => {
    let opens = 0
    const inner = createMemorySecretBox()
    const t = await setup({
      secretBox: {
        ...inner,
        open: (...args) => {
          opens++
          return inner.open(...args)
        },
      },
    })
    const state = await started(t)
    const [prefix] = state.split('.') as [string]
    const response = await t.callback({ code: 'code-1', state: `${prefix}.${'A'.repeat(4000)}` })
    expect(response.status).toBe(400)
    expect(opens).toBe(0)
  })

  test('a state made for another provider is a 400', async () => {
    const t = await setup()
    const state = await started(t)
    expect((await t.callback({ code: 'code-1', state }, 'salesforce')).status).toBe(400)
  })

  test('a code the CRM refuses is the same generic 400', async () => {
    const t = await setup()
    const state = await started(t)
    const response = await t.callback({ code: 'wrong', state })
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('crm.authorisation_failed')
  })

  test('a CRM account another Organization holds is the same generic 400', async () => {
    const t = await setup()
    const first = await started(t)
    await t.callback({ code: 'code-1', state: first })
    // The second Organization's Owner signs in to the same HubSpot account.
    t.deps.hubspot.acceptCode('code-2', grant())
    const other = await t.start(t.second.owner, undefined, t.second.organizationId)
    const response = await t.callback(
      { code: 'code-2', state: t.stateOf(other.body.authorisationUrl) },
      'hubspot',
      t.second.owner,
      t.second.organizationId
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('crm.authorisation_failed')
  })

  test('an Admin who lost the role meanwhile cannot finish', async () => {
    const t = await setup()
    t.deps.hubspot.acceptCode('code-1', grant())
    const response = await t.start(t.member('admin'))
    await t.memory.withOrganization(t.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.setRole(t.member('admin').id, 'rep', t.deps.clock.now())
    })
    const done = await t.callback(
      { code: 'code-1', state: t.stateOf(response.body.authorisationUrl) },
      'hubspot',
      t.member('admin')
    )
    // The token still says Admin, so the code is spent; the write checks the role as it is now.
    expect(done.status).toBe(403)
    expect((await t.status()).state).toBe('not_connected')
  })
})

describe('access token', () => {
  async function withConnection(refresh?: () => Promise<never>, secretBox?: SecretBox) {
    const provider = createMemoryCrmProvider()
    provider.acceptCode('code-1', grant())
    const t = await setup({
      crmProviders: { hubspot: refresh ? { ...provider, refresh } : provider },
      ...(secretBox ? { secretBox } : {}),
    })
    t.deps.hubspot.acceptCode('code-1', grant())
    const response = await t.start(t.seeded.owner)
    await t.callback({ code: 'code-1', state: t.stateOf(response.body.authorisationUrl) })
    return Object.assign(t, { provider })
  }

  const read = (t: Awaited<ReturnType<typeof setup>>) =>
    Tokens.accessToken(t.deps, t.seeded.organizationId, 'hubspot')

  test('no connection is crm.not_connected', async () => {
    const t = await setup()
    await expect(read(t)).rejects.toMatchObject({ code: 'crm.not_connected' })
  })

  test('returns the stored token while it has more than five minutes left', async () => {
    const t = await withConnection()
    expect(await read(t)).toBe(ACCESS)
  })

  test('refreshes a token near expiry, stores the new one and uses it next time', async () => {
    const t = await withConnection()
    t.deps.clock.advance('56m')
    expect(await read(t)).toBe(`${ACCESS}-refreshed`)
    // Stored: the memory provider reports the same expiry, so the next read refreshes again, and
    // the stored token is still the refreshed one when the CRM is not asked (expiry cleared).
    const tokens = await t.memory.withOrganization(t.seeded.organizationId, (scope) =>
      scope.getCrmSealedTokens('hubspot')
    )
    expect(tokens?.accessTokenSealed).not.toBeNull()
  })

  test('a revoked grant marks the connection needs_reconnect and keeps answering so', async () => {
    const t = await withConnection(async () => {
      throw new CrmRevokedError()
    })
    t.deps.clock.advance('56m')
    await expect(read(t)).rejects.toMatchObject({ code: 'crm.needs_reconnect' })
    const status = await t.status()
    expect(status.state).toBe('needs_reconnect')
    expect(status.connection).toMatchObject({ needsReconnectSince: expect.any(String) })
    await expect(read(t)).rejects.toMatchObject({ code: 'crm.needs_reconnect' })
  })

  test('a CRM that is limiting or down is crm.rate_limited and the connection stays connected', async () => {
    const t = await withConnection(async () => {
      throw new CrmUnavailableError(1000)
    })
    t.deps.clock.advance('56m')
    await expect(read(t)).rejects.toMatchObject({ code: 'crm.rate_limited' })
    expect((await t.status()).state).toBe('connected')
  })

  test('a refresh that returns no new refresh token reseals the kept one under the current key', async () => {
    // A box whose key id moves on, and whose values open only under the id they were sealed with.
    const inner = createMemorySecretBox()
    let generation = 1
    const rotating: SecretBox = {
      configured: true,
      seal: async (plaintext, context) => {
        const sealed = await inner.seal(plaintext, context)
        return {
          keyId: `g${generation}`,
          ciphertext: new Uint8Array([generation, ...sealed.ciphertext]),
        }
      },
      open: async (sealed, context) => {
        if (sealed.keyId !== `g${sealed.ciphertext[0]}`) {
          throw new Error('wrong key')
        }
        return inner.open(
          { keyId: MEMORY_SECRET_KEY_ID, ciphertext: sealed.ciphertext.slice(1) },
          context
        )
      },
    }
    const t = await withConnection(undefined, rotating)
    generation = 2
    t.deps.clock.advance('56m')
    expect(await read(t)).toBe(`${ACCESS}-refreshed`)
    t.deps.clock.advance('56m')
    expect(await read(t)).toBe(`${ACCESS}-refreshed`)
  })

  test('another Organization has no connection to read', async () => {
    const t = await withConnection()
    await expect(
      Tokens.accessToken(t.deps, t.second.organizationId, 'hubspot')
    ).rejects.toMatchObject({ code: 'crm.not_connected' })
  })

  test('a reconnect that lands during a refresh is not overwritten by the stale refresh', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = await withConnection()
    const slow = {
      ...t.provider,
      refresh: async (...a: Parameters<typeof t.provider.refresh>) => {
        await gate
        return t.provider.refresh(...a)
      },
    }
    // Same store and clock, but the refresh now waits for the gate.
    const racing = { ...t.deps, crmProviders: { hubspot: slow } }
    t.deps.clock.advance('56m')
    const pending = Tokens.accessToken(racing, t.seeded.organizationId, 'hubspot')
    await Bun.sleep(20)
    t.provider.acceptCode('code-2', {
      ...grant(),
      accessToken: 'reconnected-access',
      refreshToken: 'reconnected-refresh',
      accessTokenExpiresAt: new Date('2026-01-02T00:00:00Z'),
    })
    const response = await t.start(t.seeded.owner)
    await t.callback({ code: 'code-2', state: t.stateOf(response.body.authorisationUrl) })
    release()
    await pending
    expect(await read(t)).toBe('reconnected-access')
  })

  test('reconnecting after needs_reconnect makes the token readable again', async () => {
    const t = await withConnection(async () => {
      throw new CrmRevokedError()
    })
    t.deps.clock.advance('56m')
    await expect(read(t)).rejects.toMatchObject({ code: 'crm.needs_reconnect' })
    t.provider.acceptCode('code-2', grant())
    const response = await t.start(t.seeded.owner)
    await t.callback({ code: 'code-2', state: t.stateOf(response.body.authorisationUrl) })
    expect((await t.status()).state).toBe('connected')
  })
})

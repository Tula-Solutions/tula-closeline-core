import { afterAll, describe, expect, test } from 'bun:test'
import { CrmRefusedError, CrmRevokedError, CrmUnavailableError } from '~/ports/crm-provider'
import { describeCrmProvider } from '~/ports/crm-provider.behaviour'
import { createHubspotCrmProvider } from './crm-provider'
import { startFakeHubspot } from './fake-hubspot'

const fakes: ReturnType<typeof startFakeHubspot>[] = []
afterAll(() => {
  for (const fake of fakes) {
    fake.stop()
  }
})

const NOW = new Date('2026-01-01T00:00:00Z')

function make(extra: Partial<Parameters<typeof createHubspotCrmProvider>[0]> = {}) {
  const fake = startFakeHubspot()
  fakes.push(fake)
  const waits: number[] = []
  const provider = createHubspotCrmProvider({
    clientId: 'client-1',
    clientSecret: 'secret-1',
    apiBaseUrl: fake.url,
    now: () => NOW,
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms)
    },
    ...extra,
  })
  return { fake, provider, waits }
}

describeCrmProvider('hubspot (scripted fake over HTTP)', () => {
  const { fake, provider } = make()
  return { provider, acceptCode: (code, grant) => fake.acceptCode(code, grant) }
})

const GRANT = {
  accessToken: 'access',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: null,
  externalAccountId: '12345',
  accountLabel: 'acme.hubspot.test',
  scopeLevel: 'read' as const,
}
const open = () => new AbortController().signal

describe('hubspot adapter', () => {
  test('exchange names the account, the label, the scope level and the expiry', async () => {
    const { fake, provider } = make()
    fake.acceptCode('c', { ...GRANT, scopeLevel: 'read_write' })
    const grant = await provider.exchangeCode('c', 'https://core.test/cb', open())
    expect(grant.externalAccountId).toBe('12345')
    expect(grant.accountLabel).toBe('acme.hubspot.test')
    expect(grant.scopeLevel).toBe('read_write')
    expect(grant.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 3600_000))
    expect(fake.requests[0]?.form.redirect_uri).toBe('https://core.test/cb')
  })

  test('a refused code is CrmRefusedError and is not retried', async () => {
    const { fake, provider } = make()
    await expect(
      provider.exchangeCode('bad', 'https://core.test/cb', open())
    ).rejects.toBeInstanceOf(CrmRefusedError)
    expect(fake.requests).toHaveLength(1)
  })

  test('an account lookup HubSpot answers with an unreadable body is refused, not a crash', async () => {
    const { fake, provider } = make()
    fake.acceptCode('c', GRANT)
    // The first answer is the token; the second is the lookup, which has no hub_id.
    fake.queue(
      { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 60 } },
      { status: 200, body: { scopes: [] } }
    )
    await expect(provider.exchangeCode('c', 'https://core.test/cb', open())).rejects.toBeInstanceOf(
      CrmRefusedError
    )
  })

  test('a refresh the client credentials fail is not a revoked grant', async () => {
    const { fake, provider } = make()
    fake.queue({ status: 401, body: { status: 'BAD_CLIENT_SECRET' } })
    const error = await provider.refresh('r', open()).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(CrmRevokedError)
    expect(error).toBeInstanceOf(CrmUnavailableError)
  })

  test('the single-use code is exchanged once, even when HubSpot answers 502', async () => {
    const { fake, provider } = make()
    fake.queue({ status: 502 })
    await expect(provider.exchangeCode('c', 'https://core.test/cb', open())).rejects.toBeInstanceOf(
      CrmUnavailableError
    )
    expect(fake.requests).toHaveLength(1)
  })

  test('a revoked refresh token is CrmRevokedError and is not retried', async () => {
    const { fake, provider } = make()
    await expect(provider.refresh('gone', open())).rejects.toBeInstanceOf(CrmRevokedError)
    expect(fake.requests).toHaveLength(1)
  })

  test('a refresh keeps the refresh token HubSpot does not rotate', async () => {
    const { fake, provider } = make()
    fake.acceptCode('c', GRANT)
    const next = await provider.refresh('refresh-1', open())
    expect(next.refreshToken).toBe('refresh-1')
    expect(next.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 1800_000))
  })

  test('a 429 waits what Retry-After asked, then succeeds', async () => {
    const { fake, provider, waits } = make()
    fake.acceptCode('c', GRANT)
    fake.queue({ status: 429, headers: { 'retry-after': '2' } })
    await provider.refresh('refresh-1', open())
    expect(waits).toEqual([2000])
    expect(fake.requests).toHaveLength(2)
  })

  test('5xx is retried with a jittered backoff, three tries at most, then unavailable', async () => {
    const { fake, provider, waits } = make()
    fake.queue({ status: 503 }, { status: 502 }, { status: 500 })
    await expect(provider.refresh('refresh-1', open())).rejects.toBeInstanceOf(CrmUnavailableError)
    expect(fake.requests).toHaveLength(3)
    // random 0.5: half of the ceiling plus a quarter of it.
    expect(waits).toEqual([150, 300])
  })

  test('a Retry-After longer than the bound ends the retries at once', async () => {
    const { fake, provider, waits } = make()
    fake.queue({ status: 429, headers: { 'retry-after': '120' } })
    const error = await provider.refresh('refresh-1', open()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CrmUnavailableError)
    expect((error as CrmUnavailableError).retryAfterMs).toBe(120_000)
    expect(waits).toEqual([])
    expect(fake.requests).toHaveLength(1)
  })

  test('HubSpot rate-limit interval header is honoured when Retry-After is absent', async () => {
    const { fake, provider, waits } = make()
    fake.acceptCode('c', GRANT)
    fake.queue({ status: 429, headers: { 'x-hubspot-ratelimit-interval-milliseconds': '1000' } })
    await provider.refresh('refresh-1', open())
    expect(waits).toEqual([1000])
  })

  test('a call that hangs is cut by its timeout and retried', async () => {
    const { fake, provider } = make()
    fake.acceptCode('c', GRANT)
    fake.queue('hang')
    const started = Date.now()
    await provider.refresh('refresh-1', open())
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
  }, 20_000)

  test('the caller aborting stops the call without a retry', async () => {
    const { fake, provider } = make()
    fake.queue('hang')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await expect(provider.refresh('refresh-1', controller.signal)).rejects.toBeDefined()
    expect(fake.requests).toHaveLength(1)
  })

  test('the authorisation address asks for read scopes, and write only on request', () => {
    const { provider } = make()
    const scope = (level?: 'read' | 'read_write') =>
      new URL(
        provider.authorisationUrl({
          redirectUri: 'https://core.test/cb',
          state: 's',
          ...(level ? { scopeLevel: level } : {}),
        })
      ).searchParams.get('scope')
    expect(scope()).toBe(
      'oauth crm.objects.deals.read crm.objects.contacts.read crm.objects.companies.read'
    )
    expect(scope('read_write')).toContain('crm.objects.deals.write')
  })
})

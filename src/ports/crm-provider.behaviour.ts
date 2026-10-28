import { describe, expect, test } from 'bun:test'
import { type CrmGrant, type CrmProvider, CrmRefusedError, CrmRevokedError } from './crm-provider'

/** A provider under test, with a way to make it accept one code. */
export type CrmProviderHarness = {
  provider: CrmProvider
  /** Arranges for `code` to exchange for `grant`. */
  acceptCode(code: string, grant: CrmGrant): void
}

const GRANT: CrmGrant = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: new Date('2026-01-01T01:00:00Z'),
  externalAccountId: '12345',
  accountLabel: 'Acme Sales',
  scopeLevel: 'read',
}

/** The behaviour every {@link CrmProvider} adapter must show. */
export function describeCrmProvider(label: string, make: () => CrmProviderHarness): void {
  describe(`CrmProvider: ${label}`, () => {
    test('builds an authorisation address that carries the state and redirect', () => {
      const { provider } = make()
      const url = new URL(
        provider.authorisationUrl({ redirectUri: 'https://core.test/cb', state: 'st-1' })
      )
      expect(url.searchParams.get('state')).toBe('st-1')
      expect(url.searchParams.get('redirect_uri')).toBe('https://core.test/cb')
    })

    test('asks for the write scopes only when told to', () => {
      const { provider } = make()
      const scopeOf = (scopeLevel?: 'read' | 'read_write') =>
        new URL(
          provider.authorisationUrl({
            redirectUri: 'https://core.test/cb',
            state: 's',
            ...(scopeLevel ? { scopeLevel } : {}),
          })
        ).searchParams.get('scope') ?? ''
      expect(scopeOf()).not.toContain('write')
      expect(scopeOf('read')).not.toContain('write')
      expect(scopeOf('read_write')).toContain('write')
    })

    test('exchanges an accepted code for a grant, once', async () => {
      const harness = make()
      harness.acceptCode('code-1', GRANT)
      const signal = new AbortController().signal
      expect(await harness.provider.exchangeCode('code-1', 'https://core.test/cb', signal)).toEqual(
        GRANT
      )
      await expect(
        harness.provider.exchangeCode('code-1', 'https://core.test/cb', signal)
      ).rejects.toBeInstanceOf(CrmRefusedError)
    })

    test('refuses a code it does not know', async () => {
      const { provider } = make()
      await expect(
        provider.exchangeCode('nope', 'https://core.test/cb', new AbortController().signal)
      ).rejects.toBeInstanceOf(CrmRefusedError)
    })

    test('refreshes a known refresh token and refuses an unknown one', async () => {
      const harness = make()
      harness.acceptCode('code-1', GRANT)
      const signal = new AbortController().signal
      const next = await harness.provider.refresh('refresh-1', signal)
      expect(next.accessToken.length).toBeGreaterThan(0)
      await expect(harness.provider.refresh('unknown', signal)).rejects.toBeInstanceOf(
        CrmRevokedError
      )
    })
  })
}

import { describe, expect, test } from 'bun:test'
import {
  type CrmDeal,
  type CrmGrant,
  type CrmProvider,
  CrmRefusedError,
  CrmRevokedError,
  type CrmStage,
} from './crm-provider'

/** A provider under test, with a way to make it accept one code. */
export type CrmProviderHarness = {
  provider: CrmProvider
  /** Arranges for `code` to exchange for `grant`. */
  acceptCode(code: string, grant: CrmGrant): void
  /** Arranges for the CRM to hold these stages and Deals. */
  plant(stages: CrmStage[], deals: CrmDeal[]): void
}

const STAGES: CrmStage[] = [
  { stageId: 'won', label: 'Closed won', pipelineId: 'p1', pipelineLabel: 'Sales' },
  { stageId: 'open', label: 'Proposal', pipelineId: 'p1', pipelineLabel: 'Sales' },
]

const dealAt = (id: string, minute: number): CrmDeal => ({
  id,
  name: `Deal ${id}`,
  stageId: 'won',
  amount: 500,
  currency: 'USD',
  closedAt: '2026-01-02',
  version: `2026-01-01T00:0${minute}:00.000Z`,
})

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

    test('lists the stages the CRM holds', async () => {
      const harness = make()
      harness.plant(STAGES, [])
      const stages = await harness.provider.listStages('access', new AbortController().signal)
      expect(stages.map((s) => s.stageId).sort()).toEqual(['open', 'won'])
      expect(stages.find((s) => s.stageId === 'won')?.label).toBe('Closed won')
    })

    test('pages Deals oldest first by the cursor and reports when there is no more', async () => {
      const harness = make()
      harness.plant(STAGES, [dealAt('1', 1), dealAt('2', 2), dealAt('3', 3)])
      const signal = new AbortController().signal
      const first = await harness.provider.listDeals('access', { cursor: null, limit: 2 }, signal)
      expect(first.deals.map((d) => d.id)).toEqual(['1', '2'])
      expect(first.hasMore).toBe(true)
      expect(first.cursor).not.toBeNull()
      // The cursor may re-read the last Deal of the page before (same-millisecond safety), so
      // follow it to the end and expect every Deal to have arrived.
      const seen = new Map(first.deals.map((d) => [d.id, d]))
      let cursor = first.cursor
      let last = first
      for (let i = 0; i < 5 && last.hasMore; i += 1) {
        last = await harness.provider.listDeals('access', { cursor, limit: 2 }, signal)
        for (const d of last.deals) {
          seen.set(d.id, d)
        }
        cursor = last.cursor
      }
      expect(last.hasMore).toBe(false)
      expect([...seen.keys()].sort()).toEqual(['1', '2', '3'])
      expect(seen.get('3')).toMatchObject({
        name: 'Deal 3',
        stageId: 'won',
        amount: 500,
        currency: 'USD',
        closedAt: '2026-01-02',
        version: dealAt('3', 3).version,
      })
    })

    test('counts Deals without paging', async () => {
      const harness = make()
      harness.plant(STAGES, [dealAt('1', 1), dealAt('2', 2)])
      expect(
        await harness.provider.countDeals('access', { cursor: null }, new AbortController().signal)
      ).toBe(2)
    })
  })
}

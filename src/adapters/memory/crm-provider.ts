import {
  type CrmDeal,
  type CrmGrant,
  type CrmProvider,
  CrmRefusedError,
  CrmRevokedError,
  type CrmStage,
  CrmUnavailableError,
} from '~/ports/crm-provider'

/** A CRM provider with a way to say which codes it accepts. */
export type MemoryCrmProvider = CrmProvider & {
  /** Makes `code` exchange for `grant`, once. */
  acceptCode(code: string, grant: CrmGrant): void
  /** How many times `exchangeCode` was called, so a test can show a refused caller never reached the CRM. */
  readonly exchangeCalls: number
  /** Replaces the stages the CRM serves. */
  plantStages(stages: CrmStage[]): void
  /** Replaces the Deals the CRM serves; `invalid` names records it cannot read, each with its change time. */
  plantDeals(deals: CrmDeal[], invalid?: { id: string; version: string }[]): void
  /** Makes the next `times` Deal reads end as the CRM throttling (`CrmUnavailableError`). */
  throttleNext(times: number, retryAfterMs?: number | null): void
  /** How many Deal pages were read, so a test can show a refused run never reached the CRM. */
  readonly dealReads: number
}

/**
 * A provider for local and tests: it knows only the codes a test registered and never leaves the
 * process. Each code works once, as a real authorisation code does.
 */
export function createMemoryCrmProvider(
  base = 'https://crm.memory.test/authorize'
): MemoryCrmProvider {
  const codes = new Map<string, CrmGrant>()
  const refreshTokens = new Map<string, CrmGrant>()
  let exchangeCalls = 0
  let stages: CrmStage[] = []
  let entries: { at: number; deal?: CrmDeal; invalidId?: string }[] = []
  let throttled = 0
  let throttleAsk: number | null = null
  let dealReads = 0
  const since = (cursor: string | null) =>
    entries
      .filter((entry) => entry.at >= (cursor === null ? 0 : Number(cursor)))
      .sort((a, b) => a.at - b.at)
  const checkThrottle = () => {
    if (throttled > 0) {
      throttled -= 1
      throw new CrmUnavailableError(throttleAsk)
    }
  }
  return {
    get dealReads() {
      return dealReads
    },

    plantStages(next) {
      stages = [...next]
    },

    plantDeals(deals, invalid = []) {
      entries = [
        ...deals.map((deal) => ({ at: Date.parse(deal.version), deal })),
        ...invalid.map((record) => ({ at: Date.parse(record.version), invalidId: record.id })),
      ]
    },

    throttleNext(times, retryAfterMs = null) {
      throttled = times
      throttleAsk = retryAfterMs
    },

    async listStages() {
      return stages.map((stage) => ({ ...stage }))
    },

    async listDeals(_token, { cursor, limit }) {
      dealReads += 1
      checkThrottle()
      const page = since(cursor).slice(0, limit)
      const high = page.reduce(
        (max, entry) => Math.max(max, entry.at),
        cursor === null ? 0 : Number(cursor)
      )
      const next = high > 0 ? String(high) : cursor
      return {
        deals: page.flatMap((entry) => (entry.deal ? [{ ...entry.deal }] : [])),
        invalid: page.flatMap((entry) => (entry.invalidId ? [entry.invalidId] : [])),
        cursor: next,
        hasMore: page.length >= limit && next !== cursor,
      }
    },

    async countDeals(_token, { cursor }) {
      checkThrottle()
      return since(cursor).length
    },

    get exchangeCalls() {
      return exchangeCalls
    },

    acceptCode(code, grant) {
      codes.set(code, grant)
      if (grant.refreshToken !== null) {
        refreshTokens.set(grant.refreshToken, grant)
      }
    },

    authorisationUrl({ redirectUri, state, scopeLevel }) {
      const url = new URL(base)
      url.searchParams.set('scope', scopeLevel === 'read_write' ? 'read write' : 'read')
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      return url.toString()
    },

    async exchangeCode(code) {
      exchangeCalls += 1
      const grant = codes.get(code)
      if (!grant) {
        throw new CrmRefusedError()
      }
      codes.delete(code)
      return { ...grant }
    },

    async refresh(refreshToken) {
      const grant = refreshTokens.get(refreshToken)
      if (!grant) {
        throw new CrmRevokedError()
      }
      return {
        accessToken: `${grant.accessToken}-refreshed`,
        refreshToken: grant.refreshToken,
        accessTokenExpiresAt: grant.accessTokenExpiresAt,
      }
    },
  }
}

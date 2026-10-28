import {
  type CrmGrant,
  type CrmProvider,
  CrmRefusedError,
  CrmRevokedError,
} from '~/ports/crm-provider'

/** A CRM provider with a way to say which codes it accepts. */
export type MemoryCrmProvider = CrmProvider & {
  /** Makes `code` exchange for `grant`, once. */
  acceptCode(code: string, grant: CrmGrant): void
  /** How many times `exchangeCode` was called, so a test can show a refused caller never reached the CRM. */
  readonly exchangeCalls: number
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
  return {
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

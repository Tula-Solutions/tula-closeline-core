import type { CrmGrant, CrmProvider } from '~/ports/crm-provider'

/** Thrown by the memory provider when the CRM would refuse: an unknown code or refresh token. */
export class CrmRefusedError extends Error {
  constructor() {
    super('the CRM refused the request')
    this.name = 'CrmRefusedError'
  }
}

/** A CRM provider with a way to say which codes it accepts. */
export type MemoryCrmProvider = CrmProvider & {
  /** Makes `code` exchange for `grant`, once. */
  acceptCode(code: string, grant: CrmGrant): void
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
  return {
    acceptCode(code, grant) {
      codes.set(code, grant)
      if (grant.refreshToken !== null) {
        refreshTokens.set(grant.refreshToken, grant)
      }
    },

    authorisationUrl({ redirectUri, state }) {
      const url = new URL(base)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      return url.toString()
    },

    async exchangeCode(code) {
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
        throw new CrmRefusedError()
      }
      return {
        accessToken: `${grant.accessToken}-refreshed`,
        refreshToken: grant.refreshToken,
        accessTokenExpiresAt: grant.accessTokenExpiresAt,
      }
    },
  }
}

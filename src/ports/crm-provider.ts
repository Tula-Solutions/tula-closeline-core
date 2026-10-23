import type { CrmProvider as CrmProviderName } from 'tula-closeline-contract'

export type { CrmProviderName }

/** What a CRM granted when the user approved the connection. Tokens live only as long as the call that holds it. */
export type CrmGrant = {
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: Date | null
  /** The CRM's own id for the account (the HubSpot portal id). */
  externalAccountId: string
  accountLabel: string | null
  scopeLevel: 'read' | 'read_write'
}

/** Where to send the user to approve a connection, and the parameters the callback must return. */
export type CrmAuthorisationRequest = {
  redirectUri: string
  /** The opaque anti-forgery state the callback must echo. */
  state: string
}

/**
 * One CRM's authorisation protocol. Nothing else about a CRM (reading or writing records) is part
 * of this port yet; the HubSpot adapter arrives with the sync work.
 */
export interface CrmProvider {
  /** The URL the user visits to approve the connection. */
  authorisationUrl(request: CrmAuthorisationRequest): string
  /** Exchanges the code from the callback for a grant; rejects when the CRM refuses it. */
  exchangeCode(code: string, redirectUri: string, signal: AbortSignal): Promise<CrmGrant>
  /** Exchanges a refresh token for a new access token; rejects when the CRM refuses it. */
  refresh(
    refreshToken: string,
    signal: AbortSignal
  ): Promise<Pick<CrmGrant, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'>>
}

/** The providers a deployment has configured, by name. A provider that is absent cannot be connected. */
export type CrmProviders = Readonly<Partial<Record<CrmProviderName, CrmProvider>>>

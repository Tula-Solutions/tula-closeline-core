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
  /** `read_write` asks for the write scopes too; the default is the minimum read set. */
  scopeLevel?: CrmGrant['scopeLevel']
}

/** The CRM refused a request outright: a wrong or used code, or bad client credentials. */
export class CrmRefusedError extends Error {
  constructor() {
    super('the CRM refused the request')
    this.name = 'CrmRefusedError'
  }
}

/** The CRM says the grant is gone (revoked, expired or uninstalled): only a new authorisation helps. */
export class CrmRevokedError extends Error {
  constructor() {
    super('the CRM grant was revoked')
    this.name = 'CrmRevokedError'
  }
}

/** The CRM is throttling or down and the bounded retries ran out; a later attempt may work. */
export class CrmUnavailableError extends Error {
  /** How long the CRM asked us to wait, in ms, or `null` when it did not say. */
  readonly retryAfterMs: number | null
  constructor(retryAfterMs: number | null = null) {
    super('the CRM is unavailable or rate limiting')
    this.name = 'CrmUnavailableError'
    this.retryAfterMs = retryAfterMs
  }
}

/** A deal stage of the CRM, as the CRM names it. The text is untrusted. */
export type CrmStage = {
  stageId: string
  label: string
  pipelineId: string | null
  pipelineLabel: string | null
}

/** A Deal as the CRM holds it, cut down to what the Playbook needs. The text is untrusted. */
export type CrmDeal = {
  /** The CRM's own id. */
  id: string
  name: string | null
  stageId: string | null
  amount: number | null
  currency: string | null
  /** The close date, `YYYY-MM-DD`, or `null` while the Deal is open. */
  closedAt: string | null
  /** The CRM's last-modified marker: changes whenever the Deal does. */
  version: string
}

/** One page of Deals after a cursor, oldest change first. */
export type CrmDealPage = {
  deals: CrmDeal[]
  /** The CRM ids of records that could not be read at all (a poison record). */
  invalid: string[]
  /** The high-water mark after this page; pass it back to read on. Equals the input when the page was empty. */
  cursor: string | null
  /** True when another page may follow. */
  hasMore: boolean
}

/** One CRM's authorisation protocol and the reads a Deal pull needs. */
export interface CrmProvider {
  /** The URL the user visits to approve the connection. */
  authorisationUrl(request: CrmAuthorisationRequest): string
  /** Exchanges the code from the callback for a grant; rejects when the CRM refuses it. */
  exchangeCode(code: string, redirectUri: string, signal: AbortSignal): Promise<CrmGrant>
  /** Exchanges a refresh token for a new access token; rejects with {@link CrmRevokedError} when the grant is gone, {@link CrmUnavailableError} after bounded retries. */
  refresh(
    refreshToken: string,
    signal: AbortSignal
  ): Promise<Pick<CrmGrant, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt'>>
  /** Every deal stage of the CRM (at most 500); rejects with {@link CrmUnavailableError} after bounded retries. */
  listStages(accessToken: string, signal: AbortSignal): Promise<CrmStage[]>
  /** Up to `limit` Deals changed at or after `cursor` (`null` reads from the start), oldest change first. */
  listDeals(
    accessToken: string,
    request: { cursor: string | null; limit: number },
    signal: AbortSignal
  ): Promise<CrmDealPage>
  /** How many Deals changed at or after `cursor`: a count only, nothing else is read. */
  countDeals(
    accessToken: string,
    request: { cursor: string | null },
    signal: AbortSignal
  ): Promise<number>
}

/** The providers a deployment has configured, by name. A provider that is absent cannot be connected. */
export type CrmProviders = Readonly<Partial<Record<CrmProviderName, CrmProvider>>>

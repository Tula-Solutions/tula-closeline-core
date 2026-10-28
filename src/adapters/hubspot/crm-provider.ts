import { z } from 'zod'
import { type BackoffSteps, backoffDelayMs, rest, type Sleep } from '~/backoff'
import {
  type CrmGrant,
  type CrmProvider,
  CrmRefusedError,
  CrmRevokedError,
  CrmUnavailableError,
} from '~/ports/crm-provider'

/** The minimum read set of the first connection (ADR 0022: write scopes only when write-back is on). */
export const HUBSPOT_READ_SCOPES = [
  'oauth',
  'crm.objects.deals.read',
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
] as const

/** The extra scopes a connection with write-back asks for. */
export const HUBSPOT_WRITE_SCOPES = [
  'crm.objects.deals.write',
  'crm.objects.contacts.write',
  'crm.objects.companies.write',
] as const

/** What the adapter needs: the OAuth app, and doubles for tests. */
export type HubspotOptions = {
  clientId: string
  clientSecret: string
  /** The API origin; the public HubSpot one unless a test or the local stack points elsewhere. */
  apiBaseUrl?: string
  /** The sign-in page origin and path. */
  authoriseUrl?: string
  fetch?: typeof fetch
  sleep?: Sleep
  random?: () => number
  now?: () => Date
}

/** One try may take this long: the callback and a refresh both have a person or a job waiting. */
const ATTEMPT_TIMEOUT_MS = 10_000

/** Tries per call, the first included. */
const MAX_ATTEMPTS = 3

/** The most a `Retry-After` is honoured for in one wait, in ms; a longer ask ends the retries. */
const MAX_WAIT_MS = 5_000

const RETRY_STEPS: BackoffSteps = { baseMs: 200, capMs: 2_000 }

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
})

const accessTokenInfoSchema = z.object({
  hub_id: z.union([z.number(), z.string()]),
  hub_domain: z.string().nullish(),
  scopes: z.array(z.string()).default([]),
})

/** The wait the CRM asked for, in ms: `Retry-After` in seconds, else HubSpot's rate-limit interval. */
function askedWaitMs(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000)
  }
  const interval = Number(response.headers.get('x-hubspot-ratelimit-interval-milliseconds'))
  return Number.isFinite(interval) && interval > 0 ? interval : null
}

/**
 * HubSpot as a {@link CrmProvider}. Every call has a timeout. A 429 or 5xx, a timeout or a network
 * error is retried up to three tries with a jittered backoff (a 429 waits what HubSpot asked for,
 * at most 5 s), then ends as {@link CrmUnavailableError}. A 4xx from the token endpoint is final.
 */
export function createHubspotCrmProvider(options: HubspotOptions): CrmProvider {
  const api = (options.apiBaseUrl ?? 'https://api.hubapi.com').replace(/\/$/, '')
  const authorise = options.authoriseUrl ?? 'https://app.hubspot.com/oauth/authorize'
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? rest
  const random = options.random ?? Math.random
  const now = options.now ?? (() => new Date())

  /** Calls `url` until it answers something final; returns that response (any status below 429 or a 4xx). */
  async function call(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    maxAttempts = MAX_ATTEMPTS
  ): Promise<Response> {
    let asked: number | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await doFetch(url, {
          ...init,
          signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]),
        })
        if (response.status !== 429 && response.status < 500) {
          return response
        }
        await response.body?.cancel()
        asked = response.status === 429 ? askedWaitMs(response) : null
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        asked = null
      }
      if (attempt === maxAttempts || (asked !== null && asked > MAX_WAIT_MS)) {
        break
      }
      await sleep(asked ?? backoffDelayMs(attempt, RETRY_STEPS, random), signal)
    }
    throw new CrmUnavailableError(asked)
  }

  async function token(
    form: Record<string, string>,
    signal: AbortSignal,
    refused: (status: number) => Error | null,
    maxAttempts: number
  ): Promise<z.infer<typeof tokenSchema>> {
    const response = await call(
      `${api}/oauth/v1/token`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          ...form,
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }),
      },
      signal,
      maxAttempts
    )
    if (!response.ok) {
      await response.body?.cancel()
      // Not every refusal is the grant's fault: a bad client secret must not look like a revocation.
      throw refused(response.status) ?? new CrmUnavailableError()
    }
    const parsed = tokenSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new CrmUnavailableError()
    }
    return parsed.data
  }

  const expiry = (seconds: number | undefined): Date | null =>
    seconds === undefined ? null : new Date(now().getTime() + seconds * 1000)

  return {
    authorisationUrl({ redirectUri, state, scopeLevel }) {
      const url = new URL(authorise)
      const scopes =
        scopeLevel === 'read_write'
          ? [...HUBSPOT_READ_SCOPES, ...HUBSPOT_WRITE_SCOPES]
          : HUBSPOT_READ_SCOPES
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', scopes.join(' '))
      url.searchParams.set('state', state)
      return url.toString()
    },

    async exchangeCode(code, redirectUri, signal): Promise<CrmGrant> {
      const granted = await token(
        { grant_type: 'authorization_code', redirect_uri: redirectUri, code },
        signal,
        () => new CrmRefusedError(),
        // The code is single use: a retry after HubSpot consumed it would only be refused.
        1
      )
      // The token endpoint does not name the account; the access-token info does.
      // The URL carries the access token: never log it.
      const infoResponse = await call(
        `${api}/oauth/v1/access-tokens/${encodeURIComponent(granted.access_token)}`,
        { method: 'GET', headers: { accept: 'application/json' } },
        signal
      )
      const info = infoResponse.ok
        ? accessTokenInfoSchema.safeParse(await infoResponse.json().catch(() => null))
        : null
      if (!info?.success) {
        // A parsed body is already consumed; only an error status leaves one to release.
        if (!infoResponse.ok) {
          await infoResponse.body?.cancel()
        }
        throw new CrmRefusedError()
      }
      return {
        accessToken: granted.access_token,
        refreshToken: granted.refresh_token ?? null,
        accessTokenExpiresAt: expiry(granted.expires_in),
        externalAccountId: String(info.data.hub_id),
        accountLabel: info.data.hub_domain ?? null,
        scopeLevel: info.data.scopes.some((scope) => scope.endsWith('.write'))
          ? 'read_write'
          : 'read',
      }
    },

    async refresh(refreshToken, signal) {
      const granted = await token(
        { grant_type: 'refresh_token', refresh_token: refreshToken },
        signal,
        // HubSpot answers a dead refresh token with 400; 401 or 403 is our client credentials.
        (status) => (status === 400 ? new CrmRevokedError() : null),
        MAX_ATTEMPTS
      )
      return {
        accessToken: granted.access_token,
        refreshToken: granted.refresh_token ?? refreshToken,
        accessTokenExpiresAt: expiry(granted.expires_in),
      }
    },
  }
}

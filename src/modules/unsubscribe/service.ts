import {
  CONSENT_ERRORS,
  ERRORS,
  type UnsubscribePreview,
  type UnsubscribeReceipt,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { hashClientAddress } from '~/http/client-address'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { publishEvents } from '~/modules/prospect/events'
import { normaliseAddress } from '~/modules/suppression/address'
import { withdrawWithin } from '~/modules/withdrawal/service'
import type { OrganizationScope } from '~/ports/core-store'
import { readUnsubscribeToken, UNSUBSCRIBE_CHANNEL, type UnsubscribeClaims } from './token'

/** The most requests one client address may make to the public unsubscribe routes in one window. */
export const UNSUBSCRIBE_RATE_LIMIT = 60

/** The length of the rate-limit window, in seconds (one hour). */
export const UNSUBSCRIBE_RATE_WINDOW_SECONDS = 3_600

/** What the public unsubscribe service needs from the container. */
export type UnsubscribeDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'env' | 'demoRateLimiter'
>

/** What a public call is given: the token from the path, and the client address the rate limit counts. */
export type UnsubscribeCallOptions = {
  token: string
  address: { canonical: string }
}

/** The one answer for every link that does not work: tampered, malformed, expired, or of an Organization or Prospect that is gone. */
function invalidToken() {
  return domainError(CONSENT_ERRORS['consent.invalid_token'])
}

/** Counts one request from the client; refuses with `rate.limited` and the wait once the limit is spent. */
async function limitRate(deps: UnsubscribeDeps, canonicalAddress: string): Promise<void> {
  // A key of its own, so the unsubscribe routes share no budget with the forms.
  const hash = hashClientAddress(canonicalAddress, `${deps.env.DEMO_RATE_KEY}:unsubscribe`)
  const allowed = await deps.demoRateLimiter.hit(hash, {
    windowSeconds: UNSUBSCRIBE_RATE_WINDOW_SECONDS,
    limit: UNSUBSCRIBE_RATE_LIMIT,
  })
  if (!allowed) {
    throw new RetryAfterError(ERRORS['rate.limited'], UNSUBSCRIBE_RATE_WINDOW_SECONDS, {
      retryAfter: UNSUBSCRIBE_RATE_WINDOW_SECONDS,
    })
  }
}

/** The claims of a token whose signature holds and which has not expired; anything else is `consent.invalid_token`. */
function claimsOf(deps: UnsubscribeDeps, token: string): UnsubscribeClaims {
  const claims = readUnsubscribeToken(deps.env.UNSUBSCRIBE_TOKEN_KEY, token)
  if (claims === undefined || claims.expiresAt.getTime() <= deps.clock.now().getTime()) {
    throw invalidToken()
  }
  return claims
}

/**
 * What a valid link points at, read in the claims' Organization: its name, and the Prospect's
 * current normalised email. An Organization that is gone, a Prospect that is gone (erased) and a
 * Prospect with no email are all `consent.invalid_token`.
 */
async function target(
  scope: OrganizationScope,
  claims: UnsubscribeClaims
): Promise<{ organizationName: string; email: string }> {
  const organization = await scope.getOrganization()
  if (!organization || organization.status === 'deleted') {
    throw invalidToken()
  }
  const prospect = await scope.getProspect(claims.prospectId, { kind: 'all' })
  const stored = prospect ? await scope.getProspectIdentity(claims.prospectId, 'email') : null
  const email = stored === null ? undefined : normaliseAddress('email', stored)
  if (email === undefined) {
    throw invalidToken()
  }
  return { organizationName: organization.name, email }
}

/**
 * What the confirmation page shows for a link: the Organization's name and the channel, nothing
 * about the Prospect. Writes nothing, so a mail scanner that opens the link unsubscribes no one.
 */
export async function preview(
  deps: UnsubscribeDeps,
  options: UnsubscribeCallOptions
): Promise<UnsubscribePreview> {
  await limitRate(deps, options.address.canonical)
  const claims = claimsOf(deps, options.token)
  const { organizationName } = await deps.store.withOrganization(claims.organizationId, (scope) =>
    target(scope, claims)
  )
  return { organizationName, channel: UNSUBSCRIBE_CHANNEL }
}

/**
 * Unsubscribes the Prospect's email by a link: adds an `unsubscribe` Suppression entry for the
 * address, and withdraws the Prospect's email consent, in one transaction. A repeat answers the
 * same receipt (the entry's time) and writes and publishes nothing. A suspended Organization still
 * honours it. Events are published after the commit.
 */
export async function unsubscribe(
  deps: UnsubscribeDeps,
  options: UnsubscribeCallOptions & { traceId: string }
): Promise<UnsubscribeReceipt> {
  await limitRate(deps, options.address.canonical)
  const claims = claimsOf(deps, options.token)
  const result = await deps.store.withOrganization(claims.organizationId, async (scope) => {
    await scope.lockOrganization()
    const { email } = await target(scope, claims)
    return withdrawWithin(deps, scope, claims.organizationId, {
      address: { kind: 'email', value: email },
      prospectId: claims.prospectId,
      channel: UNSUBSCRIBE_CHANNEL,
      stopAll: false,
      source: 'unsubscribe',
      reason: 'unsubscribe',
      sourceRef: null,
    })
  })
  await publishEvents(deps, claims.organizationId, options.traceId, result.events)
  return { unsubscribed: true, recordedAt: result.entry.createdAt.toISOString() }
}

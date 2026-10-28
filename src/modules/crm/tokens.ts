import { CRM_ERRORS, type CrmProvider, type OrganizationId } from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { CrmRevokedError, CrmUnavailableError } from '~/ports/crm-provider'
import type { SecretContext } from '~/ports/secret-box'

/** What reading a CRM access token needs from the container. */
export type CrmTokenDeps = Pick<Container, 'store' | 'clock' | 'secretBox' | 'crmProviders'>

/** A token that expires within this long is refreshed first, so a call that uses it does not race its expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** The longest a whole refresh may take, retries included. */
const REFRESH_TIMEOUT_MS = 30_000

const sameBytes = (a: Uint8Array | null, b: Uint8Array | null): boolean =>
  a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b))

/**
 * A usable access token for an Organization's CRM connection, refreshed first when it is within
 * five minutes of expiry. The sync reads this and nothing else. No connection is `crm.not_connected`;
 * a connection already marked, or whose grant the CRM says is gone, is `crm.needs_reconnect` (the
 * connection is marked and keeps its tokens until the Admin reconnects); a CRM that is limiting or
 * down after the adapter's bounded retries is `crm.rate_limited`. A reconnect that lands while a
 * refresh is in flight wins: the stale result is dropped. Two refreshes at once are harmless, since
 * HubSpot does not rotate the refresh token.
 */
export async function accessToken(
  deps: CrmTokenDeps,
  organizationId: OrganizationId,
  provider: CrmProvider
): Promise<string> {
  const held = await deps.store.withOrganization(organizationId, async (scope) => ({
    connection: await scope.getCrmConnection(provider),
    tokens: await scope.getCrmSealedTokens(provider),
  }))
  const { connection, tokens } = held
  if (!connection || !tokens) {
    throw domainError(CRM_ERRORS['crm.not_connected'])
  }
  if (connection.state === 'needs_reconnect') {
    throw domainError(CRM_ERRORS['crm.needs_reconnect'])
  }
  const context = (purpose: SecretContext['purpose']): SecretContext => ({
    organizationId,
    connectionId: connection.id,
    purpose,
  })
  const keyId = tokens.tokenKeyId ?? ''
  const now = deps.clock.now()
  const fresh =
    tokens.accessTokenExpiresAt === null ||
    tokens.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS
  if (tokens.accessTokenSealed && fresh) {
    return deps.secretBox.open(
      { keyId, ciphertext: tokens.accessTokenSealed },
      context('access_token')
    )
  }
  const crm = deps.crmProviders[provider]
  /** Marks the connection, but only the grant that was read: a reconnect meanwhile is left alone. */
  const markNeedsReconnect = async (): Promise<never> => {
    await deps.store.withOrganization(organizationId, async (scope) => {
      if (!(await scope.lockOrganization())) {
        return
      }
      const current = await scope.getCrmSealedTokens(provider)
      if (current && sameBytes(current.refreshTokenSealed, tokens.refreshTokenSealed)) {
        await scope.markCrmNeedsReconnect(provider, now)
      }
    })
    throw domainError(CRM_ERRORS['crm.needs_reconnect'])
  }
  if (!tokens.refreshTokenSealed) {
    return markNeedsReconnect()
  }
  if (!crm) {
    throw domainError(CRM_ERRORS['crm.rate_limited'])
  }
  const refreshToken = await deps.secretBox.open(
    { keyId, ciphertext: tokens.refreshTokenSealed },
    context('refresh_token')
  )
  const grant = await crm
    .refresh(refreshToken, AbortSignal.timeout(REFRESH_TIMEOUT_MS))
    .catch((error: unknown) => {
      if (error instanceof CrmRevokedError) {
        return markNeedsReconnect()
      }
      if (error instanceof CrmUnavailableError) {
        throw domainError(CRM_ERRORS['crm.rate_limited'])
      }
      throw error
    })
  // Sealed before the lock: a KMS call must not hold the Organization lock.
  const sealedAccess = await deps.secretBox.seal(grant.accessToken, context('access_token'))
  // The refresh token is sealed again even when HubSpot returns none (the kept one), so both
  // tokens always sit under the key id the row is stamped with.
  const sealedRefresh = await deps.secretBox.seal(
    grant.refreshToken ?? refreshToken,
    context('refresh_token')
  )
  if (sealedRefresh.keyId !== sealedAccess.keyId) {
    throw new Error('the SecretBox sealed the two tokens under different keys')
  }
  await deps.store.withOrganization(organizationId, async (scope) => {
    if (!(await scope.lockOrganization())) {
      return
    }
    const current = await scope.getCrmSealedTokens(provider)
    if (!current || !sameBytes(current.refreshTokenSealed, tokens.refreshTokenSealed)) {
      return
    }
    await scope.replaceCrmTokens(provider, {
      accessTokenSealed: sealedAccess.ciphertext,
      refreshTokenSealed: sealedRefresh.ciphertext,
      tokenKeyId: sealedAccess.keyId,
      accessTokenExpiresAt: grant.accessTokenExpiresAt,
      now,
    })
  })
  return grant.accessToken
}

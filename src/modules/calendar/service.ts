import {
  BOOKING_ERRORS,
  type CalendarConnection,
  ERRORS,
  formatId,
  type MembershipId,
  type startCalendarConnectionResponseSchema,
} from 'tula-closeline-contract'
import {
  CalendarError,
  GOOGLE_CALENDAR_SCOPES,
  CalendarConnection as VendorConnection,
} from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { SecretContext } from '~/ports/secret-box'
import { packSealed, toCalendarConnectionResponse, unpackSealed } from './schema'

/** What the calendar service needs from the container. */
export type CalendarDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'secretBox' | 'calendar'>

/** The answer of the start route. */
type StartAnswer = z.infer<typeof startCalendarConnectionResponseSchema>

/** The table's limit on a sealed credential, key id header included. */
const MAX_CALENDAR_SEALED_BYTES = 8192

/** How often a healthy connection is checked against the vendor at most, per connection. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/** How long the consent a Rep is sent to may take before its `state` stops being accepted. */
const STATE_TTL_MS = 10 * 60 * 1000

/** The time a call to the vendor may take: the Rep waits on it. */
const VENDOR_TIMEOUT_MS = 5_000

/** What the opaque `state` carries; it is sealed, so the Rep cannot read or forge it. */
const statePayloadSchema = z.strictObject({ expiresAt: z.number(), nonce: z.string() })

/** What is sealed per connection: what the vendor adapter needs to rebuild it. */
const credentialSchema = z.strictObject({
  provider: z.string(),
  connectionId: z.string(),
  credential: z.string(),
  /** The nonce of the `state` that made this connection, so a retry of the same `state` is recognised. */
  stateNonce: z.string().optional(),
})

/** The state nonce a stored credential was made with; `undefined` when it has none or is unreadable. */
function nonceOf(plain: string): string | undefined {
  try {
    return credentialSchema.parse(JSON.parse(plain)).stateNonce
  } catch {
    return undefined
  }
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

/** The calendar setup, or 503: nothing is configured, so nothing can be connected. */
function setupOf(deps: Pick<CalendarDeps, 'calendar'>) {
  if (!deps.calendar) {
    throw domainError(ERRORS['server.unavailable'])
  }
  return deps.calendar
}

/** The caller's own Membership id, checking the role may take `action` in this Organization. */
async function ownMembership(
  deps: Pick<CalendarDeps, 'store'>,
  caller: Caller,
  action: 'calendar.read' | 'calendar.connect' | 'calendar.disconnect'
): Promise<MembershipId> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, action)
    const own = await scope.getMembershipByUser(caller.userId)
    if (!own) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    return own.id
  })
}

const stateContext = (caller: Caller, membershipId: MembershipId): SecretContext => ({
  organizationId: caller.organizationId,
  connectionId: membershipId,
  purpose: 'calendar_state',
})

/**
 * Starts connecting the caller's calendar: answers the vendor's consent URL and a `state` that is
 * sealed to this Rep and this Organization and expires in ten minutes. Nothing is stored; the
 * vendor's single-use code is what stops a replay. Every role connects its own calendar.
 */
export async function start(deps: CalendarDeps, caller: Caller): Promise<StartAnswer> {
  const setup = setupOf(deps)
  if (!deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const membershipId = await ownMembership(deps, caller, 'calendar.connect')
  const payload = {
    expiresAt: deps.clock.now().getTime() + STATE_TTL_MS,
    nonce: crypto.randomUUID(),
  }
  const sealed = await deps.secretBox.seal(
    JSON.stringify(payload),
    stateContext(caller, membershipId)
  )
  const state = base64url(packSealed(sealed))
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({
    client_id: setup.clientId,
    redirect_uri: setup.redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()
  return { authorizationUrl: url.toString(), state }
}

/**
 * Completes the connection with the code the vendor's redirect returned: checks the `state` is the
 * caller's own and fresh, exchanges the code, seals the vendor credential (bound to the
 * Organization and the connection) and stores only the sealed bytes. A bad `state` or a refused
 * code is `calendar.authorization_failed`; the code is never stored or logged. Connecting again
 * replaces the Rep's connection.
 */
export async function complete(
  deps: CalendarDeps,
  caller: Caller,
  request: { state: string; code: string }
): Promise<CalendarConnection> {
  const failed = () => domainError(BOOKING_ERRORS['calendar.authorization_failed'])
  const setup = setupOf(deps)
  if (!deps.secretBox.configured) {
    throw domainError(ERRORS['server.unavailable'])
  }
  const membershipId = await ownMembership(deps, caller, 'calendar.connect')

  const unsealed = unpackSealed(new Uint8Array(Buffer.from(request.state, 'base64url')))
  let payload: z.infer<typeof statePayloadSchema>
  try {
    if (!unsealed) {
      throw new Error('malformed state')
    }
    payload = statePayloadSchema.parse(
      JSON.parse(await deps.secretBox.open(unsealed, stateContext(caller, membershipId)))
    )
  } catch {
    throw failed()
  }
  if (payload.expiresAt < deps.clock.now().getTime()) {
    throw failed()
  }

  const existing = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const record = await scope.getCalendarConnection(membershipId)
    return record ? { record, sealed: await scope.getCalendarSealedCredential(membershipId) } : null
  })
  if (existing?.sealed) {
    const sealedBefore = unpackSealed(existing.sealed)
    const plain = sealedBefore
      ? await deps.secretBox
          .open(sealedBefore, {
            organizationId: caller.organizationId,
            connectionId: existing.record.id,
            purpose: 'calendar_credential',
          })
          .catch(() => null)
      : null
    if (plain !== null && nonceOf(plain) === payload.nonce) {
      return toCalendarConnectionResponse(existing.record)
    }
  }

  let vendor: VendorConnection
  try {
    vendor = await setup.port.connect(
      {
        organizationId: caller.organizationId,
        grant: { kind: 'authorization_code', code: request.code, redirectUri: setup.redirectUri },
      },
      { timeoutMs: VENDOR_TIMEOUT_MS }
    )
  } catch (error) {
    if (
      error instanceof CalendarError &&
      error.code !== 'calendar.unavailable' &&
      error.code !== 'calendar.timeout'
    ) {
      throw failed()
    }
    throw domainError(BOOKING_ERRORS['booking.calendar_unavailable'])
  }

  // Sealed before the Organization is locked: sealing may call KMS.
  const id = formatId('cal', crypto.randomUUID())
  const sealed = await deps.secretBox.seal(
    JSON.stringify({
      provider: vendor.provider,
      connectionId: vendor.connectionId,
      credential: vendor.unsafeCredential(),
      stateNonce: payload.nonce,
    }),
    { organizationId: caller.organizationId, connectionId: id, purpose: 'calendar_credential' }
  )
  const credentialSealed = packSealed(sealed)
  if (credentialSealed.byteLength > MAX_CALENDAR_SEALED_BYTES) {
    throw domainError(ERRORS['server.unavailable'])
  }

  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'calendar.connect')
    const record = await scope.upsertCalendarConnection({
      id,
      membershipId: access.membershipId,
      provider: 'google',
      credentialSealed,
      now,
    })
    await Audit.recordIn(scope, caller.organizationId, {
      occurredAt: now,
      actor: { kind: 'member', membershipId: access.membershipId },
      action: 'calendar.connected',
      subject: { type: 'calendar_connection', id: record.id },
      metadata: { provider: record.provider },
    })
    return toCalendarConnectionResponse(record)
  })
}

/** Opens a stored credential into the vendor connection the adapter takes. */
async function openVendorConnection(
  deps: Pick<CalendarDeps, 'secretBox'>,
  caller: Caller,
  id: string,
  sealedBytes: Uint8Array
): Promise<VendorConnection | null> {
  const sealed = unpackSealed(sealedBytes)
  if (!sealed) {
    return null
  }
  const plain = await deps.secretBox.open(sealed, {
    organizationId: caller.organizationId,
    connectionId: id,
    purpose: 'calendar_credential',
  })
  return new VendorConnection({
    organizationId: caller.organizationId,
    ...credentialSchema.parse(JSON.parse(plain)),
  })
}

/**
 * Reads the caller's own connection, never another Rep's. A healthy one is checked against the
 * vendor at most every 15 minutes (the time is stored as `lastCheckedAt`); a revoked grant flips it to `needs_reconnect`, and any
 * other vendor failure leaves the stored state alone. No connection is `calendar.not_connected`.
 */
export async function status(deps: CalendarDeps, caller: Caller): Promise<CalendarConnection> {
  const membershipId = await ownMembership(deps, caller, 'calendar.read')
  const found = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const record = await scope.getCalendarConnection(membershipId)
    return record ? { record, sealed: await scope.getCalendarSealedCredential(membershipId) } : null
  })
  if (!found) {
    throw domainError(BOOKING_ERRORS['calendar.not_connected'])
  }
  const record = found.record
  const now = deps.clock.now()
  const lastChecked = found.record.lastCheckedAt ?? found.record.connectedAt
  if (
    found.record.state !== 'healthy' ||
    !found.sealed ||
    !deps.calendar ||
    now.getTime() - lastChecked.getTime() < CHECK_INTERVAL_MS
  ) {
    return toCalendarConnectionResponse(found.record)
  }
  let vendor: VendorConnection | null
  try {
    vendor = await openVendorConnection(deps, caller, found.record.id, found.sealed)
  } catch {
    // A credential that cannot be opened (key change, corrupt row) must not fail the read.
    deps.logger.warn('calendar credential could not be opened', {
      organizationId: caller.organizationId,
    })
    return toCalendarConnectionResponse(found.record)
  }
  if (!vendor) {
    return toCalendarConnectionResponse(found.record)
  }
  try {
    await deps.calendar.port.busy(
      {
        organizationId: caller.organizationId,
        connection: vendor,
        from: now.toISOString(),
        to: new Date(now.getTime() + 60_000).toISOString(),
      },
      { timeoutMs: VENDOR_TIMEOUT_MS }
    )
    return deps.store.withOrganization(caller.organizationId, async (scope) => {
      await openOrganizationForWrite(scope, caller, 'calendar.connect')
      const checked = await scope.setCalendarConnectionState(membershipId, 'healthy', now)
      return toCalendarConnectionResponse(checked ?? record)
    })
  } catch (error) {
    if (error instanceof CalendarError && error.code === 'calendar.revoked') {
      return deps.store.withOrganization(caller.organizationId, async (scope) => {
        await openOrganizationForWrite(scope, caller, 'calendar.connect')
        const flipped = await scope.setCalendarConnectionState(membershipId, 'needs_reconnect', now)
        if (!flipped) {
          throw domainError(BOOKING_ERRORS['calendar.not_connected'])
        }
        return toCalendarConnectionResponse(flipped)
      })
    }
    // Any other failure keeps the state but counts as a check, so a failing vendor is not asked on every read.
    return deps.store.withOrganization(caller.organizationId, async (scope) => {
      await openOrganizationForWrite(scope, caller, 'calendar.connect')
      const attempted = await scope.setCalendarConnectionState(membershipId, 'healthy', now)
      return toCalendarConnectionResponse(attempted ?? record)
    })
  }
}

/**
 * Disconnects the caller's own calendar: the row and its sealed credential are deleted, then the
 * grant is revoked at the vendor on a best-effort basis. Idempotent by end state: with no
 * connection it does nothing and the route still answers 204.
 */
export async function disconnect(deps: CalendarDeps, caller: Caller): Promise<void> {
  const membershipId = await ownMembership(deps, caller, 'calendar.disconnect')
  const sealedBefore = await deps.store.withOrganization(caller.organizationId, (scope) =>
    scope.getCalendarSealedCredential(membershipId)
  )
  const now = deps.clock.now()
  const removed = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'calendar.disconnect')
    const record = await scope.deleteCalendarConnection(access.membershipId)
    if (record) {
      await Audit.recordIn(scope, caller.organizationId, {
        occurredAt: now,
        actor: { kind: 'member', membershipId: access.membershipId },
        action: 'calendar.disconnected',
        subject: { type: 'calendar_connection', id: record.id },
        metadata: { provider: record.provider },
      })
    }
    return record
  })
  if (!removed || !sealedBefore || !deps.calendar) {
    return
  }
  try {
    const vendor = await openVendorConnection(deps, caller, removed.id, sealedBefore)
    if (vendor) {
      await deps.calendar.port.revoke(
        { organizationId: caller.organizationId, connection: vendor },
        { timeoutMs: VENDOR_TIMEOUT_MS }
      )
    }
  } catch {
    // Best effort: the credential is already deleted here. A grant that stays at the vendor is
    // the Rep's to remove in their Google account.
    deps.logger.warn('calendar revoke failed', { organizationId: caller.organizationId })
  }
}

import {
  CONSENT_CHANNELS,
  CORE_ERRORS,
  type ConsentChannel,
  type ConsentSource,
  ERRORS,
  formatId,
  type OrganizationId,
  type ProspectId,
  type RecordWithdrawalRequest,
  type SuppressionReason,
} from 'tula-closeline-contract'
import { MAX_SUPPRESSION_SOURCE_REF_LENGTH } from 'tula-closeline-db/schema'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { consentWithdrawn } from '~/messages'
import {
  consentWithdrawnEvent,
  type PendingEvent,
  publishEvents,
  suppressionAddedEvent,
} from '~/modules/prospect/events'
import {
  type AddressKind,
  hashAddress,
  maskAddress,
  normaliseAddress,
} from '~/modules/suppression/address'
import type { OrganizationScope, SuppressionRecord } from '~/ports/core-store'

/** What recording a withdrawal needs from the container. */
export type WithdrawalDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events' | 'env'>

/** What a withdrawal is made of; the callers (an unsubscribe link, a STOP) each build one. */
export type Withdrawal = {
  /** The kind of the address and its normalised value; the value is hashed and never stored. */
  address: { kind: AddressKind; value: string }
  /** The Prospect that holds the address, if one is known. */
  prospectId: ProspectId | null
  /** The channel the withdrawal is on. */
  channel: ConsentChannel
  /** Whether the person asked to stop everything: every channel is withdrawn. */
  stopAll: boolean
  /** How the withdrawal reached us: the consent event's source. */
  source: Extract<ConsentSource, 'unsubscribe' | 'stop_reply'>
  /** Why the address is suppressed. */
  reason: Extract<SuppressionReason, 'unsubscribe' | 'stop'>
  /** The adapter's reference to the message, kept on the Suppression entry and as evidence; `null` for a link. */
  sourceRef: string | null
}

/** What recording a withdrawal did: the Suppression entry (the existing one on a replay) and the events to publish after the commit. */
export type RecordedWithdrawal = {
  entry: SuppressionRecord
  created: boolean
  events: PendingEvent[]
}

/** The address kind each channel is reached by. */
const ADDRESS_KIND_OF: Record<ConsentChannel, AddressKind> = {
  email: 'email',
  phone: 'phone',
  sms: 'phone',
  whatsapp: 'phone',
  linkedin: 'linkedin',
}

/** The address kind a channel uses: an email for email, a number for the phone channels, a LinkedIn address for LinkedIn. */
export function addressKindOf(channel: ConsentChannel): AddressKind {
  return ADDRESS_KIND_OF[channel]
}

/**
 * Adds a Suppression entry for the address and withdraws Contact Consent on the channel (or on
 * every channel for a STOP-all) when the Prospect is known, inside the caller's transaction. The
 * caller has already locked the Organization. Idempotent by state: a live entry for the address is
 * returned as it is, and a channel whose latest consent event is already a withdrawal gets no
 * second one, so a replay writes nothing and publishes nothing.
 */
export async function withdrawWithin(
  deps: WithdrawalDeps,
  scope: OrganizationScope,
  organizationId: OrganizationId,
  withdrawal: Withdrawal
): Promise<RecordedWithdrawal> {
  const now = deps.clock.now()
  const { address } = withdrawal
  const { entry, created } = await scope.insertSuppressionEntry({
    id: formatId('sup', crypto.randomUUID()),
    addressKind: address.kind,
    addressHash: hashAddress(
      deps.env.CONSENT_HASH_KEY,
      organizationId,
      address.kind,
      address.value
    ),
    maskedAddress: maskAddress(address.kind, address.value),
    reason: withdrawal.reason,
    channel: withdrawal.stopAll ? null : withdrawal.channel,
    sourceRef: withdrawal.sourceRef,
    addedByUserId: null,
    now,
  })
  const events: PendingEvent[] = []
  if (created) {
    events.push(
      suppressionAddedEvent({
        suppressionEntryId: entry.id,
        addressKind: entry.addressKind,
        reason: entry.reason,
        prospectId: withdrawal.prospectId,
      })
    )
  }
  if (withdrawal.prospectId !== null) {
    const prospectId = withdrawal.prospectId
    const channels = withdrawal.stopAll ? [...CONSENT_CHANNELS] : [withdrawal.channel]
    const inputs = []
    for (const channel of channels) {
      if ((await scope.latestConsentKind(prospectId, channel)) === 'withdrawn') {
        continue
      }
      inputs.push({
        id: formatId('cev', crypto.randomUUID()),
        prospectId,
        channel,
        kind: 'withdrawn' as const,
        source: withdrawal.source,
        wordingId: null,
        evidenceRef: withdrawal.sourceRef,
        callId: null,
        formId: null,
        ipAddress: null,
        userAgent: null,
        stopAll: withdrawal.stopAll,
        recordedByUserId: null,
        occurredAt: now,
      })
    }
    if (inputs.length > 0) {
      for (const event of await scope.appendConsentEvents(inputs)) {
        events.push(
          consentWithdrawnEvent(
            event.id,
            consentWithdrawn.payload.parse({
              consentEventId: event.id,
              prospectId: event.prospectId,
              channel: event.channel,
              source: event.source,
              stopAll: event.stopAll,
            })
          )
        )
      }
    }
  }
  return { entry, created, events }
}

/**
 * Records an inbound STOP the channel adapter received (`POST /internal/v1/consent-withdrawals`).
 * The Organization comes from the adapter's record of the message. The address must be the kind
 * the channel uses (else `request.invalid`). Adds a `stop` Suppression entry and withdraws the
 * channel, or every channel for `stopAll`, for the Prospect that holds the address; an address
 * no Prospect holds is still suppressed. A deleted Organization is `organization.deleted`; a
 * suspended one still takes a STOP. Idempotent on the message: a repeat answers the same entry.
 */
export async function recordWithdrawal(
  deps: WithdrawalDeps,
  request: RecordWithdrawalRequest,
  traceId: string
): Promise<{ entryId: SuppressionRecord['id']; prospectId: ProspectId | null }> {
  const kind = addressKindOf(request.channel)
  const raw =
    kind === 'email' ? request.email : kind === 'phone' ? request.phone : request.linkedinUrl
  const others = [request.email, request.phone, request.linkedinUrl].filter(
    (value) => value !== undefined
  )
  if (raw === undefined || others.length !== 1) {
    throw domainError(ERRORS['request.invalid'], { field: 'channel' })
  }
  const value = normaliseAddress(kind, raw)
  if (value === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  const sourceRef = request.sourceRef.trim().slice(0, MAX_SUPPRESSION_SOURCE_REF_LENGTH)
  const result = await deps.store.withOrganization(request.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization) {
      throw domainError(CORE_ERRORS['organization.not_found'])
    }
    if (organization.status === 'deleted') {
      throw domainError(CORE_ERRORS['organization.deleted'])
    }
    const prospectId = await scope.findProspectByIdentity(kind, value)
    const recorded = await withdrawWithin(deps, scope, request.organizationId, {
      address: { kind, value },
      prospectId,
      channel: request.channel,
      stopAll: request.stopAll,
      source: 'stop_reply',
      reason: 'stop',
      sourceRef: sourceRef === '' ? null : sourceRef,
    })
    return { recorded, prospectId }
  })
  await publishEvents(deps, request.organizationId, traceId, result.recorded.events)
  return { entryId: result.recorded.entry.id, prospectId: result.prospectId }
}

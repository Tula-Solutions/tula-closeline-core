import {
  CONSENT_CHANNELS,
  CONSENT_ERRORS,
  type ConsentChannel,
  type ConsentEvent,
  ERRORS,
  formatId,
  type ProspectConsent,
  type ProspectId,
  type RecordConsentRequest,
  type WithdrawConsentRequest,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { consentGranted, consentWithdrawn } from '~/messages'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganizationForWrite } from '~/modules/organization/access'
import {
  consentGrantedEvent,
  consentWithdrawnEvent,
  type PendingEvent,
  publishEvents,
} from '~/modules/prospect/events'
import { prospectNotFound, visibilityForRole } from '~/modules/prospect/service'
import { hashAddress } from '~/modules/suppression/address'
import type { ConsentEventInput, OrganizationScope, ProspectIdentityKind } from '~/ports/core-store'
import { type RecordedConsentResponse, recordedConsentResponseSchema } from './schema'

/** What the consent service needs from the container. */
export type ConsentDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events' | 'env'>

/** What a call is given besides its request: the request id the events carry, and the validated `Idempotency-Key`, if sent. */
export type ConsentCallOptions = { traceId: string; idempotencyKey?: string | undefined }

const ADDRESS_KINDS: readonly ProspectIdentityKind[] = ['email', 'phone', 'linkedin']

/** The Prospect's consent per channel, from the newest ledger event of each, and whether any of its addresses is suppressed. */
async function consentOf(
  deps: ConsentDeps,
  scope: OrganizationScope,
  organizationId: Caller['organizationId'],
  prospectId: ProspectId
): Promise<ProspectConsent> {
  const newest = new Map<ConsentChannel, ConsentEvent>()
  for (const event of await scope.latestConsentEvents(prospectId)) {
    newest.set(event.channel, event)
  }
  let suppressionReason: ProspectConsent['suppressionReason'] = null
  for (const kind of ADDRESS_KINDS) {
    const value = await scope.getProspectIdentity(prospectId, kind)
    if (value === null) {
      continue
    }
    const hash = hashAddress(deps.env.CONSENT_HASH_KEY, organizationId, kind, value)
    const live = (await scope.findLiveSuppression(kind, [hash]))[0]
    if (live) {
      suppressionReason = live.reason
      break
    }
  }
  return {
    prospectId,
    channels: CONSENT_CHANNELS.map((channel) => {
      const last = newest.get(channel)
      return {
        channel,
        state: last ? last.kind : 'none',
        since: last?.occurredAt ?? null,
        lastEventId: last?.id ?? null,
        wordingId: last?.wordingId ?? null,
      }
    }),
    suppressed: suppressionReason !== null,
    suppressionReason,
  }
}

/** Appends `inputs`, answers them with the Prospect's consent, and lists the events to publish. */
async function append(
  deps: ConsentDeps,
  scope: OrganizationScope,
  caller: Caller,
  prospectId: ProspectId,
  inputs: ConsentEventInput[]
): Promise<{ answer: RecordedConsentResponse; events: PendingEvent[] }> {
  const stored = await scope.appendConsentEvents(inputs)
  const events = stored.map((event): PendingEvent => {
    if (event.kind === 'granted' && event.wordingId !== null) {
      return consentGrantedEvent(
        event.id,
        consentGranted.payload.parse({
          consentEventId: event.id,
          prospectId: event.prospectId,
          channel: event.channel,
          source: event.source,
          wordingId: event.wordingId,
        })
      )
    }
    return consentWithdrawnEvent(
      event.id,
      consentWithdrawn.payload.parse({
        consentEventId: event.id,
        prospectId: event.prospectId,
        channel: event.channel,
        source: event.source,
        stopAll: event.stopAll,
      })
    )
  })
  const consent = await consentOf(deps, scope, caller.organizationId, prospectId)
  return { answer: { events: stored, consent }, events }
}

/** Refuses a time in the future: a consent cannot be recorded before it happened. */
function occurredAtOf(requested: string | undefined, now: Date): Date {
  if (requested === undefined) {
    return now
  }
  const at = new Date(requested)
  if (at.getTime() > now.getTime()) {
    throw domainError(ERRORS['request.invalid'], { field: 'occurredAt' })
  }
  return at
}

/**
 * Records a granted Contact Consent on one channel. The Prospect must be one the caller can see
 * (else `prospect.not_found`), the wording must exist (`consent.not_found`) and cover the channel
 * (`request.invalid`). Appends one event and publishes `consent.granted`; a replay of the same
 * `Idempotency-Key` answers the first result (200) and publishes nothing.
 */
export async function record(
  deps: ConsentDeps,
  caller: Caller,
  prospectId: ProspectId,
  request: RecordConsentRequest,
  options: ConsentCallOptions
): Promise<IdempotentAnswer<200 | 201, RecordedConsentResponse>> {
  const now = deps.clock.now()
  const result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    let events: PendingEvent[] = []
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'consent.record',
        request: { params: { prospectId }, body: request },
        status: 201,
        response: recordedConsentResponseSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'consent.record')
        const prospect = await scope.lockProspect(
          prospectId,
          visibilityForRole(access.role, access.membershipId)
        )
        if (!prospect) {
          throw prospectNotFound()
        }
        const occurredAt = occurredAtOf(request.occurredAt, now)
        const wording = await scope.getConsentWording(request.wordingId)
        if (!wording) {
          throw domainError(CONSENT_ERRORS['consent.not_found'], { resource: 'consent_wording' })
        }
        if (!wording.channels.includes(request.channel)) {
          throw domainError(ERRORS['request.invalid'], { field: 'wordingId' })
        }
        const appended = await append(deps, scope, caller, prospectId, [
          {
            id: formatId('cev', crypto.randomUUID()),
            prospectId,
            channel: request.channel,
            kind: 'granted',
            source: request.source,
            wordingId: request.wordingId,
            evidenceRef: request.evidenceRef,
            callId: request.callId ?? null,
            formId: null,
            ipAddress: null,
            userAgent: null,
            stopAll: false,
            recordedByUserId: caller.userId,
            occurredAt,
          },
        ])
        events = appended.events
        return appended.answer
      }
    )
    return { answer, events: answer.replayed ? [] : events }
  })
  await publishEvents(deps, caller.organizationId, options.traceId, result.events)
  return {
    status: result.answer.replayed ? 200 : 201,
    body: result.answer.body,
    replayed: result.answer.replayed,
  }
}

/**
 * Records a withdrawal on the named channels, or on every channel for a STOP-all (`all: true`,
 * which marks each event `stopAll`). Other channels are untouched. A withdrawal needs no reason
 * and is allowed in a suspended Organization. Publishes one `consent.withdrawn` per channel.
 */
export async function withdraw(
  deps: ConsentDeps,
  caller: Caller,
  prospectId: ProspectId,
  request: WithdrawConsentRequest,
  options: ConsentCallOptions
): Promise<IdempotentAnswer<200 | 201, RecordedConsentResponse>> {
  const now = deps.clock.now()
  const stopAll = request.all === true
  const channels = stopAll ? [...CONSENT_CHANNELS] : [...new Set(request.channels ?? [])]
  if (channels.length === 0) {
    throw domainError(ERRORS['request.invalid'], { field: 'channels' })
  }
  const result = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    let events: PendingEvent[] = []
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'consent.withdraw',
        request: { params: { prospectId }, body: request },
        status: 201,
        response: recordedConsentResponseSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'consent.withdraw')
        const prospect = await scope.lockProspect(
          prospectId,
          visibilityForRole(access.role, access.membershipId)
        )
        if (!prospect) {
          throw prospectNotFound()
        }
        const occurredAt = occurredAtOf(request.occurredAt, now)
        const appended = await append(
          deps,
          scope,
          caller,
          prospectId,
          channels.map((channel) => ({
            id: formatId('cev', crypto.randomUUID()),
            prospectId,
            channel,
            kind: 'withdrawn' as const,
            source: 'manual' as const,
            wordingId: null,
            evidenceRef: null,
            callId: null,
            formId: null,
            ipAddress: null,
            userAgent: null,
            stopAll,
            recordedByUserId: caller.userId,
            occurredAt,
          }))
        )
        events = appended.events
        return appended.answer
      }
    )
    return { answer, events: answer.replayed ? [] : events }
  })
  await publishEvents(deps, caller.organizationId, options.traceId, result.events)
  return {
    status: result.answer.replayed ? 200 : 201,
    body: result.answer.body,
    replayed: result.answer.replayed,
  }
}

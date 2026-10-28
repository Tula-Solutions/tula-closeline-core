import {
  CONSENT_CHANNELS,
  CONSENT_ERRORS,
  type ConsentChannel,
  type ConsentEvent,
  type consentEventPageSchema,
  decodeCursor,
  ERRORS,
  EVIDENCE_CSV_COLUMNS,
  encodeCursor,
  evidenceEventSchema,
  type evidencePageSchema,
  formatId,
  type ListConsentEventsQuery,
  type listEvidenceQuerySchema,
  type ProspectConsent,
  type ProspectId,
  type RecordConsentRequest,
  type WithdrawConsentRequest,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { consentGranted, consentWithdrawn } from '~/messages'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  consentGrantedEvent,
  consentWithdrawnEvent,
  enqueueEvents,
  type PendingEvent,
} from '~/modules/prospect/events'
import { prospectNotFound, visibilityForRole, visibilityOf } from '~/modules/prospect/service'
import { hashAddress } from '~/modules/suppression/address'
import type { ConsentEventInput, OrganizationScope, ProspectIdentityKind } from '~/ports/core-store'
import {
  consentCursorSchema,
  type RecordedConsentResponse,
  recordedConsentResponseSchema,
} from './schema'

/** A request for a page of evidence. */
type ListEvidenceQuery = z.infer<typeof listEvidenceQuerySchema>

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
        const eventId = formatId('cev', crypto.randomUUID())
        const appended = await append(deps, scope, caller, prospectId, [
          {
            id: eventId,
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
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'consent.granted',
          subject: { type: 'consent_event', id: eventId },
          prospectId,
          metadata: { channel: request.channel, source: request.source },
        })
        return appended.answer
      }
    )
    if (!answer.replayed) {
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    }
    return { answer }
  })
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
        const withdrawals = channels.map((channel) => ({
          channel,
          eventId: formatId('cev', crypto.randomUUID()),
        }))
        const appended = await append(
          deps,
          scope,
          caller,
          prospectId,
          withdrawals.map(({ channel, eventId }) => ({
            id: eventId,
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
        for (const { channel, eventId } of withdrawals) {
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: access.membershipId },
            action: 'consent.withdrawn',
            subject: { type: 'consent_event', id: eventId },
            prospectId,
            metadata: { channel, stopAll },
          })
        }
        return appended.answer
      }
    )
    if (!answer.replayed) {
      await enqueueEvents(scope, caller.organizationId, options.traceId, events)
    }
    return { answer }
  })
  return {
    status: result.answer.replayed ? 200 : 201,
    body: result.answer.body,
    replayed: result.answer.replayed,
  }
}

/** The decoded cursor of a page request; one that does not decode is `request.invalid`. */
function afterOf(cursor: string | undefined): { seq: number } | undefined {
  if (cursor === undefined) {
    return undefined
  }
  const after = decodeCursor(cursor, consentCursorSchema)
  if (after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return after
}

/**
 * Reads a Prospect's Contact Consent: the state of every channel from the newest ledger event of
 * each, and whether an address of the Prospect is suppressed. Any role, for a Prospect the caller
 * can see; any other (or one of another Organization) is `prospect.not_found`.
 */
export async function read(
  deps: ConsentDeps,
  caller: Caller,
  prospectId: ProspectId
): Promise<ProspectConsent> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent.read')
    const { visibility } = await visibilityOf(scope, caller)
    if (!(await scope.getProspect(prospectId, visibility))) {
      throw prospectNotFound()
    }
    return consentOf(deps, scope, caller.organizationId, prospectId)
  })
}

/**
 * Lists a Prospect's ledger events, newest first, one page at a time (at most 100), optionally
 * one channel. One row more than the page is read to know whether another follows. Any role, for
 * a Prospect the caller can see. The events never carry the submission details of a hosted form.
 */
export async function listEvents(
  deps: Pick<ConsentDeps, 'store'>,
  caller: Caller,
  prospectId: ProspectId,
  query: ListConsentEventsQuery
): Promise<z.infer<typeof consentEventPageSchema>> {
  const after = afterOf(query.cursor)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent.read')
    const { visibility } = await visibilityOf(scope, caller)
    if (!(await scope.getProspect(prospectId, visibility))) {
      throw prospectNotFound()
    }
    const rows = await scope.listConsentEvents({
      prospectId,
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => row.event),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ seq: last.seq }) : null,
    }
  })
}

/**
 * Exports a Prospect's consent evidence, newest first, one page at a time (at most 100): each
 * ledger event with the wording text shown and, for a hosted form, the submission details the
 * contract allows. Owner and Admin only, for a Prospect they can see.
 */
export async function listEvidence(
  deps: Pick<ConsentDeps, 'store'>,
  caller: Caller,
  prospectId: ProspectId,
  query: ListEvidenceQuery
): Promise<z.infer<typeof evidencePageSchema>> {
  const after = afterOf(query.cursor)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'consent.evidence')
    const { visibility } = await visibilityOf(scope, caller)
    if (!(await scope.getProspect(prospectId, visibility))) {
      throw prospectNotFound()
    }
    const rows = await scope.listConsentEvidence({
      prospectId,
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) =>
        evidenceEventSchema.parse({
          ...row.event,
          wording: row.wording,
          submission: row.submission,
        })
      ),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ seq: last.seq }) : null,
    }
  })
}

/** Rows of evidence fetched per transaction while a CSV export streams. */
const EVIDENCE_CSV_PAGE_ROWS = 100

/**
 * The CSV form of {@link listEvidence}: every event of the Prospect (one channel when `channel` is
 * given), newest first, as `EVIDENCE_CSV_COLUMNS`. The first page is read before this returns, so a
 * refusal (role, unknown Prospect) is an ordinary error response; later pages are read as the
 * stream is pulled, each in its own transaction, so memory stays bounded however long the ledger
 * is. A cell that begins like a formula is prefixed, so a spreadsheet does not run wording or a
 * user agent as one.
 */
export async function evidenceCsvStream(
  deps: Pick<ConsentDeps, 'store'>,
  caller: Caller,
  prospectId: ProspectId,
  query: Pick<ListEvidenceQuery, 'channel'>
): Promise<ReadableStream<Uint8Array>> {
  const fetchPage = (cursor: string | undefined) =>
    listEvidence(deps, caller, prospectId, {
      limit: EVIDENCE_CSV_PAGE_ROWS,
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(cursor === undefined ? {} : { cursor }),
    })
  let page = await fetchPage(undefined)
  const encoder = new TextEncoder()
  const line = (cells: readonly (string | number | null)[]) =>
    `${cells.map(Audit.csvCell).join(',')}\r\n`
  let started = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true
        controller.enqueue(encoder.encode(line(EVIDENCE_CSV_COLUMNS)))
      } else if (page.nextCursor !== null) {
        // shortcut: a failed later page errors the stream after the 200 is sent; the client sees a broken download, not a clean end.
        page = await fetchPage(page.nextCursor)
      } else {
        controller.close()
        return
      }
      controller.enqueue(
        encoder.encode(
          page.items
            .map((e) =>
              line([
                e.id,
                e.prospectId,
                e.channel,
                e.kind,
                e.source,
                e.occurredAt,
                e.recordedAt,
                e.wordingId,
                e.wording?.version ?? null,
                e.wording?.text ?? null,
                e.evidenceRef,
                e.submission?.ipAddress ?? null,
                e.submission?.userAgent ?? null,
              ])
            )
            .join('')
        )
      )
    },
  })
}

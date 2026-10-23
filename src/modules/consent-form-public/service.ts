import {
  CONSENT_ERRORS,
  type ConsentChannel,
  ERRORS,
  formatId,
  type HostedConsentFormView,
  type HostedConsentReceipt,
  type HostedConsentSubmission,
  hostedConsentFormViewSchema,
  hostedConsentReceiptSchema,
  type OrganizationId,
  type ProspectId,
  userIdSchema,
} from 'tula-closeline-contract'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import type { Container } from '~/container'
import { hashClientAddress } from '~/http/client-address'
import { domainError, RetryAfterError } from '~/http/domain-error'
import { consentGranted } from '~/messages'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import {
  consentGrantedEvent,
  createdEvent,
  type PendingEvent,
  publishEvents,
} from '~/modules/prospect/events'
import { writeFields } from '~/modules/prospect/fields'
import { normalisePhone } from '~/modules/prospect/normalise'
import type { FieldWrite } from '~/modules/prospect/provenance'
import type { ConsentFormLocation, OrganizationScope } from '~/ports/core-store'

/** The most requests one client address may make to the public consent routes in one window. */
export const CONSENT_RATE_LIMIT = 60

/** The length of the rate-limit window, in seconds (one hour). */
export const CONSENT_RATE_WINDOW_SECONDS = 3_600

/** What the public consent service needs from the container. */
export type HostedConsentDeps = Pick<
  Container,
  'store' | 'clock' | 'logger' | 'events' | 'env' | 'demoRateLimiter'
>

/** What a public call is given besides its body: the client, and the validated `Idempotency-Key`, if sent. */
export type HostedConsentCallOptions = {
  traceId: string
  /** The client's address as the router resolved it; counted for the rate limit and kept as evidence. */
  address: { canonical: string; raw: string | null }
  userAgent: string | undefined
  idempotencyKey?: string | undefined
}

/** The most characters of the address and of the user agent kept as evidence (the database columns). */
const MAX_EVIDENCE_ADDRESS = 64
const MAX_EVIDENCE_USER_AGENT = 512

/** The Source of a Prospect or a field the form created. */
const FORM_SOURCE = 'form'

/** The one answer for every link that does not work: unknown, tampered, draft, closed, or of an Organization that is not active. */
function invalidToken() {
  return domainError(CONSENT_ERRORS['consent.invalid_token'])
}

/** Counts one request from the client; refuses with `rate.limited` and the wait once the limit is spent. */
async function limitRate(deps: HostedConsentDeps, canonicalAddress: string): Promise<void> {
  // A key of its own, so the demo form and the consent form do not share a budget.
  const hash = hashClientAddress(canonicalAddress, `${deps.env.DEMO_RATE_KEY}:consent-form`)
  const allowed = await deps.demoRateLimiter.hit(hash, {
    windowSeconds: CONSENT_RATE_WINDOW_SECONDS,
    limit: CONSENT_RATE_LIMIT,
  })
  if (!allowed) {
    throw new RetryAfterError(ERRORS['rate.limited'], CONSENT_RATE_WINDOW_SECONDS, {
      retryAfter: CONSENT_RATE_WINDOW_SECONDS,
    })
  }
}

/** The form a token opens, if it is published; else `consent.invalid_token`. */
async function openLink(deps: HostedConsentDeps, token: string): Promise<ConsentFormLocation> {
  const location = await deps.store.consentFormForToken(token)
  if (location?.state !== 'published') {
    throw invalidToken()
  }
  return location
}

/**
 * What the hosted page shows for a link: the Organization's name, the exact wording and the
 * channels offered. Rate limited per client address. Any link that does not work is
 * `consent.invalid_token`.
 */
export async function view(
  deps: HostedConsentDeps,
  input: { token: string; address: { canonical: string } }
): Promise<HostedConsentFormView> {
  await limitRate(deps, input.address.canonical)
  const location = await openLink(deps, input.token)
  return deps.store.withOrganization(location.organizationId, async (scope) => {
    const [organization, form] = await Promise.all([
      scope.getOrganization(),
      scope.findConsentForm(location.formId),
    ])
    if (organization?.status !== 'active' || form?.state !== 'published') {
      throw invalidToken()
    }
    const wording = await scope.findConsentWording(form.wordingId)
    if (!wording) {
      throw invalidToken()
    }
    return hostedConsentFormViewSchema.parse({
      organizationName: organization.name,
      wordingId: wording.id,
      wordingVersion: wording.version,
      wordingText: wording.text,
      channels: form.channels,
    })
  })
}

/** The Prospect the submission is about: the one that holds its phone or email, or a new one. When the phone and email belong to different Prospects the phone's wins, and the answer is the same as for any submission, so a stranger learns nothing about whose they are. */
async function resolveProspect(
  scope: OrganizationScope,
  request: HostedConsentSubmission,
  formId: string,
  now: Date,
  events: PendingEvent[]
): Promise<ProspectId> {
  const email = request.email?.trim().toLowerCase()
  let phone: string | undefined
  if (request.phone !== undefined && request.phone.trim() !== '') {
    phone = normalisePhone(request.phone)
    if (phone === undefined) {
      throw domainError(ERRORS['request.invalid'], { field: 'phone' })
    }
  }
  const byPhone = phone === undefined ? null : await scope.findProspectByIdentity('phone', phone)
  const byEmail =
    email === undefined || email === '' ? null : await scope.findProspectByIdentity('email', email)
  const known = byPhone ?? byEmail
  if (known) {
    // Nothing a stranger types is written over a Prospect the Organization already has.
    return known
  }
  const id = formatId('prs', crypto.randomUUID())
  await scope.insertProspect({
    id,
    companyId: null,
    ownerMembershipId: null,
    source: FORM_SOURCE,
    tags: [],
    notes: null,
    now,
  })
  const writes: FieldWrite[] = []
  const candidates: Array<[string, string | undefined]> = [
    ['firstName', request.firstName?.trim()],
    ['lastName', request.lastName?.trim()],
    ['email', email],
    ['phone', phone],
  ]
  for (const [field, value] of candidates) {
    if (value !== undefined && value !== '') {
      writes.push({ field, value, source: FORM_SOURCE, sourceRef: formId })
    }
  }
  await writeFields(scope, 'prospect', id, writes, { userId: null, at: now })
  events.push(
    createdEvent({ prospectId: id, companyId: null, ownerMembershipId: null, source: FORM_SOURCE })
  )
  return id
}

/** The channels the submission ticked: each one in `offered` whose every choice says agreed. */
function agreedChannels(
  request: HostedConsentSubmission,
  offered: readonly ConsentChannel[]
): ConsentChannel[] {
  const choices = new Map<ConsentChannel, boolean>()
  for (const choice of request.choices) {
    choices.set(choice.channel, (choices.get(choice.channel) ?? true) && choice.agreed)
  }
  for (const channel of choices.keys()) {
    if (choices.get(channel) === true && !offered.includes(channel)) {
      throw domainError(ERRORS['request.invalid'], { field: 'choices' })
    }
  }
  return offered.filter((channel) => choices.get(channel) === true)
}

/**
 * Takes a hosted consent form submission. One grant is appended to the ledger per ticked channel
 * (source `hosted_form`), each citing the exact wording version the form shows, the form, the
 * time, and the client's address and user agent as evidence; an unticked or missing channel
 * grants nothing. The Prospect is the one that holds the phone or email, or a new one. The same
 * `Idempotency-Key` returns the first receipt (200) and appends nothing. The address and body are
 * never logged. Errors: `consent.invalid_token`, `rate.limited`, `request.invalid` (a wording
 * other than the form's, a channel the form does not offer, or two people's addresses at once).
 */
export async function submit(
  deps: HostedConsentDeps,
  input: { token: string; request: HostedConsentSubmission } & HostedConsentCallOptions
): Promise<IdempotentAnswer<200 | 201, HostedConsentReceipt>> {
  await limitRate(deps, input.address.canonical)
  const location = await openLink(deps, input.token)
  const now = deps.clock.now()
  const organizationId: OrganizationId = location.organizationId
  const caller = { userId: userIdSchema.parse(INTERNAL_CALL_USER_ID), organizationId }

  const result = await deps.store.withOrganization(organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    const events: PendingEvent[] = []
    const answer = await idempotent(
      deps,
      scope,
      caller,
      {
        key: input.idempotencyKey,
        route: `consent.hosted_submit.${location.formId}`,
        request: { body: input.request },
        status: 201,
        response: hostedConsentReceiptSchema,
      },
      async () => {
        const organization = await scope.lockOrganization()
        if (organization?.status !== 'active') {
          throw invalidToken()
        }
        const form = await scope.findConsentForm(location.formId)
        if (form?.state !== 'published') {
          throw invalidToken()
        }
        if (input.request.wordingId !== form.wordingId) {
          // The page the person saw is not the form's current wording: nothing is granted on it.
          throw domainError(ERRORS['request.invalid'], { field: 'wordingId' })
        }
        const channels = agreedChannels(input.request, form.channels)
        if (channels.length === 0) {
          throw domainError(ERRORS['request.invalid'], { field: 'choices' })
        }
        const prospectId = await resolveProspect(scope, input.request, form.id, now, events)
        const stored = await scope.appendConsentEvents(
          channels.map((channel) => ({
            id: formatId('cev', crypto.randomUUID()),
            prospectId,
            channel,
            kind: 'granted' as const,
            source: 'hosted_form' as const,
            wordingId: form.wordingId,
            evidenceRef: form.id,
            callId: null,
            formId: form.id,
            ipAddress: (input.address.raw ?? 'unknown').slice(0, MAX_EVIDENCE_ADDRESS),
            userAgent: (input.userAgent ?? 'unknown').slice(0, MAX_EVIDENCE_USER_AGENT),
            stopAll: false,
            recordedByUserId: null,
            occurredAt: now,
          }))
        )
        for (const event of stored) {
          events.push(
            consentGrantedEvent(
              event.id,
              consentGranted.payload.parse({
                consentEventId: event.id,
                prospectId: event.prospectId,
                channel: event.channel,
                source: event.source,
                wordingId: form.wordingId,
              })
            )
          )
        }
        return hostedConsentReceiptSchema.parse({
          channels,
          recordedAt: now.toISOString(),
        })
      }
    )
    return { answer, events: answer.replayed ? [] : events }
  })
  await publishEvents(deps, organizationId, input.traceId, result.events)
  return {
    status: result.answer.replayed ? 200 : 201,
    body: result.answer.body,
    replayed: result.answer.replayed,
  }
}

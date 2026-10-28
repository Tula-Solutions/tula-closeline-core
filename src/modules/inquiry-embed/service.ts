import { randomBytes } from 'node:crypto'
import {
  ERRORS,
  formatId,
  INQUIRY_ERRORS,
  type InquiryEmbed,
  type InquiryIntakeRequest,
  type InquiryIntakeResult,
  inquiryEmbedSchema,
  inquiryIntakeResultSchema,
  type OrganizationId,
  type ProspectId,
  type ResolvedInquiryKey,
  resolvedInquiryKeySchema,
  type SetInquiryEmbedRequest,
  userIdSchema,
} from 'tula-closeline-contract'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { consentGranted } from '~/messages'
import { hashSecret } from '~/modules/api-key/secret'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  consentGrantedEvent,
  createdEvent,
  enqueueEvents,
  type PendingEvent,
} from '~/modules/prospect/events'
import { writeFields } from '~/modules/prospect/fields'
import { normalisePhone } from '~/modules/prospect/normalise'
import type { FieldWrite } from '~/modules/prospect/provenance'
import type { InquiryEmbedRecord } from '~/ports/inquiry-embed-store'

/** What the Inquiry embed service needs from the container. */
export type InquiryEmbedDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'events'>

/** The Source of a Prospect or field an Inquiry form created. */
const INQUIRY_SOURCE = 'form'

/** The most characters of a consent evidence reference (the ledger column). */
const MAX_EVIDENCE_REF = 200

/** A new publishable key: 43 URL-safe characters from 32 random bytes (the contract allows 32 to 64). */
function generateKey(): string {
  return randomBytes(32).toString('base64url')
}

/** The API shape of an embed row: the key, origins and wording id, never the hash or the text. */
function toEmbed(record: InquiryEmbedRecord): InquiryEmbed {
  return inquiryEmbedSchema.parse({
    publishableKey: record.publishableKey,
    allowedOrigins: record.allowedOrigins,
    consentWordingId: record.consentWordingId,
    updatedAt: record.updatedAt.toISOString(),
  })
}

/**
 * The Organization's embed settings. Owner and Admin. A first read makes the row, with a new key,
 * no origin and no wording, so the key exists before the form is configured; the form is not live
 * (its key resolves to `inquiry.key_unknown`) until an origin and a wording are set.
 */
export async function get(deps: InquiryEmbedDeps, caller: Caller): Promise<InquiryEmbed> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inquiry_embed.read')
    const found = await scope.getInquiryEmbed()
    if (found) {
      return toEmbed(found)
    }
    const now = deps.clock.now()
    await openOrganizationForWrite(scope, caller, 'inquiry_embed.update')
    const publishableKey = generateKey()
    // Another request may have made the row while this one waited for the lock.
    if (!(await scope.getInquiryEmbed())) {
      await scope.insertInquiryEmbed({
        publishableKey,
        keyHash: hashSecret(publishableKey),
        now,
      })
    }
    const made = await scope.getInquiryEmbed()
    if (!made) {
      throw new Error('inquiry embed missing after insert')
    }
    return toEmbed(made)
  })
}

/**
 * Replaces the allowed origins and the wording the form shows. Owner and Admin. The wording must
 * exist and cover the phone channel (`inquiry.embed_invalid`); its id, version and text are copied
 * onto the embed, so the form shows exactly what the consent will cite. A repeat changes nothing.
 */
export async function set(
  deps: InquiryEmbedDeps,
  caller: Caller,
  request: SetInquiryEmbedRequest,
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<200, InquiryEmbed>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent<200, InquiryEmbed>(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'inquiry_embed.set',
        request: { body: request },
        status: 200,
        response: inquiryEmbedSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(
          scope,
          caller,
          'inquiry_embed.update'
        )
        const wording = await scope.findConsentWording(request.consentWordingId)
        if (!wording?.channels.includes('phone')) {
          throw domainError(INQUIRY_ERRORS['inquiry.embed_invalid'], { field: 'consentWordingId' })
        }
        if (!(await scope.getInquiryEmbed())) {
          const publishableKey = generateKey()
          await scope.insertInquiryEmbed({
            publishableKey,
            keyHash: hashSecret(publishableKey),
            now,
          })
        }
        await scope.updateInquiryEmbed({
          allowedOrigins: request.allowedOrigins,
          wording: { id: wording.id, version: wording.version, text: wording.text },
          now,
        })
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId },
          action: 'inquiry_embed.updated',
          subject: { type: 'inquiry_embed', id: caller.organizationId },
          metadata: { origin_count: request.allowedOrigins.length },
        })
        const saved = await scope.getInquiryEmbed()
        if (!saved) {
          throw new Error('inquiry embed missing after update')
        }
        return toEmbed(saved)
      }
    )
  )
  return { status: 200, body: answer.body, replayed: answer.replayed }
}

/**
 * Issues a new publishable key. Owner and Admin. The old key stops resolving at once. The same
 * `Idempotency-Key` answers the same new key and rotates once.
 */
export async function rotateKey(
  deps: InquiryEmbedDeps,
  caller: Caller,
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<200, InquiryEmbed>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent<200, InquiryEmbed>(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'inquiry_embed.rotate',
        request: {},
        status: 200,
        response: inquiryEmbedSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(
          scope,
          caller,
          'inquiry_embed.rotate'
        )
        const publishableKey = generateKey()
        const key = { publishableKey, keyHash: hashSecret(publishableKey), now }
        if (await scope.getInquiryEmbed()) {
          await scope.rotateInquiryEmbedKey(key)
        } else {
          await scope.insertInquiryEmbed(key)
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId },
          action: 'inquiry_embed.key_rotated',
          subject: { type: 'inquiry_embed', id: caller.organizationId },
          metadata: {},
        })
        const saved = await scope.getInquiryEmbed()
        if (!saved) {
          throw new Error('inquiry embed missing after rotate')
        }
        return toEmbed(saved)
      }
    )
  )
  return { status: 200, body: answer.body, replayed: answer.replayed }
}

/**
 * Which Organization a publishable key belongs to, with its allowed origins and the exact wording.
 * Internal (voice). The key is hashed here and looked up by hash; an unknown, rotated or not-yet-live
 * key, or one of an Organization that is not active, is `inquiry.key_unknown`. The key is never
 * logged or put in an error.
 */
export async function resolveKey(
  deps: Pick<InquiryEmbedDeps, 'store'>,
  request: { publishableKey: string }
): Promise<ResolvedInquiryKey> {
  const found = await deps.store.inquiryEmbedForKeyHash(hashSecret(request.publishableKey))
  if (!found) {
    throw domainError(INQUIRY_ERRORS['inquiry.key_unknown'])
  }
  const active = await deps.store.withOrganization(found.organizationId, async (scope) => {
    return (await scope.getOrganization())?.status === 'active'
  })
  if (!active) {
    throw domainError(INQUIRY_ERRORS['inquiry.key_unknown'])
  }
  return resolvedInquiryKeySchema.parse(found)
}

/** The first and last name a typed full name splits into: the first word, and the rest. */
function splitName(name: string): { firstName?: string; lastName?: string } {
  const [first, ...rest] = name.trim().split(/\s+/)
  return {
    ...(first ? { firstName: first } : {}),
    ...(rest.length > 0 ? { lastName: rest.join(' ') } : {}),
  }
}

/**
 * Takes an Inquiry's Prospect and consent from voice, in one transaction: the Prospect that holds
 * the phone or email, or a new one (nothing a stranger types overwrites a known Prospect), and
 * one phone Contact Consent citing the embed's wording, the page address and the capture time. The
 * wording version must be the embed's current one (`inquiry.consent_wording_missing`). The same
 * `Idempotency-Key` answers the first result (200) and stores nothing. No Prospect data is logged.
 */
export async function intake(
  deps: InquiryEmbedDeps,
  request: InquiryIntakeRequest,
  options: { traceId: string; idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<200 | 201, InquiryIntakeResult>> {
  const now = deps.clock.now()
  const organizationId: OrganizationId = request.organizationId
  const caller = { userId: userIdSchema.parse(INTERNAL_CALL_USER_ID), organizationId }
  const phone = normalisePhone(request.prospect.phone)
  if (phone === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'prospect.phone' })
  }
  const email = request.prospect.email?.trim().toLowerCase()
  // A future time would sort after a later STOP and revive withdrawn consent (ADR 0003).
  if (new Date(request.consent.capturedAt).getTime() > now.getTime()) {
    throw domainError(ERRORS['request.invalid'], { field: 'consent.capturedAt' })
  }

  return deps.store.withOrganization(organizationId, async (scope) => {
    // Created inside the callback: the store may run it again after a deadlock.
    const events: PendingEvent[] = []
    const answer = await idempotent<201, InquiryIntakeResult>(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'inquiry.intake',
        request: { body: request },
        status: 201,
        response: inquiryIntakeResultSchema,
      },
      async () => {
        const organization = await scope.lockOrganization()
        if (organization?.status !== 'active') {
          throw domainError(INQUIRY_ERRORS['inquiry.key_unknown'])
        }
        const embed = await scope.getInquiryEmbed()
        if (
          embed?.consentWordingId == null ||
          embed.consentWordingVersion !== request.consent.wordingVersion
        ) {
          throw domainError(INQUIRY_ERRORS['inquiry.consent_wording_missing'])
        }
        // Phone consent attaches only to the Prospect that owns the typed phone; an email match
        // alone must never let a visitor make another person's stored number callable.
        const byEmail =
          email === undefined ? null : await scope.findProspectByIdentity('email', email)
        let prospectId: ProspectId | null = await scope.findProspectByIdentity('phone', phone)
        if (prospectId === null) {
          prospectId = formatId('prs', crypto.randomUUID())
          await scope.insertProspect({
            id: prospectId,
            companyId: null,
            ownerMembershipId: null,
            source: INQUIRY_SOURCE,
            tags: [],
            notes: null,
            now,
          })
          const sourceRef = request.inquiryId
          const candidates: Array<[string, string | undefined]> = [
            [
              'firstName',
              request.prospect.name ? splitName(request.prospect.name).firstName : undefined,
            ],
            [
              'lastName',
              request.prospect.name ? splitName(request.prospect.name).lastName : undefined,
            ],
            ['email', byEmail === null ? email : undefined],
            ['phone', phone],
          ]
          const writes: FieldWrite[] = candidates.flatMap(([field, value]) =>
            value === undefined || value === ''
              ? []
              : [{ field, value, source: INQUIRY_SOURCE, sourceRef }]
          )
          await writeFields(scope, 'prospect', prospectId, writes, { userId: null, at: now })
          events.push(
            createdEvent({
              prospectId,
              companyId: null,
              ownerMembershipId: null,
              source: INQUIRY_SOURCE,
            })
          )
        }
        const [stored] = await scope.appendConsentEvents([
          {
            id: formatId('cev', crypto.randomUUID()),
            prospectId,
            channel: 'phone',
            kind: 'granted',
            source: 'manual',
            wordingId: embed.consentWordingId,
            evidenceRef: `inquiry:${request.inquiryId} ${request.consent.sourceUrl}`.slice(
              0,
              MAX_EVIDENCE_REF
            ),
            callId: null,
            formId: null,
            ipAddress: null,
            userAgent: null,
            stopAll: false,
            recordedByUserId: caller.userId,
            occurredAt: new Date(request.consent.capturedAt),
          },
        ])
        if (!stored) {
          throw new Error('consent event not stored')
        }
        await Audit.recordIn(scope, organizationId, {
          occurredAt: now,
          actor: { kind: 'system' },
          action: 'consent.granted',
          subject: { type: 'consent_event', id: stored.id },
          prospectId,
          metadata: { channel: stored.channel, source: stored.source },
        })
        events.push(
          consentGrantedEvent(
            stored.id,
            consentGranted.payload.parse({
              consentEventId: stored.id,
              prospectId,
              channel: stored.channel,
              source: stored.source,
              wordingId: embed.consentWordingId,
            })
          )
        )
        return { prospectId, consentId: stored.id }
      }
    )
    if (!answer.replayed) {
      await enqueueEvents(scope, organizationId, options.traceId, events)
    }
    return {
      status: answer.replayed ? 200 : 201,
      body: answer.body,
      replayed: answer.replayed,
    }
  })
}

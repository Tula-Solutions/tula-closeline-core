import {
  CONSENT_REQUIRED_CHANNELS,
  type ConsentChannel,
  type ContactCheckId,
  type ContactCheckRequest,
  type ContactCheckResult,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListContactChecksQuery,
  type ProspectId,
  type SuppressionReason,
} from 'tula-closeline-contract'
import { CONTACT_CHECK_RETENTION_DAYS } from 'tula-closeline-db/schema'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization } from '~/modules/organization/access'
import { type AddressKind, hashAddress, normaliseAddress } from '~/modules/suppression/address'
import { contactCheckCursorSchema } from '~/modules/suppression/schema'
import type { ContactCheckRecord, OrganizationScope } from '~/ports/core-store'

/** What the Contact Check needs from the container. */
export type ContactCheckDeps = Pick<Container, 'store' | 'clock' | 'env' | 'logger'>

/** How many days a log row is kept: the retention of ADR 0021. */
const RETENTION_MS = CONTACT_CHECK_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** The most log rows one purge removes, so no request pays for a backlog. */
export const CONTACT_CHECK_PURGE_BATCH = 100

/**
 * Whether the check with this id also purges one batch of expired log rows: about one in sixteen,
 * chosen by the id so no process state is needed and any instance may do it.
 */
export function purgeDue(checkId: ContactCheckId): boolean {
  return checkId.charAt(checkId.length - 1) === '0'
}

/** Removes at most one batch of this Organization's log rows past the retention. */
export async function purgeExpired(scope: OrganizationScope, now: Date): Promise<number> {
  return scope.purgeContactChecks(new Date(now.getTime() - RETENTION_MS), CONTACT_CHECK_PURGE_BATCH)
}

/** The answer to the contract's Contact Check as a list item. */
type ContactCheckPage = {
  items: {
    id: ContactCheckId
    prospectId: ProspectId | null
    channel: ConsentChannel
    purpose: ContactCheckRecord['purpose']
    caller: string
    allowed: boolean
    code: ContactCheckRecord['code']
    basis: ContactCheckRecord['basis']
    checkedAt: string
  }[]
  nextCursor: string | null
}

/** The kind of address a channel reaches a Prospect on. */
const ADDRESS_KIND_OF_CHANNEL: Readonly<Record<ConsentChannel, AddressKind>> = {
  email: 'email',
  phone: 'phone',
  sms: 'phone',
  whatsapp: 'phone',
  linkedin: 'linkedin',
}

/** What the rules decided before it is logged and answered. */
type Decision =
  | { allowed: true; basis: NonNullable<ContactCheckRecord['basis']> }
  | {
      allowed: false
      code: NonNullable<ContactCheckRecord['code']>
      suppressionReason: SuppressionReason | null
    }

/** A refusal that is not a suppression. */
function deny(code: 'consent.missing' | 'consent.withdrawn'): Decision {
  return { allowed: false, code, suppressionReason: null }
}

/** The hashes of the addresses whose suppression decides this check, and the Prospect it concerns. */
async function addressesOf(
  deps: ContactCheckDeps,
  scope: OrganizationScope,
  request: ContactCheckRequest
): Promise<
  | { ok: true; prospectId: ProspectId | null; kind: AddressKind; hashes: Uint8Array[] }
  | { ok: false; prospectId: ProspectId | null }
> {
  const secret = deps.env.CONSENT_HASH_KEY
  const kind = ADDRESS_KIND_OF_CHANNEL[request.channel]
  if (request.prospectId !== undefined) {
    const prospect = await scope.getProspect(request.prospectId, { kind: 'all' })
    if (!prospect) {
      return { ok: false, prospectId: request.prospectId }
    }
    const value = await scope.getProspectIdentity(prospect.id, kind)
    return {
      ok: true,
      prospectId: prospect.id,
      kind,
      hashes: value === null ? [] : [hashAddress(secret, request.organizationId, kind, value)],
    }
  }
  const named: { kind: AddressKind; value: string } | undefined =
    request.email !== undefined
      ? { kind: 'email', value: request.email }
      : request.phone !== undefined
        ? { kind: 'phone', value: request.phone }
        : request.linkedinUrl !== undefined
          ? { kind: 'linkedin', value: request.linkedinUrl }
          : undefined
  const normalised = named === undefined ? undefined : normaliseAddress(named.kind, named.value)
  if (named === undefined || normalised === undefined) {
    return { ok: false, prospectId: null }
  }
  return {
    ok: true,
    prospectId: null,
    kind: named.kind,
    hashes: [hashAddress(secret, request.organizationId, named.kind, normalised)],
  }
}

/** Applies the rules of ADR 0003 and ADR 0021 to one check, reading only what the rules need. */
async function decide(
  deps: ContactCheckDeps,
  scope: OrganizationScope,
  request: ContactCheckRequest
): Promise<{ prospectId: ProspectId | null; decision: Decision }> {
  const found = await addressesOf(deps, scope, request)
  if (!found.ok) {
    return { prospectId: found.prospectId, decision: deny('consent.missing') }
  }
  const suppressed = await scope.findLiveSuppression(found.kind, found.hashes)
  const first = suppressed[0]
  if (first) {
    return {
      prospectId: found.prospectId,
      decision: { allowed: false, code: 'consent.suppressed', suppressionReason: first.reason },
    }
  }
  if (request.purpose !== 'agent_initiated') {
    return { prospectId: found.prospectId, decision: { allowed: true, basis: request.purpose } }
  }
  if (request.channel === 'email') {
    return {
      prospectId: found.prospectId,
      decision: { allowed: true, basis: 'email_no_suppression' },
    }
  }
  if (
    !(CONSENT_REQUIRED_CHANNELS as readonly ConsentChannel[]).includes(request.channel) ||
    found.prospectId === null
  ) {
    // LinkedIn has no consent to rely on, and a check by address has no ledger to read.
    return { prospectId: found.prospectId, decision: deny('consent.missing') }
  }
  const latest = await scope.latestConsentKind(found.prospectId, request.channel)
  if (latest === 'granted') {
    return { prospectId: found.prospectId, decision: { allowed: true, basis: 'consent_granted' } }
  }
  return {
    prospectId: found.prospectId,
    decision: deny(latest === 'withdrawn' ? 'consent.withdrawn' : 'consent.missing'),
  }
}

/**
 * The Contact Check: may this contact be reached on this channel for this purpose? Fails closed.
 * A suppressed address is refused on every channel and purpose. An Agent calling, texting or
 * messaging on WhatsApp needs a granted Contact Consent on that channel; an Agent emailing needs
 * only that the address is not suppressed; an Agent on LinkedIn is refused (`consent.missing`);
 * a Rep's own contact and a reply need no consent. A missing, deleted or suspended Organization, an unknown
 * Prospect and an address that cannot be read are refused as `consent.missing`. Every answer
 * about an Organization that exists is written to the audit log before it is returned; if the log cannot
 * be written the call fails (a 500), and the caller must treat that as a refusal
 * (`consent.unavailable`), so nothing is ever allowed without a record. The log keeps no address.
 */
export async function check(
  deps: ContactCheckDeps,
  request: ContactCheckRequest
): Promise<ContactCheckResult> {
  const now = deps.clock.now()
  const checkId: ContactCheckId = formatId('chk', crypto.randomUUID())
  const { decision, logged } = await deps.store.withOrganization(
    request.organizationId,
    async (scope) => {
      const organization = await scope.getOrganization()
      if (!organization || organization.status === 'deleted') {
        // Nothing to log against: the log row belongs to an Organization that is not there.
        return { decision: deny('consent.missing'), logged: false }
      }
      const decided = await decide(deps, scope, request)
      const prospectId = decided.prospectId
      // Only an active Organization may be contacted for: suspended is refused and still logged.
      const decision: Decision =
        organization.status === 'active' ? decided.decision : deny('consent.missing')
      await scope.insertContactCheck({
        id: checkId,
        prospectId,
        channel: request.channel,
        purpose: request.purpose,
        caller: request.caller,
        allowed: decision.allowed,
        code: decision.allowed ? null : decision.code,
        basis: decision.allowed ? decision.basis : null,
        checkedAt: now,
      })
      if (purgeDue(checkId)) {
        try {
          await purgeExpired(scope, now)
        } catch (error) {
          // Housekeeping must not fail the check; the store undoes the failed statement itself.
          // Only the error's name is logged: its message may carry row data.
          deps.logger.warn('contact check log purge failed', {
            error: error instanceof Error ? error.name : 'unknown',
          })
        }
      }
      return { decision, logged: true }
    }
  )
  if (decision.allowed) {
    return { allowed: true, checkId, basis: decision.basis }
  }
  return {
    allowed: false,
    checkId: logged ? checkId : null,
    code: decision.code,
    suppressionReason: decision.suppressionReason,
  }
}

/**
 * Lists the Contact Check log, newest first, one page at a time (at most 100), narrowed by the
 * optional filters. Owner and Admin only. It holds no address and no message.
 */
export async function list(
  deps: Pick<ContactCheckDeps, 'store'>,
  caller: Caller,
  query: ListContactChecksQuery
): Promise<ContactCheckPage> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, contactCheckCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'contact_check.list')
    if (query.code === 'consent.unavailable') {
      // Core never logs that code (the caller makes it up when core cannot answer), so nothing matches.
      return { items: [], nextCursor: null }
    }
    const rows = await scope.listContactChecks({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after: { at: new Date(after.at), id: after.id } }),
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
      ...(query.allowed === undefined ? {} : { allowed: query.allowed === 'true' }),
      ...(query.prospectId === undefined ? {} : { prospectId: query.prospectId }),
      ...(query.code === undefined ? {} : { code: query.code }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => ({
        id: row.id,
        prospectId: row.prospectId,
        channel: row.channel,
        purpose: row.purpose,
        caller: row.caller,
        allowed: row.allowed,
        code: row.code,
        basis: row.basis,
        checkedAt: row.checkedAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ at: last.checkedAt.toISOString(), id: last.id })
          : null,
    }
  })
}

import {
  type ConsentChannel,
  type ConsentEvent,
  type ConsentEventId,
  type ConsentFormId,
  type ConsentWordingId,
  formatId,
  type OrganizationId,
  type ProspectId,
  type SuppressionEntryId,
  type UserId,
  userIdSchema,
} from 'tula-closeline-contract'
import { INTERNAL_CALL_USER_ID } from 'tula-closeline-db/schema'
import type {
  ConsentEventKind,
  ConsentEventPageRequest,
  ConsentEventRow,
  ConsentFormRecord,
  ConsentWordingDetail,
  ConsentWordingRecord,
  ContactCheckRecord,
  OrganizationScope,
  SuppressionRecord,
} from '~/ports/core-store'
import { ConsentWordingLockedError, ConsentWordingSupersededError } from '~/ports/core-store'

/** A Suppression entry with the Organization it belongs to and the hex of its address hash. */
type StoredSuppression = SuppressionRecord & { organizationId: OrganizationId; hash: string }

type StoredCheck = ContactCheckRecord & { organizationId: OrganizationId }

/** A wording with the text shown and the lineage the wording routes read. */
type StoredWording = ConsentWordingRecord & {
  text: string
  supersedesId: ConsentWordingId | null
  createdAt: Date
  createdByUserId: UserId
}

/** A hosted form with the Organization it belongs to. */
type StoredForm = ConsentFormRecord & { organizationId: OrganizationId }

/**
 * The Contact Check log. It is large and only ever appended to or trimmed, so a transaction's
 * copy shares the big `base` map and keeps its own few `added` rows and `removed` keys; once those
 * pass {@link CHECK_LOG_FOLD} they are folded into a new base. Copying a transaction's state is
 * then O(recent changes), not O(log size).
 */
type CheckLog = {
  base: ReadonlyMap<string, StoredCheck>
  added: Map<string, StoredCheck>
  removed: Set<string>
}

const CHECK_LOG_FOLD = 1024

function copyCheckLog(log: CheckLog): CheckLog {
  if (log.added.size + log.removed.size < CHECK_LOG_FOLD) {
    return { base: log.base, added: new Map(log.added), removed: new Set(log.removed) }
  }
  const base = new Map(log.base)
  for (const key of log.removed) {
    base.delete(key)
  }
  for (const [key, row] of log.added) {
    base.set(key, row)
  }
  return { base, added: new Map(), removed: new Set() }
}

function* checkRows(log: CheckLog): Generator<[string, StoredCheck]> {
  for (const entry of log.base) {
    if (!log.removed.has(entry[0])) {
      yield entry
    }
  }
  yield* log.added
}

/**
 * What the in-memory store keeps for Suppression, the consent ledger's newest events and the
 * Contact Check log. Every collection is replaced, never changed in place, once a transaction has
 * taken its copy.
 */
export type ConsentLedgerState = {
  suppression: Map<SuppressionEntryId, StoredSuppression>
  /** `organization/kind/hash` to the live entry that holds the address. */
  liveSuppression: Map<string, SuppressionEntryId>
  /** `organization/prospect/channel` to the kind of the newest consent event. */
  latestConsent: Map<string, ConsentEventKind>
  /** The append-only ledger, oldest first (the sequence is the position). */
  consentEvents: (ConsentEvent & { organizationId: OrganizationId })[]
  /** `organization/wording` to the wording and the text shown. */
  wordings: Map<string, StoredWording>
  /** `organization/form` to the hosted form. */
  forms: Map<string, StoredForm>
  /** Event id to its ledger sequence and, for a hosted form, the submission details (never in a `ConsentEvent`). Only grows, so a sequence is never reused. */
  ledgerMeta: Map<string, { seq: number; ipAddress: string | null; userAgent: string | null }>
  checks: CheckLog
}

/** An empty {@link ConsentLedgerState}. */
export function emptyConsentLedgerState(): ConsentLedgerState {
  return {
    suppression: new Map(),
    liveSuppression: new Map(),
    latestConsent: new Map(),
    consentEvents: [],
    wordings: new Map(),
    forms: new Map(),
    ledgerMeta: new Map(),
    checks: { base: new Map(), added: new Map(), removed: new Set() },
  }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyConsentLedgerState(state: ConsentLedgerState): ConsentLedgerState {
  return {
    suppression: new Map(state.suppression),
    liveSuppression: new Map(state.liveSuppression),
    latestConsent: new Map(state.latestConsent),
    consentEvents: [...state.consentEvents],
    wordings: new Map(state.wordings),
    forms: new Map(state.forms),
    ledgerMeta: new Map(state.ledgerMeta),
    checks: copyCheckLog(state.checks),
  }
}

const hex = (hash: Uint8Array): string => Buffer.from(hash).toString('hex')
const liveKey = (organizationId: OrganizationId, kind: string, hash: string): string =>
  `${organizationId}\u0000${kind}\u0000${hash}`
const consentKey = (
  organizationId: OrganizationId,
  prospectId: ProspectId,
  channel: ConsentChannel
): string => `${organizationId}\u0000${prospectId}\u0000${channel}`

const publicEntry = ({
  organizationId: _organizationId,
  hash: _hash,
  ...record
}: StoredSuppression): SuppressionRecord => record

/** Whether `a` is strictly older than the position `b` in a newest-first list. */
const isAfter = (a: { at: number; id: string }, b: { at: number; id: string }): boolean =>
  a.at < b.at || (a.at === b.at && a.id < b.id)

/** Newest first: later time first, then greater id first. */
const newestFirst = (a: { at: number; id: string }, b: { at: number; id: string }): number =>
  isAfter(a, b) ? 1 : isAfter(b, a) ? -1 : 0

/** The Suppression, consent-read and Contact Check methods of an {@link OrganizationScope}. */
export type ConsentLedgerScope = Pick<
  OrganizationScope,
  | 'findLiveSuppression'
  | 'getSuppressionEntry'
  | 'insertSuppressionEntry'
  | 'removeSuppressionEntry'
  | 'listSuppressionEntries'
  | 'latestConsentKind'
  | 'getConsentWording'
  | 'findConsentWording'
  | 'insertConsentWording'
  | 'updateConsentWording'
  | 'listConsentWordings'
  | 'findConsentForm'
  | 'insertConsentForm'
  | 'listConsentForms'
  | 'publishConsentForm'
  | 'closeConsentForm'
  | 'appendConsentEvents'
  | 'latestConsentEvents'
  | 'listConsentEvents'
  | 'listConsentEvidence'
  | 'insertContactCheck'
  | 'listContactChecks'
  | 'purgeContactChecks'
>

/** What a method needs from the transaction it runs in. */
export type ConsentLedgerEnvironment = {
  organizationId: OrganizationId
  read: () => ConsentLedgerState
  write: () => ConsentLedgerState
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

/** Builds the Suppression and Contact Check methods of one transaction's scope. */
export function createConsentLedgerScope(env: ConsentLedgerEnvironment): ConsentLedgerScope {
  const { organizationId, read, write, requireLock } = env
  const wordingKey = (id: ConsentWordingId): string => `${organizationId}\u0000${id}`
  const formKey = (id: ConsentFormId): string => `${organizationId}\u0000${id}`
  const detailOf = (state: ConsentLedgerState, stored: StoredWording): ConsentWordingDetail => {
    const cited = state.consentEvents.some(
      (event) => event.organizationId === organizationId && event.wordingId === stored.id
    )
    const used = [...state.forms.values()].some(
      (form) =>
        form.organizationId === organizationId &&
        form.wordingId === stored.id &&
        form.state !== 'draft'
    )
    const superseded = [...state.wordings.entries()].some(
      ([key, other]) =>
        key.startsWith(`${organizationId}\u0000`) && other.supersedesId === stored.id
    )
    return {
      id: stored.id,
      version: stored.version,
      text: stored.text,
      channels: [...stored.channels],
      locked: cited || used,
      supersedesId: stored.supersedesId,
      superseded,
      createdAt: stored.createdAt,
      createdByUserId: stored.createdByUserId,
    }
  }
  const formIn = (id: ConsentFormId): StoredForm | undefined => {
    const stored = read().forms.get(formKey(id))
    return stored?.organizationId === organizationId ? stored : undefined
  }
  const publicForm = ({ organizationId: _owner, ...record }: StoredForm): ConsentFormRecord => ({
    ...record,
    channels: [...record.channels],
  })
  const entryIn = (id: SuppressionEntryId): StoredSuppression | undefined => {
    const stored = read().suppression.get(id)
    return stored?.organizationId === organizationId ? stored : undefined
  }

  return {
    findLiveSuppression: async (kind, hashes) => {
      const found: SuppressionRecord[] = []
      for (const hash of hashes) {
        const id = read().liveSuppression.get(liveKey(organizationId, kind, hex(hash)))
        const stored = id ? entryIn(id) : undefined
        if (stored) {
          found.push(publicEntry(stored))
        }
      }
      return found
    },

    getSuppressionEntry: async (id) => {
      const stored = entryIn(id)
      return stored ? publicEntry(stored) : null
    },

    insertSuppressionEntry: async (input) => {
      requireLock()
      const hash = hex(input.addressHash)
      if (input.addressHash.length !== 32) {
        throw new Error('core.suppression_entry_address_hash_length: a hash is 32 octets')
      }
      const at = liveKey(organizationId, input.addressKind, hash)
      const liveId = read().liveSuppression.get(at)
      const live = liveId ? entryIn(liveId) : undefined
      if (live) {
        return { entry: publicEntry(live), created: false }
      }
      const reason = input.reason
      const record: StoredSuppression = {
        id: input.id,
        addressKind: input.addressKind,
        maskedAddress: input.maskedAddress,
        reason,
        channel: input.channel,
        sourceRef: input.sourceRef,
        addedByUserId: input.addedByUserId,
        removable: reason === 'manual',
        createdAt: input.now,
        removedAt: null,
        removedByUserId: null,
        removalReason: null,
        organizationId,
        hash,
      }
      const state = write()
      state.suppression.set(record.id, record)
      state.liveSuppression.set(at, record.id)
      return { entry: publicEntry(record), created: true }
    },

    removeSuppressionEntry: async (id, input) => {
      requireLock()
      const stored = entryIn(id)
      if (!stored || stored.removedAt !== null || !stored.removable) {
        return null
      }
      const removed: StoredSuppression = {
        ...stored,
        removedAt: input.now,
        removedByUserId: input.userId,
        removalReason: input.reason,
      }
      const state = write()
      state.suppression.set(id, removed)
      state.liveSuppression.delete(liveKey(organizationId, stored.addressKind, stored.hash))
      return publicEntry(removed)
    },

    listSuppressionEntries: async (request) => {
      const keyed = [...read().suppression.values()]
        .filter(
          (stored) =>
            stored.organizationId === organizationId &&
            (request.state === 'active' ? stored.removedAt === null : stored.removedAt !== null) &&
            (request.reason === undefined || stored.reason === request.reason) &&
            (request.addressKind === undefined || stored.addressKind === request.addressKind)
        )
        .map((stored) => ({
          stored,
          key: {
            at: (request.state === 'active' ? stored.createdAt : stored.removedAt)?.getTime() ?? 0,
            id: stored.id as string,
          },
        }))
        .sort((a, b) => newestFirst(a.key, b.key))
      const after = request.after
        ? { at: request.after.at.getTime(), id: request.after.id as string }
        : undefined
      return keyed
        .filter((row) => !after || isAfter(row.key, after))
        .slice(0, request.limit)
        .map((row) => publicEntry(row.stored))
    },

    latestConsentKind: async (prospectId, channel) =>
      read().latestConsent.get(consentKey(organizationId, prospectId, channel)) ?? null,

    getConsentWording: async (id) => {
      const found = read().wordings.get(`${organizationId}\u0000${id}`)
      if (!found) {
        return null
      }
      return { id: found.id, version: found.version, channels: found.channels }
    },

    findConsentWording: async (id) => {
      const state = read()
      const found = state.wordings.get(wordingKey(id))
      return found ? detailOf(state, found) : null
    },

    insertConsentWording: async (input) => {
      requireLock()
      const state = write()
      if (
        input.supersedesId !== null &&
        [...state.wordings.values()].some((w) => w.supersedesId === input.supersedesId)
      ) {
        throw new ConsentWordingSupersededError()
      }
      const stored: StoredWording = {
        id: input.id,
        version: input.version,
        channels: [...input.channels],
        text: input.text,
        supersedesId: input.supersedesId,
        createdAt: input.now,
        createdByUserId: input.createdByUserId,
      }
      state.wordings = new Map(state.wordings).set(wordingKey(input.id), stored)
      return detailOf(state, stored)
    },

    updateConsentWording: async (id, patch) => {
      requireLock()
      const found = read().wordings.get(wordingKey(id))
      if (!found) {
        return null
      }
      if (detailOf(read(), found).locked) {
        throw new ConsentWordingLockedError()
      }
      const next: StoredWording = {
        ...found,
        text: patch.text ?? found.text,
        channels: patch.channels ? [...patch.channels] : found.channels,
      }
      const state = write()
      state.wordings = new Map(state.wordings).set(wordingKey(id), next)
      return detailOf(state, next)
    },

    listConsentWordings: async (request) => {
      const state = read()
      const after = request.after
        ? { at: request.after.at.getTime(), id: request.after.id as string }
        : undefined
      return [...state.wordings.entries()]
        .filter(([key]) => key.startsWith(`${organizationId}\u0000`))
        .map(([, stored]) => ({
          stored,
          key: { at: stored.createdAt.getTime(), id: stored.id as string },
        }))
        .sort((a, b) => newestFirst(a.key, b.key))
        .filter((row) => !after || isAfter(row.key, after))
        .slice(0, request.limit)
        .map((row) => detailOf(state, row.stored))
    },

    findConsentForm: async (id) => {
      const stored = formIn(id)
      return stored ? publicForm(stored) : null
    },

    insertConsentForm: async (input) => {
      requireLock()
      const stored: StoredForm = {
        id: input.id,
        organizationId,
        wordingId: input.wordingId,
        name: input.name,
        channels: [...input.channels],
        state: 'draft',
        token: null,
        createdAt: input.now,
        createdByUserId: input.createdByUserId,
        publishedAt: null,
        closedAt: null,
      }
      const state = write()
      state.forms = new Map(state.forms).set(formKey(input.id), stored)
      return publicForm(stored)
    },

    listConsentForms: async (request) => {
      const after = request.after
        ? { at: request.after.at.getTime(), id: request.after.id as string }
        : undefined
      return [...read().forms.values()]
        .filter(
          (form) =>
            form.organizationId === organizationId &&
            (request.state === undefined || form.state === request.state)
        )
        .map((form) => ({ form, key: { at: form.createdAt.getTime(), id: form.id as string } }))
        .sort((a, b) => newestFirst(a.key, b.key))
        .filter((row) => !after || isAfter(row.key, after))
        .slice(0, request.limit)
        .map((row) => publicForm(row.form))
    },

    publishConsentForm: async (id, input) => {
      requireLock()
      const stored = formIn(id)
      if (stored?.state !== 'draft') {
        return null
      }
      const next: StoredForm = {
        ...stored,
        state: 'published',
        token: input.token,
        publishedAt: input.now,
      }
      const state = write()
      state.forms = new Map(state.forms).set(formKey(id), next)
      return publicForm(next)
    },

    closeConsentForm: async (id, now) => {
      requireLock()
      const stored = formIn(id)
      if (stored?.state !== 'published') {
        return null
      }
      const next: StoredForm = { ...stored, state: 'closed', closedAt: now }
      const state = write()
      state.forms = new Map(state.forms).set(formKey(id), next)
      return publicForm(next)
    },

    appendConsentEvents: async (inputs) => {
      requireLock()
      const state = write()
      const stored: ConsentEvent[] = []
      for (const input of inputs) {
        if ((input.source === 'hosted_form') !== (input.ipAddress !== null)) {
          throw new Error('core.consent_event_evidence: ip_address is required for a hosted_form')
        }
        if ((input.source === 'hosted_form') !== (input.userAgent !== null)) {
          throw new Error('core.consent_event_evidence: user_agent is required for a hosted_form')
        }
        const event: ConsentEvent = {
          id: input.id,
          prospectId: input.prospectId,
          channel: input.channel,
          kind: input.kind,
          source: input.source,
          wordingId: input.wordingId,
          evidenceRef: input.evidenceRef,
          callId: input.callId,
          formId: input.formId,
          stopAll: input.stopAll,
          recordedByUserId: input.recordedByUserId,
          occurredAt: input.occurredAt.toISOString(),
          recordedAt: new Date().toISOString(),
        }
        state.consentEvents.push({ ...event, organizationId })
        state.ledgerMeta.set(event.id, {
          seq: state.ledgerMeta.size + 1,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        })
        state.latestConsent.set(
          consentKey(organizationId, input.prospectId, input.channel),
          input.kind
        )
        stored.push(event)
      }
      return stored
    },

    latestConsentEvents: async (prospectId) => {
      const newest = new Map<string, ConsentEvent>()
      for (const { organizationId: owner, ...event } of read().consentEvents) {
        if (owner === organizationId && event.prospectId === prospectId) {
          newest.set(event.channel, event)
        }
      }
      return [...newest.values()]
    },

    listConsentEvents: async (request) => consentPage(read(), organizationId, request),

    listConsentEvidence: async (request) =>
      consentPage(read(), organizationId, request).map((row) => {
        const state = read()
        const wording = row.event.wordingId
          ? state.wordings.get(`${organizationId}\u0000${row.event.wordingId}`)
          : undefined
        const meta = state.ledgerMeta.get(row.event.id)
        return {
          ...row,
          wording: wording
            ? { id: wording.id, version: wording.version, text: wording.text }
            : null,
          submission:
            meta?.ipAddress != null && meta.userAgent != null
              ? { ipAddress: meta.ipAddress, userAgent: meta.userAgent }
              : null,
        }
      }),

    insertContactCheck: async (input) => {
      const log = write().checks
      const key = `${organizationId}\u0000${input.id}`
      if (log.base.has(key)) {
        log.removed.add(key)
      }
      log.added.set(key, { ...input, organizationId })
    },

    listContactChecks: async (request) => {
      const keyed = [...checkRows(read().checks)]
        .map(([, row]) => row)
        .filter(
          (row) =>
            row.organizationId === organizationId &&
            (request.channel === undefined || row.channel === request.channel) &&
            (request.purpose === undefined || row.purpose === request.purpose) &&
            (request.allowed === undefined || row.allowed === request.allowed) &&
            (request.prospectId === undefined || row.prospectId === request.prospectId) &&
            (request.code === undefined || row.code === request.code)
        )
        .map((row) => ({ row, key: { at: row.checkedAt.getTime(), id: row.id as string } }))
        .sort((a, b) => newestFirst(a.key, b.key))
      const after = request.after
        ? { at: request.after.at.getTime(), id: request.after.id as string }
        : undefined
      return keyed
        .filter((entry) => !after || isAfter(entry.key, after))
        .slice(0, request.limit)
        .map(({ row: { organizationId: _organizationId, ...record } }) => record)
    },

    purgeContactChecks: async (before, limit) => {
      const old: [string, StoredCheck][] = []
      for (const entry of checkRows(read().checks)) {
        if (
          entry[1].organizationId === organizationId &&
          entry[1].checkedAt.getTime() < before.getTime()
        ) {
          old.push(entry)
        }
      }
      old.sort((a, b) => a[1].checkedAt.getTime() - b[1].checkedAt.getTime())
      old.length = Math.min(old.length, limit)
      const log = old.length > 0 ? write().checks : read().checks
      for (const [key] of old) {
        if (!log.added.delete(key)) {
          log.removed.add(key)
        }
      }
      return old.length
    },
  }
}

/** One page of a Prospect's events, newest sequence first, as the Postgres adapter reads them. */
function consentPage(
  state: ConsentLedgerState,
  organizationId: OrganizationId,
  request: ConsentEventPageRequest
): ConsentEventRow[] {
  return state.consentEvents
    .flatMap(({ organizationId: owner, ...event }) => {
      const seq = state.ledgerMeta.get(event.id)?.seq ?? 0
      return owner === organizationId &&
        event.prospectId === request.prospectId &&
        (request.channel === undefined || event.channel === request.channel) &&
        (request.after === undefined || seq < request.after.seq)
        ? [{ seq, event }]
        : []
    })
    .sort((a, b) => b.seq - a.seq)
    .slice(0, request.limit)
}

/** Records the newest consent event kind of a Prospect on a channel, as the ledger's writer would; for tests only. */
export function seedConsentEvent(
  state: ConsentLedgerState,
  organizationId: OrganizationId,
  prospectId: ProspectId,
  channel: ConsentChannel,
  kind: ConsentEventKind
): void {
  state.latestConsent.set(consentKey(organizationId, prospectId, channel), kind)
  const id = formatId('cev', crypto.randomUUID()) as ConsentEventId
  const at = new Date().toISOString()
  state.consentEvents.push({
    id,
    organizationId,
    prospectId,
    channel,
    kind,
    source: 'manual',
    wordingId: null,
    evidenceRef: null,
    callId: null,
    formId: null,
    stopAll: false,
    recordedByUserId: null,
    occurredAt: at,
    recordedAt: at,
  })
  state.ledgerMeta.set(id, { seq: state.ledgerMeta.size + 1, ipAddress: null, userAgent: null })
}

/** Stores a consent wording as the wording routes would; for tests only. */
export function seedConsentWording(
  state: ConsentLedgerState,
  organizationId: OrganizationId,
  wording: ConsentWordingRecord & { text?: string }
): void {
  state.wordings.set(`${organizationId}\u0000${wording.id as ConsentWordingId}`, {
    ...wording,
    text: wording.text ?? `Wording ${wording.id}`,
    supersedesId: null,
    createdAt: new Date(0),
    createdByUserId: userIdSchema.parse(INTERNAL_CALL_USER_ID),
  })
}

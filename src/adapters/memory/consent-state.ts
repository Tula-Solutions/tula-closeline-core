import type {
  ConsentChannel,
  OrganizationId,
  ProspectId,
  SuppressionEntryId,
} from 'tula-closeline-contract'
import type {
  ConsentEventKind,
  ContactCheckRecord,
  OrganizationScope,
  SuppressionRecord,
} from '~/ports/core-store'

/** A Suppression entry with the Organization it belongs to and the hex of its address hash. */
type StoredSuppression = SuppressionRecord & { organizationId: OrganizationId; hash: string }

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
  checks: Map<string, ContactCheckRecord & { organizationId: OrganizationId }>
}

/** An empty {@link ConsentLedgerState}. */
export function emptyConsentLedgerState(): ConsentLedgerState {
  return {
    suppression: new Map(),
    liveSuppression: new Map(),
    latestConsent: new Map(),
    checks: new Map(),
  }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyConsentLedgerState(state: ConsentLedgerState): ConsentLedgerState {
  return {
    suppression: new Map(state.suppression),
    liveSuppression: new Map(state.liveSuppression),
    latestConsent: new Map(state.latestConsent),
    checks: new Map(state.checks),
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

    insertContactCheck: async (input) => {
      write().checks.set(`${organizationId}\u0000${input.id}`, { ...input, organizationId })
    },

    listContactChecks: async (request) => {
      const keyed = [...read().checks.values()]
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
      const old = [...read().checks.entries()]
        .filter(
          ([, row]) =>
            row.organizationId === organizationId && row.checkedAt.getTime() < before.getTime()
        )
        .sort((a, b) => a[1].checkedAt.getTime() - b[1].checkedAt.getTime())
        .slice(0, limit)
      for (const [key] of old) {
        write().checks.delete(key)
      }
      return old.length
    },
  }
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
}

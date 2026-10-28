import type {
  MembershipId,
  OrganizationId,
  ProspectId,
  ProspectMergeId,
} from 'tula-closeline-contract'
import type { ProspectIdentityKind } from '~/ports/core-store'
import type {
  DuplicatePair,
  ProspectLinks,
  ProspectMergeRecord,
  ProspectMergeScope,
} from '~/ports/prospect-merge-store'
import type { BookingState } from './booking-state'
import type { InboxState } from './inbox-state'
import { type FieldRow, fieldKey, identityKey, type ProspectState, withKey } from './prospect-state'

/** What the in-memory store keeps for Prospect merges; the Map is replaced, never changed in place. */
export type ProspectMergeState = {
  prospectMerges: Map<ProspectMergeId, ProspectMergeRecord & { organizationId: OrganizationId }>
}

/** An empty {@link ProspectMergeState}. */
export function emptyProspectMergeState(): ProspectMergeState {
  return { prospectMerges: new Map() }
}

/** Copies the Map shell of a {@link ProspectMergeState}. */
export function copyProspectMergeState(state: ProspectMergeState): ProspectMergeState {
  return { prospectMerges: new Map(state.prospectMerges) }
}

/** The address kind a Prospect field is matched on, if it is one. */
const KIND_OF_FIELD: Readonly<Record<string, ProspectIdentityKind | undefined>> = {
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin',
}

/** The slice of the whole state a merge method reads and writes. */
type MergeStateView = ProspectState &
  BookingState &
  InboxState &
  ProspectMergeState & {
    memberships: Map<MembershipId, { organizationId: OrganizationId }>
  }

/** What a merge method needs from the transaction it runs in. */
export type ProspectMergeEnvironment = {
  organizationId: OrganizationId
  read: () => MergeStateView
  write: () => MergeStateView
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

const copyMerge = (stored: ProspectMergeRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return {
    ...record,
    mergedProspectIds: [...record.mergedProspectIds],
    fieldChoices: { ...record.fieldChoices },
  } satisfies ProspectMergeRecord
}

/** Builds the merge, duplicate and undo methods of one transaction's scope. */
export function createProspectMergeScope(env: ProspectMergeEnvironment): ProspectMergeScope {
  const { organizationId, read, write, requireLock } = env
  const mergeIn = (id: ProspectMergeId) => {
    const stored = read().prospectMerges.get(id)
    return stored?.organizationId === organizationId ? stored : undefined
  }
  const owns = (id: ProspectId) => read().prospects.get(id)?.organizationId === organizationId

  return {
    listProspectDuplicates: async ({ prospectId, after, limit }) => {
      const state = read()
      const pairs = new Map<string, DuplicatePair>()
      for (const [key, rows] of state.fields) {
        const owner = key.slice('prospect\u0000'.length) as ProspectId
        if (!key.startsWith('prospect\u0000') || !owns(owner)) {
          continue
        }
        for (const row of rows) {
          const kind = KIND_OF_FIELD[row.field]
          if (row.state === 'current' || !kind) {
            continue
          }
          const holder = state.identities.get(identityKey(organizationId, kind, row.value))
          if (!holder || holder === owner) {
            continue
          }
          const [first, second] = holder < owner ? [holder, owner] : [owner, holder]
          if (prospectId && first !== prospectId && second !== prospectId) {
            continue
          }
          const pair = pairs.get(`${first}\u0000${second}`) ?? { first, second, matchedOn: [] }
          if (!pair.matchedOn.includes(kind)) {
            pair.matchedOn = [...pair.matchedOn, kind].sort()
          }
          pairs.set(`${first}\u0000${second}`, pair)
        }
      }
      return [...pairs.values()]
        .filter(
          (pair) =>
            !after ||
            pair.first > after.first ||
            (pair.first === after.first && pair.second > after.second)
        )
        .sort((a, b) =>
          a.first === b.first ? (a.second < b.second ? -1 : 1) : a.first < b.first ? -1 : 1
        )
        .slice(0, limit)
    },

    listProspectFieldHistory: async (prospectId) => {
      if (!owns(prospectId)) {
        return []
      }
      return (read().fields.get(fieldKey('prospect', prospectId)) ?? []).map(
        ({ seq: _seq, ...row }) => ({ ...row })
      )
    },

    replaceProspectFields: async (prospectId, rows) => {
      requireLock()
      const state = write()
      state.fields.set(
        fieldKey('prospect', prospectId),
        rows.map((row): FieldRow => {
          state.fieldSeq += 1
          return { ...row, seq: state.fieldSeq }
        })
      )
    },

    restoreProspect: async (record) => {
      requireLock()
      const state = write()
      const owner =
        record.ownerMembershipId &&
        state.memberships.get(record.ownerMembershipId)?.organizationId === organizationId
          ? record.ownerMembershipId
          : null
      const company =
        record.companyId && state.companies.get(record.companyId)?.organizationId === organizationId
          ? record.companyId
          : null
      state.prospects.set(record.id, {
        ...record,
        tags: [...record.tags],
        ownerMembershipId: owner,
        companyId: company,
        organizationId,
      })
      state.prospectOrder.set(
        organizationId,
        withKey(state.prospectOrder.get(organizationId) ?? [], {
          at: record.createdAt.getTime(),
          id: record.id,
        })
      )
    },

    moveProspectLinks: async (from, to) => {
      requireLock()
      const state = write()
      const links: ProspectLinks = { bookingIds: [], conversationIds: [] }
      for (const [key, booking] of state.bookings) {
        if (booking.organizationId === organizationId && booking.prospectId === from) {
          state.bookings.set(key, { ...booking, prospectId: to })
          links.bookingIds.push(booking.id)
        }
      }
      for (const [key, conversation] of state.conversations) {
        if (conversation.organizationId === organizationId && conversation.prospectId === from) {
          state.conversations.set(key, { ...conversation, prospectId: to })
          links.conversationIds.push(conversation.id)
        }
      }
      return links
    },

    restoreProspectLinks: async (prospectId, links) => {
      requireLock()
      const state = write()
      for (const [key, booking] of state.bookings) {
        if (booking.organizationId === organizationId && links.bookingIds.includes(booking.id)) {
          state.bookings.set(key, { ...booking, prospectId })
        }
      }
      for (const [key, conversation] of state.conversations) {
        if (
          conversation.organizationId === organizationId &&
          links.conversationIds.includes(conversation.id)
        ) {
          state.conversations.set(key, { ...conversation, prospectId })
        }
      }
    },

    insertProspectMerge: async (record) => {
      requireLock()
      write().prospectMerges.set(record.id, {
        ...copyMerge({ ...record, organizationId }),
        organizationId,
      })
    },

    getProspectMerge: async (id) => {
      const stored = mergeIn(id)
      return stored ? copyMerge(stored) : null
    },
    lockProspectMerge: async (id) => {
      requireLock()
      const stored = mergeIn(id)
      return stored ? copyMerge(stored) : null
    },

    updateProspectMerge: async (id, patch) => {
      requireLock()
      const stored = mergeIn(id)
      if (!stored) {
        return null
      }
      const next = { ...stored, ...patch }
      write().prospectMerges.set(id, next)
      return copyMerge(next)
    },

    findActiveMerge: async (prospectIds) => {
      for (const stored of read().prospectMerges.values()) {
        if (
          stored.organizationId === organizationId &&
          stored.state === 'merged' &&
          stored.mergedProspectIds.some((id) => prospectIds.includes(id))
        ) {
          return copyMerge(stored)
        }
      }
      return null
    },
  }
}

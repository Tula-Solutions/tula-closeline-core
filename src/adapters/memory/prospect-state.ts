import type {
  MembershipId,
  OrganizationId,
  ProspectCompanyId,
  ProspectId,
} from 'tula-closeline-contract'
import {
  CompanyDomainTakenError,
  type FieldChange,
  type FieldOwnerKind,
  type FieldRecord,
  MissingReferenceError,
  type NewProspect,
  type NewProspectCompany,
  type OrganizationScope,
  type ProspectCompanyPageRequest,
  type ProspectCompanyPatch,
  type ProspectCompanyRecord,
  type ProspectIdentityKind,
  ProspectIdentityTakenError,
  type ProspectPageRequest,
  type ProspectPatch,
  type ProspectRecord,
  type ProspectVisibility,
  REASSIGN_MAX_IDS,
} from '~/ports/core-store'

/** A position in a newest-first list: creation time in milliseconds, then id. */
type OrderKey = { at: number; id: string }

/** A field row as kept in history: the current value, an older one or a suggestion. */
type FieldRow = FieldRecord & { seq: number; state: 'current' | 'superseded' | 'suggested' }

/** The most entries one field's history may hold, as the database's trigger enforces. */
const FIELD_HISTORY_LIMIT = 50

/**
 * What the in-memory store keeps for Prospects and Prospect Companies. Every collection is
 * replaced, never changed in place, once a transaction has taken its copy, so copying the state
 * for a write is a copy of the Map shells and not of the rows.
 */
export type ProspectState = {
  prospects: Map<ProspectId, ProspectRecord & { organizationId: OrganizationId }>
  /** Per Organization, the Prospect ids newest first (creation time, then id, both descending). */
  prospectOrder: Map<OrganizationId, readonly OrderKey[]>
  /** `organization/kind/value` to the Prospect that holds the identity. */
  identities: Map<string, ProspectId>
  /** `organization/prospect/kind` to the identity value, the reverse of {@link identities}. */
  identityOf: Map<string, string>
  companies: Map<ProspectCompanyId, ProspectCompanyRecord & { organizationId: OrganizationId }>
  companyOrder: Map<OrganizationId, readonly OrderKey[]>
  /** `organization/domain` to the company that has it. */
  companyDomains: Map<string, ProspectCompanyId>
  /** `kind/owner` to the field history of that Prospect or Prospect Company. */
  fields: Map<string, readonly FieldRow[]>
  fieldSeq: number
}

/** The slice of the whole state a Prospect method reads: Membership and Team places decide visibility. */
export type ProspectStateView = ProspectState & {
  memberships: Map<MembershipId, { organizationId: OrganizationId; role: string }>
  teamMembers: Map<
    string,
    { organizationId: OrganizationId; teamId: string; membershipId: MembershipId }
  >
}

/** An empty {@link ProspectState}. */
export function emptyProspectState(): ProspectState {
  return {
    prospects: new Map(),
    prospectOrder: new Map(),
    identities: new Map(),
    identityOf: new Map(),
    companies: new Map(),
    companyOrder: new Map(),
    companyDomains: new Map(),
    fields: new Map(),
    fieldSeq: 0,
  }
}

/** Copies the Map shells of a {@link ProspectState}; rows and arrays are shared because they are never changed in place. */
export function copyProspectState(state: ProspectState): ProspectState {
  return {
    prospects: new Map(state.prospects),
    prospectOrder: new Map(state.prospectOrder),
    identities: new Map(state.identities),
    identityOf: new Map(state.identityOf),
    companies: new Map(state.companies),
    companyOrder: new Map(state.companyOrder),
    companyDomains: new Map(state.companyDomains),
    fields: new Map(state.fields),
    fieldSeq: state.fieldSeq,
  }
}

/** Whether `a` comes after `b` in a newest-first list. */
const comesAfter = (a: OrderKey, b: OrderKey): boolean =>
  a.at < b.at || (a.at === b.at && a.id < b.id)

/** The index of the first key that comes strictly after `position` in a newest-first list. */
function firstAfter(order: readonly OrderKey[], position: OrderKey): number {
  let low = 0
  let high = order.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const key = order[middle]
    if (key && comesAfter(key, position)) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

/** A new list with `key` in its place. */
function withKey(order: readonly OrderKey[], key: OrderKey): readonly OrderKey[] {
  // The index after every key that is not after `key`, that is, where it sorts.
  let low = 0
  let high = order.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const other = order[middle]
    if (other && comesAfter(key, other)) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return [...order.slice(0, low), key, ...order.slice(low)]
}

const identityKey = (organizationId: OrganizationId, kind: string, value: string): string =>
  `${organizationId}\u0000${kind}\u0000${value}`
const reverseKey = (organizationId: OrganizationId, prospectId: string, kind: string): string =>
  `${organizationId}\u0000${prospectId}\u0000${kind}`
const fieldKey = (kind: FieldOwnerKind, ownerId: string): string => `${kind}\u0000${ownerId}`
const domainKey = (organizationId: OrganizationId, domain: string): string =>
  `${organizationId}\u0000${domain}`

const copyProspect = (stored: ProspectRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return { ...record, tags: [...record.tags] } satisfies ProspectRecord
}

const copyCompany = (stored: ProspectCompanyRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return { ...record } satisfies ProspectCompanyRecord
}

/** The Membership ids a Manager sees besides their own: the Reps who share a Team with them. */
function teamReps(
  view: ProspectStateView,
  organizationId: OrganizationId,
  manager: MembershipId
): Set<MembershipId> {
  const teams = new Set<string>()
  for (const place of view.teamMembers.values()) {
    if (place.organizationId === organizationId && place.membershipId === manager) {
      teams.add(place.teamId)
    }
  }
  const reps = new Set<MembershipId>()
  for (const place of view.teamMembers.values()) {
    if (
      place.organizationId === organizationId &&
      teams.has(place.teamId) &&
      view.memberships.get(place.membershipId)?.role === 'rep'
    ) {
      reps.add(place.membershipId)
    }
  }
  return reps
}

/** A predicate for the owner ids a visibility allows. */
function mayOwn(
  view: ProspectStateView,
  organizationId: OrganizationId,
  visibility: ProspectVisibility
): (owner: MembershipId | null) => boolean {
  switch (visibility.kind) {
    case 'all':
      return () => true
    case 'owner':
      return (owner) => owner === visibility.membershipId
    case 'team': {
      const reps = teamReps(view, organizationId, visibility.managerMembershipId)
      return (owner) =>
        owner !== null && (owner === visibility.managerMembershipId || reps.has(owner))
    }
  }
}

/** The current rows of one owner's history. */
const currentRows = (view: ProspectState, kind: FieldOwnerKind, ownerId: string) =>
  (view.fields.get(fieldKey(kind, ownerId)) ?? []).filter((row) => row.state === 'current')

const toRecord = ({ seq: _seq, state: _state, ...record }: FieldRow): FieldRecord => record

/** The Prospect methods of an {@link OrganizationScope}, over the in-memory state. */
export type ProspectScope = Pick<
  OrganizationScope,
  | 'insertProspect'
  | 'getProspect'
  | 'lockProspect'
  | 'updateProspect'
  | 'reassignProspects'
  | 'listProspects'
  | 'getProspectCompany'
  | 'lockProspectCompany'
  | 'insertProspectCompany'
  | 'updateProspectCompany'
  | 'listProspectCompanies'
  | 'getProspectCompanies'
  | 'listCurrentFields'
  | 'applyFieldChanges'
  | 'findProspectByIdentity'
  | 'setProspectIdentity'
>

/** What a Prospect method needs from the transaction it runs in. */
export type ProspectEnvironment = {
  organizationId: OrganizationId
  read: () => ProspectStateView
  write: () => ProspectStateView
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

/** Builds the Prospect and Prospect Company methods of one transaction's scope. */
export function createProspectScope(env: ProspectEnvironment): ProspectScope {
  const { organizationId, read, write, requireLock } = env

  const prospectIn = (id: ProspectId) => {
    const stored = read().prospects.get(id)
    return stored?.organizationId === organizationId ? stored : undefined
  }
  const companyIn = (id: ProspectCompanyId) => {
    const stored = read().companies.get(id)
    return stored?.organizationId === organizationId ? stored : undefined
  }
  const visibleProspect = (id: ProspectId, visibility: ProspectVisibility) => {
    const stored = prospectIn(id)
    return stored && mayOwn(read(), organizationId, visibility)(stored.ownerMembershipId)
      ? stored
      : undefined
  }
  const requireMembership = (id: MembershipId | null | undefined): void => {
    if (id && read().memberships.get(id)?.organizationId !== organizationId) {
      throw new MissingReferenceError('The owner')
    }
  }
  const requireCompany = (id: ProspectCompanyId | null | undefined): void => {
    if (id && !companyIn(id)) {
      throw new MissingReferenceError('The Prospect Company')
    }
  }
  const companyName = (id: ProspectCompanyId | null): string => {
    const company = id ? companyIn(id) : undefined
    return company ? company.name.toLowerCase() : ''
  }
  const fieldText = (id: ProspectId): string[] =>
    currentRows(read(), 'prospect', id)
      .filter((row) => ['firstName', 'lastName', 'email'].includes(row.field))
      .map((row) => row.value.toLowerCase())

  return {
    insertProspect: async (input: NewProspect) => {
      requireLock()
      requireCompany(input.companyId)
      requireMembership(input.ownerMembershipId)
      const record: ProspectRecord = {
        id: input.id,
        companyId: input.companyId,
        ownerMembershipId: input.ownerMembershipId,
        status: 'active',
        source: input.source,
        tags: [...input.tags],
        notes: input.notes,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const state = write()
      state.prospects.set(input.id, { ...record, organizationId })
      state.prospectOrder.set(
        organizationId,
        withKey(state.prospectOrder.get(organizationId) ?? [], {
          at: input.now.getTime(),
          id: input.id,
        })
      )
      return copyProspect({ ...record, organizationId })
    },

    getProspect: async (id, visibility) => {
      const stored = visibleProspect(id, visibility)
      return stored ? copyProspect(stored) : null
    },

    lockProspect: async (id, visibility) => {
      requireLock()
      const stored = visibleProspect(id, visibility)
      return stored ? copyProspect(stored) : null
    },

    updateProspect: async (id, patch: ProspectPatch, now) => {
      requireLock()
      const stored = prospectIn(id)
      if (!stored) {
        return null
      }
      if (patch.companyId !== undefined) {
        requireCompany(patch.companyId)
      }
      if (patch.ownerMembershipId !== undefined) {
        requireMembership(patch.ownerMembershipId)
      }
      const next = {
        ...stored,
        ...(patch.companyId === undefined ? {} : { companyId: patch.companyId }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.tags === undefined ? {} : { tags: [...patch.tags] }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        ...(patch.ownerMembershipId === undefined
          ? {}
          : { ownerMembershipId: patch.ownerMembershipId }),
        updatedAt: now,
      }
      write().prospects.set(id, next)
      return copyProspect(next)
    },

    reassignProspects: async (ids, owner, now) => {
      requireLock()
      if (ids.length > REASSIGN_MAX_IDS) {
        throw new RangeError('Too many Prospects to reassign in one call')
      }
      requireMembership(owner)
      let found = 0
      const changed: ProspectId[] = []
      for (const id of new Set(ids)) {
        const stored = prospectIn(id)
        if (!stored) {
          continue
        }
        found += 1
        if (stored.ownerMembershipId !== owner) {
          write().prospects.set(id, { ...stored, ownerMembershipId: owner, updatedAt: now })
          changed.push(id)
        }
      }
      return { found, changed }
    },

    listProspects: async (request: ProspectPageRequest) => {
      const view = read()
      const order = view.prospectOrder.get(organizationId) ?? []
      const allowed = mayOwn(view, organizationId, request.visibility)
      const needle = request.q?.toLowerCase()
      const start = request.after
        ? firstAfter(order, { at: request.after.createdAt.getTime(), id: request.after.id })
        : 0
      const page: ProspectRecord[] = []
      for (let index = start; index < order.length && page.length < request.limit; index++) {
        const key = order[index]
        const stored = key ? view.prospects.get(key.id as ProspectId) : undefined
        if (
          !stored ||
          !allowed(stored.ownerMembershipId) ||
          (request.ownerMembershipId !== undefined &&
            stored.ownerMembershipId !== request.ownerMembershipId) ||
          (request.source !== undefined && stored.source !== request.source) ||
          (request.companyId !== undefined && stored.companyId !== request.companyId) ||
          (request.status !== undefined && stored.status !== request.status)
        ) {
          continue
        }
        if (
          needle !== undefined &&
          !companyName(stored.companyId).includes(needle) &&
          !fieldText(stored.id).some((text) => text.includes(needle))
        ) {
          continue
        }
        page.push(copyProspect(stored))
      }
      return page
    },

    getProspectCompany: async (id) => {
      const stored = companyIn(id)
      return stored ? copyCompany(stored) : null
    },

    lockProspectCompany: async (id) => {
      requireLock()
      const stored = companyIn(id)
      return stored ? copyCompany(stored) : null
    },

    insertProspectCompany: async (input: NewProspectCompany) => {
      requireLock()
      if (
        input.domain !== null &&
        read().companyDomains.has(domainKey(organizationId, input.domain))
      ) {
        throw new CompanyDomainTakenError()
      }
      const record: ProspectCompanyRecord = {
        id: input.id,
        name: input.name,
        domain: input.domain,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const state = write()
      state.companies.set(input.id, { ...record, organizationId })
      state.companyOrder.set(
        organizationId,
        withKey(state.companyOrder.get(organizationId) ?? [], {
          at: input.now.getTime(),
          id: input.id,
        })
      )
      if (input.domain !== null) {
        state.companyDomains.set(domainKey(organizationId, input.domain), input.id)
      }
      return { ...record }
    },

    updateProspectCompany: async (id, patch: ProspectCompanyPatch, now) => {
      requireLock()
      const stored = companyIn(id)
      if (!stored) {
        return null
      }
      const domain = patch.domain === undefined ? stored.domain : patch.domain
      if (domain !== null && domain !== stored.domain) {
        const holder = read().companyDomains.get(domainKey(organizationId, domain))
        if (holder && holder !== id) {
          throw new CompanyDomainTakenError()
        }
      }
      const state = write()
      if (stored.domain !== null && stored.domain !== domain) {
        state.companyDomains.delete(domainKey(organizationId, stored.domain))
      }
      if (domain !== null) {
        state.companyDomains.set(domainKey(organizationId, domain), id)
      }
      const next = { ...stored, name: patch.name ?? stored.name, domain, updatedAt: now }
      state.companies.set(id, next)
      return copyCompany(next)
    },

    listProspectCompanies: async (request: ProspectCompanyPageRequest) => {
      const view = read()
      const order = view.companyOrder.get(organizationId) ?? []
      const needle = request.q?.toLowerCase()
      const start = request.after
        ? firstAfter(order, { at: request.after.createdAt.getTime(), id: request.after.id })
        : 0
      const page: ProspectCompanyRecord[] = []
      for (let index = start; index < order.length && page.length < request.limit; index++) {
        const key = order[index]
        const stored = key ? view.companies.get(key.id as ProspectCompanyId) : undefined
        if (!stored) {
          continue
        }
        if (
          needle !== undefined &&
          !stored.name.toLowerCase().includes(needle) &&
          !(stored.domain ?? '').includes(needle)
        ) {
          continue
        }
        page.push(copyCompany(stored))
      }
      return page
    },

    getProspectCompanies: async (ids) =>
      ids.flatMap((id) => {
        const stored = companyIn(id)
        return stored ? [copyCompany(stored)] : []
      }),

    listCurrentFields: async (kind, ids) => {
      const found = new Map<string, FieldRecord[]>()
      for (const id of ids) {
        const owned =
          kind === 'prospect' ? prospectIn(id as ProspectId) : companyIn(id as ProspectCompanyId)
        const rows = owned ? currentRows(read(), kind, id) : []
        if (rows.length > 0) {
          found.set(id, rows.map(toRecord))
        }
      }
      return found
    },

    applyFieldChanges: async (kind, ownerId, changes: FieldChange[]) => {
      requireLock()
      const owned =
        kind === 'prospect'
          ? prospectIn(ownerId as ProspectId)
          : companyIn(ownerId as ProspectCompanyId)
      if (!owned) {
        throw new MissingReferenceError(
          kind === 'prospect' ? 'The Prospect' : 'The Prospect Company'
        )
      }
      const state = write()
      let rows = [...(state.fields.get(fieldKey(kind, ownerId)) ?? [])]
      const ordered = [...changes].sort((a, b) =>
        a.field < b.field ? -1 : a.field > b.field ? 1 : 0
      )
      for (const change of ordered) {
        if (change.action !== 'record') {
          rows = rows.map((row) =>
            row.field === change.field && row.state === 'current'
              ? { ...row, state: 'superseded' as const }
              : row
          )
        }
        if (change.action === 'clear') {
          continue
        }
        // Keep room for the new entry: drop the oldest entries that are not current.
        const ofField = rows.filter((row) => row.field === change.field)
        const surplus = ofField.length - (FIELD_HISTORY_LIMIT - 1)
        if (surplus > 0) {
          const doomed = new Set(
            ofField
              .filter((row) => row.state !== 'current')
              .sort((a, b) => a.seq - b.seq)
              .slice(0, surplus)
              .map((row) => row.seq)
          )
          rows = rows.filter((row) => !doomed.has(row.seq))
        }
        state.fieldSeq += 1
        rows.push({
          seq: state.fieldSeq,
          field: change.field,
          state: change.action === 'set' ? 'current' : change.state,
          value: change.value,
          source: change.source,
          sourceRef: change.sourceRef,
          setAt: change.at,
          setByUserId: change.setByUserId,
        })
      }
      state.fields.set(fieldKey(kind, ownerId), rows)
    },

    findProspectByIdentity: async (kind: ProspectIdentityKind, value) =>
      read().identities.get(identityKey(organizationId, kind, value)) ?? null,

    setProspectIdentity: async (prospectId, kind, value) => {
      requireLock()
      if (!prospectIn(prospectId)) {
        throw new MissingReferenceError('The Prospect')
      }
      if (value !== null) {
        const holder = read().identities.get(identityKey(organizationId, kind, value))
        if (holder && holder !== prospectId) {
          throw new ProspectIdentityTakenError(kind, holder)
        }
      }
      const state = write()
      const previous = state.identityOf.get(reverseKey(organizationId, prospectId, kind))
      if (previous !== undefined) {
        state.identities.delete(identityKey(organizationId, kind, previous))
        state.identityOf.delete(reverseKey(organizationId, prospectId, kind))
      }
      if (value !== null) {
        state.identities.set(identityKey(organizationId, kind, value), prospectId)
        state.identityOf.set(reverseKey(organizationId, prospectId, kind), value)
      }
    },
  }
}

/** A Prospect planted directly in the state for a benchmark: the row, its current fields and its identities. */
export type SeededProspect = { record: ProspectRecord; fields: FieldRecord[] }

/** Plants many Prospects in the live state at once, bypassing the transaction path; for tests and benchmarks only. */
export function seedProspectState(
  state: ProspectState,
  organizationId: OrganizationId,
  seeds: readonly SeededProspect[]
): void {
  const keys: OrderKey[] = [...(state.prospectOrder.get(organizationId) ?? [])]
  const identityKinds: Record<string, ProspectIdentityKind> = {
    email: 'email',
    phone: 'phone',
    linkedinUrl: 'linkedin',
  }
  for (const { record, fields } of seeds) {
    state.prospects.set(record.id, { ...record, organizationId })
    keys.push({ at: record.createdAt.getTime(), id: record.id })
    state.fields.set(
      fieldKey('prospect', record.id),
      fields.map((field) => {
        state.fieldSeq += 1
        return { ...field, seq: state.fieldSeq, state: 'current' as const }
      })
    )
    for (const field of fields) {
      const kind = identityKinds[field.field]
      if (kind) {
        state.identities.set(identityKey(organizationId, kind, field.value), record.id)
        state.identityOf.set(reverseKey(organizationId, record.id, kind), field.value)
      }
    }
  }
  keys.sort((a, b) => (comesAfter(a, b) ? 1 : comesAfter(b, a) ? -1 : 0))
  state.prospectOrder.set(organizationId, keys)
}

/** Clears the owner of every Prospect a removed Membership owned, as the database's `ON DELETE SET NULL` does. */
export function releaseOwnedProspects(
  state: ProspectState,
  organizationId: OrganizationId,
  membershipId: MembershipId
): void {
  if (state.prospects.size === 0) {
    return
  }
  for (const [id, stored] of state.prospects) {
    if (stored.organizationId === organizationId && stored.ownerMembershipId === membershipId) {
      state.prospects.set(id, { ...stored, ownerMembershipId: null })
    }
  }
}

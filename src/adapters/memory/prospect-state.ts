import type {
  MembershipId,
  OrganizationId,
  ProspectCompanyId,
  ProspectId,
  ProspectImportId,
} from 'tula-closeline-contract'
import {
  CompanyDomainTakenError,
  type FieldChange,
  type FieldOwnerKind,
  type FieldRecord,
  MissingReferenceError,
  type NewProspect,
  type NewProspectCompany,
  type NewProspectImport,
  type OrganizationScope,
  type ProspectCompanyPageRequest,
  type ProspectCompanyPatch,
  type ProspectCompanyRecord,
  type ProspectIdentityKind,
  ProspectIdentityTakenError,
  type ProspectImportRecord,
  type ProspectImportRowRecord,
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
  prospectImports: Map<ProspectImportId, ProspectImportRecord & { organizationId: OrganizationId }>
  /** Per Organization, the import ids newest first (creation time, then id, both descending). */
  importOrder: Map<OrganizationId, readonly OrderKey[]>
  /** `organization/import` to the rows of that import, ordered by row number. */
  importRows: Map<string, readonly ProspectImportRowRecord[]>
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
    prospectImports: new Map(),
    importOrder: new Map(),
    importRows: new Map(),
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
    prospectImports: new Map(state.prospectImports),
    importOrder: new Map(state.importOrder),
    importRows: new Map(state.importRows),
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

/** The keys in id order, which is how a `q` list is paged (as the database's search function returns it). */
const byId = (order: readonly OrderKey[]): OrderKey[] =>
  [...order].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The index where a page starts: after the cursor's id for a `q` list, else in the newest-first order. */
function pageStart(
  keys: readonly OrderKey[],
  byIdOrder: boolean,
  after: { createdAt: Date; id: string } | undefined
): number {
  if (!after) {
    return 0
  }
  if (!byIdOrder) {
    return firstAfter(keys, { at: after.createdAt.getTime(), id: after.id })
  }
  const index = keys.findIndex((key) => key.id > after.id)
  return index < 0 ? keys.length : index
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
const ADDRESS_KINDS: readonly ProspectIdentityKind[] = ['email', 'phone', 'linkedin']
const ADDRESS_KIND_OF_FIELD: Readonly<Record<string, ProspectIdentityKind | undefined>> = {
  email: 'email',
  phone: 'phone',
  linkedinUrl: 'linkedin',
}
const fieldKey = (kind: FieldOwnerKind, ownerId: string): string => `${kind}\u0000${ownerId}`
const domainKey = (organizationId: OrganizationId, domain: string): string =>
  `${organizationId}\u0000${domain}`

const importRowsKey = (organizationId: OrganizationId, importId: string): string =>
  `${organizationId}\u0000${importId}`
const copyImport = (stored: ProspectImportRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return { ...record, contentHash: new Uint8Array(record.contentHash) }
}

const copyProspect = (stored: ProspectRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return { ...record, tags: [...record.tags] } satisfies ProspectRecord
}

const copyCompany = (stored: ProspectCompanyRecord & { organizationId: OrganizationId }) => {
  const { organizationId: _organization, ...record } = stored
  return {
    ...record,
    technologies: record.technologies ? [...record.technologies] : null,
  } satisfies ProspectCompanyRecord
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
export function mayOwn(
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

/** The most ids a search function returns in one call, and the most windows one page reads (as in the Postgres store). */
const SEARCH_WINDOW = 101
const SEARCH_WINDOWS = 5

/** The Prospect methods of an {@link OrganizationScope}, over the in-memory state. */
export type ProspectScope = Pick<
  OrganizationScope,
  | 'insertProspect'
  | 'getProspect'
  | 'lockProspect'
  | 'updateProspect'
  | 'reassignProspects'
  | 'listProspects'
  | 'searchProspects'
  | 'getProspectCompany'
  | 'lockProspectCompany'
  | 'insertProspectCompany'
  | 'updateProspectCompany'
  | 'listProspectCompanies'
  | 'getProspectCompanies'
  | 'listCurrentFields'
  | 'applyFieldChanges'
  | 'findProspectByIdentity'
  | 'getProspectIdentity'
  | 'listProspectAddresses'
  | 'eraseProspectFields'
  | 'setProspectIdentity'
  | 'insertProspectImport'
  | 'getProspectImport'
  | 'lockProspectImport'
  | 'listProspectImports'
  | 'updateProspectImport'
  | 'deleteProspectImport'
  | 'insertProspectImportRows'
  | 'listProspectImportRows'
  | 'countProspectImportRows'
  | 'findProspectCompany'
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
  const importIn = (id: ProspectImportId) => {
    const stored = read().prospectImports.get(id)
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
  const companyText = (id: ProspectCompanyId | null): string[] => {
    const company = id ? companyIn(id) : undefined
    return company ? [company.name.toLowerCase(), (company.domain ?? '').toLowerCase()] : []
  }
  const fieldText = (id: ProspectId): string[] =>
    currentRows(read(), 'prospect', id).map((row) => row.value.toLowerCase())
  const passesFilters = (
    stored: ProspectRecord,
    request: ProspectPageRequest,
    allowed: (owner: MembershipId | null) => boolean
  ): boolean =>
    allowed(stored.ownerMembershipId) &&
    (request.ownerMembershipId === undefined ||
      stored.ownerMembershipId === request.ownerMembershipId) &&
    (request.source === undefined || stored.source === request.source) &&
    (request.companyId === undefined || stored.companyId === request.companyId) &&
    (request.status === undefined || stored.status === request.status)

  /** Mirrors the Postgres store: windows of 101 matches in id order, at most five a call. */
  const searchProspects: ProspectScope['searchProspects'] = async (request) => {
    const view = read()
    const needle = request.q.toLowerCase()
    const allowed = mayOwn(view, organizationId, request.visibility)
    const after = request.after?.id ?? ''
    const matches = byId(view.prospectOrder.get(organizationId) ?? [])
      .filter((key) => key.id > after)
      .filter((key) => {
        const stored = view.prospects.get(key.id as ProspectId)
        return (
          stored !== undefined &&
          (companyText(stored.companyId).some((text) => text.includes(needle)) ||
            fieldText(stored.id).some((text) => text.includes(needle)))
        )
      })
    const rows: ProspectRecord[] = []
    let resumeAfter: ProspectId | null = null
    for (let window = 0; window < SEARCH_WINDOWS && rows.length < request.limit; window++) {
      const ids = matches.slice(window * SEARCH_WINDOW, (window + 1) * SEARCH_WINDOW)
      const lastKey = ids.at(-1)
      if (!lastKey) {
        resumeAfter = null
        break
      }
      for (const key of ids) {
        const stored = view.prospects.get(key.id as ProspectId)
        if (rows.length < request.limit && stored && passesFilters(stored, request, allowed)) {
          rows.push(copyProspect(stored))
        }
      }
      if (ids.length < SEARCH_WINDOW) {
        resumeAfter = null
        break
      }
      resumeAfter = lastKey.id as ProspectId
    }
    return { rows, resumeAfter: rows.length < request.limit ? resumeAfter : null }
  }

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
      if (request.q !== undefined) {
        return (await searchProspects({ ...request, q: request.q })).rows
      }
      const view = read()
      const order = view.prospectOrder.get(organizationId) ?? []
      const allowed = mayOwn(view, organizationId, request.visibility)
      const start = pageStart(order, false, request.after)
      const page: ProspectRecord[] = []
      for (let index = start; index < order.length && page.length < request.limit; index++) {
        const key = order[index]
        const stored = key ? view.prospects.get(key.id as ProspectId) : undefined
        if (stored && passesFilters(stored, request, allowed)) {
          page.push(copyProspect(stored))
        }
      }
      return page
    },

    searchProspects,

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
        industry: input.industry ?? null,
        region: input.region ?? null,
        employeeCount: input.employeeCount ?? null,
        technologies: input.technologies ? [...input.technologies] : null,
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
      const next = {
        ...stored,
        name: patch.name ?? stored.name,
        domain,
        ...(patch.industry === undefined ? {} : { industry: patch.industry }),
        ...(patch.region === undefined ? {} : { region: patch.region }),
        ...(patch.employeeCount === undefined ? {} : { employeeCount: patch.employeeCount }),
        ...(patch.technologies === undefined ? {} : { technologies: patch.technologies }),
        updatedAt: now,
      }
      state.companies.set(id, next)
      return copyCompany(next)
    },

    listProspectCompanies: async (request: ProspectCompanyPageRequest) => {
      const view = read()
      const order = view.companyOrder.get(organizationId) ?? []
      const needle = request.q?.toLowerCase()
      const wanted = request.ids === undefined ? undefined : new Set<string>(request.ids)
      const keys = needle === undefined ? order : byId(order)
      const start = pageStart(keys, needle !== undefined, request.after)
      const page: ProspectCompanyRecord[] = []
      for (let index = start; index < keys.length && page.length < request.limit; index++) {
        const key = keys[index]
        const stored = key ? view.companies.get(key.id as ProspectCompanyId) : undefined
        if (!stored || (wanted !== undefined && !wanted.has(stored.id))) {
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

    insertProspectImport: async (input: NewProspectImport) => {
      requireLock()
      const record: ProspectImportRecord = {
        id: input.id,
        state: 'uploaded',
        failureReason: null,
        sizeBytes: input.sizeBytes,
        contentHash: new Uint8Array(input.contentHash),
        objectKey: input.objectKey,
        processedRows: 0,
        rowCount: null,
        createdCount: null,
        updatedCount: null,
        skippedCount: null,
        rejectedCount: null,
        uploadedByUserId: input.uploadedByUserId,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const state = write()
      state.prospectImports.set(input.id, { ...record, organizationId })
      state.importOrder.set(
        organizationId,
        withKey(state.importOrder.get(organizationId) ?? [], {
          at: input.now.getTime(),
          id: input.id,
        })
      )
      return copyImport({ ...record, organizationId })
    },

    getProspectImport: async (id) => {
      const stored = importIn(id)
      return stored ? copyImport(stored) : null
    },

    lockProspectImport: async (id) => {
      requireLock()
      const stored = importIn(id)
      return stored ? copyImport(stored) : null
    },

    listProspectImports: async (request) => {
      const order = read().importOrder.get(organizationId) ?? []
      const start = request.after
        ? firstAfter(order, { at: request.after.createdAt.getTime(), id: request.after.id })
        : 0
      const page: ReturnType<typeof copyImport>[] = []
      for (const key of order.slice(start, start + request.limit)) {
        const stored = read().prospectImports.get(key.id as ProspectImportId)
        if (stored) {
          page.push(copyImport(stored))
        }
      }
      return page
    },

    updateProspectImport: async (id, patch, now) => {
      requireLock()
      const stored = importIn(id)
      if (!stored) {
        return null
      }
      const next = {
        ...stored,
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.processedRows === undefined ? {} : { processedRows: patch.processedRows }),
        ...(patch.counts === undefined
          ? {}
          : {
              rowCount: patch.counts.rowCount,
              createdCount: patch.counts.created,
              updatedCount: patch.counts.updated,
              skippedCount: patch.counts.skipped,
              rejectedCount: patch.counts.rejected,
            }),
        updatedAt: now,
      }
      write().prospectImports.set(id, next)
      return copyImport(next)
    },

    deleteProspectImport: async (id) => {
      requireLock()
      const stored = importIn(id)
      if (!stored) {
        return false
      }
      const state = write()
      state.prospectImports.delete(id)
      state.importOrder.set(
        organizationId,
        (state.importOrder.get(organizationId) ?? []).filter((key) => key.id !== id)
      )
      state.importRows.delete(importRowsKey(organizationId, id))
      return true
    },

    insertProspectImportRows: async (importId, rows) => {
      requireLock()
      if (!importIn(importId)) {
        throw new MissingReferenceError('The import')
      }
      const key = importRowsKey(organizationId, importId)
      const known = new Map((read().importRows.get(key) ?? []).map((row) => [row.rowNumber, row]))
      for (const row of rows) {
        if (!known.has(row.rowNumber)) {
          known.set(row.rowNumber, { ...row })
        }
      }
      write().importRows.set(
        key,
        [...known.values()].sort((a, b) => a.rowNumber - b.rowNumber)
      )
    },

    listProspectImportRows: async (request) => {
      if (!importIn(request.importId)) {
        return []
      }
      const afterRow = request.afterRow ?? 0
      return (read().importRows.get(importRowsKey(organizationId, request.importId)) ?? [])
        .filter(
          (row) =>
            row.rowNumber > afterRow &&
            (request.result === undefined || row.result === request.result)
        )
        .slice(0, request.limit)
        .map((row) => ({ ...row }))
    },

    countProspectImportRows: async (importId) => {
      const counts = { created: 0, updated: 0, skipped: 0, rejected: 0 }
      if (importIn(importId)) {
        for (const row of read().importRows.get(importRowsKey(organizationId, importId)) ?? []) {
          counts[row.result] += 1
        }
      }
      return counts
    },

    findProspectCompany: async (match) => {
      if ('domain' in match) {
        const id = read().companyDomains.get(domainKey(organizationId, match.domain))
        const stored = id ? companyIn(id) : undefined
        return stored ? copyCompany(stored) : null
      }
      const wanted = match.name.toLowerCase()
      for (const key of [...(read().companyOrder.get(organizationId) ?? [])].reverse()) {
        const stored = companyIn(key.id as ProspectCompanyId)
        if (stored && stored.name.toLowerCase() === wanted) {
          return copyCompany(stored)
        }
      }
      return null
    },

    findProspectByIdentity: async (kind: ProspectIdentityKind, value) =>
      read().identities.get(identityKey(organizationId, kind, value)) ?? null,

    getProspectIdentity: async (prospectId, kind) =>
      prospectIn(prospectId)
        ? (read().identityOf.get(reverseKey(organizationId, prospectId, kind)) ?? null)
        : null,

    listProspectAddresses: async (prospectId) => {
      if (!prospectIn(prospectId)) {
        return []
      }
      const found = new Map<string, { kind: ProspectIdentityKind; value: string }>()
      for (const kind of ADDRESS_KINDS) {
        const held = read().identityOf.get(reverseKey(organizationId, prospectId, kind))
        if (held !== undefined) {
          found.set(`${kind}\u0000${held}`, { kind, value: held })
        }
      }
      for (const row of read().fields.get(fieldKey('prospect', prospectId)) ?? []) {
        const kind = ADDRESS_KIND_OF_FIELD[row.field]
        if (kind) {
          found.set(`${kind}\u0000${row.value}`, { kind, value: row.value })
        }
      }
      return [...found.values()]
    },

    eraseProspectFields: async (prospectId, limit) => {
      requireLock()
      if (!prospectIn(prospectId)) {
        return 0
      }
      const rows = read().fields.get(fieldKey('prospect', prospectId)) ?? []
      const taken = Math.min(limit, rows.length)
      if (taken > 0) {
        write().fields.set(fieldKey('prospect', prospectId), rows.slice(taken))
      }
      return taken
    },

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

import type {
  CrmConnectionId,
  CrmProvider,
  CrmSyncRunId,
  OrganizationId,
} from 'tula-closeline-contract'
import type { OrganizationScope } from '~/ports/core-store'
import type { CrmStageMappingRecord, CrmSyncRunRecord } from '~/ports/crm-sync-store'
import type { CrmState } from './crm-state'

type StoredMapping = { connectionId: CrmConnectionId; record: CrmStageMappingRecord }
type StoredRef = {
  connectionId: CrmConnectionId
  localId: string
  lastSeenVersion: string | null
}

/** What the in-memory store keeps for CRM Stage mappings, sync runs and external references. Maps are replaced, never changed in place, after a transaction has taken its copy. */
export type CrmSyncState = {
  /** `organization/provider` to the mapping. */
  crmStageMappings: Map<string, StoredMapping>
  /** `organization/run id` to the run. */
  crmSyncRuns: Map<string, CrmSyncRunRecord & { organizationId: OrganizationId }>
  /** `organization/provider/kind/external id` to the reference. */
  crmExternalRefs: Map<string, StoredRef>
}

/** An empty {@link CrmSyncState}. */
export function emptyCrmSyncState(): CrmSyncState {
  return { crmStageMappings: new Map(), crmSyncRuns: new Map(), crmExternalRefs: new Map() }
}

/** A copy of the shell of each map, for a transaction's first write. */
export function copyCrmSyncState(state: CrmSyncState): CrmSyncState {
  return {
    crmStageMappings: new Map(state.crmStageMappings),
    crmSyncRuns: new Map(state.crmSyncRuns),
    crmExternalRefs: new Map(state.crmExternalRefs),
  }
}

/** The CRM Stage mapping and sync run methods of an {@link OrganizationScope}. */
export type CrmSyncScope = Pick<
  OrganizationScope,
  | 'getCrmStageMapping'
  | 'replaceCrmStageMapping'
  | 'insertCrmSyncRun'
  | 'getCrmSyncRun'
  | 'updateCrmSyncRun'
  | 'listCrmSyncRuns'
  | 'findActiveCrmSyncRun'
  | 'latestCrmCursor'
  | 'getCrmExternalRef'
  | 'upsertCrmExternalRef'
  | 'setCrmLastSynced'
>

/** What a method needs from the transaction it runs in. */
export type CrmSyncEnvironment = {
  organizationId: OrganizationId
  read: () => CrmState & CrmSyncState
  write: () => CrmState & CrmSyncState
  /** Refuses a write unless the transaction holds the Organization lock first. */
  requireLock: () => void
}

const at = (...parts: string[]): string => parts.join('\u0000')

/** Builds the CRM Stage mapping and sync run methods of one transaction's scope. */
export function createCrmSyncScope(env: CrmSyncEnvironment): CrmSyncScope {
  const { organizationId, read, write, requireLock } = env
  const connection = (provider: CrmProvider) => {
    const stored = read().crmConnections.get(at(organizationId, provider))
    return stored?.organizationId === organizationId ? stored : undefined
  }
  const ownRun = (id: CrmSyncRunId) => {
    const run = read().crmSyncRuns.get(at(organizationId, id))
    return run?.organizationId === organizationId ? run : undefined
  }
  const publicRun = (run: CrmSyncRunRecord & { organizationId: OrganizationId }) => {
    const { organizationId: _organizationId, ...record } = run
    return structuredClone(record)
  }
  /** The newest first order of `(requested_at, id)`. */
  const newestFirst = (a: CrmSyncRunRecord, b: CrmSyncRunRecord): number =>
    a.requestedAt === b.requestedAt
      ? a.id < b.id
        ? 1
        : -1
      : a.requestedAt < b.requestedAt
        ? 1
        : -1
  const runsOf = (provider: CrmProvider) => {
    const connectionId = connection(provider)?.record.id
    return [...read().crmSyncRuns.values()]
      .filter((run) => run.organizationId === organizationId && run.connectionId === connectionId)
      .sort(newestFirst)
  }

  return {
    getCrmStageMapping: async (provider) => {
      const conn = connection(provider)
      if (!conn) {
        return null
      }
      const stored = read().crmStageMappings.get(at(organizationId, provider))
      if (!stored || stored.connectionId !== conn.record.id) {
        return { entries: [], confirmedByMembershipId: null, confirmedAt: null }
      }
      return structuredClone(stored.record)
    },

    replaceCrmStageMapping: async (provider, entries, membershipId, when) => {
      requireLock()
      const conn = connection(provider)
      if (!conn) {
        return false
      }
      write().crmStageMappings.set(at(organizationId, provider), {
        connectionId: conn.record.id,
        record: {
          entries: entries.map((entry) => ({ ...entry })),
          confirmedByMembershipId: membershipId,
          confirmedAt: when,
        },
      })
      return true
    },

    insertCrmSyncRun: async (input) => {
      requireLock()
      const conn = connection(input.provider)
      if (!conn) {
        return null
      }
      const run = {
        organizationId,
        id: input.id,
        connectionId: conn.record.id,
        provider: input.provider,
        objectKind: input.objectKind,
        trigger: input.trigger,
        state: 'queued' as const,
        requestedAt: input.requestedAt,
        requestedByMembershipId: input.requestedByMembershipId,
        startedAt: null,
        completedAt: null,
        counts: { created: 0, updated: 0, skipped: 0, failed: 0, unlinked: 0 },
        skipped: [],
        skippedFields: [],
        failures: [],
        failuresTruncated: false,
        errorCode: null,
        retryOfRunId: input.retryOfRunId,
        cursor: null,
      }
      write().crmSyncRuns.set(at(organizationId, input.id), run)
      return publicRun(run)
    },

    getCrmSyncRun: async (id) => {
      const run = ownRun(id)
      return run ? publicRun(run) : null
    },

    updateCrmSyncRun: async (id, patch) => {
      requireLock()
      const run = ownRun(id)
      if (!run) {
        return null
      }
      const next = { ...run, ...structuredClone(patch) }
      write().crmSyncRuns.set(at(organizationId, id), next)
      return publicRun(next)
    },

    listCrmSyncRuns: async ({ provider, state, objectKind, after, limit }) =>
      runsOf(provider)
        .filter((run) => state === undefined || run.state === state)
        .filter((run) => objectKind === undefined || run.objectKind === objectKind)
        .filter(
          (run) =>
            after === undefined ||
            run.requestedAt < after.requestedAt ||
            (run.requestedAt === after.requestedAt && run.id < after.id)
        )
        .slice(0, limit)
        .map(publicRun),

    findActiveCrmSyncRun: async (provider, objectKind) => {
      const run = runsOf(provider).find(
        (candidate) =>
          candidate.objectKind === objectKind &&
          (candidate.state === 'queued' || candidate.state === 'running')
      )
      return run ? publicRun(run) : null
    },

    latestCrmCursor: async (provider, objectKind) =>
      runsOf(provider).find((run) => run.objectKind === objectKind && run.cursor !== null)
        ?.cursor ?? null,

    getCrmExternalRef: async (provider, objectKind, externalId) => {
      const conn = connection(provider)
      const ref = read().crmExternalRefs.get(at(organizationId, provider, objectKind, externalId))
      return conn && ref && ref.connectionId === conn.record.id
        ? { localId: ref.localId, lastSeenVersion: ref.lastSeenVersion }
        : null
    },

    upsertCrmExternalRef: async (input) => {
      requireLock()
      const conn = connection(input.provider)
      if (!conn) {
        return false
      }
      write().crmExternalRefs.set(
        at(organizationId, input.provider, input.objectKind, input.externalId),
        {
          connectionId: conn.record.id,
          localId: input.localId,
          lastSeenVersion: input.version,
        }
      )
      return true
    },

    setCrmLastSynced: async (provider, when) => {
      requireLock()
      const conn = connection(provider)
      if (!conn) {
        return false
      }
      write().crmConnections.set(at(organizationId, provider), {
        ...conn,
        record: { ...conn.record, lastSyncedAt: when },
      })
      return true
    },
  }
}

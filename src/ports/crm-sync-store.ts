import type {
  CrmObjectKind,
  CrmProvider,
  CrmRunState,
  CrmStageMappingEntry,
  CrmSyncRun,
  CrmSyncRunId,
  MembershipId,
} from 'tula-closeline-contract'

/** The Stage mapping of a connection as the store holds it; the API shape is the contract's `CrmStageMapping`. */
export type CrmStageMappingRecord = {
  entries: CrmStageMappingEntry[]
  /** Who confirmed the mapping, or `null` while it is unconfirmed. */
  confirmedByMembershipId: MembershipId | null
  confirmedAt: Date | null
}

/** A sync run as the store holds it: the API report plus the CRM cursor, which is never returned. */
export type CrmSyncRunRecord = CrmSyncRun & {
  /** The CRM high-water mark after the last committed page, or `null` before the first. */
  cursor: string | null
}

/** What starting a run stores; the run begins `queued` with zero counts. */
export type NewCrmSyncRun = {
  id: CrmSyncRunId
  provider: CrmProvider
  objectKind: CrmObjectKind
  trigger: CrmSyncRun['trigger']
  /** ISO time, as the API reports it. */
  requestedAt: string
  requestedByMembershipId: MembershipId | null
  retryOfRunId: CrmSyncRunId | null
}

/** The fields of a run that change while it works. */
export type CrmSyncRunPatch = Partial<
  Pick<
    CrmSyncRunRecord,
    | 'state'
    | 'startedAt'
    | 'completedAt'
    | 'counts'
    | 'skipped'
    | 'failures'
    | 'failuresTruncated'
    | 'errorCode'
    | 'cursor'
  >
>

/** The link between a CRM record and what Closeline made from it. */
export type CrmExternalRefRecord = {
  /** The id on the Closeline side (for a Deal, the Playbook's customer Deal id). */
  localId: string
  /** The CRM's change marker of the version last pulled; an equal marker means nothing changed. */
  lastSeenVersion: string | null
}

/** The CRM Stage mapping and sync run methods of an Organization scope. */
export interface CrmSyncScope {
  /** The Stage mapping of the connection to a provider, or `null` when there is no connection. */
  getCrmStageMapping(provider: CrmProvider): Promise<CrmStageMappingRecord | null>
  /**
   * Replaces the whole Stage mapping and records who confirmed it and when; answers whether there
   * was a connection. Needs the Organization lock.
   */
  replaceCrmStageMapping(
    provider: CrmProvider,
    entries: CrmStageMappingEntry[],
    membershipId: MembershipId,
    at: Date
  ): Promise<boolean>
  /** Stores a new `queued` run; answers `null` when there is no connection to the provider. Needs the Organization lock. */
  insertCrmSyncRun(input: NewCrmSyncRun): Promise<CrmSyncRunRecord | null>
  /** One run of this Organization, or `null` when it is unknown or another Organization's. */
  getCrmSyncRun(id: CrmSyncRunId): Promise<CrmSyncRunRecord | null>
  /** Changes the working fields of a run and answers it, or `null` when there is none. Needs the Organization lock. */
  updateCrmSyncRun(id: CrmSyncRunId, patch: CrmSyncRunPatch): Promise<CrmSyncRunRecord | null>
  /** One page of a provider's runs, newest first, after `after` when given. */
  listCrmSyncRuns(request: {
    provider: CrmProvider
    state?: CrmRunState
    objectKind?: CrmObjectKind
    after?: { requestedAt: string; id: CrmSyncRunId }
    limit: number
  }): Promise<CrmSyncRunRecord[]>
  /** The newest `queued` or `running` run of a kind, or `null`. */
  findActiveCrmSyncRun(
    provider: CrmProvider,
    objectKind: CrmObjectKind
  ): Promise<CrmSyncRunRecord | null>
  /** The cursor of the newest run of a kind that holds one, or `null` for a first load. */
  latestCrmCursor(provider: CrmProvider, objectKind: CrmObjectKind): Promise<string | null>
  /** The reference for one CRM record, or `null` when it was never pulled. */
  getCrmExternalRef(
    provider: CrmProvider,
    objectKind: CrmObjectKind,
    externalId: string
  ): Promise<CrmExternalRefRecord | null>
  /** Links a CRM record to its Closeline side and notes the version pulled. Needs the Organization lock. */
  upsertCrmExternalRef(input: {
    provider: CrmProvider
    objectKind: CrmObjectKind
    externalId: string
    localId: string
    version: string
    at: Date
  }): Promise<boolean>
  /** Sets when the connection last finished a sync; answers whether there was a connection. Needs the Organization lock. */
  setCrmLastSynced(provider: CrmProvider, at: Date): Promise<boolean>
}

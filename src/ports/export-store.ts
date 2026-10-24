import type {
  ExportFailureReason,
  ExportJobId,
  ExportService,
  ExportState,
  MembershipId,
} from 'tula-closeline-contract'

/** The reason a part failed, as the contract names it. */
export type ExportPartFailureReason = 'write_failed' | 'storage_unavailable' | 'source_unavailable'

/** One export job as the store keeps it: an Organization export, with real times. */
export type ExportJobRecord = {
  id: ExportJobId
  state: ExportState
  requestedByMembershipId: MembershipId
  includeRecordingLinks: boolean
  failureReason: ExportFailureReason | null
  requestedAt: Date
  completedAt: Date | null
  expiresAt: Date | null
}

/** One service's part of an export job. */
export type ExportPartRecord = {
  exportId: ExportJobId
  service: ExportService
  state: 'pending' | 'ready' | 'failed'
  prefix: string | null
  fileCount: number | null
  bytes: number | null
  failureReason: ExportPartFailureReason | null
  readyAt: Date | null
}

/** A keyset position in the newest-first list of export jobs. */
export type ExportListPosition = { requestedAt: Date; id: ExportJobId }

/** The export methods of an Organization scope. */
export interface ExportScope {
  /**
   * Inserts a queued job with one pending part per service. Returns `false`, writing nothing, when
   * the Organization already has a queued or running job (the database allows only one).
   */
  insertExportJob(input: {
    id: ExportJobId
    requestedByMembershipId: MembershipId
    includeRecordingLinks: boolean
    requestedAt: Date
    services: readonly ExportService[]
  }): Promise<boolean>
  /** The Organization's queued or running job, or `null`. */
  getActiveExportJob(): Promise<ExportJobRecord | null>
  /** How many jobs the Organization requested at or after `since`, whatever their state. */
  countExportsSince(since: Date): Promise<number>
  /** One job by id, or `null`. */
  getExportJob(id: ExportJobId): Promise<ExportJobRecord | null>
  /** Up to `limit` jobs, newest first, after the position when given. */
  listExportJobs(request: { after?: ExportListPosition; limit: number }): Promise<ExportJobRecord[]>
  /** The parts of the given jobs. */
  listExportParts(ids: readonly ExportJobId[]): Promise<ExportPartRecord[]>
  /** Moves a queued job to running; `false` when it is not queued. */
  markExportRunning(id: ExportJobId): Promise<boolean>
  /** Records a pending part as ready, only while the job is active; `false` when it wrote nothing. */
  markExportPartReady(
    id: ExportJobId,
    service: ExportService,
    result: { prefix: string; fileCount: number; bytes: number; readyAt: Date }
  ): Promise<boolean>
  /** Records a pending part as failed, only while the job is active; `false` when it wrote nothing. */
  markExportPartFailed(
    id: ExportJobId,
    service: ExportService,
    reason: ExportPartFailureReason
  ): Promise<boolean>
  /** Fails an active job; `false` when it was not active. */
  failExportJob(id: ExportJobId, reason: ExportFailureReason, at: Date): Promise<boolean>
  /** Completes an active job as ready; `false` when it was not active. */
  completeExportJob(id: ExportJobId, completedAt: Date, expiresAt: Date): Promise<boolean>
  /** Marks a ready job past its expiry as expired; `false` when it was not ready. */
  expireExportJob(id: ExportJobId): Promise<boolean>
  /**
   * Returns a failed job to queued and its failed parts to pending, unless another job is active
   * (then `false`). The attempt restarts its timeout clock at `at`.
   */
  retryExportJob(id: ExportJobId, at: Date): Promise<boolean>
}

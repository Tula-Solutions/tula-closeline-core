import type { ExportJobId, ExportService, OrganizationId } from 'tula-closeline-contract'
import type { ExportJobRecord, ExportPartRecord, ExportScope } from '~/ports/export-store'

/** What the in-memory store keeps for exports: each Organization's jobs and parts. */
export type ExportState = {
  /** The arrays are replaced, never changed in place, once a transaction has taken its copy. */
  exportJobs: Map<OrganizationId, ExportJobRecord[]>
  exportParts: Map<OrganizationId, ExportPartRecord[]>
}

/** An empty {@link ExportState}. */
export function emptyExportState(): ExportState {
  return { exportJobs: new Map(), exportParts: new Map() }
}

/** A copy of the shell of the maps, for a transaction's first write. */
export function copyExportState(state: ExportState): ExportState {
  return { exportJobs: new Map(state.exportJobs), exportParts: new Map(state.exportParts) }
}

const isActive = (job: ExportJobRecord): boolean =>
  job.state === 'queued' || job.state === 'running'

/** Builds the export methods of one transaction's scope, with the database's own rules. */
export function createExportScope(env: {
  organizationId: OrganizationId
  read: () => ExportState
  write: () => ExportState
  requireLock: () => void
}): ExportScope {
  const { organizationId, read, write, requireLock } = env
  const jobsOf = (state: ExportState): ExportJobRecord[] =>
    state.exportJobs.get(organizationId) ?? []
  const partsOf = (state: ExportState): ExportPartRecord[] =>
    state.exportParts.get(organizationId) ?? []

  const changeJob = (id: ExportJobId, change: (job: ExportJobRecord) => ExportJobRecord | null) => {
    const found = jobsOf(read()).find((job) => job.id === id)
    if (!found) {
      return false
    }
    const next = change(found)
    if (next === null) {
      return false
    }
    const state = write()
    state.exportJobs.set(
      organizationId,
      jobsOf(state).map((job) => (job.id === id ? next : job))
    )
    return true
  }

  const changePart = (
    id: ExportJobId,
    service: ExportService,
    change: (part: ExportPartRecord) => ExportPartRecord | null
  ) => {
    const job = jobsOf(read()).find((candidate) => candidate.id === id)
    const found = partsOf(read()).find((part) => part.exportId === id && part.service === service)
    if (!job || !isActive(job) || !found || found.state !== 'pending') {
      return false
    }
    const next = change(found)
    if (next === null) {
      return false
    }
    const state = write()
    state.exportParts.set(
      organizationId,
      partsOf(state).map((part) => (part === found ? next : part))
    )
    return true
  }

  return {
    insertExportJob: async (input) => {
      requireLock()
      if (jobsOf(read()).some(isActive)) {
        return false
      }
      const state = write()
      state.exportJobs.set(organizationId, [
        ...jobsOf(state),
        {
          id: input.id,
          state: 'queued',
          requestedByMembershipId: input.requestedByMembershipId,
          includeRecordingLinks: input.includeRecordingLinks,
          failureReason: null,
          requestedAt: input.requestedAt,
          completedAt: null,
          expiresAt: null,
        },
      ])
      state.exportParts.set(organizationId, [
        ...partsOf(state),
        ...input.services.map(
          (service): ExportPartRecord => ({
            exportId: input.id,
            service,
            state: 'pending',
            prefix: null,
            fileCount: null,
            bytes: null,
            failureReason: null,
            readyAt: null,
          })
        ),
      ])
      return true
    },

    getActiveExportJob: async () => jobsOf(read()).find(isActive) ?? null,

    countExportsSince: async (since) =>
      jobsOf(read()).filter((job) => job.requestedAt >= since).length,

    getExportJob: async (id) => jobsOf(read()).find((job) => job.id === id) ?? null,

    listExportJobs: async ({ after, limit }) =>
      [...jobsOf(read())]
        .sort(
          (a, b) =>
            b.requestedAt.getTime() - a.requestedAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )
        .filter(
          (job) =>
            !after ||
            job.requestedAt.getTime() < after.requestedAt.getTime() ||
            (job.requestedAt.getTime() === after.requestedAt.getTime() && job.id < after.id)
        )
        .slice(0, limit),

    listExportParts: async (ids) => partsOf(read()).filter((part) => ids.includes(part.exportId)),

    markExportRunning: async (id) => {
      requireLock()
      return changeJob(id, (job) => (job.state === 'queued' ? { ...job, state: 'running' } : null))
    },

    markExportPartReady: async (id, service, result) => {
      requireLock()
      return changePart(id, service, (part) => ({
        ...part,
        state: 'ready',
        prefix: result.prefix,
        fileCount: result.fileCount,
        bytes: result.bytes,
        readyAt: result.readyAt,
      }))
    },

    markExportPartFailed: async (id, service, reason) => {
      requireLock()
      return changePart(id, service, (part) => ({
        ...part,
        state: 'failed',
        failureReason: reason,
      }))
    },

    failExportJob: async (id, reason, at) => {
      requireLock()
      return changeJob(id, (job) =>
        isActive(job) ? { ...job, state: 'failed', failureReason: reason, completedAt: at } : null
      )
    },

    completeExportJob: async (id, completedAt, expiresAt) => {
      requireLock()
      return changeJob(id, (job) =>
        isActive(job) ? { ...job, state: 'ready', completedAt, expiresAt } : null
      )
    },

    expireExportJob: async (id) => {
      requireLock()
      return changeJob(id, (job) => (job.state === 'ready' ? { ...job, state: 'expired' } : null))
    },

    retryExportJob: async (id, at) => {
      requireLock()
      if (jobsOf(read()).some(isActive)) {
        return false
      }
      const reset = changeJob(id, (job) =>
        job.state === 'failed'
          ? { ...job, state: 'queued', failureReason: null, completedAt: null, requestedAt: at }
          : null
      )
      if (!reset) {
        return false
      }
      const state = write()
      state.exportParts.set(
        organizationId,
        partsOf(state).map((part) =>
          part.exportId === id && part.state === 'failed'
            ? {
                ...part,
                state: 'pending',
                prefix: null,
                fileCount: null,
                bytes: null,
                failureReason: null,
                readyAt: null,
              }
            : part
        )
      )
      return true
    },
  }
}

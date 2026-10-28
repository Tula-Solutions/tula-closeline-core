import {
  type CrmConnection,
  type CrmConnectionStatus,
  type CrmProvider,
  type CrmStageMapping,
  type CrmSyncRun,
  crmConnectionIdSchema,
  crmConnectionSchema,
  crmConnectionStatusSchema,
  crmStageMappingSchema,
  crmSyncRunIdSchema,
  crmSyncRunSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { CrmConnectionRecord } from '~/ports/core-store'
import type { CrmStageMappingRecord, CrmSyncRunRecord } from '~/ports/crm-sync-store'

/** The cursor of the connection list: the id of the last item, which is the sort key. */
export const crmCursorSchema = z.strictObject({ id: crmConnectionIdSchema })

/** The API shape of a connection: no token, no sealed bytes and no CRM account id, through the contract's schema. */
export function toCrmConnectionResponse(record: CrmConnectionRecord): CrmConnection {
  return crmConnectionSchema.parse({
    id: record.id,
    provider: record.provider,
    state: record.state,
    accountLabel: record.accountLabel,
    scopeLevel: record.scopeLevel,
    connectedByMembershipId: record.connectedByMembershipId,
    connectedAt: record.connectedAt.toISOString(),
    lastSyncedAt: record.lastSyncedAt?.toISOString() ?? null,
    needsReconnectSince: record.needsReconnectSince?.toISOString() ?? null,
  })
}

/** The status of a provider: `not_connected` when the Organization has no connection to it. */
export function toCrmStatusResponse(
  provider: CrmProvider,
  record: CrmConnectionRecord | null
): CrmConnectionStatus {
  return crmConnectionStatusSchema.parse(
    record === null
      ? { provider, state: 'not_connected', connection: null }
      : { provider, state: record.state, connection: toCrmConnectionResponse(record) }
  )
}

/** The cursor of the run list: when the last run was requested and its id, the sort key. */
export const crmRunCursorSchema = z.strictObject({
  t: z.string().min(1).max(40),
  id: crmSyncRunIdSchema,
})

/** The API shape of a run: the CRM cursor stays in the store, and the contract's schema checks the rest. */
export function toCrmSyncRunResponse(record: CrmSyncRunRecord): CrmSyncRun {
  const { cursor: _cursor, ...run } = record
  return crmSyncRunSchema.parse(run)
}

/** The API shape of a Stage mapping; `confirmed` is true exactly when who and when are set. */
export function toCrmStageMappingResponse(
  provider: CrmProvider,
  record: CrmStageMappingRecord
): CrmStageMapping {
  return crmStageMappingSchema.parse({
    provider,
    entries: record.entries,
    confirmed: record.confirmedAt !== null,
    confirmedByMembershipId: record.confirmedByMembershipId,
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
  })
}

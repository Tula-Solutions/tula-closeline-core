import {
  type CrmConnection,
  type CrmConnectionStatus,
  type CrmProvider,
  crmConnectionIdSchema,
  crmConnectionSchema,
  crmConnectionStatusSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { CrmConnectionRecord } from '~/ports/core-store'

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

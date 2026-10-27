import { type AgentControl, type AgentsPaused, agentKindSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { AgentSettingRecord, AgentsPausedRecord } from '~/ports/agent-settings-store'

/** The path of the route that sets one kind and channel's controls. */
export const controlParamsSchema = z.object({
  agentKind: agentKindSchema,
  channel: z.union([
    z.enum(['phone', 'sms', 'whatsapp', 'email', 'linkedin']),
    z.literal('default'),
  ]),
})

/** The cursor of the controls list: the kind and channel of the last row on the page. */
export const controlListCursorSchema = z.strictObject({
  agentKind: agentKindSchema,
  channel: controlParamsSchema.shape.channel,
})

/** A stored row as the contract's control; `default` is `null` in the response. */
export function toControlResponse(record: AgentSettingRecord): AgentControl {
  return {
    agentKind: record.agentKind,
    channel: record.channel === 'default' ? null : record.channel,
    level: record.level,
    sendWindow: record.sendWindow,
    escalationRules: record.escalationRules,
    updatedAt: record.updatedAt.toISOString(),
    updatedByMembershipId: record.updatedByMembershipId,
  }
}

/** The pause switch as the contract's answer; never set is not paused. */
export function toPausedResponse(record: AgentsPausedRecord | null): AgentsPaused {
  return {
    paused: record?.paused ?? false,
    updatedAt: record ? record.updatedAt.toISOString() : null,
    updatedByMembershipId: record?.updatedByMembershipId ?? null,
  }
}

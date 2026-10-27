import type { OrganizationId } from 'tula-closeline-contract'
import type {
  AgentSettingRecord,
  AgentSettingsScope,
  AgentsPausedRecord,
} from '~/ports/agent-settings-store'

/** What the in-memory store keeps for Agent controls: setting rows and the pause switches. */
export type AgentSettingsState = {
  /** Keyed `organization:kind:channel`; records are replaced, never changed in place. */
  agentSettings: Map<string, AgentSettingRecord>
  /** Keyed by Organization. */
  agentsPaused: Map<OrganizationId, AgentsPausedRecord>
}

/** An empty {@link AgentSettingsState}. */
export function emptyAgentSettingsState(): AgentSettingsState {
  return { agentSettings: new Map(), agentsPaused: new Map() }
}

/** A copy of the shells of the maps, for a transaction's first write. */
export function copyAgentSettingsState(state: AgentSettingsState): AgentSettingsState {
  return {
    agentSettings: new Map(state.agentSettings),
    agentsPaused: new Map(state.agentsPaused),
  }
}

/** Builds the Agent control methods of one transaction's scope, with the database's own rules. */
export function createAgentSettingsScope(env: {
  organizationId: OrganizationId
  read: () => AgentSettingsState
  write: () => AgentSettingsState
  requireLock: () => void
}): AgentSettingsScope {
  const { organizationId, read, write, requireLock } = env
  const prefix = `${organizationId}:`
  const keyOf = (agentKind: string, channel: string): string => `${prefix}${agentKind}:${channel}`

  return {
    getAgentSetting: async (agentKind, channel) =>
      read().agentSettings.get(keyOf(agentKind, channel)) ?? null,

    listAgentSettings: async ({ agentKind, after, limit }) =>
      [...read().agentSettings.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => record)
        .filter((r) => agentKind === undefined || r.agentKind === agentKind)
        .sort((a, b) =>
          a.agentKind === b.agentKind
            ? a.channel.localeCompare(b.channel)
            : a.agentKind.localeCompare(b.agentKind)
        )
        .filter(
          (r) =>
            after === undefined ||
            r.agentKind > after.agentKind ||
            (r.agentKind === after.agentKind && r.channel > after.channel)
        )
        .slice(0, limit),

    upsertAgentSetting: async (input) => {
      requireLock()
      const record: AgentSettingRecord = {
        agentKind: input.agentKind,
        channel: input.channel,
        level: input.level,
        sendWindow: input.sendWindow,
        escalationRules: input.escalationRules,
        updatedByMembershipId: input.membershipId,
        updatedAt: input.now,
      }
      write().agentSettings.set(keyOf(input.agentKind, input.channel), record)
      return record
    },

    getAgentsPaused: async () => read().agentsPaused.get(organizationId) ?? null,

    setAgentsPaused: async (input) => {
      requireLock()
      const record: AgentsPausedRecord = {
        paused: input.paused,
        updatedByMembershipId: input.membershipId,
        updatedAt: input.now,
      }
      write().agentsPaused.set(organizationId, record)
      return record
    },
  }
}

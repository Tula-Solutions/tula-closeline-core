import type {
  AgentKind,
  AgentSendWindow,
  ConsentChannel,
  ControlLevel,
  EscalationRule,
  MembershipId,
} from 'tula-closeline-contract'

/** A channel of Contact Consent, or `default` for the kind's fallback row. */
export type AgentControlChannelParam = ConsentChannel | 'default'

/** One Agent kind and channel's controls as the store keeps them; `channel` `default` is the kind's. */
export type AgentSettingRecord = {
  agentKind: AgentKind
  channel: AgentControlChannelParam
  level: ControlLevel
  sendWindow: AgentSendWindow
  escalationRules: EscalationRule[]
  updatedByMembershipId: MembershipId | null
  updatedAt: Date
}

/** The Organization-wide pause switch as the store keeps it. */
export type AgentsPausedRecord = {
  paused: boolean
  updatedByMembershipId: MembershipId | null
  updatedAt: Date
}

/** The Agent control methods of one Organization's transaction. Writes need the Organization lock. */
export interface AgentSettingsScope {
  /** One kind and channel's row, or `null` when none was set. A primary-key read. */
  getAgentSetting(
    agentKind: AgentKind,
    channel: AgentControlChannelParam
  ): Promise<AgentSettingRecord | null>
  /** Rows ordered by kind then channel, after `after` when given, of `agentKind` when given, at most `limit`. */
  listAgentSettings(request: {
    agentKind?: AgentKind
    after?: { agentKind: AgentKind; channel: AgentControlChannelParam }
    limit: number
  }): Promise<AgentSettingRecord[]>
  /** Saves the row for a kind and channel (an upsert). */
  upsertAgentSetting(input: {
    agentKind: AgentKind
    channel: AgentControlChannelParam
    level: ControlLevel
    sendWindow: AgentSendWindow
    escalationRules: EscalationRule[]
    membershipId: MembershipId
    now: Date
  }): Promise<AgentSettingRecord>
  /** The Organization's pause switch, or `null` when it was never set. */
  getAgentsPaused(): Promise<AgentsPausedRecord | null>
  /** Sets the pause switch (an upsert). */
  setAgentsPaused(input: {
    paused: boolean
    membershipId: MembershipId
    now: Date
  }): Promise<AgentsPausedRecord>
}

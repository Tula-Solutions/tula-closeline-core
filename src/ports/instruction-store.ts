import type { AgentInstructionVersionId, AgentKind, MembershipId } from 'tula-closeline-contract'

/** One saved version of an Agent kind's instructions as the store keeps it. Immutable. */
export type InstructionVersionRecord = {
  id: AgentInstructionVersionId
  agentKind: AgentKind
  number: number
  text: string
  authorMembershipId: MembershipId | null
  createdAt: Date
}

/** Which version of an Agent kind is published, and who published it when. */
export type InstructionPointerRecord = {
  agentKind: AgentKind
  versionNumber: number
  publishedByMembershipId: MembershipId | null
  publishedAt: Date
}

/** A new version; its number is the next one for the Organization and Agent kind. */
export type NewInstructionVersion = {
  id: AgentInstructionVersionId
  agentKind: AgentKind
  text: string
  authorMembershipId: MembershipId
  now: Date
}

/** The instruction methods of one Organization's transaction. Writes need the Organization lock. */
export interface InstructionScope {
  /** Saves a new version numbered after the highest one of the kind. Versions are never updated. */
  insertInstructionVersion(input: NewInstructionVersion): Promise<InstructionVersionRecord>
  /** One version by its number, or `null`. A primary-key style read. */
  findInstructionVersion(
    agentKind: AgentKind,
    number: number
  ): Promise<InstructionVersionRecord | null>
  /** Versions of a kind, newest first, those numbered below `before` when given, at most `limit`. */
  listInstructionVersions(request: {
    agentKind: AgentKind
    before?: number
    limit: number
  }): Promise<InstructionVersionRecord[]>
  /** The published pointer of a kind, or `null` when nothing is published. */
  getInstructionPointer(agentKind: AgentKind): Promise<InstructionPointerRecord | null>
  /** Points the kind at a saved version (an upsert): publish and rollback are this call. */
  setInstructionPointer(input: {
    agentKind: AgentKind
    versionNumber: number
    publishedByMembershipId: MembershipId
    now: Date
  }): Promise<InstructionPointerRecord>
}

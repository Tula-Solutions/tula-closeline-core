import type { AgentKind, OrganizationId } from 'tula-closeline-contract'
import type {
  InstructionPointerRecord,
  InstructionScope,
  InstructionVersionRecord,
} from '~/ports/instruction-store'

/** What the in-memory store keeps for Agent instructions: versions and published pointers. */
export type InstructionState = {
  /** Keyed `organization:kind`; the arrays are replaced, never changed in place, by a write. */
  instructionVersions: Map<string, InstructionVersionRecord[]>
  /** Keyed `organization:kind`. */
  instructionPointers: Map<string, InstructionPointerRecord>
}

/** An empty {@link InstructionState}. */
export function emptyInstructionState(): InstructionState {
  return { instructionVersions: new Map(), instructionPointers: new Map() }
}

/** A copy of the shells of the maps, for a transaction's first write. */
export function copyInstructionState(state: InstructionState): InstructionState {
  return {
    instructionVersions: new Map(state.instructionVersions),
    instructionPointers: new Map(state.instructionPointers),
  }
}

/** Builds the instruction methods of one transaction's scope, with the database's own rules. */
export function createInstructionScope(env: {
  organizationId: OrganizationId
  read: () => InstructionState
  write: () => InstructionState
  requireLock: () => void
}): InstructionScope {
  const { organizationId, read, write, requireLock } = env
  const keyOf = (agentKind: AgentKind): string => `${organizationId}:${agentKind}`

  return {
    insertInstructionVersion: async (input) => {
      requireLock()
      const state = write()
      const key = keyOf(input.agentKind)
      const existing = state.instructionVersions.get(key) ?? []
      const record: InstructionVersionRecord = {
        id: input.id,
        agentKind: input.agentKind,
        number: (existing.at(-1)?.number ?? 0) + 1,
        text: input.text,
        authorMembershipId: input.authorMembershipId,
        createdAt: input.now,
      }
      state.instructionVersions.set(key, [...existing, record])
      return record
    },

    findInstructionVersion: async (agentKind, number) =>
      read()
        .instructionVersions.get(keyOf(agentKind))
        ?.find((v) => v.number === number) ?? null,

    listInstructionVersions: async ({ agentKind, before, limit }) =>
      [...(read().instructionVersions.get(keyOf(agentKind)) ?? [])]
        .reverse()
        .filter((v) => before === undefined || v.number < before)
        .slice(0, limit),

    getInstructionPointer: async (agentKind) =>
      read().instructionPointers.get(keyOf(agentKind)) ?? null,

    setInstructionPointer: async (input) => {
      requireLock()
      const record: InstructionPointerRecord = {
        agentKind: input.agentKind,
        versionNumber: input.versionNumber,
        publishedByMembershipId: input.publishedByMembershipId,
        publishedAt: input.now,
      }
      write().instructionPointers.set(keyOf(input.agentKind), record)
      return record
    },
  }
}

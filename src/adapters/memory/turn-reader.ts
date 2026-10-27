import type { CallId, OrganizationId } from 'tula-closeline-contract'
import type { TurnReader, TurnText } from '~/ports/turn-reader'

/** A reader that returns the turns a test or local run put in it. */
export type MemoryTurnReader = TurnReader & {
  /** Sets the text of one turn. */
  put(organizationId: OrganizationId, callId: CallId, turnIndex: number, text: TurnText): void
}

/** A fixture {@link TurnReader} over a map. */
export function createMemoryTurnReader(): MemoryTurnReader {
  const turns = new Map<string, TurnText>()
  const key = (organizationId: string, callId: string, turnIndex: number) =>
    `${organizationId}|${callId}|${turnIndex}`
  return {
    put: (organizationId, callId, turnIndex, text) => {
      turns.set(key(organizationId, callId, turnIndex), text)
    },
    read: async (input) =>
      turns.get(key(input.organizationId, input.callId, input.turnIndex)) ?? null,
  }
}

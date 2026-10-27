import type { CallId, CallTurn, OrganizationId } from 'tula-closeline-contract'
import type { TurnReader, TurnText } from '~/ports/turn-reader'

/** A reader that returns the turns a test or local run put in it. */
export type MemoryTurnReader = TurnReader & {
  /** Sets the text of one turn. */
  put(organizationId: OrganizationId, callId: CallId, turnIndex: number, text: TurnText): void
  /** Sets the whole Transcript of a Call, for the window read. */
  putCall(organizationId: OrganizationId, callId: CallId, turns: CallTurn[]): void
}

/** A fixture {@link TurnReader} over a map. */
export function createMemoryTurnReader(): MemoryTurnReader {
  const turns = new Map<string, TurnText>()
  const calls = new Map<string, CallTurn[]>()
  const key = (organizationId: string, callId: string, turnIndex: number) =>
    `${organizationId}|${callId}|${turnIndex}`
  return {
    putCall: (organizationId, callId, callTurns) => {
      calls.set(`${organizationId}|${callId}`, callTurns)
    },
    window: async (input) => {
      const all = calls.get(`${input.organizationId}|${input.callId}`)
      if (!all?.some((turn) => turn.index === input.turnIndex)) {
        return null
      }
      return {
        around: input.turnIndex,
        turns: all.filter((turn) => Math.abs(turn.index - input.turnIndex) <= input.window),
      }
    },
    put: (organizationId, callId, turnIndex, text) => {
      turns.set(key(organizationId, callId, turnIndex), text)
    },
    read: async (input) =>
      turns.get(key(input.organizationId, input.callId, input.turnIndex)) ?? null,
  }
}

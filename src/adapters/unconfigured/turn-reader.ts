import type { TurnReader } from '~/ports/turn-reader'

/** A reader for deployments with no Transcript source: every read fails, so no turn is assessed. */
export function createUnconfiguredTurnReader(): TurnReader {
  return {
    read: async () => {
      throw new Error('No Call transcript source is configured')
    },
  }
}

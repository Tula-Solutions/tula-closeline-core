import type { TurnReader } from '~/ports/turn-reader'

/** A reader for deployments with no Transcript source: every read fails, so no turn is assessed. */
export function createUnconfiguredTurnReader(): TurnReader {
  const refuse = async (): Promise<never> => {
    throw new Error('No Call transcript source is configured')
  }
  return { read: refuse, window: refuse }
}

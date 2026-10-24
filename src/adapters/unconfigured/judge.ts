import type { Judge } from '~/ports/judge'

/** A judge for deployments with no model: every call fails, so every Draft is held (fail closed). */
export function createUnconfiguredJudge(): Judge {
  return {
    assess: async () => {
      throw new Error('No Draft judge is configured')
    },
  }
}

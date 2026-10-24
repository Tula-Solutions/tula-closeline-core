import type { MomentSearch } from '~/ports/moment-search'

/** A Playbook search for an environment where the Playbook is not reachable from core: it always throws, so the Conversation is escalated. */
export function createUnconfiguredMomentSearch(): MomentSearch {
  return {
    searchWonMoments: async () => {
      throw new Error('No Playbook search is configured for this environment')
    },
    passagesFor: async () => {
      throw new Error('No Playbook search is configured for this environment')
    },
  }
}

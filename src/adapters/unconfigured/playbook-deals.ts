import { type PlaybookDeals, PlaybookUnavailableError } from '~/ports/playbook-deals'

/**
 * A sink for deployments with no Playbook Deal route: every call fails as unreachable, so a run
 * keeps its cursor and is retried once one is configured. The Playbook has no such route yet.
 */
export function createUnconfiguredPlaybookDeals(): PlaybookDeals {
  return {
    recordDeal: async () => {
      throw new PlaybookUnavailableError('No Playbook Deal sink is configured')
    },
  }
}

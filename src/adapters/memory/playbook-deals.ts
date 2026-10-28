import {
  type PlaybookDeal,
  type PlaybookDeals,
  PlaybookRejectedError,
  PlaybookUnavailableError,
} from '~/ports/playbook-deals'

/** The in-memory Playbook Deal sink, with what a test reads and scripts. */
export type MemoryPlaybookDeals = PlaybookDeals & {
  /** Every Deal accepted, in order, once per idempotency key. */
  readonly recorded: readonly PlaybookDeal[]
  /** Every call, accepted or not, in order. */
  readonly calls: number
  /** Refuses the Deal with this id for good. */
  rejectDeal(dealId: string): void
  /** Makes the next `times` calls fail as unreachable. */
  failNext(times: number): void
}

/** An in-memory Deal sink that dedupes by idempotency key, like the Playbook does. */
export function createMemoryPlaybookDeals(): MemoryPlaybookDeals {
  const recorded: PlaybookDeal[] = []
  const keys = new Set<string>()
  const rejected = new Set<string>()
  let failures = 0
  let calls = 0
  return {
    get recorded() {
      return recorded
    },
    get calls() {
      return calls
    },
    rejectDeal: (dealId) => {
      rejected.add(dealId)
    },
    failNext: (times) => {
      failures = times
    },
    recordDeal: async (deal) => {
      calls += 1
      if (failures > 0) {
        failures -= 1
        throw new PlaybookUnavailableError('The Playbook did not answer')
      }
      if (rejected.has(deal.dealId)) {
        throw new PlaybookRejectedError('The Playbook refused the Deal')
      }
      const key = `${deal.organizationId}\u0000${deal.idempotencyKey}`
      if (!keys.has(key)) {
        keys.add(key)
        recorded.push({ ...deal })
      }
    },
  }
}

import type { RepNotice, RepNotifier } from '~/ports/rep-notifier'

/** Rep notifier that keeps notices in memory so tests can read what was "sent". */
export type MemoryRepNotifier = RepNotifier & {
  /** Every notice handed over, oldest first. */
  outbox: RepNotice[]
  /** Simulates the notification system being down: `notify` rejects while true. */
  failing: boolean
}

/** Builds the in-memory Rep notifier. */
export function createMemoryRepNotifier(): MemoryRepNotifier {
  const notifier: MemoryRepNotifier = {
    outbox: [],
    failing: false,
    notify: async (notice) => {
      if (notifier.failing) {
        throw new Error('notification system unavailable')
      }
      notifier.outbox.push(notice)
    },
  }
  return notifier
}

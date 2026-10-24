import { expect, test } from 'bun:test'
import { formatId, type MessageId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '../src/adapters/memory/core-store'
import { consumeAnalyticsEvent } from '../src/modules/analytics/consumer'
import * as Analytics from '../src/modules/analytics/service'
import { sentEnvelope } from '../src/modules/analytics/testing'
import { createTestDeps, seedOrganization } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The hot paths of the analytics rollups. Writing: one event is one ledger insert and at most two
// rollup upserts (the total cell and the channel cell of its day), each by primary key, so the
// work is O(1) in the size of the Organization and of the ledger. Reading: one series is a
// range scan of at most 400 days over the (organization, metric, group kind, day, key) key, plus
// at most 20 group keys a page, so it is O(days x groups on the page), never the ledger. Input:
// one Organization with 3,000 events already counted over 300 days and three channels. The
// memory adapter keeps maps and copies them on every write, so these budgets guard the service's
// own work (a hidden ledger scan, a per-event query) and not the database, whose plans the
// integration suite checks.
// Typical best batch of 500 on the dev laptop: 12 ms for writes (median 20 ms) and 8.5 ms for
// series reads (median 9 ms). A CI runner is several times slower than the laptop, so the budgets
// are about 5x a CI-sized time, rounded up: 300 ms for writes and 250 ms for reads.
const SEEDED_EVENTS = 3_000
const DAYS = 300
const CHANNELS = ['email', 'linkedin', 'chat'] as const
const START = Date.UTC(2025, 0, 1)

const sentAt = (index: number) => new Date(START + (index % DAYS) * 86_400_000 + 3_600_000)

async function build() {
  const store = createMemoryCoreStore()
  const seeded = await seedOrganization(store, ['admin'])
  const deps = createTestDeps({ store })
  for (let index = 0; index < SEEDED_EVENTS; index++) {
    await consumeAnalyticsEvent(
      deps,
      seeded.organizationId,
      sentEnvelope(seeded.organizationId, sentAt(index).toISOString(), {
        channel: CHANNELS[index % CHANNELS.length],
      })
    )
  }
  return { store, seeded, deps }
}

test(`rollup write: the best of ${BATCHES} batches of ${BATCH_REQUESTS} events is within 300 ms`, async () => {
  const { seeded, deps } = await build()
  const result = await measure((index) =>
    consumeAnalyticsEvent(
      deps,
      seeded.organizationId,
      sentEnvelope(seeded.organizationId, sentAt(index).toISOString(), {
        messageId: formatId('msg', crypto.randomUUID().replaceAll('-', '')) as MessageId,
        channel: CHANNELS[index % CHANNELS.length],
      })
    )
  )
  console.log(summary('rollup write', result))
  expect(result.bestMs).toBeLessThan(300)
}, 120_000)

test(`series read: the best of ${BATCHES} batches of ${BATCH_REQUESTS} reads is within 250 ms`, async () => {
  const { seeded, deps } = await build()
  const caller = {
    organizationId: seeded.organizationId,
    userId: seeded.owner.userId,
    role: 'owner' as const,
  }
  const result = await measure((index) =>
    Analytics.series(deps, caller, {
      from: '2025-01-01',
      to: '2025-12-31',
      metric: 'sends',
      limit: 20,
      ...(index % 2 === 0 ? { groupBy: 'channel' as const } : {}),
    })
  )
  console.log(summary('series read', result))
  expect(result.bestMs).toBeLessThan(250)
}, 120_000)

import { expect, test } from 'bun:test'
import { encodeCursor, formatId, type MembershipId, type ProspectId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '../src/adapters/memory/core-store'
import * as Prospects from '../src/modules/prospect/service'
import { seedOrganization } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The hot paths: the Prospect list a Rep opens all day, and the identity lookup that every create,
// edit, import row and CRM sync makes to find the Prospect an email or phone already belongs to.
// Complexity: the list is O(page size) in the number of Prospects: the visibility and filters are
// served by the (organization, created_at, id) keyset indexes, a cursor is a range start and never
// an offset, and the page's fields are read with one query for the whole page. The identity lookup
// is O(1): one read of the primary key (organization, kind, value). Input: one Organization with
// 100,000 Prospects over 40 days, 20 Reps, and an email each. The memory adapter keeps an ordered
// list and a map, so this budget guards the service's own work (a hidden full read, a per-row query,
// a sort) and not the database, whose plans the integration suite checks with EXPLAIN.
// Typical best batch of 500 calls (measured on the dev laptop): first page 41 ms, deep cursor and
// owner filter 47 ms, identity lookup 0.3 ms. Budgets: about 5x, rounded up (the identity lookup
// is so small that its budget is a floor of a few milliseconds, not 5x).
const ROWS = 100_000
const REPS = 20
const PAGE = 50
const DAY = 86_400_000
const FIRST_DAY = new Date('2026-01-01T00:00:00Z').getTime()

async function build() {
  const store = createMemoryCoreStore()
  const seeded = await seedOrganization(store, Array(REPS).fill('rep'))
  const reps = seeded.members.filter((m) => m.role === 'rep')
  const seeds = Array.from({ length: ROWS }, (_, index) => {
    const id = formatId('prs', crypto.randomUUID()) as ProspectId
    const createdAt = new Date(FIRST_DAY + Math.floor((index * 40 * DAY) / ROWS))
    return {
      record: {
        id,
        companyId: null,
        ownerMembershipId: (reps[index % REPS]?.id ?? null) as MembershipId | null,
        status: 'active' as const,
        source: 'import',
        tags: [],
        notes: null,
        createdAt,
        updatedAt: createdAt,
      },
      fields: [
        {
          field: 'email',
          value: `p${index}@example.test`,
          source: 'import',
          sourceRef: 'bench',
          setAt: createdAt,
          setByUserId: null,
        },
        {
          field: 'firstName',
          value: `First${index}`,
          source: 'import',
          sourceRef: 'bench',
          setAt: createdAt,
          setByUserId: null,
        },
      ],
    }
  })
  store.seedProspects(seeded.organizationId, seeds)
  return { store, seeded, reps, seeds }
}

const deps = (store: Awaited<ReturnType<typeof build>>['store']) => ({ store })

test(`prospect list, first page: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within 200 ms`, async () => {
  const { store, seeded } = await build()
  const caller = {
    userId: seeded.owner.userId,
    organizationId: seeded.organizationId,
    role: 'owner' as const,
  }

  const result = await measure(() => Prospects.list(deps(store), caller, { limit: PAGE }))

  console.log(summary('prospect list, first page', result))
  expect(result.bestMs).toBeLessThan(200)
})

test(`prospect list, deep cursor and owner filter: the best of ${BATCHES} batches is within 250 ms`, async () => {
  const { store, seeded, reps, seeds } = await build()
  const caller = {
    userId: seeded.owner.userId,
    organizationId: seeded.organizationId,
    role: 'owner' as const,
  }
  const deepRecord = seeds[Math.floor(ROWS * 0.1)]?.record
  if (!deepRecord) {
    throw new Error('no deep record')
  }
  const cursor = encodeCursor({ createdAt: deepRecord.createdAt.toISOString(), id: deepRecord.id })
  const rep = reps[3]

  const result = await measure((index) =>
    index % 2 === 0
      ? Prospects.list(deps(store), caller, { limit: PAGE, cursor })
      : Prospects.list(deps(store), caller, { limit: PAGE, ownerMembershipId: rep?.id })
  )

  console.log(summary('prospect list, deep cursor and owner filter', result))
  expect(result.bestMs).toBeLessThan(250)
})

test(`prospect identity lookup: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within 5 ms`, async () => {
  const { store, seeded } = await build()

  const result = await measure((index) =>
    store.withOrganization(seeded.organizationId, (scope) =>
      scope.findProspectByIdentity(
        'email',
        index % 4 === 0 ? 'nobody@example.test' : `p${(index * 7919) % ROWS}@example.test`
      )
    )
  )

  console.log(summary('prospect identity lookup', result))
  expect(result.bestMs).toBeLessThan(5)
})

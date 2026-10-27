import { expect, test } from 'bun:test'
import { createMemoryCoreStore } from '../src/adapters/memory/core-store'
import { lookupMembership } from '../src/modules/internal/service'
import { type SeededOrganization, seedOrganization } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The hot path: the lookup the auth service's token hook makes on every sign-in and refresh.
// Complexity: O(1) in the number of Organizations, members and users: two indexed reads (the
// directory function by user id, then the Membership by Organization and user id), no list, no
// count, no write. Input: 20 Organizations of 20 members each (400 memberships), looked up in
// turn, a found user, an unknown one and a member of a suspended Organization. The memory adapter
// scans instead of using an index, so this budget guards the service function's own work (extra
// reads, parsing, a hidden loop) and not the database, which the integration suite covers.
// Typical best batch for 500 lookups: 0.8 ms on the dev laptop (1.2 ms before the memory store built
// each Organization's scope once). The GitHub runner was 3.7 ms before that change (2.4 to 4.7 over
// ten runs, 6.0 and 6.2 in two noisy ones), so about 3x the laptop; the budget is about 5x that
// estimate, 12 ms, and is to be re-read from CI logs after this lands.
const BUDGET_MS = 12

async function build() {
  const store = createMemoryCoreStore()
  const organizations: SeededOrganization[] = []
  for (let index = 0; index < 20; index++) {
    organizations.push(await seedOrganization(store, Array(19).fill('rep')))
  }
  const last = organizations[19]
  if (last) {
    store.setOrganizationStatus(last.organizationId, 'suspended')
  }
  const users = organizations.flatMap((organization) => organization.members.map((m) => m.userId))
  return { store, users }
}

test(`membership lookup: the best of ${BATCHES} batches of ${BATCH_REQUESTS} lookups is within ${BUDGET_MS} ms`, async () => {
  const { store, users } = await build()
  const unknown = `usr_${'f'.repeat(32)}` as (typeof users)[number]

  const result = await measure(async (index) => {
    const userId = index % 5 === 0 ? unknown : (users[(index * 7) % users.length] ?? unknown)
    return lookupMembership({ store }, userId)
  })

  console.log(summary('membership lookup', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})

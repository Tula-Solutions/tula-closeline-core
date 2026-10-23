import { expect, test } from 'bun:test'
import {
  type ConsentChannel,
  type ContactCheckRequest,
  formatId,
  type ProspectId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '../src/adapters/memory/core-store'
import * as ContactChecks from '../src/modules/contact-check/service'
import { hashAddress } from '../src/modules/suppression/address'
import { createTestDeps, seedOrganization, TEST_CONSENT_HASH_KEY } from '../src/testing'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The hot path: the Contact Check, asked before every call, text or message an Agent or a Rep
// sends. Complexity: O(1) in the size of the Organization. One check makes at most five reads that
// the indexes serve by key (the Organization, the Prospect, its identity of the channel's kind,
// the live Suppression entry by (kind, hash), the latest Contact Consent event of the Prospect on
// the channel) and one insert of a log row; about one check in sixteen also deletes at most 100
// expired log rows by the (organization, checked_at) index. Nothing scans the Prospects, the
// Suppression list or the log. Input: one Organization with 20,000 Prospects, a Suppression list
// of 20,000 entries, 50,000 log rows and a granted consent for every other Prospect on sms. The
// memory adapter keeps ordered lists and maps, so this budget guards the service's own work (a
// hidden full read, a per-row query, a sort) and not the database, whose plans the integration
// suite checks with EXPLAIN.
// Typical best batch of 500 checks (measured on the dev laptop): 300 ms, median 316 ms (the memory
// adapter's purge filters its whole log on one check in sixteen, which Postgres does by index).
// The budget is about 5x, rounded up.
const ROWS = 20_000
const LOG_ROWS = 50_000

async function build() {
  const store = createMemoryCoreStore()
  const seeded = await seedOrganization(store, [])
  const at = new Date('2026-01-01T00:00:00Z')
  const ids = Array.from({ length: ROWS }, () => formatId('prs', crypto.randomUUID()) as ProspectId)
  store.seedProspects(
    seeded.organizationId,
    ids.map((id, index) => ({
      record: {
        id,
        companyId: null,
        ownerMembershipId: null,
        status: 'active' as const,
        source: 'import',
        tags: [],
        notes: null,
        createdAt: at,
        updatedAt: at,
      },
      fields: [
        {
          field: 'email',
          value: `p${index}@example.test`,
          source: 'import',
          sourceRef: 'bench',
          setAt: at,
          setByUserId: null,
        },
        {
          field: 'phone',
          value: `+1415${String(index).padStart(7, '0')}`,
          source: 'import',
          sourceRef: 'bench',
          setAt: at,
          setByUserId: null,
        },
      ],
    }))
  )
  ids.forEach((id, index) => {
    if (index % 2 === 0) {
      store.seedConsentEvent(seeded.organizationId, id, 'sms', 'granted')
    }
  })
  await store.withOrganization(seeded.organizationId, async (scope) => {
    await scope.lockOrganization()
    for (let index = 0; index < ROWS; index += 2) {
      await scope.insertSuppressionEntry({
        id: formatId('sup', crypto.randomUUID()),
        addressKind: 'email',
        addressHash: hashAddress(
          TEST_CONSENT_HASH_KEY,
          seeded.organizationId,
          'email',
          `p${index + 1}@example.test`
        ),
        maskedAddress: 'p***@example.test',
        reason: 'manual',
        channel: null,
        sourceRef: null,
        addedByUserId: null,
        now: at,
      })
    }
    for (let index = 0; index < LOG_ROWS; index++) {
      await scope.insertContactCheck({
        id: formatId('chk', crypto.randomUUID()),
        prospectId: ids[index % ROWS] ?? null,
        channel: 'email',
        purpose: 'reply',
        caller: 'bench',
        allowed: true,
        code: null,
        basis: 'reply',
        checkedAt: new Date(at.getTime() + index),
      })
    }
  })
  return { store, seeded, ids }
}

const CHANNELS: readonly ConsentChannel[] = ['email', 'sms', 'phone', 'whatsapp', 'linkedin']

test(`contact check: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within 1500 ms`, async () => {
  const { store, seeded, ids } = await build()
  const deps = createTestDeps({ store })

  const result = await measure((index) => {
    const request: ContactCheckRequest = {
      organizationId: seeded.organizationId,
      prospectId: ids[(index * 7919) % ROWS] as ProspectId,
      channel: CHANNELS[index % CHANNELS.length] as ConsentChannel,
      purpose: 'agent_initiated',
      caller: 'bench',
    }
    return ContactChecks.check(deps, request)
  })

  console.log(summary('contact check', result))
  expect(result.bestMs).toBeLessThan(1500)
})

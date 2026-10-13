import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDb, withOrganization } from 'tula-closeline-db'
import { organizations } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { LastOwnerError } from '~/ports/core-store'
import { describeCoreStore } from '~/ports/core-store.behaviour'
import { seedOrganization } from '~/testing'
import { createPostgresCoreStore } from './core-store'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresCoreStore(db)

afterAll(close)

describeCoreStore('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describe('CoreStore: postgres, under concurrency', () => {
  test('two Owners demoting each other at once leave one Owner and one refusal', async () => {
    const seeded = await seedOrganization(store, ['owner'])
    const [first, second] = seeded.members
    if (!first || !second) {
      throw new Error('seed made no pair of Owners')
    }
    const now = new Date()

    const results = await Promise.allSettled([
      store.withOrganization(seeded.organizationId, (s) => s.setRole(first.id, 'rep', now)),
      store.withOrganization(seeded.organizationId, (s) => s.setRole(second.id, 'rep', now)),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(LastOwnerError)
    const owners = await store.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    expect(owners.filter((m) => m.role === 'owner')).toHaveLength(1)
  })

  test('a failure other than a rule is thrown as it came, not as a rule error', async () => {
    const seeded = await seedOrganization(store)

    await expect(
      store.withOrganization(seeded.organizationId, (s) =>
        s.insertOrganization({ name: 'Again', region: 'us', now: new Date() })
      )
    ).rejects.not.toBeInstanceOf(LastOwnerError)
  })
})

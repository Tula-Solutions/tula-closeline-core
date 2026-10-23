import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { OrganizationId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { createPostgresOutboxStore } from '~/adapters/postgres/outbox-store'
import { harness, owner, service, urls } from '~/integration-harness'
import { drainOutbox } from '~/modules/outbox/drain'
import { publicCaller } from '~/testing'

const options = { batchSize: 10, leaseMs: 30_000, publishTimeoutMs: 2_000, pollIntervalMs: 50 }

/** One outbox row as the probe reads it. */
type OutboxProbe = { id: string; topic: string; published: boolean; attempts: number }

/** The outbox rows of one Organization, read as the owner inside its scope. */
async function rowsOf(organizationId: OrganizationId): Promise<OutboxProbe[]> {
  const { rows } = await withOrganization(owner.db, organizationId, (tx) =>
    tx.execute<OutboxProbe>(
      sql`select id, topic, published_at is not null as published, attempts from core.outbox order by id`
    )
  )
  return rows
}

/** Everything the harness queue holds, acknowledged. */
async function received(h: Awaited<ReturnType<typeof harness>>) {
  const out: { id: string; type: string; organizationId: string }[] = []
  for (;;) {
    const batch = await h.deps.events.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 60,
      waitSeconds: 0,
    })
    if (batch.length === 0) {
      return out
    }
    for (const delivery of batch) {
      if (delivery.kind === 'message') {
        out.push({
          id: delivery.envelope.id,
          type: delivery.envelope.type,
          organizationId: delivery.envelope.organizationId,
        })
        await h.deps.events.acknowledge(delivery.receipt)
      }
    }
  }
}

describe('the outbox, over Postgres', () => {
  test('a Prospect change writes its event in the same transaction and the drain publishes it once', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const theirs = await h.signUp()
    const api = publicCaller(h)
    const me = { userId: mine.userId, role: 'owner' as const }

    for (const name of ['Ada', 'Grace', 'Edith']) {
      const made = await api(me, mine.organizationId, 'POST', '/prospects', {
        firstName: name,
        email: `${name}@example.test`,
      })
      expect(made.status).toBe(201)
    }

    const before = await rowsOf(mine.organizationId)
    expect(before.filter((row) => row.topic === 'prospect.created')).toHaveLength(3)
    expect(before.every((row) => !row.published)).toBe(true)
    expect(await rowsOf(theirs.organizationId)).toEqual([])
    expect((await received(h)).filter((m) => m.organizationId === mine.organizationId)).toEqual([])

    // Other suites share this database, so the drain may also take their rows; only ours are checked.
    for (let pass = 0; pass < 20; pass++) {
      const result = await drainOutbox(
        { ...h.deps, outbox: createPostgresOutboxStore(service.db) },
        options
      )
      if (result.claimed === 0) {
        break
      }
    }

    const after = await rowsOf(mine.organizationId)
    expect(after.every((row) => row.published)).toBe(true)
    const mineSent = (await received(h)).filter((m) => m.organizationId === mine.organizationId)
    expect(mineSent.map((m) => m.id).sort()).toEqual(after.map((row) => row.id).sort())
    expect(new Set(mineSent.map((m) => m.id)).size).toBe(after.length)
  })

  test('three instances draining at once publish every row exactly once', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const api = publicCaller(h)
    const me = { userId: mine.userId, role: 'owner' as const }
    for (let i = 0; i < 25; i++) {
      const made = await api(me, mine.organizationId, 'POST', '/prospects', {
        firstName: `P${i}`,
        email: `p${i}@example.test`,
      })
      expect(made.status).toBe(201)
    }
    // Each instance has its own pool, as separate processes would.
    const pools = [createDb(urls.service), createDb(urls.service), createDb(urls.service)]
    try {
      const drains = pools.map((pool) => ({
        ...h.deps,
        outbox: createPostgresOutboxStore(pool.db),
        store: createPostgresCoreStore(pool.db),
      }))
      const loop = async (deps: (typeof drains)[number]) => {
        for (let pass = 0; pass < 30; pass++) {
          const result = await drainOutbox(deps, { ...options, batchSize: 5 })
          if (result.claimed === 0) {
            return
          }
        }
      }

      await Promise.all(drains.map(loop))
    } finally {
      await Promise.all(pools.map((pool) => pool.close()))
    }

    const rows = await rowsOf(mine.organizationId)
    expect(rows).toHaveLength(25)
    expect(rows.every((row) => row.published)).toBe(true)
    expect(rows.every((row) => row.attempts === 1)).toBe(true)
    const sent = (await received(h)).filter((m) => m.organizationId === mine.organizationId)
    expect(sent).toHaveLength(25)
    expect(new Set(sent.map((m) => m.id)).size).toBe(25)
  })
})

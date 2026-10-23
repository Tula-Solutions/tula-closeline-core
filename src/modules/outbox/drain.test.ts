import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createdEvent, enqueueEvents, newOutboxId } from '~/modules/prospect/events'
import { createTestDeps, drainTestOutbox, seedOrganization } from '~/testing'
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffMs, drainOutbox, startOutboxDrain } from './drain'

const START = Date.parse('2026-03-01T00:00:00Z')

/** A memory store on a clock the test moves, one Organization, and the container pieces the drain uses. */
async function setup() {
  const store = createMemoryCoreStore()
  const deps = createTestDeps({ store, clockStart: new Date(START).toISOString() })
  // `clock.at += ms` moves the app's clock, which the memory store also reads.
  const clock = {
    get at() {
      return deps.clock.now().getTime()
    },
    set at(next: number) {
      deps.clock.advance(`${next - deps.clock.now().getTime()}ms`)
    },
  }
  const { organizationId } = await seedOrganization(store, [])
  const publish = (count = 1, traceId = 'req_trace_1') => {
    const ids = Array.from({ length: count }, () => formatId('prs', crypto.randomUUID()))
    return store
      .withOrganization(organizationId, (scope) =>
        enqueueEvents(
          scope,
          organizationId,
          traceId,
          ids.map((prospectId) =>
            createdEvent({ prospectId, companyId: null, ownerMembershipId: null, source: 'manual' })
          )
        )
      )
      .then(() => ids)
  }
  /** Everything on the events queue, acknowledged. */
  const received = async () => {
    const out: { id: string; type: string; organizationId: string; payload: unknown }[] = []
    for (;;) {
      const batch = await deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        return out
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          const { envelope } = delivery
          out.push({
            id: envelope.id,
            type: envelope.type,
            organizationId: envelope.organizationId,
            payload: envelope.payload,
          })
          await deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  return { store, deps, clock, organizationId, publish, received }
}

describe('the outbox', () => {
  test('a change writes its event to the outbox and nothing reaches the queue before the drain', async () => {
    const t = await setup()
    await t.publish(2)

    expect(t.store.outbox.rows().map((row) => [row.topic, row.publishedAt])).toEqual([
      ['prospect.created', null],
      ['prospect.created', null],
    ])
    expect(await t.received()).toEqual([])
  })

  test('an event written in a transaction that fails is not stored', async () => {
    const t = await setup()

    await expect(
      t.store.withOrganization(t.organizationId, async (scope) => {
        await enqueueEvents(scope, t.organizationId, 'req_trace_1', [
          createdEvent({
            prospectId: formatId('prs', crypto.randomUUID()),
            companyId: null,
            ownerMembershipId: null,
            source: 'manual',
          }),
        ])
        throw new Error('the change failed')
      })
    ).rejects.toThrow('the change failed')

    expect(t.store.outbox.rows()).toEqual([])
  })

  test('an event the schema refuses fails the transaction instead of being stored', async () => {
    const t = await setup()

    await expect(
      t.store.withOrganization(t.organizationId, (scope) =>
        enqueueEvents(scope, t.organizationId, 'req_trace_1', [
          createdEvent({
            prospectId: 'not-an-id',
            companyId: null,
            ownerMembershipId: null,
            source: 'manual',
          } as never),
        ])
      )
    ).rejects.toThrow()

    expect(t.store.outbox.rows()).toEqual([])
  })

  test('the dedupe key is the event id: re-deciding an event adds no second row', async () => {
    const t = await setup()
    const event = createdEvent({
      prospectId: formatId('prs', crypto.randomUUID()),
      companyId: null,
      ownerMembershipId: null,
      source: 'manual',
    })
    const write = () =>
      t.store.withOrganization(t.organizationId, (scope) =>
        enqueueEvents(scope, t.organizationId, 'req_trace_1', [event])
      )

    await write()
    await write()

    const rows = t.store.outbox.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.dedupeKey).toBe(event.id)
  })
})

describe('draining the outbox', () => {
  test('publishes each event once, with the row id as the message id, then completes the row', async () => {
    const t = await setup()
    const prospectIds = await t.publish(3, 'req_trace_9')

    const result = await drainTestOutbox(t.deps)

    expect(result).toEqual({ claimed: 3, published: 3, failed: 0, parked: 0 })
    const messages = await t.received()
    expect(messages.map((message) => message.id).sort()).toEqual(
      t.store.outbox
        .rows()
        .map((row) => row.id)
        .sort()
    )
    expect(messages.every((message) => message.id.startsWith('obx_'))).toBe(true)
    expect(messages.every((message) => message.type === 'prospect.created')).toBe(true)
    expect(messages.every((message) => message.organizationId === t.organizationId)).toBe(true)
    expect(
      messages.map((message) => (message.payload as { prospectId: string }).prospectId).sort()
    ).toEqual([...prospectIds].sort())
    expect(t.store.outbox.rows().every((row) => row.publishedAt !== null)).toBe(true)
    expect(await drainTestOutbox(t.deps)).toMatchObject({ claimed: 0 })
  })

  test('keeps the event time and trace id of the decision, not of the drain', async () => {
    const t = await setup()
    await t.publish(1, 'req_trace_7')
    t.clock.at += 3_600_000

    await drainTestOutbox(t.deps)

    const delivery = (
      await t.deps.events.receive({ maxMessages: 1, visibilityTimeoutSeconds: 60, waitSeconds: 0 })
    )[0]
    if (delivery?.kind !== 'message') {
      throw new Error('no message was published')
    }
    expect(delivery.envelope.traceId).toBe('req_trace_7')
    expect(delivery.envelope.occurredAt).toBe(
      t.store.outbox.rows()[0]?.payload.occurredAt as string
    )
  })

  test('a failed publish fails the row with a growing, jittered backoff, then succeeds', async () => {
    const t = await setup()
    await t.publish(1)
    const failures: { code: string; delay: number; attempts: number }[] = []
    const outbox = {
      ...t.deps.outbox,
      claim: t.deps.outbox.claim,
      complete: t.deps.outbox.complete,
      fail: async (
        row: { organizationId: typeof t.organizationId; id: string },
        code: string,
        delay: number
      ) => {
        failures.push({ code, delay, attempts: t.store.outbox.rows()[0]?.attempts ?? 0 })
        await t.deps.outbox.fail(row, code, delay)
      },
    }
    let broken = true
    const events = {
      ...t.deps.events,
      publishBatch: (envelopes: Parameters<typeof t.deps.events.publishBatch>[0]) => {
        if (broken) {
          return Promise.reject(
            Object.assign(new Error('boom: secret detail'), { code: 'queue.unavailable' })
          )
        }
        return t.deps.events.publishBatch(envelopes)
      },
    }
    const deps = { events, outbox, logger: t.deps.logger }
    const options = {
      batchSize: 10,
      leaseMs: 60_000,
      publishTimeoutMs: 1_000,
      pollIntervalMs: 50,
      random: () => 0,
    }

    for (let pass = 0; pass < 4; pass++) {
      expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 1, failed: 1 })
      // Not due while it waits: another pass finds nothing.
      expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 0 })
      t.clock.at += 10 * 60_000
    }
    expect(failures.map((failure) => failure.delay)).toEqual([
      BACKOFF_BASE_MS / 2,
      BACKOFF_BASE_MS,
      BACKOFF_BASE_MS * 2,
      BACKOFF_BASE_MS * 4,
    ])
    expect(failures.every((failure) => failure.code === 'queue.unavailable')).toBe(true)
    expect(t.deps.logLines.join('\n')).not.toContain('secret detail')

    broken = false
    expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 1, published: 1, failed: 0 })
    expect((await t.received()).length).toBe(1)
    expect(t.store.outbox.rows()[0]?.attempts).toBe(5)
  })

  test('a publish that never answers times out, fails the row and leaves the pass finished', async () => {
    const t = await setup()
    await t.publish(1)
    const deps = {
      ...t.deps,
      events: { ...t.deps.events, publishBatch: () => new Promise<never>(() => undefined) },
    }

    const result = await drainOutbox(deps, {
      batchSize: 10,
      leaseMs: 60_000,
      publishTimeoutMs: 100,
      pollIntervalMs: 50,
    })

    expect(result).toMatchObject({ claimed: 1, published: 0, failed: 1 })
    expect(t.store.outbox.rows()[0]?.lastErrorCode).toBe('outbox.publish_timeout')
  })

  test("a message the queue refuses is failed with the queue's code; the rest of the batch is completed", async () => {
    const t = await setup()
    await t.publish(2)
    const [first] = t.store.outbox.rows()
    const deps = {
      ...t.deps,
      events: {
        ...t.deps.events,
        publishBatch: async (envelopes: Parameters<typeof t.deps.events.publishBatch>[0]) => {
          const ok = envelopes.filter((envelope) => envelope.id !== first?.id)
          const sent = await t.deps.events.publishBatch(ok)
          return {
            sent: sent.sent,
            failed: envelopes
              .filter((envelope) => envelope.id === first?.id)
              .map((envelope) => ({
                id: envelope.id,
                code: 'queue.throttled',
                senderFault: false,
              })),
          }
        },
      },
    }

    const result = await drainTestOutbox(deps)

    expect(result).toMatchObject({ claimed: 2, published: 1, failed: 1 })
    expect(
      t.store.outbox.rows().map((row) => [row.publishedAt !== null, row.lastErrorCode])
    ).toEqual([
      [false, 'queue.throttled'],
      [true, null],
    ])
  })

  test('a row that cannot become an event is failed on its own and does not block the others', async () => {
    const t = await setup()
    await t.publish(1)
    const broken = newOutboxId(START + 1)
    await t.store.withOrganization(t.organizationId, (scope) =>
      scope.enqueueOutbox({
        id: broken,
        topic: 'no.such_topic',
        payload: { eventId: 'x' },
        dedupeKey: 'x',
      })
    )

    const result = await drainTestOutbox(t.deps)

    expect(result).toMatchObject({ claimed: 2, published: 1, failed: 1 })
    expect(t.store.outbox.rows().find((row) => row.id === broken)?.lastErrorCode).toBe(
      'outbox.invalid_event'
    )
  })

  test('a row failing on its 50th claim is parked and logged without its payload', async () => {
    const t = await setup()
    const [prospectId] = await t.publish(1, 'req_trace_secret')
    const row = t.store.outbox.rows()[0]
    if (!row || !prospectId) {
      throw new Error('no row was written')
    }
    for (let claim = 1; claim < 49; claim++) {
      await t.deps.outbox.claim(1, 1_000)
      await t.deps.outbox.fail(
        { organizationId: t.organizationId, id: row.id },
        'outbox.publish_failed',
        0
      )
    }
    const deps = {
      ...t.deps,
      events: { ...t.deps.events, publishBatch: () => Promise.reject(new Error('down')) },
    }

    const options = { batchSize: 10, leaseMs: 60_000, publishTimeoutMs: 1_000, pollIntervalMs: 50 }
    expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 1, failed: 1, parked: 0 })
    t.clock.at += 24 * 3_600_000
    expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 1, failed: 1, parked: 1 })
    t.clock.at += 24 * 3_600_000
    expect(await drainOutbox(deps, options)).toMatchObject({ claimed: 0 })

    const logs = t.deps.logLines.join('\n')
    expect(logs).toContain('parked')
    expect(logs).toContain(row.id)
    expect(logs).not.toContain(prospectId)
    expect(logs).not.toContain('req_trace_secret')
  })

  test('two drains running at once never publish a row twice within a lease', async () => {
    const t = await setup()
    await t.publish(35)
    // Each publish yields, so the drains interleave as two instances would.
    const events = {
      ...t.deps.events,
      publishBatch: async (envelopes: Parameters<typeof t.deps.events.publishBatch>[0]) => {
        await Bun.sleep(2)
        return t.deps.events.publishBatch(envelopes)
      },
    }
    const options = { batchSize: 10, leaseMs: 60_000, publishTimeoutMs: 1_000, pollIntervalMs: 50 }
    const loop = async () => {
      let total = 0
      for (;;) {
        const pass = await drainOutbox({ ...t.deps, events }, options)
        if (pass.claimed === 0) {
          return total
        }
        total += pass.published
      }
    }

    const [a, b, c] = await Promise.all([loop(), loop(), loop()])

    expect(a + b + c).toBe(35)
    const ids = (await t.received()).map((message) => message.id)
    expect(ids).toHaveLength(35)
    expect(new Set(ids).size).toBe(35)
  })

  test('a drain that dies before completing leaves the row to a second drain after the lease, with the same message id', async () => {
    const t = await setup()
    await t.publish(1)
    const lost = {
      ...t.deps.outbox,
      complete: () => Promise.reject(new Error('the database went away')),
    }
    const options = { batchSize: 10, leaseMs: 1_000, publishTimeoutMs: 500, pollIntervalMs: 50 }

    await drainOutbox({ ...t.deps, outbox: lost }, options)
    expect(await drainOutbox(t.deps, options)).toMatchObject({ claimed: 0 })
    t.clock.at += 1_100
    expect(await drainOutbox(t.deps, options)).toMatchObject({ claimed: 1, published: 1 })

    const ids = (await t.received()).map((message) => message.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1] as string)
  })

  test('the loop drains until aborted and then settles', async () => {
    const t = await setup()
    await t.publish(3)
    const controller = new AbortController()

    const running = startOutboxDrain(
      t.deps,
      { batchSize: 2, leaseMs: 60_000, publishTimeoutMs: 1_000, pollIntervalMs: 50 },
      controller.signal
    )
    await Bun.sleep(150)
    controller.abort()
    await running

    expect(t.store.outbox.rows().every((row) => row.publishedAt !== null)).toBe(true)
  })
})

describe('backoffMs', () => {
  test('doubles from the base, stays inside the upper half of its step and never passes the cap', () => {
    expect([1, 2, 3, 4].map((attempt) => backoffMs(attempt, () => 0))).toEqual([
      500, 1000, 2000, 4000,
    ])
    for (let attempt = 1; attempt <= 60; attempt++) {
      const low = backoffMs(attempt, () => 0)
      const high = backoffMs(attempt, () => 0.999999)
      expect(high).toBeGreaterThanOrEqual(low)
      expect(high).toBeLessThanOrEqual(BACKOFF_CAP_MS)
      expect(high).toBeLessThanOrEqual(86_400_000)
    }
    expect(backoffMs(50, () => 0.999999)).toBe(BACKOFF_CAP_MS - 1)
  })
})

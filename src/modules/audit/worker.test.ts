import { describe, expect, spyOn, test } from 'bun:test'
import {
  type AuditEventId,
  formatId,
  type MembershipId,
  type OrganizationId,
  type ProspectId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import * as Audit from './service'
import { processAuditMessages, startAuditWorker } from './worker'

const CALL_ID = 'call_0123456789abcdef0123456789abcdef'
const eventId = () => formatId('aud', crypto.randomUUID().replaceAll('-', '')) as AuditEventId

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin'])
  const other = await seedOrganization(memory, ['admin'], 'Other')
  const signal = new AbortController().signal
  /** Publishes the way the kit's audit recorder does: the event id is the envelope id. */
  const publish = (organizationId: OrganizationId, id: string = eventId(), over = {}) =>
    harness.deps.audit.publish({
      id,
      type: 'audit.recorded',
      version: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      organizationId,
      traceId: id,
      payload: {
        actor: { kind: 'system' },
        action: 'voice.call_started',
        subject: { type: 'call', id: CALL_ID },
        metadata: { seconds: 3 },
        ...over,
      },
    })
  const events = async (org = seeded) =>
    (
      await Audit.list(
        harness.deps,
        { organizationId: org.organizationId, userId: org.owner.userId, role: 'owner' },
        { limit: 100 }
      )
    ).items
  const run = () => processAuditMessages(harness.deps, signal)
  return { harness, seeded, other, publish, events, run }
}

describe('audit.recorded consumer', () => {
  test('a valid message is recorded in its Organization and acknowledged', async () => {
    const { harness, seeded, publish, events, run } = await setup()
    await publish(seeded.organizationId)
    expect(await run()).toBe(1)
    const [event] = await events()
    expect(event?.action).toBe('voice.call_started')
    expect(event?.actor).toEqual({ kind: 'system' })
    expect(event?.subject).toEqual({ type: 'call', id: CALL_ID })
    expect(event?.metadata).toEqual({ seconds: 3 })
    expect(harness.deps.audit.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a message without a Prospect is stored with none', async () => {
    const { seeded, publish, events, run } = await setup()
    await publish(seeded.organizationId)
    await run()
    expect((await events())[0]?.prospectId).toBeNull()
  })

  test('a message with a Prospect keeps it, once, and a Team Manager sees the event', async () => {
    const memory = createMemoryCoreStore()
    const harness = await createTestApp({ store: memory })
    const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
    const rep = seeded.members.find((m) => m.role === 'rep') as SeededMember
    const manager = seeded.members.find((m) => m.role === 'manager') as SeededMember
    const api = publicCaller(harness)
    const as = (
      a: { userId: SeededMember['userId']; role: Role },
      method: string,
      path: string,
      body?: unknown
    ) => api(a, seeded.organizationId, method, path, body)
    const teamId = (await as(seeded.owner, 'POST', '/teams', { name: 'North' })).body.id as string
    for (const member of [manager, rep]) {
      await as(seeded.owner, 'POST', `/teams/${teamId}/members`, {
        membershipId: member.id as MembershipId,
      })
    }
    const owned = (await as(rep, 'POST', '/prospects', { firstName: 'Ada' })).body.id as ProspectId
    const id = eventId()
    const publishOne = () =>
      harness.deps.audit.publish({
        id,
        type: 'audit.recorded',
        version: 1,
        occurredAt: '2026-01-01T00:00:00.000Z',
        organizationId: seeded.organizationId,
        traceId: id,
        payload: {
          actor: { kind: 'system' },
          action: 'voice.prospect_called',
          subject: { type: 'call', id: CALL_ID },
          prospectId: owned,
          metadata: {},
        },
      })
    await publishOne()
    await publishOne()
    const signal = new AbortController().signal
    await processAuditMessages(harness.deps, signal)
    await processAuditMessages(harness.deps, signal)
    const list = await as(manager, 'GET', '/audit-events')
    const mine = (list.body.items as { id: string; prospectId: string | null }[]).filter(
      (item) => item.id === id
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]?.prospectId).toBe(owned)
  })

  test('a member actor id becomes the membership id', async () => {
    const { seeded, publish, events, run } = await setup()
    const membershipId = seeded.owner.id
    await publish(seeded.organizationId, eventId(), { actor: { kind: 'member', id: membershipId } })
    await run()
    expect((await events())[0]?.actor).toEqual({ kind: 'member', membershipId })
  })

  test('a redelivered message records nothing more', async () => {
    const { seeded, publish, events, run } = await setup()
    const id = eventId()
    await publish(seeded.organizationId, id)
    await publish(seeded.organizationId, id)
    await run()
    await run()
    expect(await events()).toHaveLength(1)
  })

  test('an invalid message records nothing, is logged without its content and is not acknowledged', async () => {
    const { harness, seeded, publish, events, run } = await setup()
    // A member actor whose id is not a membership id, an event id that is not an audit id, and raw junk.
    await publish(seeded.organizationId, eventId(), {
      actor: { kind: 'member', id: 'not-a-membership' },
    })
    await publish(seeded.organizationId, 'not-an-audit-id')
    harness.deps.audit.publishRaw('{"nope":')
    await run()
    expect(await events()).toHaveLength(0)
    expect(harness.deps.audit.depth().inFlight).toBe(3)
    expect(harness.deps.logLines.join('\n')).not.toContain(CALL_ID)
  })

  test('an invalid message ends in the dead letters after the queue retry limit', async () => {
    const { harness, seeded, publish, run } = await setup()
    await publish(seeded.organizationId, 'not-an-audit-id')
    for (let i = 0; i < 6; i += 1) {
      harness.deps.clock.advance('2m')
      await run()
    }
    expect(harness.deps.audit.deadLetters()).toHaveLength(1)
  })

  test('a message for another Organization lands only in that one', async () => {
    const { seeded, other, publish, events, run } = await setup()
    await publish(other.organizationId)
    await run()
    expect(await events(seeded)).toHaveLength(0)
    expect(await events(other)).toHaveLength(1)
  })

  test('a message for an Organization that does not exist is dropped and acknowledged', async () => {
    const { harness, publish, run } = await setup()
    await publish(formatId('org', crypto.randomUUID().replaceAll('-', '')) as OrganizationId)
    await run()
    expect(harness.deps.audit.depth()).toEqual({ visible: 0, inFlight: 0 })
  })
})

describe('audit worker backoff', () => {
  /** Runs the loop with a fake queue that follows `script` (true = receive fails) then aborts. */
  async function drive(script: boolean[], random: () => number) {
    const { harness } = await setup()
    const controller = new AbortController()
    const delays: number[] = []
    let calls = 0
    const receive = spyOn(harness.deps.audit, 'receive').mockImplementation(async () => {
      const fails = script[calls++]
      if (calls >= script.length) {
        controller.abort()
      }
      if (fails) {
        throw new Error('queue does not exist')
      }
      return []
    })
    const errors = spyOn(harness.deps.logger, 'error')
    await startAuditWorker(harness.deps, controller.signal, {
      random,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    const logged = errors.mock.calls.map(([, fields]) => fields)
    receive.mockRestore()
    errors.mockRestore()
    return { delays, logged }
  }

  test('consecutive failures wait longer each time, up to a cap, and a success resets them', async () => {
    const { delays } = await drive(
      [true, true, true, true, true, true, true, false, true, true, true],
      () => 0
    )
    // equal jitter at random 0 is half the ceiling: 5s doubling to the 60s cap, then back to 5s
    expect(delays).toEqual([2_500, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 2_500, 5_000])
  })

  test('the jittered wait never passes the cap', async () => {
    const { delays } = await drive(Array(12).fill(true), () => 0.999999)
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000)
    expect(delays[0]).toBeLessThanOrEqual(5_000)
    expect(delays[0]).toBeGreaterThanOrEqual(2_500)
    expect(delays.at(-1)).toBeGreaterThan(50_000)
  })

  test('each failure logs its attempt count and the next delay', async () => {
    const { logged } = await drive([true, true, false], () => 0)
    expect(logged.map((f) => [f?.attempt, f?.nextDelayMs])).toEqual([
      [1, 2_500],
      [2, 5_000],
    ])
  })

  test('an abort during a long backoff stops the worker at once', async () => {
    const { harness } = await setup()
    const controller = new AbortController()
    const receive = spyOn(harness.deps.audit, 'receive').mockRejectedValue(new Error('refused'))
    let sleeping: () => void = () => {}
    const asleep = new Promise<void>((resolve) => {
      sleeping = resolve
    })
    const done = startAuditWorker(harness.deps, controller.signal, {
      random: () => 0.5,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          sleeping()
          signal.addEventListener('abort', () => resolve(), { once: true })
        }),
    })
    await asleep
    controller.abort()
    await done
    expect(receive).toHaveBeenCalledTimes(1)
    receive.mockRestore()
  })
})

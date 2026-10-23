import { describe, expect, test } from 'bun:test'
import { type AuditEventId, formatId, type OrganizationId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, seedOrganization } from '~/testing'
import * as Audit from './service'
import { processAuditMessages } from './worker'

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

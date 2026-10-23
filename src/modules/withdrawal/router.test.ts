import { describe, expect, test } from 'bun:test'
import {
  CONSENT_CHANNELS,
  type ConsentChannel,
  type OrganizationId,
  type ProspectId,
  recordedSuppressionSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, seedOrganization } from '~/testing'

const EMAIL = 'ada@example.test'
const PHONE = '+14155550123'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, [])
  const api = publicCaller(harness)
  const stop = async (body: Record<string, unknown>, headers = harness.internal()) => {
    const response = await harness.app.request('/internal/v1/consent-withdrawals', {
      method: 'POST',
      headers,
      body: JSON.stringify({ organizationId: seeded.organizationId, ...body }),
    })
    return {
      status: response.status,
      body: (await response.json()) as { error: { code: string }; prospectId?: string | null },
    }
  }
  const prospect = async (organization = seeded) => {
    const made = await api(organization.owner, organization.organizationId, 'POST', '/prospects', {
      firstName: 'Ada',
      email: EMAIL,
      phone: PHONE,
    })
    return made.body.id as ProspectId
  }
  const grant = (prospectId: ProspectId, channel: ConsentChannel, organization = seeded) =>
    memory.seedConsentEvent(organization.organizationId, prospectId, channel, 'granted')
  const check = async (
    prospectId: ProspectId,
    channel: ConsentChannel,
    organizationId: OrganizationId = seeded.organizationId
  ) => {
    const response = await harness.app.request('/internal/v1/contact-checks', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({
        organizationId,
        prospectId,
        channel,
        purpose: 'agent_initiated',
        caller: 'outbound',
      }),
    })
    return (await response.json()) as { allowed: boolean; code?: string }
  }
  const entries = async (organization = seeded) =>
    (
      await api(
        organization.owner,
        organization.organizationId,
        'GET',
        '/suppression-entries?state=active&limit=100'
      )
    ).body.items as { id: string; reason: string; sourceRef: string | null }[]
  const ledger = async (prospectId: ProspectId) =>
    (
      await api(
        seeded.owner,
        seeded.organizationId,
        'GET',
        `/prospects/${prospectId}/consent-events`
      )
    ).body.items as { channel: string; kind: string; source: string; stopAll: boolean }[]
  const queued = async () => {
    const out: string[] = []
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        return out
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          out.push(delivery.envelope.type)
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  return { harness, memory, seeded, stop, prospect, grant, check, entries, ledger, queued }
}

describe('record-withdrawal (inbound STOP)', () => {
  test('needs the internal secret', async () => {
    const { stop, harness } = await setup()
    const bad = await stop(
      { channel: 'sms', phone: PHONE, sourceRef: 'msg-1' },
      harness.internal('k', 'wrong-secret-0123456789abcdef-0123456')
    )
    expect(bad.status).toBe(401)
    const none = await harness.app.request('/internal/v1/consent-withdrawals', { method: 'POST' })
    expect(none.status).toBe(401)
  })

  test('a STOP on sms suppresses the number and withdraws sms only', async () => {
    const { stop, prospect, grant, check, entries, ledger, queued } = await setup()
    const id = await prospect()
    grant(id, 'sms')
    grant(id, 'whatsapp')
    await queued()
    expect(await check(id, 'sms')).toMatchObject({ allowed: true })
    const answer = await stop({ channel: 'sms', phone: PHONE, sourceRef: 'twilio:SM123' })
    expect(answer.status).toBe(200)
    expect(recordedSuppressionSchema.parse(answer.body)).toMatchObject({ prospectId: id })
    expect(await check(id, 'sms')).toMatchObject({ allowed: false, code: 'consent.suppressed' })
    const events = await ledger(id)
    expect(events.filter((e) => e.kind === 'withdrawn')).toEqual([
      expect.objectContaining({ channel: 'sms', source: 'stop_reply' }),
    ])
    expect(events.filter((e) => e.channel === 'whatsapp' && e.kind === 'withdrawn')).toEqual([])
    const live = await entries()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ reason: 'stop', sourceRef: 'twilio:SM123' })
    expect((await queued()).sort()).toEqual(['consent.withdrawn', 'suppression.added'])
  })

  test('is idempotent on the message', async () => {
    const { stop, prospect, entries, ledger, queued } = await setup()
    const id = await prospect()
    await queued()
    const first = await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-1' })
    await queued()
    const again = await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-1' })
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await entries()).toHaveLength(1)
    expect(await ledger(id)).toHaveLength(1)
    expect(await queued()).toEqual([])
  })

  test('stopAll withdraws every channel', async () => {
    const { stop, prospect, ledger } = await setup()
    const id = await prospect()
    expect(
      (await stop({ channel: 'sms', phone: PHONE, stopAll: true, sourceRef: 'm-2' })).status
    ).toBe(200)
    const events = await ledger(id)
    expect(events.map((e) => e.channel).sort()).toEqual([...CONSENT_CHANNELS].sort())
    expect(events.every((e) => e.stopAll && e.kind === 'withdrawn')).toBe(true)
  })

  test('an email STOP denies email at once', async () => {
    const { stop, prospect, check } = await setup()
    const id = await prospect()
    expect(await check(id, 'email')).toMatchObject({ allowed: true })
    await stop({ channel: 'email', email: 'Ada@Example.test', sourceRef: 'm-3' })
    expect(await check(id, 'email')).toMatchObject({ allowed: false, code: 'consent.suppressed' })
  })

  test('a number no Prospect holds is still suppressed', async () => {
    const { stop, entries } = await setup()
    const answer = await stop({ channel: 'sms', phone: '+14155550999', sourceRef: 'm-4' })
    expect(answer.status).toBe(200)
    expect(answer.body.prospectId).toBeNull()
    expect(await entries()).toHaveLength(1)
  })

  test('an address that does not fit the channel, or not exactly one, is request.invalid', async () => {
    const { stop, entries } = await setup()
    for (const body of [
      { channel: 'email', phone: PHONE, sourceRef: 'x' },
      { channel: 'sms', email: EMAIL, sourceRef: 'x' },
      { channel: 'sms', phone: PHONE, email: EMAIL, sourceRef: 'x' },
      { channel: 'sms', sourceRef: 'x' },
      { channel: 'sms', phone: 'not a number', sourceRef: 'x' },
    ]) {
      const answer = await stop(body)
      expect(answer.status).toBe(400)
      expect(answer.body.error.code).toBe('request.invalid')
    }
    expect(await entries()).toHaveLength(0)
  })

  test('another Organization is untouched, and an unknown or deleted one is refused', async () => {
    const { stop, prospect, grant, memory, check, entries, seeded } = await setup()
    const other = await seedOrganization(memory, [])
    const mine = await prospect()
    const theirs = await prospect(other)
    grant(mine, 'sms')
    grant(theirs, 'sms', other)
    await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-5' })
    expect(await entries()).toHaveLength(1)
    expect(await entries(other)).toHaveLength(0)
    expect(await check(theirs, 'sms', other.organizationId)).toMatchObject({ allowed: true })
    expect(await check(mine, 'sms')).toMatchObject({ allowed: false })
    const unknown = await stop({
      organizationId: 'org_00000000000040008000000000000000',
      channel: 'sms',
      phone: PHONE,
      sourceRef: 'm-6',
    })
    expect(unknown.status).toBeGreaterThanOrEqual(400)
    memory.setOrganizationStatus(seeded.organizationId, 'deleted')
    const gone = await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-7' })
    expect(gone.body.error.code).toBe('organization.deleted')
  })

  test('a suspended Organization still takes a STOP', async () => {
    const { stop, memory, seeded } = await setup()
    memory.setOrganizationStatus(seeded.organizationId, 'suspended')
    expect((await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-8' })).status).toBe(200)
  })

  test('logs nothing of the address', async () => {
    const { stop, prospect, harness } = await setup()
    await prospect()
    harness.deps.logLines.length = 0
    await stop({ channel: 'sms', phone: PHONE, sourceRef: 'm-9' })
    await stop({ channel: 'sms', phone: 'bad', sourceRef: 'm-9' })
    const lines = harness.deps.logLines.join('\n')
    expect(lines).not.toContain('4155550123')
  })
})

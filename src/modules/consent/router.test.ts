import { describe, expect, test } from 'bun:test'
import {
  CONSENT_CHANNELS,
  type ConsentChannel,
  formatId,
  type ProspectId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { recordedConsentResponseSchema } from './schema'

const WORDING = formatId('cwd', crypto.randomUUID())
const SMS_ONLY = formatId('cwd', crypto.randomUUID())

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  memory.seedConsentWording(seeded.organizationId, {
    id: WORDING,
    version: 1,
    channels: [...CONSENT_CHANNELS],
  })
  memory.seedConsentWording(seeded.organizationId, { id: SMS_ONLY, version: 1, channels: ['sms'] })
  let count = 0
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const prospect = async (actor: { userId: SeededMember['userId']; role: Role } = seeded.owner) => {
    count += 1
    const n = count
    const made = await call(actor, 'POST', '/prospects', {
      firstName: 'Ada',
      email: `ada${n}@example.test`,
      phone: `+1415555${String(1000 + n)}`,
    })
    return made.body.id as ProspectId
  }
  const grant = (
    actor: { userId: SeededMember['userId']; role: Role },
    prospectId: ProspectId,
    channel: ConsentChannel,
    extra: Record<string, unknown> = {},
    headers?: Record<string, string>
  ) =>
    call(
      actor,
      'POST',
      `/prospects/${prospectId}/consents`,
      {
        channel,
        source: 'manual',
        wordingId: WORDING,
        evidenceRef: 'signed form 17',
        ...extra,
      },
      headers
    )
  const withdraw = (
    actor: { userId: SeededMember['userId']; role: Role },
    prospectId: ProspectId,
    body: Record<string, unknown>,
    headers?: Record<string, string>
  ) => call(actor, 'POST', `/prospects/${prospectId}/consent-withdrawals`, body, headers)
  const check = async (prospectId: ProspectId, channel: ConsentChannel) => {
    const response = await harness.app.request('/internal/v1/contact-checks', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({
        organizationId: seeded.organizationId,
        prospectId,
        channel,
        purpose: 'agent_initiated',
        caller: 'outbound-agent',
      }),
    })
    return (await response.json()) as { allowed: boolean; code: string | null }
  }
  const queued = async () => {
    const out: { type: string; id: string; payload: Record<string, unknown> }[] = []
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
          out.push({
            type: delivery.envelope.type,
            id: delivery.envelope.id,
            payload: delivery.envelope.payload as Record<string, unknown>,
          })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  return {
    ...harness,
    memory,
    call,
    prospect,
    grant,
    withdraw,
    check,
    queued,
    seeded,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

const stateOf = (body: unknown, channel: ConsentChannel) =>
  recordedConsentResponseSchema.parse(body).consent.channels.find((c) => c.channel === channel)
    ?.state

describe('recording and withdrawing consent', () => {
  test('grant, withdraw, grant again drives the Contact Check', async () => {
    const { owner, prospect, grant, withdraw, check } = await setup()
    const id = await prospect()
    expect(await check(id, 'sms')).toMatchObject({ allowed: false, code: 'consent.missing' })

    const granted = await grant(owner, id, 'sms')
    expect(granted.status).toBe(201)
    expect(stateOf(granted.body, 'sms')).toBe('granted')
    expect(await check(id, 'sms')).toMatchObject({ allowed: true })

    const withdrawn = await withdraw(owner, id, { channels: ['sms'] })
    expect(withdrawn.status).toBe(201)
    expect(stateOf(withdrawn.body, 'sms')).toBe('withdrawn')
    expect(await check(id, 'sms')).toMatchObject({ allowed: false, code: 'consent.withdrawn' })

    await grant(owner, id, 'sms')
    expect(await check(id, 'sms')).toMatchObject({ allowed: true })
  })

  test('a Rep, a Manager and an Admin may record', async () => {
    const { admin, rep, owner, prospect, grant } = await setup()
    const repsOwn = await prospect(rep)
    expect((await grant(rep, repsOwn, 'phone')).status).toBe(201)
    expect((await grant(admin, repsOwn, 'phone')).status).toBe(201)
    expect((await grant(owner, repsOwn, 'whatsapp')).status).toBe(201)
  })

  test('refuses a grant without a source or a wording', async () => {
    const { owner, prospect, call } = await setup()
    const id = await prospect()
    for (const body of [
      { channel: 'sms', wordingId: WORDING, evidenceRef: 'x' },
      { channel: 'sms', source: 'manual', evidenceRef: 'x' },
      { channel: 'sms', source: 'manual', wordingId: WORDING },
      { channel: 'sms', source: 'hosted_form', wordingId: WORDING, evidenceRef: 'x' },
    ]) {
      const response = await call(owner, 'POST', `/prospects/${id}/consents`, body)
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('request.invalid')
    }
  })

  test('refuses a wording that does not exist or does not cover the channel', async () => {
    const { owner, prospect, grant } = await setup()
    const id = await prospect()
    const missing = await grant(owner, id, 'sms', {
      wordingId: formatId('cwd', crypto.randomUUID()),
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('consent.not_found')
    const wrong = await grant(owner, id, 'email', { wordingId: SMS_ONLY })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error?.code).toBe('request.invalid')
    expect((await grant(owner, id, 'sms', { wordingId: SMS_ONLY })).status).toBe(201)
  })

  test('refuses an occurredAt in the future', async () => {
    const { owner, prospect, grant } = await setup()
    const id = await prospect()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect((await grant(owner, id, 'sms', { occurredAt: future })).status).toBe(400)
  })

  test('a verbal_call grant names the Call and others do not', async () => {
    const { owner, prospect, grant } = await setup()
    const id = await prospect()
    expect((await grant(owner, id, 'phone', { source: 'verbal_call' })).status).toBe(400)
    expect(
      (await grant(owner, id, 'phone', { callId: formatId('call', crypto.randomUUID()) })).status
    ).toBe(400)
    const ok = await grant(owner, id, 'phone', {
      source: 'verbal_call',
      callId: formatId('call', crypto.randomUUID()),
    })
    expect(ok.status).toBe(201)
  })

  test('a Rep records only for a Prospect they can see', async () => {
    const { owner, rep, manager, prospect, grant, withdraw } = await setup()
    const notTheirs = await prospect(owner)
    const denied = await grant(rep, notTheirs, 'sms')
    expect(denied.status).toBe(404)
    expect(denied.body.error?.code).toBe('prospect.not_found')
    expect((await withdraw(rep, notTheirs, { all: true })).status).toBe(404)
    expect((await grant(manager, notTheirs, 'sms')).status).toBe(404)
    const theirs = await prospect(rep)
    expect((await grant(rep, theirs, 'sms')).status).toBe(201)
    expect((await grant(rep, formatId('prs', crypto.randomUUID()), 'sms')).status).toBe(404)
  })

  test('a withdrawal on one channel leaves the others, and STOP-all withdraws all', async () => {
    const { owner, prospect, grant, withdraw, check } = await setup()
    const id = await prospect()
    for (const channel of ['sms', 'phone', 'whatsapp'] as const) {
      await grant(owner, id, channel)
    }
    const one = await withdraw(owner, id, { channels: ['sms'] })
    expect(recordedConsentResponseSchema.parse(one.body).events).toHaveLength(1)
    expect(await check(id, 'phone')).toMatchObject({ allowed: true })
    expect(await check(id, 'whatsapp')).toMatchObject({ allowed: true })
    expect(await check(id, 'sms')).toMatchObject({ code: 'consent.withdrawn' })

    const all = recordedConsentResponseSchema.parse((await withdraw(owner, id, { all: true })).body)
    expect(all.events).toHaveLength(CONSENT_CHANNELS.length)
    expect(all.events.every((event) => event.stopAll)).toBe(true)
    for (const channel of ['sms', 'phone', 'whatsapp'] as const) {
      expect(await check(id, channel)).toMatchObject({ allowed: false, code: 'consent.withdrawn' })
    }
    expect(all.consent.channels.every((c) => c.state === 'withdrawn')).toBe(true)
  })

  test('refuses a withdrawal that names both or neither of channels and all', async () => {
    const { owner, prospect, withdraw } = await setup()
    const id = await prospect()
    expect((await withdraw(owner, id, {})).status).toBe(400)
    expect((await withdraw(owner, id, { all: true, channels: ['sms'] })).status).toBe(400)
  })

  test('publishes consent.granted and consent.withdrawn, and a replay publishes nothing', async () => {
    const { owner, prospect, grant, withdraw, queued } = await setup()
    const id = await prospect()
    await queued()
    const key = { 'idempotency-key': 'consent-key-0001' }
    const first = await grant(owner, id, 'sms', {}, key)
    expect(first.status).toBe(201)
    const events = await queued()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'consent.granted',
      payload: { prospectId: id, channel: 'sms', source: 'manual', wordingId: WORDING },
    })
    const replay = await grant(owner, id, 'sms', {}, key)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(await queued()).toHaveLength(0)

    await withdraw(owner, id, { all: true }, { 'idempotency-key': 'consent-key-0002' })
    const withdrawn = await queued()
    expect(withdrawn).toHaveLength(CONSENT_CHANNELS.length)
    expect(withdrawn.every((event) => event.type === 'consent.withdrawn')).toBe(true)
    expect(withdrawn.every((event) => event.payload.stopAll === true)).toBe(true)
  })

  test("a second Organization cannot record for, or read, the first one's Prospect", async () => {
    const { memory, call, owner, prospect, grant, check, seeded } = await setup()
    const id = await prospect()
    await grant(owner, id, 'sms')
    const other = await seedOrganization(memory, [])
    memory.seedConsentWording(other.organizationId, {
      id: WORDING,
      version: 1,
      channels: [...CONSENT_CHANNELS],
    })
    const response = await call(
      other.owner,
      'POST',
      `/prospects/${id}/consents`,
      { channel: 'sms', source: 'manual', wordingId: WORDING, evidenceRef: 'x' },
      undefined,
      other.organizationId
    )
    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('prospect.not_found')
    const withdrawal = await call(
      other.owner,
      'POST',
      `/prospects/${id}/consent-withdrawals`,
      { all: true },
      undefined,
      other.organizationId
    )
    expect(withdrawal.status).toBe(404)
    expect(await check(id, 'sms')).toMatchObject({ allowed: true })
    expect(newOrganizationId()).not.toBe(seeded.organizationId)
  })

  test('the response carries no address or evidence beyond the reference', async () => {
    const { owner, prospect, grant } = await setup()
    const id = await prospect()
    const text = JSON.stringify((await grant(owner, id, 'sms')).body)
    expect(text).not.toContain('example.test')
    expect(text).not.toContain('+1415555')
  })

  test('the response says when an address of the Prospect is suppressed', async () => {
    const { owner, prospect, grant, call } = await setup()
    const id = await prospect()
    expect(
      recordedConsentResponseSchema.parse((await grant(owner, id, 'sms')).body).consent
    ).toMatchObject({
      suppressed: false,
      suppressionReason: null,
    })
    const added = await call(owner, 'POST', '/suppression-entries', {
      email: 'ada1@example.test',
    })
    expect(added.status).toBe(201)
    const again = await grant(owner, id, 'email')
    expect(recordedConsentResponseSchema.parse(again.body).consent).toMatchObject({
      suppressed: true,
      suppressionReason: 'manual',
    })
  })

  test('a suspended Organization refuses a grant but still takes a withdrawal', async () => {
    const { owner, prospect, grant, withdraw, memory, seeded } = await setup()
    const id = await prospect()
    expect((await grant(owner, id, 'sms')).status).toBe(201)
    memory.setOrganizationStatus(seeded.organizationId, 'suspended')
    const refused = await grant(owner, id, 'phone')
    expect(refused.status).toBe(403)
    expect(refused.body.error?.code).toBe('organization.suspended')
    const withdrawn = await withdraw(owner, id, { channels: ['sms'] })
    expect(withdrawn.status).toBe(201)
    expect(stateOf(withdrawn.body, 'sms')).toBe('withdrawn')
  })
})

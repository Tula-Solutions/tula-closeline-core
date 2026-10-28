import { describe, expect, test } from 'bun:test'
import {
  CONSENT_CHANNELS,
  type ConsentChannel,
  consentEventPageSchema,
  evidencePageSchema,
  formatId,
  type ProspectId,
  prospectConsentSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  drainTestOutbox,
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
    text: 'I agree to be contacted.',
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
    await drainTestOutbox(harness.deps)
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

describe('reading the consent ledger', () => {
  const page = (body: unknown) => consentEventPageSchema.parse(body)

  test('the state per channel follows the ledger and flags a suppressed Prospect', async () => {
    const { owner, prospect, grant, withdraw, call } = await setup()
    const id = await prospect()
    const none = await call(owner, 'GET', `/prospects/${id}/consent`)
    expect(none.status).toBe(200)
    const empty = prospectConsentSchema.parse(none.body)
    expect(empty.channels.map((c) => c.state)).toEqual(CONSENT_CHANNELS.map(() => 'none'))
    expect(empty).toMatchObject({ suppressed: false, suppressionReason: null })

    const granted = await grant(owner, id, 'sms')
    await withdraw(owner, id, { channels: ['phone'] })
    await call(owner, 'POST', '/suppression-entries', { email: 'ada1@example.test' })
    const now = prospectConsentSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent`)).body
    )
    const sms = now.channels.find((c) => c.channel === 'sms')
    expect(sms).toMatchObject({ state: 'granted', wordingId: WORDING })
    expect(String(sms?.lastEventId)).toBe(
      String((granted.body as { events: { id: string }[] }).events[0]?.id)
    )
    expect(now.channels.find((c) => c.channel === 'phone')?.state).toBe('withdrawn')
    expect(now).toMatchObject({ suppressed: true, suppressionReason: 'manual' })
  })

  test('a Rep reads only the consent of their own Prospects', async () => {
    const { owner, rep, manager, prospect, call } = await setup()
    const repsOwn = await prospect(rep)
    const ownersOnly = await prospect(owner)
    expect((await call(rep, 'GET', `/prospects/${repsOwn}/consent`)).status).toBe(200)
    for (const path of ['consent', 'consent-events']) {
      const hidden = await call(rep, 'GET', `/prospects/${ownersOnly}/${path}`)
      expect(hidden.status).toBe(404)
      expect(hidden.body.error?.code).toBe('prospect.not_found')
    }
    // The Manager is on no Team with the Rep here, so sees neither.
    expect((await call(manager, 'GET', `/prospects/${repsOwn}/consent-events`)).status).toBe(404)
  })

  test('events come newest first, a page at a time, with a cursor', async () => {
    const { owner, prospect, grant, withdraw, call } = await setup()
    const id = await prospect()
    await grant(owner, id, 'sms')
    await grant(owner, id, 'email')
    await withdraw(owner, id, { channels: ['sms'] })
    await grant(owner, id, 'sms')

    const all = page((await call(owner, 'GET', `/prospects/${id}/consent-events`)).body)
    expect(all.items.map((e) => [e.channel, e.kind])).toEqual([
      ['sms', 'granted'],
      ['sms', 'withdrawn'],
      ['email', 'granted'],
      ['sms', 'granted'],
    ])
    expect(all.nextCursor).toBeNull()

    const first = page((await call(owner, 'GET', `/prospects/${id}/consent-events?limit=3`)).body)
    expect(first.items.map((e) => e.id)).toEqual(all.items.slice(0, 3).map((e) => e.id))
    expect(first.nextCursor).not.toBeNull()
    const second = page(
      (
        await call(
          owner,
          'GET',
          `/prospects/${id}/consent-events?limit=3&cursor=${first.nextCursor}`
        )
      ).body
    )
    expect(second.items.map((e) => e.id)).toEqual(all.items.slice(3).map((e) => e.id))
    expect(second.nextCursor).toBeNull()

    const sms = page((await call(owner, 'GET', `/prospects/${id}/consent-events?channel=sms`)).body)
    expect(sms.items).toHaveLength(3)
    expect(sms.items.every((e) => e.channel === 'sms')).toBe(true)
  })

  test('refuses a page larger than the maximum, a bad cursor and an unknown channel', async () => {
    const { owner, prospect, call } = await setup()
    const id = await prospect()
    for (const query of ['limit=101', 'limit=0', 'cursor=not-a-cursor', 'channel=fax', 'x=1']) {
      const response = await call(owner, 'GET', `/prospects/${id}/consent-events?${query}`)
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('request.invalid')
    }
  })

  test('a second Organization gets prospect.not_found for every read', async () => {
    const { owner, prospect, grant, call, memory } = await setup()
    const id = await prospect()
    await grant(owner, id, 'sms')
    const other = await seedOrganization(memory, [])
    for (const path of ['consent', 'consent-events', 'consent-evidence']) {
      const response = await call(
        other.owner,
        'GET',
        `/prospects/${id}/${path}`,
        undefined,
        undefined,
        other.organizationId
      )
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('prospect.not_found')
    }
  })

  test('evidence is for an Owner or Admin and carries the wording text shown', async () => {
    const { owner, admin, manager, rep, prospect, grant, call } = await setup()
    const id = await prospect(owner)
    await grant(owner, id, 'sms')
    for (const actor of [manager, rep]) {
      const refused = await call(actor, 'GET', `/prospects/${id}/consent-evidence`)
      expect(refused.status).toBe(403)
      expect(refused.body.error?.code).toBe('auth.forbidden')
    }
    for (const actor of [owner, admin]) {
      const response = await call(actor, 'GET', `/prospects/${id}/consent-evidence`)
      expect(response.status).toBe(200)
      const evidence = evidencePageSchema.parse(response.body)
      expect(evidence.items).toHaveLength(1)
      expect(evidence.items[0]).toMatchObject({
        channel: 'sms',
        evidenceRef: 'signed form 17',
        wording: { id: WORDING, version: 1, text: 'I agree to be contacted.' },
        submission: null,
      })
    }
  })

  test('evidence pages newest first and shows submission details for a hosted form only', async () => {
    const { owner, prospect, grant, call, memory, seeded } = await setup()
    const id = await prospect()
    await grant(owner, id, 'sms')
    await memory.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.appendConsentEvents([
        {
          id: formatId('cev', crypto.randomUUID()),
          prospectId: id,
          channel: 'email',
          kind: 'granted',
          source: 'hosted_form',
          wordingId: WORDING,
          evidenceRef: 'form-post-1',
          callId: null,
          formId: formatId('cfm', crypto.randomUUID()),
          ipAddress: '203.0.113.9',
          userAgent: 'TestBrowser/1.0',
          stopAll: false,
          recordedByUserId: null,
          occurredAt: new Date(),
        },
      ])
    })
    const first = evidencePageSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent-evidence?limit=1`)).body
    )
    expect(first.items[0]).toMatchObject({
      source: 'hosted_form',
      submission: { ipAddress: '203.0.113.9', userAgent: 'TestBrowser/1.0' },
    })
    expect(first.nextCursor).not.toBeNull()
    const second = evidencePageSchema.parse(
      (
        await call(
          owner,
          'GET',
          `/prospects/${id}/consent-evidence?limit=1&cursor=${first.nextCursor}`
        )
      ).body
    )
    expect(second.items[0]?.source).toBe('manual')
    expect(second.items[0]?.submission).toBeNull()
    // The events list never shows the submission.
    const events = JSON.stringify(
      (await call(owner, 'GET', `/prospects/${id}/consent-events`)).body
    )
    expect(events).not.toContain('203.0.113.9')
    expect(events).not.toContain('TestBrowser')
  })

  describe('evidence as CSV', () => {
    async function csv() {
      const world = await setup()
      const get = async (
        actor: { userId: SeededMember['userId']; role: Role },
        id: ProspectId,
        organizationId = world.seeded.organizationId
      ) => {
        const token = await world.bearer({ userId: actor.userId, organizationId, role: actor.role })
        const response = await world.app.request(`/v1/prospects/${id}/consent-evidence`, {
          headers: { ...token, accept: 'text/csv' },
        })
        return { response, text: await response.text() }
      }
      const append = (id: ProspectId, count: number, extra: Record<string, unknown> = {}) =>
        world.memory.withOrganization(world.seeded.organizationId, async (scope) => {
          await scope.lockOrganization()
          await scope.appendConsentEvents(
            Array.from({ length: count }, (_, n) => ({
              id: formatId('cev', crypto.randomUUID()),
              prospectId: id,
              channel: 'email' as const,
              kind: 'granted' as const,
              source: 'manual' as const,
              wordingId: WORDING,
              evidenceRef: `ref-${n}`,
              callId: null,
              formId: null,
              ipAddress: null,
              userAgent: null,
              stopAll: false,
              recordedByUserId: null,
              occurredAt: new Date(Date.now() - n * 1000),
              ...extra,
            }))
          )
        })
      return { ...world, get, append }
    }

    test('an Owner or Admin gets a header row and the wording text; others are refused', async () => {
      const { owner, admin, manager, rep, prospect, grant, get } = await csv()
      const id = await prospect(owner)
      await grant(owner, id, 'sms')

      for (const actor of [manager, rep]) {
        expect((await get(actor, id)).response.status).toBe(403)
      }
      for (const actor of [owner, admin]) {
        const { response, text } = await get(actor, id)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/csv')
        expect(response.headers.get('content-disposition')).toContain('attachment')
        const lines = text.split('\r\n').filter(Boolean)
        expect(lines[0]).toStartWith('event_id,prospect_id,channel,kind,source')
        expect(lines).toHaveLength(2)
        expect(lines[1]).toContain('I agree to be contacted.')
        expect(lines[1]).toContain('signed form 17')
      }
    })

    test('a cell with a comma, a quote or a formula is escaped, and every event of many pages is there', async () => {
      const { owner, prospect, grant, append, get } = await csv()
      const id = await prospect(owner)
      await grant(owner, id, 'sms', { evidenceRef: '=SUM(A1)' })
      await grant(owner, id, 'email', { evidenceRef: 'a, "b"' })
      await append(id, 250)

      const { text } = await get(owner, id)

      expect(text).toContain(`'=SUM(A1)`)
      expect(text).toContain('"a, ""b"""')
      // 252 events + the header; refs are unique, so none repeats across a page boundary.
      expect(text.split('\r\n').filter(Boolean)).toHaveLength(253)
      expect(new Set(text.match(/ref-\d+/g)).size).toBe(250)
    })

    test('a second Organization gets prospect.not_found, and JSON is still the default', async () => {
      const { owner, prospect, grant, get, call, memory } = await csv()
      const id = await prospect(owner)
      await grant(owner, id, 'sms')
      const other = await seedOrganization(memory, [])

      const foreign = await get(other.owner, id, other.organizationId)
      const json = await call(owner, 'GET', `/prospects/${id}/consent-evidence`)

      expect(foreign.response.status).toBe(404)
      expect(JSON.parse(foreign.text).error.code).toBe('prospect.not_found')
      expect(evidencePageSchema.parse(json.body).items).toHaveLength(1)
    })
  })
})

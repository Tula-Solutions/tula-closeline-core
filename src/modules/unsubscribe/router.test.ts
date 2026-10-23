import { describe, expect, test } from 'bun:test'
import {
  type ConsentChannel,
  type OrganizationId,
  type ProspectId,
  unsubscribeReceiptSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { processErase } from '~/modules/prospect/erase'
import {
  type ApiResponse,
  createTestApp,
  publicCaller,
  type SeededOrganization,
  seedOrganization,
} from '~/testing'
import { mintUnsubscribeToken, UNSUBSCRIBE_TOKEN_TTL_MS, type UnsubscribeClaims } from './token'

const IP = '203.0.113.9'
const EMAIL = 'ada@example.test'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, [])
  const api = publicCaller(harness)
  const key = harness.deps.env.UNSUBSCRIBE_TOKEN_KEY
  const call = (
    method: string,
    path: string,
    body?: unknown,
    organizationId: OrganizationId = seeded.organizationId
  ) => api(seeded.owner, organizationId, method, path, body)

  /** A call to a public route: no access token, the client address as the server would see it. */
  const pub = async (
    method: string,
    token: string,
    options: { body?: string; contentType?: string; address?: string } = {}
  ): Promise<ApiResponse> => {
    const response = await harness.app.request(
      `/v1/public/unsubscribe/${token}`,
      {
        method,
        headers: { 'content-type': options.contentType ?? 'application/x-www-form-urlencoded' },
        ...(options.body === undefined ? {} : { body: options.body }),
      },
      { requestIP: () => ({ address: options.address ?? IP }) }
    )
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
      retryAfter: response.headers.get('retry-after'),
    }
  }
  const click = (token: string, address?: string) =>
    pub('POST', token, { body: 'List-Unsubscribe=One-Click', ...(address ? { address } : {}) })

  const prospect = async (
    organizationId: OrganizationId = seeded.organizationId,
    email: string | undefined = EMAIL,
    actor: SeededOrganization['owner'] = seeded.owner
  ) => {
    const made = await api(actor, organizationId, 'POST', '/prospects', {
      firstName: 'Ada',
      ...(email ? { email } : {}),
      phone: '+14155550123',
    })
    await queued()
    return made.body.id as ProspectId
  }
  const token = (
    prospectId: ProspectId,
    over: Partial<UnsubscribeClaims> = {},
    organizationId: OrganizationId = seeded.organizationId
  ) =>
    mintUnsubscribeToken(key, {
      organizationId,
      prospectId,
      channel: 'email',
      expiresAt: new Date(harness.deps.clock.now().getTime() + UNSUBSCRIBE_TOKEN_TTL_MS),
      ...over,
    })
  const check = async (
    prospectId: ProspectId,
    channel: ConsentChannel = 'email',
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
  const queued = async () => {
    const out: { type: string; payload: Record<string, unknown> }[] = []
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
            payload: delivery.envelope.payload as Record<string, unknown>,
          })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  const entries = async (organizationId = seeded.organizationId) => {
    const listed = await api(
      seeded.owner,
      organizationId,
      'GET',
      '/suppression-entries?state=active&limit=100'
    )
    return listed.body.items as { id: string; reason: string; maskedAddress: string }[]
  }
  const ledger = async (prospectId: ProspectId) =>
    (await call('GET', `/prospects/${prospectId}/consent-events`)).body.items as {
      channel: string
      kind: string
      source: string
    }[]
  return {
    harness,
    memory,
    seeded,
    call,
    pub,
    click,
    prospect,
    token,
    check,
    queued,
    entries,
    ledger,
    key,
  }
}

describe('one-click unsubscribe', () => {
  test('a valid link unsubscribes the email, and the Contact Check denies email at once', async () => {
    const { prospect, token, click, check, entries, ledger } = await setupFor()
    const id = await prospect()
    expect(await check(id)).toMatchObject({ allowed: true })
    const answer = await click(token(id))
    expect(answer.status).toBe(200)
    expect(unsubscribeReceiptSchema.parse(answer.body)).toMatchObject({ unsubscribed: true })
    expect(await check(id)).toMatchObject({ allowed: false, code: 'consent.suppressed' })
    const live = await entries()
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ reason: 'unsubscribe', maskedAddress: 'a***@example.test' })
    expect(await ledger(id)).toEqual([
      expect.objectContaining({ channel: 'email', kind: 'withdrawn', source: 'unsubscribe' }),
    ])
  })

  test('the JSON form of the body works, and a body that is not the pair is request.invalid', async () => {
    const { prospect, token, pub } = await setupFor()
    const id = await prospect()
    const json = await pub('POST', token(id), {
      body: JSON.stringify({ 'List-Unsubscribe': 'One-Click' }),
      contentType: 'application/json',
    })
    expect(json.status).toBe(200)
    const wrong = await pub('POST', token(id), { body: 'List-Unsubscribe=Nope' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error?.code).toBe('request.invalid')
    const empty = await pub('POST', token(id), { body: '' })
    expect(empty.status).toBe(400)
  })

  test('the response holds no Prospect data', async () => {
    const { prospect, token, click } = await setupFor()
    const id = await prospect()
    const answer = await click(token(id))
    expect(Object.keys(answer.body).sort()).toEqual(['recordedAt', 'unsubscribed'])
    const text = JSON.stringify(answer.body)
    for (const secret of [EMAIL, 'Ada', '4155550123', id]) {
      expect(text).not.toContain(secret)
    }
  })

  test('a replay answers the same receipt and writes and publishes nothing more', async () => {
    const { prospect, token, click, entries, ledger, queued } = await setupFor()
    const id = await prospect()
    const first = await click(token(id))
    const firstEvents = await queued()
    expect(firstEvents.map((e) => e.type).sort()).toEqual([
      'consent.withdrawn',
      'suppression.added',
    ])
    const again = await click(token(id))
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await entries()).toHaveLength(1)
    expect(await ledger(id)).toHaveLength(1)
    expect(await queued()).toEqual([])
  })

  test('leaves the other channels alone', async () => {
    const { prospect, token, click, check, memory, seeded } = await setupFor()
    const id = await prospect()
    memory.seedConsentEvent(seeded.organizationId, id, 'sms', 'granted')
    await click(token(id))
    expect(await check(id, 'sms')).toMatchObject({ allowed: true })
  })

  test('a tampered token is consent.invalid_token, the same answer as an unknown one', async () => {
    const { prospect, token, click } = await setupFor()
    const id = await prospect()
    const good = token(id)
    const flipped = `${good.slice(0, -2)}${good.endsWith('AA') ? 'BB' : 'AA'}`
    const swapped = `${good.slice(1)}${good[0] === 'A' ? 'B' : 'A'}`
    const answers = []
    for (const bad of [flipped, swapped, 'x'.repeat(40), good.slice(0, 30), `${good}${good}`]) {
      const answer = await click(bad)
      answers.push(answer)
      expect(answer.status).toBe(400)
      expect(answer.body.error?.code).toBe('consent.invalid_token')
    }
    const messages = new Set(answers.map((a) => JSON.stringify(a.body.error)))
    expect(messages.size).toBe(1)
  })

  test('a token with another key, another purpose, or a malformed shape is refused', async () => {
    const { prospect, click, harness, seeded } = await setupFor()
    const id = await prospect()
    const forged = mintUnsubscribeToken('some-other-key-0123456789-abcdefghijklmnop', {
      organizationId: seeded.organizationId,
      prospectId: id,
      channel: 'email',
      expiresAt: new Date(harness.deps.clock.now().getTime() + 1_000_000),
    })
    expect((await click(forged)).body.error?.code).toBe('consent.invalid_token')
    expect((await click('!!not-a-token!!')).body.error?.code).toBe('consent.invalid_token')
  })

  test('an expired token is consent.invalid_token and unsubscribes no one', async () => {
    const { prospect, token, click, check, harness } = await setupFor()
    const id = await prospect()
    const short = token(id, { expiresAt: new Date(harness.deps.clock.now().getTime() + 60_000) })
    harness.deps.clock.advance('61s')
    const answer = await click(short)
    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('consent.invalid_token')
    expect(await check(id)).toMatchObject({ allowed: true })
  })

  test('a token for one Organization cannot affect another', async () => {
    const { prospect, token, click, check, entries, memory } = await setupFor()
    const other = await seedOrganization(memory, [])
    const mine = await prospect()
    const theirs = await prospect(other.organizationId, EMAIL, other.owner)
    // A token signed for the other Organization but naming this Organization's Prospect.
    const crossed = token(mine, {}, other.organizationId)
    const answer = await click(crossed)
    expect(answer.status).toBe(400)
    expect(answer.body.error?.code).toBe('consent.invalid_token')
    expect(await check(mine)).toMatchObject({ allowed: true })
    expect(await entries()).toHaveLength(0)
    expect(await entries(other.organizationId)).toHaveLength(0)
    // The honest token of the other Organization affects only that one.
    expect((await click(token(theirs, {}, other.organizationId))).status).toBe(200)
    expect(await entries(other.organizationId)).toHaveLength(1)
    expect(await entries()).toHaveLength(0)
    expect(await check(mine)).toMatchObject({ allowed: true })
    expect(await check(theirs, 'email', other.organizationId)).toMatchObject({ allowed: false })
  })

  test('a suspended Organization still honours it; a deleted one does not', async () => {
    const { prospect, token, click, memory, seeded } = await setupFor()
    const id = await prospect()
    memory.setOrganizationStatus(seeded.organizationId, 'suspended')
    expect((await click(token(id))).status).toBe(200)
    memory.setOrganizationStatus(seeded.organizationId, 'deleted')
    const gone = await click(token(id))
    expect(gone.status).toBe(400)
    expect(gone.body.error?.code).toBe('consent.invalid_token')
  })

  test('an erased Prospect, an unknown Prospect and a Prospect with no email are invalid', async () => {
    const { prospect, token, click, harness, seeded } = await setupFor()
    const noEmail = await prospect(undefined, '')
    expect((await click(token(noEmail))).body.error?.code).toBe('consent.invalid_token')
    const erased = await prospect()
    await processErase(harness.deps, {
      organizationId: seeded.organizationId,
      prospectId: erased,
      actorUserId: seeded.owner.userId,
      traceId: 'trace-erase',
    })
    expect((await click(token(erased))).body.error?.code).toBe('consent.invalid_token')
    const unknown = await click(token('prs_00000000-0000-4000-8000-000000000000' as ProspectId))
    expect(unknown.body.error?.code).toBe('consent.invalid_token')
  })

  test('never refuses a valid link, however many come from one address', async () => {
    const { prospect, token, click, pub } = await setupFor()
    const t = token(await prospect())
    for (let i = 0; i < 61; i += 1) {
      expect((await click(t)).status).toBe(200)
    }
    expect((await pub('GET', t)).status).toBe(200)
  })

  test('rate limits unusable links per client address, and a valid link still works', async () => {
    const { prospect, token, click } = await setupFor()
    const t = token(await prospect())
    const bad = `${t.slice(0, -2)}AA`
    for (let i = 0; i < 60; i += 1) {
      expect((await click(bad)).body.error?.code).toBe('consent.invalid_token')
    }
    const limited = await click(bad)
    expect(limited.status).toBe(429)
    expect(limited.body.error?.code).toBe('rate.limited')
    expect(Number(limited.retryAfter)).toBeGreaterThan(0)
    expect((await click(t)).status).toBe(200)
    expect((await click(bad, '198.51.100.7')).body.error?.code).toBe('consent.invalid_token')
  })

  test('logs nothing of the token, the address or the Prospect', async () => {
    const { prospect, token, click, pub, harness } = await setupFor()
    const id = await prospect()
    harness.deps.logLines.length = 0
    const t = token(id)
    await click(t)
    await click(t)
    await click(`${t.slice(0, -2)}AA`)
    await pub('GET', t)
    const lines = harness.deps.logLines.join('\n')
    for (const secret of [EMAIL, 'ada@', t, id, 'Ada']) {
      expect(lines).not.toContain(secret)
    }
  })
})

describe('the preview', () => {
  test('shows the Organization and the channel and writes nothing', async () => {
    const { prospect, token, pub, check, entries, queued } = await setupFor()
    const id = await prospect()
    const shown = await pub('GET', token(id))
    expect(shown.status).toBe(200)
    expect(Object.keys(shown.body).sort()).toEqual(['channel', 'organizationName'])
    expect(shown.body.channel).toBe('email')
    expect(JSON.stringify(shown.body)).not.toContain(EMAIL)
    expect(await entries()).toHaveLength(0)
    expect(await check(id)).toMatchObject({ allowed: true })
    expect(await queued()).toEqual([])
  })

  test('a bad or expired token is consent.invalid_token', async () => {
    const { prospect, token, pub, harness } = await setupFor()
    const id = await prospect()
    expect((await pub('GET', `${token(id).slice(0, -2)}AA`)).body.error?.code).toBe(
      'consent.invalid_token'
    )
    const short = token(id, { expiresAt: new Date(harness.deps.clock.now().getTime() + 1_000) })
    harness.deps.clock.advance('2s')
    expect((await pub('GET', short)).body.error?.code).toBe('consent.invalid_token')
  })
})

/** The shared setup, typed for the tests above. */
async function setupFor(): Promise<
  Awaited<ReturnType<typeof setup>> & { seeded: SeededOrganization }
> {
  return setup()
}

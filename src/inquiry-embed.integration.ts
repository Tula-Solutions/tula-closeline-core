import { afterAll, describe, expect, test } from 'bun:test'
import {
  formatId,
  inquiryEmbedSchema,
  inquiryIntakeResultSchema,
  resolvedInquiryKeySchema,
} from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { integrationUrls } from '~/integration-support'
import { createTestApp, publicCaller, seedOrganization } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const store = createPostgresCoreStore(service.db)
const ORIGIN = 'https://www.acme.test'

afterAll(async () => {
  await service.close()
})

async function setup() {
  const harness = await createTestApp({
    store,
    env: { DATABASE_URL: urls.service },
    clockStart: new Date().toISOString(),
  })
  const a = await seedOrganization(store, [], 'Org A')
  const b = await seedOrganization(store, [], 'Org B')
  const api = publicCaller(harness)
  const internal = async (path: string, body: unknown, key?: string) => {
    const response = await harness.app.request(`/internal${path}`, {
      method: 'POST',
      headers: harness.internal(key),
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & { error?: { code: string } },
    }
  }
  const live = async () => {
    const made = await api(
      a.owner,
      a.organizationId,
      'POST',
      '/consent-wordings',
      { text: 'We may call you about this enquiry.', channels: ['phone'] },
      { 'idempotency-key': crypto.randomUUID() }
    )
    const wording = made.body as { id: string; version: number }
    const saved = await api(a.owner, a.organizationId, 'PUT', '/inquiry-embed', {
      allowedOrigins: [ORIGIN],
      consentWordingId: wording.id,
    })
    expect(saved.status).toBe(200)
    return { wording, embed: inquiryEmbedSchema.parse(saved.body) }
  }
  const intake = (organizationId: string, version: number) => ({
    organizationId,
    inquiryId: formatId('inq', crypto.randomUUID()),
    prospect: { name: 'Ada Lovelace', email: 'ada@acme.test', phone: '+14155550123' },
    consent: {
      channel: 'phone',
      wordingVersion: version,
      sourceUrl: `${ORIGIN}/contact`,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  })
  return { a, b, api, internal, live, intake }
}

describe('Inquiry embed over Postgres', () => {
  test('a key resolves through the definer function only once the embed is live', async () => {
    const { a, api, internal, live } = await setup()
    const first = inquiryEmbedSchema.parse(
      (await api(a.owner, a.organizationId, 'GET', '/inquiry-embed')).body
    )
    const before = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: first.publishableKey,
    })
    expect(before.body.error?.code).toBe('inquiry.key_unknown')

    const { embed, wording } = await live()

    expect(embed.publishableKey).toBe(first.publishableKey)
    const after = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: embed.publishableKey,
    })
    expect(after.status).toBe(200)
    expect(resolvedInquiryKeySchema.parse(after.body)).toEqual({
      organizationId: a.organizationId,
      allowedOrigins: [ORIGIN],
      consentWording: { version: wording.version, text: 'We may call you about this enquiry.' },
    })
  })

  test('rotating retires the old key', async () => {
    const { a, api, internal, live } = await setup()
    const { embed } = await live()

    const rotated = await api(
      a.owner,
      a.organizationId,
      'POST',
      '/inquiry-embed/rotate-key',
      undefined,
      { 'idempotency-key': crypto.randomUUID() }
    )

    const next = inquiryEmbedSchema.parse(rotated.body)
    expect(next.publishableKey).not.toBe(embed.publishableKey)
    const old = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: embed.publishableKey,
    })
    expect(old.body.error?.code).toBe('inquiry.key_unknown')
    expect(
      (await internal('/v1/inquiry-keys/resolutions', { publishableKey: next.publishableKey }))
        .status
    ).toBe(200)
  })

  test('intake keeps one Prospect and one consent for a repeated key, and cites the wording', async () => {
    const { a, api, internal, live, intake } = await setup()
    const { wording } = await live()
    const body = intake(a.organizationId, wording.version)
    const key = crypto.randomUUID()

    const first = await internal('/v1/inquiry-intakes', body, key)
    const again = await internal('/v1/inquiry-intakes', body, key)

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const result = inquiryIntakeResultSchema.parse(first.body)
    const prospects = await api(a.owner, a.organizationId, 'GET', '/prospects')
    expect((prospects.body as { items: unknown[] }).items).toHaveLength(1)
    const events = await api(
      a.owner,
      a.organizationId,
      'GET',
      `/prospects/${result.prospectId}/consent-events`
    )
    const items = (events.body as { items: Array<{ id: string; channel: string }> }).items
    expect(items.map((e) => e.id)).toEqual([result.consentId])
    expect(items[0]?.channel).toBe('phone')
  })

  test('a stale wording version stores nothing', async () => {
    const { a, api, internal, live, intake } = await setup()
    const { wording } = await live()

    const stale = await internal(
      '/v1/inquiry-intakes',
      intake(a.organizationId, wording.version + 1)
    )

    expect(stale.status).toBe(422)
    expect(stale.body.error?.code).toBe('inquiry.consent_wording_missing')
    const prospects = await api(a.owner, a.organizationId, 'GET', '/prospects')
    expect((prospects.body as { items: unknown[] }).items).toHaveLength(0)
  })

  test('a second Organization cannot read the embed or the Prospects, and its key is its own', async () => {
    const { a, b, api, internal, live, intake } = await setup()
    const { embed, wording } = await live()
    await internal('/v1/inquiry-intakes', intake(a.organizationId, wording.version))

    const theirs = inquiryEmbedSchema.parse(
      (await api(b.owner, b.organizationId, 'GET', '/inquiry-embed')).body
    )

    expect(theirs.publishableKey).not.toBe(embed.publishableKey)
    expect(theirs.allowedOrigins).toEqual([])
    const prospects = await api(b.owner, b.organizationId, 'GET', '/prospects')
    expect((prospects.body as { items: unknown[] }).items).toHaveLength(0)
    const crossed = await internal('/v1/inquiry-intakes', intake(b.organizationId, wording.version))
    expect(crossed.status).toBe(422)
  })
})

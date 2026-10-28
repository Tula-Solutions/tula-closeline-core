import { describe, expect, test } from 'bun:test'
import { formatId, inquiryEmbedSchema, resolvedInquiryKeySchema } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, seedOrganization } from '~/testing'
import { hashSecret } from '../api-key/secret'

const ORIGIN = 'https://www.acme.test'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(store, [], 'Other')
  const api = publicCaller(harness)
  const call = (
    actor: { userId: typeof seeded.owner.userId; role: typeof seeded.owner.role },
    method: string,
    path: string,
    body?: unknown,
    organizationId = seeded.organizationId,
    key: string | null = crypto.randomUUID()
  ) =>
    api(actor, organizationId, method, path, body, key === null ? {} : { 'idempotency-key': key })
  const internal = async (
    path: string,
    body: unknown,
    key?: string,
    headers = harness.internal(key)
  ) => {
    const response = await harness.app.request(`/internal${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown> & { error?: { code: string } },
    }
  }
  const wording = async (
    organizationId = seeded.organizationId,
    actor = seeded.owner,
    channels = ['phone']
  ) => {
    const made = await call(
      actor,
      'POST',
      '/consent-wordings',
      { text: 'We may call you about this enquiry.', channels },
      organizationId
    )
    expect(made.status).toBe(201)
    return made.body as { id: string; version: number }
  }
  const live = async () => {
    const w = await wording()
    const saved = await call(seeded.owner, 'PUT', '/inquiry-embed', {
      allowedOrigins: [ORIGIN],
      consentWordingId: w.id,
    })
    expect(saved.status).toBe(200)
    const embed = inquiryEmbedSchema.parse(saved.body)
    return { w, embed }
  }
  const intakeBody = (organizationId: string, version: number, phone = '+14155550123') => ({
    organizationId,
    inquiryId: formatId('inq', crypto.randomUUID()),
    prospect: { name: 'Ada Lovelace', email: 'ada@acme.test', phone },
    consent: {
      channel: 'phone',
      wordingVersion: version,
      sourceUrl: `${ORIGIN}/contact`,
      capturedAt: '2025-12-31T23:00:00.000Z', // before the fixed test clock (2026-01-01)
    },
  })
  return { ...harness, store, seeded, other, call, internal, wording, live, intakeBody }
}

describe('embed settings', () => {
  test('the first read makes a key that is not live yet, and the same key is returned again', async () => {
    const { call, seeded, internal } = await setup()

    const first = inquiryEmbedSchema.parse((await call(seeded.owner, 'GET', '/inquiry-embed')).body)
    const again = inquiryEmbedSchema.parse((await call(seeded.owner, 'GET', '/inquiry-embed')).body)

    expect(again.publishableKey).toBe(first.publishableKey)
    expect(first.allowedOrigins).toEqual([])
    expect(first.consentWordingId).toBeNull()
    const resolved = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: first.publishableKey,
    })
    expect(resolved.status).toBe(404)
    expect(resolved.body.error?.code).toBe('inquiry.key_unknown')
  })

  test('only an Owner or Admin may read, set or rotate', async () => {
    const { call, seeded } = await setup()
    const manager = seeded.members.find((m) => m.role === 'manager')
    if (!manager) {
      throw new Error('no manager')
    }

    expect((await call(manager, 'GET', '/inquiry-embed')).status).toBe(403)
    expect((await call(manager, 'POST', '/inquiry-embed/rotate-key')).status).toBe(403)
    expect(
      (await call(manager, 'PUT', '/inquiry-embed', { allowedOrigins: [], consentWordingId: 'x' }))
        .status
    ).toBe(400)
    const admin = seeded.members.find((m) => m.role === 'admin')
    if (!admin) {
      throw new Error('no admin')
    }
    expect((await call(admin, 'GET', '/inquiry-embed')).status).toBe(200)
  })

  test('a wording that does not cover the phone channel is inquiry.embed_invalid', async () => {
    const { call, seeded, wording } = await setup()
    const email = await wording(seeded.organizationId, seeded.owner, ['email'])

    const refused = await call(seeded.owner, 'PUT', '/inquiry-embed', {
      allowedOrigins: [ORIGIN],
      consentWordingId: email.id,
    })

    expect(refused.status).toBe(422)
    expect(refused.body.error?.code).toBe('inquiry.embed_invalid')
  })

  test('another Organization wording cannot be used', async () => {
    const { call, seeded, other, wording } = await setup()
    const theirs = await wording(other.organizationId, other.owner)

    const refused = await call(seeded.owner, 'PUT', '/inquiry-embed', {
      allowedOrigins: [ORIGIN],
      consentWordingId: theirs.id,
    })

    expect(refused.status).toBe(422)
  })

  test('once an origin and a wording are set the key resolves to them', async () => {
    const { live, internal, seeded } = await setup()

    const { embed, w } = await live()

    const resolved = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: embed.publishableKey,
    })
    expect(resolved.status).toBe(200)
    expect(resolvedInquiryKeySchema.parse(resolved.body)).toEqual({
      organizationId: seeded.organizationId,
      allowedOrigins: [ORIGIN],
      consentWording: { version: w.version, text: 'We may call you about this enquiry.' },
    })
  })

  test('rotating makes the old key unknown, and a replay returns the same new key', async () => {
    const { live, call, seeded, internal } = await setup()
    const { embed } = await live()
    const key = crypto.randomUUID()

    const first = await call(
      seeded.owner,
      'POST',
      '/inquiry-embed/rotate-key',
      undefined,
      seeded.organizationId,
      key
    )
    const again = await call(
      seeded.owner,
      'POST',
      '/inquiry-embed/rotate-key',
      undefined,
      seeded.organizationId,
      key
    )

    const rotated = inquiryEmbedSchema.parse(first.body)
    expect(inquiryEmbedSchema.parse(again.body).publishableKey).toBe(rotated.publishableKey)
    expect(rotated.publishableKey).not.toBe(embed.publishableKey)
    expect(rotated.allowedOrigins).toEqual([ORIGIN])
    const old = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: embed.publishableKey,
    })
    expect(old.body.error?.code).toBe('inquiry.key_unknown')
    const fresh = await internal('/v1/inquiry-keys/resolutions', {
      publishableKey: rotated.publishableKey,
    })
    expect(fresh.status).toBe(200)
  })

  test('the key is not logged and its hash is not in the audit log', async () => {
    const { live, call, seeded, deps, internal } = await setup()
    const { embed } = await live()
    await internal('/v1/inquiry-keys/resolutions', { publishableKey: embed.publishableKey })

    const audit = await call(seeded.owner, 'GET', '/audit-events')

    expect(JSON.stringify(audit.body)).toContain('inquiry_embed.updated')
    expect(JSON.stringify(audit.body)).not.toContain(embed.publishableKey)
    expect(JSON.stringify(audit.body)).not.toContain(hashSecret(embed.publishableKey))
    expect(deps.logLines.join('\n')).not.toContain(embed.publishableKey)
  })

  test('internal routes need the internal secret', async () => {
    const { live, internal } = await setup()
    const { embed } = await live()

    const refused = await internal(
      '/v1/inquiry-keys/resolutions',
      { publishableKey: embed.publishableKey },
      undefined,
      { authorization: 'Bearer wrong', 'content-type': 'application/json' } as never
    )

    expect(refused.status).toBe(401)
  })
})

describe('intake', () => {
  test('records the Prospect and one phone consent, and a repeat of the key stores nothing more', async () => {
    const { live, call, seeded, internal, intakeBody } = await setup()
    const { w } = await live()
    const body = intakeBody(seeded.organizationId, w.version)
    const key = crypto.randomUUID()

    const first = await internal('/v1/inquiry-intakes', body, key)
    const again = await internal('/v1/inquiry-intakes', body, key)

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const prospects = await call(seeded.owner, 'GET', '/prospects')
    expect(prospects.body.items).toHaveLength(1)
    const consent = (await call(
      seeded.owner,
      'GET',
      `/prospects/${first.body.prospectId}/consent-events`
    )) as unknown as { body: { items: Array<{ channel: string; kind: string }> } }
    expect(consent.body.items).toHaveLength(1)
    expect(consent.body.items[0]?.channel).toBe('phone')
    expect(consent.body.items[0]?.kind).toBe('granted')
  })

  test('a second Inquiry from the same phone reuses the Prospect', async () => {
    const { live, seeded, internal, intakeBody } = await setup()
    const { w } = await live()

    const one = await internal('/v1/inquiry-intakes', intakeBody(seeded.organizationId, w.version))
    const two = await internal('/v1/inquiry-intakes', intakeBody(seeded.organizationId, w.version))

    expect(two.body.prospectId).toBe(one.body.prospectId)
    expect(two.body.consentId).not.toBe(one.body.consentId)
  })

  test('a typed phone never takes over the consent of a Prospect matched only by email', async () => {
    const { live, call, seeded, internal, intakeBody } = await setup()
    const { w } = await live()
    const one = await internal('/v1/inquiry-intakes', intakeBody(seeded.organizationId, w.version))

    const two = await internal(
      '/v1/inquiry-intakes',
      intakeBody(seeded.organizationId, w.version, '+14155550199')
    )

    expect(two.status).toBe(201)
    expect(two.body.prospectId).not.toBe(one.body.prospectId)
    const events = (await call(
      seeded.owner,
      'GET',
      `/prospects/${one.body.prospectId}/consent-events`
    )) as unknown as { body: { items: unknown[] } }
    expect(events.body.items).toHaveLength(1)
  })

  test('a capturedAt in the future is refused and stores nothing', async () => {
    const { live, call, seeded, internal, intakeBody } = await setup()
    const { w } = await live()
    const body = intakeBody(seeded.organizationId, w.version)

    const refused = await internal('/v1/inquiry-intakes', {
      ...body,
      consent: { ...body.consent, capturedAt: '2026-01-01T01:00:00.000Z' },
    })

    expect(refused.status).toBe(400)
    expect(refused.body.error?.code).toBe('request.invalid')
    expect((await call(seeded.owner, 'GET', '/prospects')).body.items).toHaveLength(0)
  })

  test('a wording version that is not the current one is inquiry.consent_wording_missing', async () => {
    const { live, call, seeded, internal, intakeBody } = await setup()
    const { w } = await live()

    const stale = await internal(
      '/v1/inquiry-intakes',
      intakeBody(seeded.organizationId, w.version + 1)
    )

    expect(stale.status).toBe(422)
    expect(stale.body.error?.code).toBe('inquiry.consent_wording_missing')
    expect((await call(seeded.owner, 'GET', '/prospects')).body.items).toHaveLength(0)
  })

  test('an Organization with no live embed takes no intake', async () => {
    const { other, internal, intakeBody } = await setup()

    const refused = await internal('/v1/inquiry-intakes', intakeBody(other.organizationId, 1))

    expect(refused.status).toBe(422)
  })

  test('a second Organization cannot see the first one’s embed, key or Prospects', async () => {
    const { live, call, other, seeded, internal, intakeBody } = await setup()
    const { embed, w } = await live()
    await internal('/v1/inquiry-intakes', intakeBody(seeded.organizationId, w.version))

    const theirs = inquiryEmbedSchema.parse(
      (await call(other.owner, 'GET', '/inquiry-embed', undefined, other.organizationId)).body
    )

    expect(theirs.publishableKey).not.toBe(embed.publishableKey)
    expect(theirs.allowedOrigins).toEqual([])
    const prospects = await call(other.owner, 'GET', '/prospects', undefined, other.organizationId)
    expect(prospects.body.items).toHaveLength(0)
  })
})

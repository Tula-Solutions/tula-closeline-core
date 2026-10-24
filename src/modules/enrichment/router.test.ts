import { describe, expect, test } from 'bun:test'
import {
  ENRICHMENT_INTERNAL_ROUTES,
  enrichmentInputResponseSchema,
  formatId,
  type ProspectId,
  writeEnrichedFieldsResponseSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, newOrganizationId, publicCaller, seedOrganization } from '~/testing'

const FIELD = (field: string, value: string, provider = 'apollo') => ({
  field,
  value,
  provider,
  confidence: 0.9,
  obtainedAt: '2026-10-20T10:00:00.000Z',
})

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['rep'])
  const second = await seedOrganization(memory, ['rep'])
  const api = publicCaller(harness)
  const make = async (
    body: Record<string, unknown>,
    actor = seeded.owner,
    organizationId = seeded.organizationId
  ) => {
    const made = await api(actor, organizationId, 'POST', '/prospects', body)
    return made.body.id as ProspectId
  }
  const company = async (body: Record<string, unknown>) => {
    const made = await api(seeded.owner, seeded.organizationId, 'POST', '/prospect-companies', body)
    return made.body.id as string
  }
  const send = async (
    method: 'GET' | 'POST',
    prospectId: string,
    suffix: 'enrichment-input' | 'enriched-fields',
    body?: unknown,
    organizationId = seeded.organizationId,
    headers: Record<string, string> = harness.internal()
  ) => {
    const response = await harness.app.request(`/internal/v1/prospects/${prospectId}/${suffix}`, {
      method,
      headers: { ...headers, 'x-organization-id': organizationId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const read = (prospectId: string, organizationId = seeded.organizationId) =>
    send('GET', prospectId, 'enrichment-input', undefined, organizationId)
  const write = (prospectId: string, body: unknown, organizationId = seeded.organizationId) =>
    send('POST', prospectId, 'enriched-fields', body, organizationId)
  const current = async (prospectId: string) =>
    (await api(seeded.owner, seeded.organizationId, 'GET', `/prospects/${prospectId}`)).body
  return { ...harness, memory, seeded, second, make, company, read, write, send, current }
}

const runId = () => formatId('erun', crypto.randomUUID())

describe('the contract routes', () => {
  test('are the ones this service answers', () => {
    expect(ENRICHMENT_INTERNAL_ROUTES.getEnrichmentInput.path).toBe(
      '/internal/v1/prospects/{prospectId}/enrichment-input'
    )
    expect(ENRICHMENT_INTERNAL_ROUTES.writeEnrichedFields.path).toBe(
      '/internal/v1/prospects/{prospectId}/enriched-fields'
    )
  })
})

describe('GET enrichment-input', () => {
  test('answers the fields core holds and which enrichable fields are present', async () => {
    const t = await setup()
    const companyId = await t.company({
      name: 'Acme',
      domain: 'acme.test',
      industry: 'Software',
    })
    const id = await t.make({ firstName: 'Ada', email: 'ada@acme.test', companyId })
    const res = await t.read(id)
    expect(res.status).toBe(200)
    const body = enrichmentInputResponseSchema.parse(res.body)
    expect(body).toMatchObject({
      prospectId: id,
      email: 'ada@acme.test',
      firstName: 'Ada',
      lastName: null,
      jobTitle: null,
      companyName: 'Acme',
      companyDomain: 'acme.test',
    })
    expect([...body.presentFields].sort()).toEqual([
      'companyDomain',
      'companyName',
      'email',
      'firstName',
      'industry',
    ])
  })

  test('a Prospect with no company has null company fields', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const body = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(body.companyName).toBeNull()
    expect(body.companyDomain).toBeNull()
    expect(body.presentFields).toEqual(['firstName'])
  })

  test('an unknown Prospect is enrichment.prospect_not_found', async () => {
    const t = await setup()
    const res = await t.read(formatId('prs', crypto.randomUUID()))
    expect(res.status).toBe(404)
    expect((res.body.error as { code: string }).code).toBe('enrichment.prospect_not_found')
  })

  test("another Organization's token cannot read the Prospect", async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const res = await t.read(id, t.second.organizationId)
    expect(res.status).toBe(404)
    expect((res.body.error as { code: string }).code).toBe('enrichment.prospect_not_found')
  })

  test('an unknown Organization is the same 404', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const res = await t.read(id, newOrganizationId())
    expect(res.status).toBe(404)
  })
})

describe('POST enriched-fields', () => {
  test('writes into an empty field and suggests beside a manual value', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada', jobTitle: 'Head of Sales' })
    const res = await t.write(id, {
      runId: runId(),
      fields: [FIELD('jobTitle', 'VP Sales'), FIELD('lastName', 'Lovelace')],
    })
    expect(res.status).toBe(200)
    const body = writeEnrichedFieldsResponseSchema.parse(res.body)
    expect(body.results.find((r) => r.field === 'jobTitle')?.application).toBe('suggested')
    expect(body.results.find((r) => r.field === 'lastName')?.application).toBe('written')
    const prospect = (await t.current(id)) as {
      fields: Record<string, { value: string; source: string }>
    }
    expect(prospect.fields.jobTitle).toMatchObject({ value: 'Head of Sales', source: 'manual' })
    expect(prospect.fields.lastName).toMatchObject({
      value: 'Lovelace',
      source: 'enrichment:apollo',
    })
  })

  test('writes company fields on the Prospect Company', async () => {
    const t = await setup()
    const companyId = await t.company({ name: 'Acme' })
    const id = await t.make({ firstName: 'Ada', companyId })
    const res = await t.write(id, {
      runId: runId(),
      fields: [FIELD('companyDomain', 'acme.test'), FIELD('companyName', 'Acme Inc')],
    })
    const body = writeEnrichedFieldsResponseSchema.parse(res.body)
    expect(body.results.find((r) => r.field === 'companyDomain')?.application).toBe('written')
    expect(body.results.find((r) => r.field === 'companyName')?.application).toBe('suggested')
    const input = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(input.companyDomain).toBe('acme.test')
    expect(input.companyName).toBe('Acme')
  })

  test('a replay returns the original results and writes nothing', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const body = { runId: runId(), fields: [FIELD('lastName', 'Lovelace')] }
    const first = await t.write(id, body)
    // A Rep fixes the value by hand between the two calls; a replay must not touch it.
    await publicCaller(t)(t.seeded.owner, t.seeded.organizationId, 'PATCH', `/prospects/${id}`, {
      lastName: 'Byron',
    })
    const second = await t.write(id, body)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    const input = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(input.lastName).toBe('Byron')
  })

  test('a replay with a different body returns the original results', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const run = runId()
    const first = await t.write(id, { runId: run, fields: [FIELD('lastName', 'Lovelace')] })
    const second = await t.write(id, {
      runId: run,
      fields: [FIELD('jobTitle', 'CTO'), FIELD('lastName', 'Other')],
    })
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    const input = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(input.jobTitle).toBeNull()
    expect(input.lastName).toBe('Lovelace')
  })

  test('another run is a new request', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    await t.write(id, { runId: runId(), fields: [FIELD('lastName', 'Lovelace')] })
    const res = await t.write(id, { runId: runId(), fields: [FIELD('jobTitle', 'CTO')] })
    expect(writeEnrichedFieldsResponseSchema.parse(res.body).results).toEqual([
      { field: 'jobTitle', application: 'written' },
    ])
  })

  test('an unknown Prospect is enrichment.prospect_not_found and stores no key', async () => {
    const t = await setup()
    const missing = formatId('prs', crypto.randomUUID())
    const run = runId()
    const res = await t.write(missing, { runId: run, fields: [FIELD('lastName', 'x')] })
    expect(res.status).toBe(404)
    expect((res.body.error as { code: string }).code).toBe('enrichment.prospect_not_found')
  })

  test("another Organization's token cannot write the Prospect", async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const res = await t.write(
      id,
      { runId: runId(), fields: [FIELD('lastName', 'Lovelace')] },
      t.second.organizationId
    )
    expect(res.status).toBe(404)
    expect((res.body.error as { code: string }).code).toBe('enrichment.prospect_not_found')
    const input = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(input.lastName).toBeNull()
  })

  test('refuses a body with a source, a repeated field or no fields', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    for (const bad of [
      { runId: runId(), fields: [] },
      { runId: runId(), fields: [FIELD('lastName', 'a'), FIELD('lastName', 'b')] },
      { runId: runId(), fields: [FIELD('lastName', 'a')], source: 'manual' },
      { runId: 'nope', fields: [FIELD('lastName', 'a')] },
    ]) {
      expect((await t.write(id, bad)).status).toBe(400)
    }
  })

  test('a field held by another Prospect as its email is suggested, not written', async () => {
    const t = await setup()
    await t.make({ firstName: 'Bob', email: 'shared@acme.test' })
    const id = await t.make({ firstName: 'Ada' })
    const res = await t.write(id, {
      runId: runId(),
      fields: [FIELD('email', 'Shared@Acme.test'), FIELD('lastName', 'Lovelace')],
    })
    expect(res.status).toBe(200)
    const body = writeEnrichedFieldsResponseSchema.parse(res.body)
    expect(body.results.find((r) => r.field === 'email')?.application).toBe('suggested')
    expect(body.results.find((r) => r.field === 'lastName')?.application).toBe('written')
  })
})

describe('the service guard', () => {
  test('no secret, a wrong secret and a user access token are all refused', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const body = { runId: runId(), fields: [FIELD('lastName', 'Lovelace')] }
    const userToken = await t.bearer({
      userId: t.seeded.owner.userId,
      organizationId: t.seeded.organizationId,
      role: 'owner',
    })
    for (const headers of [
      {},
      t.internal(undefined, 'wrong-secret-0123456789abcdefghijklmnop'),
      { ...userToken, 'content-type': 'application/json' },
    ]) {
      const get = await t.send('GET', id, 'enrichment-input', undefined, undefined, headers)
      const post = await t.send('POST', id, 'enriched-fields', body, undefined, headers)
      expect([get.status, post.status]).toEqual([401, 401])
    }
    const input = enrichmentInputResponseSchema.parse((await t.read(id)).body)
    expect(input.lastName).toBeNull()
  })

  test('a request without the Organization header is refused', async () => {
    const t = await setup()
    const id = await t.make({ firstName: 'Ada' })
    const response = await t.app.request(`/internal/v1/prospects/${id}/enrichment-input`, {
      headers: t.internal(),
    })
    expect(response.status).toBe(400)
  })
})

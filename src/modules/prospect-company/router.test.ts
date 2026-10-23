import { describe, expect, test } from 'bun:test'
import {
  formatId,
  listProspectCompaniesResponseSchema,
  type ProspectCompany,
  type ProspectCompanyId,
  prospectCompanySchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, seedOrganization } from '~/testing'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['rep'])
  const rep = seeded.members.find((m) => m.role === 'rep')
  if (!rep) {
    throw new Error('no rep seeded')
  }
  const api = publicCaller(harness)
  const call = (
    actor: { userId: typeof rep.userId; role: Role },
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const create = async (name: string, domain?: string): Promise<ProspectCompany> => {
    const response = await call(rep, 'POST', '/prospect-companies', {
      name,
      ...(domain ? { domain } : {}),
    })
    expect(response.status).toBe(201)
    return prospectCompanySchema.parse(response.body)
  }
  return { ...harness, store, seeded, rep, call, create, clock: harness.deps.clock }
}

describe('Prospect Companies', () => {
  test('creates with the Source manual and a lowercased domain', async () => {
    const { create, rep } = await setup()

    const company = await create('Analytical', 'Analytical.TEST')

    expect(company.fields.name).toMatchObject({
      value: 'Analytical',
      source: 'manual',
      setByUserId: rep.userId,
    })
    expect(company.fields.domain?.value).toBe('analytical.test')
  })

  test('the same Idempotency-Key answers 200 with the first company and creates none', async () => {
    const { call, rep } = await setup()
    const headers = { 'idempotency-key': 'company-key-0001-abcdef' }

    const first = await call(rep, 'POST', '/prospect-companies', { name: 'A' }, headers)
    const again = await call(rep, 'POST', '/prospect-companies', { name: 'A' }, headers)
    const list = listProspectCompaniesResponseSchema.parse(
      (await call(rep, 'GET', '/prospect-companies')).body
    )

    expect([first.status, again.status]).toEqual([201, 200])
    expect(again.body).toEqual(first.body)
    expect(list.items).toHaveLength(1)
  })

  test('a domain another company holds is refused', async () => {
    const { call, create, rep } = await setup()
    await create('A', 'a.test')

    const dup = await call(rep, 'POST', '/prospect-companies', { name: 'B', domain: 'A.test' })

    expect(dup.status).toBe(400)
    expect(dup.body.error?.code).toBe('request.invalid')
  })

  test('gets one, and a missing one is prospect.not_found', async () => {
    const { call, create, rep } = await setup()
    const company = await create('A')

    const got = await call(rep, 'GET', `/prospect-companies/${company.id}`)
    const missing = await call(
      rep,
      'GET',
      `/prospect-companies/${formatId('pco', crypto.randomUUID())}`
    )

    expect(prospectCompanySchema.parse(got.body)).toEqual(company)
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('prospect.not_found')
  })

  test('an edit renames and clears the domain, written as manual', async () => {
    const { call, create, rep, clock } = await setup()
    const company = await create('A', 'a.test')
    clock.advance('1h')

    const updated = prospectCompanySchema.parse(
      (
        await call(rep, 'PATCH', `/prospect-companies/${company.id}`, {
          name: 'Alpha',
          domain: null,
        })
      ).body
    )

    expect(updated.fields.name).toMatchObject({ value: 'Alpha', source: 'manual' })
    expect(updated.fields.domain).toBeUndefined()
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(company.updatedAt))
  })

  test('an edit that changes nothing leaves updatedAt alone', async () => {
    const { call, create, rep, clock } = await setup()
    const company = await create('A')
    clock.advance('1h')

    const same = prospectCompanySchema.parse(
      (await call(rep, 'PATCH', `/prospect-companies/${company.id}`, { name: 'A' })).body
    )

    expect(same.updatedAt).toBe(company.updatedAt)
  })

  test('pages newest first, the last page has no cursor, and q matches the name', async () => {
    const { call, create, rep, clock } = await setup()
    const ids: ProspectCompanyId[] = []
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      ids.push((await create(name)).id)
      clock.advance('1m')
    }

    const first = listProspectCompaniesResponseSchema.parse(
      (await call(rep, 'GET', '/prospect-companies?limit=2')).body
    )
    const last = listProspectCompaniesResponseSchema.parse(
      (
        await call(
          rep,
          'GET',
          `/prospect-companies?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`
        )
      ).body
    )
    const found = listProspectCompaniesResponseSchema.parse(
      (await call(rep, 'GET', '/prospect-companies?q=bet')).body
    )

    expect([...first.items, ...last.items].map((c) => c.id)).toEqual([...ids].reverse())
    expect(first.nextCursor).not.toBeNull()
    expect(last.nextCursor).toBeNull()
    expect(found.items.map((c) => c.id)).toEqual(ids.slice(1, 2))
  })

  test('another Organization sees none of them', async () => {
    const { call, create, store } = await setup()
    const company = await create('A')
    const other = await seedOrganization(store)

    const list = await call(
      other.owner,
      'GET',
      '/prospect-companies',
      undefined,
      undefined,
      other.organizationId
    )
    const get = await call(
      other.owner,
      'GET',
      `/prospect-companies/${company.id}`,
      undefined,
      undefined,
      other.organizationId
    )
    const patch = await call(
      other.owner,
      'PATCH',
      `/prospect-companies/${company.id}`,
      { name: 'X' },
      undefined,
      other.organizationId
    )

    expect(listProspectCompaniesResponseSchema.parse(list.body).items).toEqual([])
    expect(get.status).toBe(404)
    expect(patch.status).toBe(404)
  })
})

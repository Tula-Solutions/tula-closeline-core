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
import * as Companies from '~/modules/prospect-company/service'
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

  test('creates with industry, region, employeeCount and technologies, written as manual', async () => {
    const { call, rep } = await setup()

    const response = await call(rep, 'POST', '/prospect-companies', {
      name: 'Acme',
      industry: 'Software',
      region: 'EMEA',
      employeeCount: 250,
      technologies: ['Postgres', 'Bun'],
    })
    const company = prospectCompanySchema.parse(response.body)

    expect(response.status).toBe(201)
    expect(company.fields.industry).toMatchObject({
      value: 'Software',
      source: 'manual',
      setByUserId: rep.userId,
    })
    expect(company.fields.region?.value).toBe('EMEA')
    expect(company.fields.employeeCount).toMatchObject({ value: '250', source: 'manual' })
    expect(company.fields.technologies?.value).toBe('["Postgres","Bun"]')
  })

  test('reads each enrichment field back, and a company without them has none', async () => {
    const { call, create, rep } = await setup()
    const plain = await create('Plain')
    const made = prospectCompanySchema.parse(
      (
        await call(rep, 'POST', '/prospect-companies', {
          name: 'Zero',
          employeeCount: 0,
          technologies: [],
        })
      ).body
    )

    const got = prospectCompanySchema.parse(
      (await call(rep, 'GET', `/prospect-companies/${made.id}`)).body
    )
    const gotPlain = prospectCompanySchema.parse(
      (await call(rep, 'GET', `/prospect-companies/${plain.id}`)).body
    )

    expect(got.fields.employeeCount?.value).toBe('0')
    expect(got.fields.technologies?.value).toBe('[]')
    expect(gotPlain.fields.industry).toBeUndefined()
    expect(gotPlain.fields.region).toBeUndefined()
    expect(gotPlain.fields.employeeCount).toBeUndefined()
    expect(gotPlain.fields.technologies).toBeUndefined()
  })

  test('an edit sets each enrichment field, and null clears it', async () => {
    const { call, create, rep, clock } = await setup()
    const company = await create('A')
    clock.advance('1h')

    const set = prospectCompanySchema.parse(
      (
        await call(rep, 'PATCH', `/prospect-companies/${company.id}`, {
          industry: 'Retail',
          region: 'APAC',
          employeeCount: 12,
          technologies: ['Shopify'],
        })
      ).body
    )
    clock.advance('1h')
    const cleared = prospectCompanySchema.parse(
      (
        await call(rep, 'PATCH', `/prospect-companies/${company.id}`, {
          industry: null,
          employeeCount: null,
          technologies: null,
        })
      ).body
    )

    expect(set.fields.industry?.value).toBe('Retail')
    expect(set.fields.region?.value).toBe('APAC')
    expect(set.fields.employeeCount?.value).toBe('12')
    expect(set.fields.technologies?.value).toBe('["Shopify"]')
    expect(Date.parse(set.updatedAt)).toBeGreaterThan(Date.parse(company.updatedAt))
    expect(cleared.fields.industry).toBeUndefined()
    expect(cleared.fields.employeeCount).toBeUndefined()
    expect(cleared.fields.technologies).toBeUndefined()
    expect(cleared.fields.region?.value).toBe('APAC')
  })

  test('history is kept per field: an older value is superseded, not lost', async () => {
    const { call, create, rep, store, seeded, clock } = await setup()
    const company = await create('A')
    for (const employeeCount of [10, 20]) {
      clock.advance('1h')
      await call(rep, 'PATCH', `/prospect-companies/${company.id}`, {
        employeeCount,
        region: `R${employeeCount}`,
      })
    }

    const current = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.listCurrentFields('company', [company.id])
    )

    const fields = current.get(company.id) ?? []
    expect(fields.map((f) => f.field).sort()).toEqual(['employeeCount', 'name', 'region'])
    expect(fields.find((f) => f.field === 'employeeCount')?.value).toBe('20')
  })

  test('another Organization cannot read the enrichment fields', async () => {
    const { call, store } = await setup()
    const mine = await seedOrganization(store, ['rep'])
    const rep = mine.members.find((m) => m.role === 'rep')
    if (!rep) {
      throw new Error('no rep seeded')
    }
    const made = prospectCompanySchema.parse(
      (
        await call(
          rep,
          'POST',
          '/prospect-companies',
          { name: 'Secret', industry: 'Defence', employeeCount: 5, technologies: ['X'] },
          undefined,
          mine.organizationId
        )
      ).body
    )
    const other = await seedOrganization(store)

    const get = await call(
      other.owner,
      'GET',
      `/prospect-companies/${made.id}`,
      undefined,
      undefined,
      other.organizationId
    )
    const list = listProspectCompaniesResponseSchema.parse(
      (
        await call(
          other.owner,
          'GET',
          '/prospect-companies',
          undefined,
          undefined,
          other.organizationId
        )
      ).body
    )

    expect(get.status).toBe(404)
    expect(JSON.stringify(get.body)).not.toContain('Defence')
    expect(list.items).toEqual([])
  })

  test('technologies over the JSON length limit are request.invalid before any write', async () => {
    const { deps, store, seeded, rep } = await setup()
    const technologies = Array.from({ length: 50 }, () => '"'.repeat(100))
    const caller = { userId: rep.userId, organizationId: seeded.organizationId, role: rep.role }

    const create = Companies.create(deps, caller, { name: 'Big', technologies })

    await expect(create).rejects.toMatchObject({ code: 'request.invalid' })
    const list = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.listProspectCompanies({ limit: 10 })
    )
    expect(list).toEqual([])
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

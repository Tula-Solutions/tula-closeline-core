import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  formatId,
  listProspectsResponseSchema,
  type MembershipId,
  type OrganizationId,
  prospectCompanySchema,
  prospectSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import {
  identityLookupQuery,
  prospectCompanyPageQuery,
  prospectPageQuery,
} from '~/adapters/postgres/prospect-store'
import { harness, owner, service, store } from '~/integration-harness'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { processErase } from '~/modules/prospect/erase'
import { hashAddress } from '~/modules/suppression/address'
import { publicCaller, seedOrganization, TEST_CONSENT_HASH_KEY } from '~/testing'

/** Counts the rows of one table that match a condition, through the tenant-scoped login. */
async function countRows(table: string, organizationId: OrganizationId, extra = sql`true`) {
  return withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.raw(table)} where ${extra}`
    )
    return Number(rows[0]?.n)
  })
}

/** The JSON plan Postgres chooses and runs for a statement, as text. */
async function planOf(
  organizationId: OrganizationId,
  statement: (tx: Parameters<Parameters<typeof withOrganization>[2]>[0]) => ReturnType<typeof sql>
) {
  return withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
      sql`explain (analyze, buffers, format json) ${statement(tx)}`
    )
    return JSON.stringify(rows[0]?.['QUERY PLAN'])
  })
}

describe('Prospects, over Postgres', () => {
  test('assigning owners: one, many, replayed by key, queued, and never across Organizations', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep', 'rep'])
    const other = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const [admin, rep, mate] = [org.members[1], org.members[2], org.members[3]]
    const theirRep = other.members[1]
    if (!admin || !rep || !mate || !theirRep) {
      throw new Error('seed')
    }
    const make = async (name: string) =>
      prospectSchema.parse(
        (await api(rep, org.organizationId, 'POST', '/prospects', { firstName: name })).body
      ).id
    const [a, b] = [await make('A'), await make('B')]
    const theirs = prospectSchema.parse(
      (await api(theirRep, other.organizationId, 'POST', '/prospects', { firstName: 'Z' })).body
    ).id
    const ownerOf = async (id: string) =>
      prospectSchema.parse(
        (await api(org.owner, org.organizationId, 'GET', `/prospects/${id}`)).body
      ).ownerMembershipId

    const one = await api(admin, org.organizationId, 'PUT', `/prospects/${a}/owner`, {
      ownerMembershipId: mate.id,
    })
    expect(one.status).toBe(200)
    expect(await ownerOf(a)).toBe(mate.id)

    const headers = { 'Idempotency-Key': crypto.randomUUID() }
    const body = { prospectIds: [a, b, theirs], ownerMembershipId: mate.id }
    const bulk = await api(admin, org.organizationId, 'POST', '/prospects/assign', body, headers)
    const again = await api(admin, org.organizationId, 'POST', '/prospects/assign', body, headers)
    expect(bulk.status).toBe(200)
    expect(bulk.body).toMatchObject({ state: 'applied', requested: 3, assigned: 2, skipped: 1 })
    expect(again.body).toEqual(bulk.body)
    expect(await ownerOf(b)).toBe(mate.id)
    const foreign = await api(theirRep, other.organizationId, 'GET', `/prospects/${theirs}`)
    expect(prospectSchema.parse(foreign.body).ownerMembershipId).toBe(theirRep.id)

    const ids = [a, b, ...Array.from({ length: 600 }, () => formatId('prs', crypto.randomUUID()))]
    const queued = await api(admin, org.organizationId, 'POST', '/prospects/assign', {
      prospectIds: ids,
      ownerMembershipId: rep.id,
    })
    expect(queued.status).toBe(202)
    const signal = new AbortController().signal
    while ((await processAssignJobs(h.deps, signal)) > 0) {}
    expect(await ownerOf(a)).toBe(rep.id)
    expect(await ownerOf(b)).toBe(rep.id)
  })

  test('create, read, update and page by cursor over HTTP', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const rep = org.members[1]
    if (!rep) {
      throw new Error('seed')
    }
    const headers = { 'Idempotency-Key': crypto.randomUUID() }

    const made = await api(
      rep,
      org.organizationId,
      'POST',
      '/prospects',
      { firstName: 'Ada', lastName: 'Lovelace', email: 'Ada@Example.test', tags: ['vip'] },
      headers
    )
    expect(made.status).toBe(201)
    const prospect = prospectSchema.parse(made.body)
    expect(prospect.fields.email?.value).toBe('ada@example.test')
    expect(prospect.ownerMembershipId).toBe(rep.id)

    const replay = await api(
      rep,
      org.organizationId,
      'POST',
      '/prospects',
      { firstName: 'Ada', lastName: 'Lovelace', email: 'Ada@Example.test', tags: ['vip'] },
      headers
    )
    expect(prospectSchema.parse(replay.body).id).toBe(prospect.id)
    expect(await countRows('core.prospects', org.organizationId)).toBe(1)

    const clash = await api(rep, org.organizationId, 'POST', '/prospects', {
      firstName: 'Other',
      email: 'ada@example.test',
    })
    expect(clash.status).toBeGreaterThanOrEqual(400)
    expect(await countRows('core.prospects', org.organizationId)).toBe(1)

    const patched = await api(rep, org.organizationId, 'PATCH', `/prospects/${prospect.id}`, {
      jobTitle: 'Analyst',
    })
    expect(patched.status).toBe(200)
    expect(prospectSchema.parse(patched.body).fields.jobTitle?.value).toBe('Analyst')

    for (const name of ['B', 'C', 'D']) {
      await api(rep, org.organizationId, 'POST', '/prospects', {
        firstName: name,
        email: `${name.toLowerCase()}@example.test`,
      })
    }
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`
      const page = await api(rep, org.organizationId, 'GET', `/prospects?${query}`)
      expect(page.status).toBe(200)
      const parsed = listProspectsResponseSchema.parse(page.body)
      seen.push(...parsed.items.map((item) => item.id))
      cursor = parsed.nextCursor
    } while (cursor !== null)
    expect(seen).toHaveLength(4)
    expect(new Set(seen).size).toBe(4)

    const found = await api(rep, org.organizationId, 'GET', '/prospects?q=LOVE')
    expect(listProspectsResponseSchema.parse(found.body).items.map((i) => i.id)).toEqual([
      prospect.id,
    ])
  })

  test("another Organization sees nothing, and the service login's row-level security agrees", async () => {
    const h = await harness()
    const mine = await seedOrganization(store, ['rep'])
    const theirs = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const theirRep = theirs.members[1]
    if (!theirRep) {
      throw new Error('seed')
    }
    const theirs1 = prospectSchema.parse(
      (
        await api(theirRep, theirs.organizationId, 'POST', '/prospects', {
          firstName: 'Secret',
          email: 'secret@example.test',
        })
      ).body
    )
    const company = prospectCompanySchema.parse(
      (await api(theirRep, theirs.organizationId, 'POST', '/prospect-companies', { name: 'Acme' }))
        .body
    )

    const list = await api(mine.owner, mine.organizationId, 'GET', '/prospects')
    expect(listProspectsResponseSchema.parse(list.body).items).toEqual([])
    const get = await api(mine.owner, mine.organizationId, 'GET', `/prospects/${theirs1.id}`)
    const patch = await api(mine.owner, mine.organizationId, 'PATCH', `/prospects/${theirs1.id}`, {
      firstName: 'Hacked',
    })
    const companyGet = await api(
      mine.owner,
      mine.organizationId,
      'GET',
      `/prospect-companies/${company.id}`
    )
    expect([get.status, patch.status, companyGet.status]).toEqual([404, 404, 404])
    expect(get.body.error?.code).toBe('prospect.not_found')

    const seen = await withOrganization(service.db, mine.organizationId, async (tx) => {
      const counts: number[] = []
      for (const table of [
        'core.prospects',
        'core.prospect_fields',
        'core.prospect_identities',
        'core.prospect_companies',
        'core.prospect_company_fields',
      ]) {
        const { rows } = await tx.execute<{ n: string }>(
          sql`select count(*)::text as n from ${sql.raw(table)}`
        )
        counts.push(Number(rows[0]?.n))
      }
      return counts
    })
    expect(seen).toEqual([0, 0, 0, 0, 0])
  })

  test('a field keeps at most 50 history entries, for Prospects and Prospect Companies', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const rep = org.members[1]
    if (!rep) {
      throw new Error('seed')
    }
    const prospect = prospectSchema.parse(
      (await api(rep, org.organizationId, 'POST', '/prospects', { firstName: 'N0' })).body
    )
    const company = prospectCompanySchema.parse(
      (await api(rep, org.organizationId, 'POST', '/prospect-companies', { name: 'C0' })).body
    )
    for (let i = 1; i <= 60; i++) {
      const a = await api(rep, org.organizationId, 'PATCH', `/prospects/${prospect.id}`, {
        firstName: `N${i}`,
      })
      const b = await api(rep, org.organizationId, 'PATCH', `/prospect-companies/${company.id}`, {
        name: `C${i}`,
      })
      expect([a.status, b.status]).toEqual([200, 200])
    }

    const prospectRows = await countRows(
      'core.prospect_fields',
      org.organizationId,
      sql`prospect_id = ${prospect.id} and field_name = 'first_name'`
    )
    const companyRows = await countRows(
      'core.prospect_company_fields',
      org.organizationId,
      sql`company_id = ${company.id} and field_name = 'name'`
    )
    expect(prospectRows).toBeLessThanOrEqual(50)
    expect(companyRows).toBeLessThanOrEqual(50)
    const current = await api(rep, org.organizationId, 'GET', `/prospects/${prospect.id}`)
    expect(prospectSchema.parse(current.body).fields.firstName?.value).toBe('N60')
  })

  test('list and identity lookup use their indexes at 20,000 rows, with no scan and no sort', async () => {
    const org = await seedOrganization(store, ['rep'])
    const organizationId = org.organizationId
    const rep = org.members[1]
    if (!rep) {
      throw new Error('seed')
    }
    const repId: MembershipId = rep.id
    await withOrganization(service.db, organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.prospects
          (id, organization_id, owner_membership_id, status, source, created_at, updated_at)
        select 'prs_' || md5(${organizationId} || g::text), ${organizationId},
               case when g % 10 = 0 then ${repId} else null end, 'active', 'import',
               now() - (g || ' seconds')::interval, now()
        from generate_series(1, 20000) g`)
      await tx.execute(sql`
        insert into core.prospect_identities (organization_id, kind, value, prospect_id, created_at)
        select ${organizationId}, 'email', 'p' || g || '@example.test',
               'prs_' || md5(${organizationId} || g::text), now()
        from generate_series(1, 20000) g`)
      await tx.execute(sql`
        insert into core.prospect_companies (id, organization_id, name, created_at, updated_at)
        select 'pco_' || md5(${organizationId} || g::text), ${organizationId}, 'Company ' || g,
               now() - (g || ' seconds')::interval, now()
        from generate_series(1, 5000) g`)
    })
    for (const table of ['prospects', 'prospect_identities', 'prospect_companies']) {
      await owner.db.execute(sql`analyze ${sql.raw(`core.${table}`)}`)
    }

    const first = await planOf(organizationId, (tx) =>
      prospectPageQuery(tx, organizationId, { visibility: { kind: 'all' }, limit: 51 }).getSQL()
    )
    expect(first).toContain('prospects_list_idx')
    expect(first).not.toContain('Seq Scan')
    expect(first).not.toContain('"Node Type":"Sort"')

    const owned = await planOf(organizationId, (tx) =>
      prospectPageQuery(tx, organizationId, {
        visibility: { kind: 'all' },
        ownerMembershipId: repId,
        limit: 51,
      }).getSQL()
    )
    expect(owned).toContain('prospects_owner_list_idx')
    expect(owned).not.toContain('Seq Scan')
    expect(owned).not.toContain('"Node Type":"Sort"')

    const identity = await planOf(organizationId, (tx) =>
      identityLookupQuery(tx, organizationId, 'email', 'p77@example.test').getSQL()
    )
    expect(identity).toContain('prospect_identities_pkey')
    expect(identity).not.toContain('Seq Scan')

    const companies = await planOf(organizationId, (tx) =>
      prospectCompanyPageQuery(tx, organizationId, { limit: 51 }).getSQL()
    )
    expect(companies).toContain('prospect_companies_list_idx')
    expect(companies).not.toContain('Seq Scan')
    expect(companies).not.toContain('"Node Type":"Sort"')
  })

  test('erasing removes every row of the Prospect, keeps hashed suppression, frees the identity, and spares another Organization', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const other = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const rep = org.members[1]
    const theirRep = other.members[1]
    if (!rep || !theirRep) {
      throw new Error('seed')
    }
    const body = { firstName: 'Pat', email: 'pat.erase@example.test', phone: '+14155550123' }
    const made = prospectSchema.parse(
      (await api(rep, org.organizationId, 'POST', '/prospects', body)).body
    )
    await api(rep, org.organizationId, 'PATCH', `/prospects/${made.id}`, {
      email: 'pat.second@example.test',
    })
    const theirs = prospectSchema.parse(
      (await api(theirRep, other.organizationId, 'POST', '/prospects', body)).body
    )
    const forProspect = sql`prospect_id = ${made.id}`

    const forbidden = await api(rep, org.organizationId, 'DELETE', `/prospects/${made.id}`)
    const accepted = await api(org.owner, org.organizationId, 'DELETE', `/prospects/${made.id}`)
    expect(forbidden.status).toBe(403)
    expect(accepted.status).toBe(202)
    expect(await countRows('core.prospects', org.organizationId, sql`id = ${made.id}`)).toBe(1)
    const signal = new AbortController().signal
    while ((await processAssignJobs(h.deps, signal)) > 0) {}
    await processErase(
      h.deps,
      {
        organizationId: org.organizationId,
        prospectId: made.id,
        actorUserId: org.owner.userId,
        traceId: 'trace-erase',
      },
      { batchRows: 1 }
    )

    expect((await api(org.owner, org.organizationId, 'GET', `/prospects/${made.id}`)).status).toBe(
      404
    )
    expect(await countRows('core.prospects', org.organizationId, sql`id = ${made.id}`)).toBe(0)
    expect(await countRows('core.prospect_fields', org.organizationId, forProspect)).toBe(0)
    expect(await countRows('core.prospect_identities', org.organizationId, forProspect)).toBe(0)
    for (const [kind, address] of [
      ['email', 'pat.erase@example.test'],
      ['email', 'pat.second@example.test'],
      ['phone', '+14155550123'],
    ] as const) {
      const hash = hashAddress(TEST_CONSENT_HASH_KEY, org.organizationId, kind, address)
      expect(
        await countRows(
          'core.suppression_entry',
          org.organizationId,
          sql`address_hash = ${hash} and reason = 'erased' and masked_address is null`
        )
      ).toBe(1)
    }
    const again = await api(rep, org.organizationId, 'POST', '/prospects', body)
    expect(again.status).toBe(201)
    const spared = await api(theirRep, other.organizationId, 'GET', `/prospects/${theirs.id}`)
    expect(spared.status).toBe(200)
    expect(await countRows('core.suppression_entry', other.organizationId)).toBe(0)
  })
})

import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { withOrganization } from 'tula-closeline-db'
import { owner, service, store } from '~/integration-harness'
import { seedOrganization } from '~/testing'

// The hot path: the Prospect list with a `q` filter (`listProspects`, src/modules/prospect/service.ts),
// through the database's definer search function over the trigram indexes (migration 0030).
// Complexity: O(matches of q) inside the function (it sorts every match before its 101-row limit,
// from a bitmap scan of the trigram index), then O(at most five windows) in the page queries.
// Input: one Organization with 200,000 Prospects (first name, last name, email each) and 20,000
// Companies, so a sequential scan or the old correlated EXISTS plan shows at once. Unlike the other
// benchmarks this one needs Postgres, so it is an integration suite (`bun run test:integration`,
// compose Postgres up) and not part of `bun run bench`.
// Best round of 15 calls (dev laptop, Postgres 18 in Docker): see BUDGET_MS. The Organization's
// Prospects and Companies are removed afterwards.
const PROSPECTS = 200_000
const COMPANIES = 20_000
const CALLS = 15
const ROUNDS = 5
const CHUNK = 10_000
const SLICE = 50_000

/** The median of the fastest rounds: each round is `CALLS` calls, the gate uses the best round. */
async function bestRoundMs(operation: () => Promise<unknown>): Promise<number> {
  for (let index = 0; index < 5; index++) {
    await operation()
  }
  const rounds: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now()
    for (let index = 0; index < CALLS; index++) {
      await operation()
    }
    rounds.push((performance.now() - started) / CALLS)
  }
  return Math.min(...rounds)
}

let seeded: string | undefined

describe('Prospect q search at 200,000 Prospects, over Postgres', () => {
  // The bench rows are about 1 GB: remove them so repeated runs do not fill the database.
  afterAll(async () => {
    if (seeded === undefined) {
      return
    }
    // In slices, fields first: one statement that cascades 600,000 rows holds every row's foreign
    // key event in memory, which is what ended a small Docker VM's Postgres.
    for (const table of ['prospect_fields', 'prospects', 'prospect_companies']) {
      for (;;) {
        const { rowCount } = await owner.db.execute(sql`
          delete from ${sql.raw(`core.${table}`)} where ctid in (
            select ctid from ${sql.raw(`core.${table}`)}
            where organization_id = ${seeded} limit ${SLICE})`)
        if (!rowCount) {
          break
        }
      }
    }
  }, 300_000)

  test('a rare, a common and a company term are served within budget', async () => {
    const org = await seedOrganization(store, ['rep'])
    const organizationId = org.organizationId
    seeded = organizationId
    await withOrganization(service.db, organizationId, (tx) =>
      tx.execute(sql`
        insert into core.prospect_companies (id, organization_id, name, domain, created_at, updated_at)
        select 'pco_' || md5(${organizationId} || 'c' || g::text), ${organizationId},
               'Company ' || g, 'company' || g || '.test', now(), now()
        from generate_series(1, ${COMPANIES}::int) g`)
    )
    // 200,000 Prospects and 600,000 fields through the table's own triggers and indexes take minutes
    // (a history-limit trigger with an advisory lock and a count per field row, and four indexes
    // updated per row), so the load runs with the secondary indexes dropped and that trigger off and
    // both are restored afterwards: the indexes are rebuilt from the loaded rows (one sorted build
    // each) from their own definitions, and the generated rows hold the trigger's rule (one entry per
    // field). The rows are still written by the service role inside the Organization's transaction,
    // so row-level security and the foreign keys apply as usual; only the owner role, which owns the
    // tables, changes the indexes and the trigger.
    const indexes = (
      await owner.db.execute<{ indexname: string; indexdef: string }>(sql`
        select i.indexname, i.indexdef
        from pg_indexes i
        where i.schemaname = 'core' and i.tablename in ('prospects', 'prospect_fields')
          and not exists (
            select 1 from pg_constraint c
            where c.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass)`)
    ).rows
    expect(indexes.length).toBeGreaterThan(3)
    try {
      for (const index of indexes) {
        await owner.db.execute(sql`drop index if exists ${sql.raw(`core.${index.indexname}`)}`)
      }
      await owner.db.execute(
        sql`alter table core.prospect_fields disable trigger prospect_fields_history_limit`
      )
      for (let first = 1; first <= PROSPECTS; first += CHUNK) {
        const last = Math.min(first + CHUNK - 1, PROSPECTS)
        await withOrganization(service.db, organizationId, async (tx) => {
          // One statement: the ids are hashed once and feed both tables (foreign keys are checked at
          // the end of the statement).
          await tx.execute(sql`
            with ids as materialized (
              select g, 'prs_' || md5(${organizationId} || g::text) as id
              from generate_series(${first}::int, ${last}::int) g
            ), added as (
              insert into core.prospects
                (id, organization_id, company_id, status, source, created_at, updated_at)
              select id, ${organizationId},
                     case when g <= ${COMPANIES}::int then 'pco_' || md5(${organizationId} || 'c' || g::text) end,
                     'active', 'import', now() - (g || ' seconds')::interval, now()
              from ids
            )
            insert into core.prospect_fields
              (organization_id, prospect_id, field_name, state, value, source, set_at)
            select ${organizationId}, id, f.name, 'current',
                   case f.name
                     when 'first_name' then 'First' || g
                     when 'last_name' then 'Surname' || (g % 5000)
                     else 'p' || g || '@example.test'
                   end,
                   'import', now()
            from ids
            cross join (values ('first_name'), ('last_name'), ('email')) as f(name)`)
        })
      }
    } finally {
      await owner.db.execute(
        sql`alter table core.prospect_fields enable trigger prospect_fields_history_limit`
      )
      for (const index of indexes) {
        await owner.db.execute(
          sql.raw(
            index.indexdef.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')
          )
        )
      }
    }
    for (const table of ['prospects', 'prospect_fields', 'prospect_companies']) {
      await owner.db.execute(sql`analyze ${sql.raw(`core.${table}`)}`)
    }

    const list = (q: string, limit = 51) =>
      store.withOrganization(organizationId, (scope) =>
        scope.listProspects({ visibility: { kind: 'all' }, q, limit })
      )
    const companies = (q: string) =>
      store.withOrganization(organizationId, (scope) =>
        scope.listProspectCompanies({ q, limit: 51 })
      )

    // Correctness at this size: the rare term finds its few Prospects, the common one fills a page.
    expect((await list('First77777')).length).toBeGreaterThan(0)
    expect(await list('example.test')).toHaveLength(51)
    expect((await companies('company777')).length).toBeGreaterThan(0)

    const rare = await bestRoundMs(() => list('First77777'))
    const common = await bestRoundMs(() => list('example.test'))
    const company = await bestRoundMs(() => companies('company777'))
    process.stdout.write(
      `prospect q search at ${PROSPECTS}: rare ${rare.toFixed(2)} ms, common ${common.toFixed(2)} ms, company ${company.toFixed(2)} ms per call\n`
    )
    expect(rare).toBeLessThan(BUDGET_MS.rare)
    expect(common).toBeLessThan(BUDGET_MS.common)
    expect(company).toBeLessThan(BUDGET_MS.company)
  }, 300_000)
})

/**
 * Budgets per call, about 5x the best round measured on the dev laptop over two runs: rare 3.9 to
 * 4.3 ms, common 250 to 307 ms, company 4.1 to 17 ms. The common term (a substring of every email)
 * costs O(matches): the function collects and sorts all 200,000 ids before its 101-row limit, so
 * that budget records a known cost, not a target.
 */
const BUDGET_MS = { rare: 25, common: 1500, company: 85 }

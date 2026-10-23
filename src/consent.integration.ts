import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { organizations } from 'tula-closeline-db/schema'
import {
  contactCheckPageQuery,
  latestConsentQuery,
  liveSuppressionQuery,
  purgeContactChecksQuery,
  suppressionPageQuery,
} from '~/adapters/postgres/consent-store'
import { harness, owner, service, store } from '~/integration-harness'
import { seedOrganization } from '~/testing'

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

describe('Suppression and Contact Check, over Postgres', () => {
  test('every statement on the check path uses its index at scale, with no scan and no sort', async () => {
    const org = await seedOrganization(store, ['rep'])
    const organizationId = org.organizationId
    await withOrganization(service.db, organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.prospects
          (id, organization_id, status, source, created_at, updated_at)
        select 'prs_' || md5(${organizationId} || g::text), ${organizationId}, 'active', 'import',
               now(), now()
        from generate_series(1, 5000) g`)
      await tx.execute(sql`
        insert into core.suppression_entry
          (id, organization_id, address_kind, address_hash, masked_address, reason, created_at)
        select 'sup_' || md5(${organizationId} || g::text), ${organizationId}, 'email',
               decode(md5('h' || g::text) || md5('i' || g::text), 'hex'), 'a***@example.test',
               case when g % 2 = 0 then 'unsubscribe' else 'bounce' end,
               now() - (g || ' seconds')::interval
        from generate_series(1, 20000) g`)
      await tx.execute(sql`
        insert into core.contact_check_log
          (id, organization_id, prospect_id, channel, purpose, caller, allowed, code, basis, checked_at)
        select 'chk_' || md5(${organizationId} || g::text), ${organizationId},
               'prs_' || md5(${organizationId} || (g % 5000 + 1)::text), 'sms', 'agent_initiated', 'bench',
               false, 'consent.missing', null, now() - (g || ' seconds')::interval
        from generate_series(1, 30000) g`)
    })
    // The consent ledger is append-only and its prospects are seeded above; add its rows now.
    await withOrganization(service.db, organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.contact_consent_event
          (id, organization_id, prospect_id, channel, kind, source, occurred_at)
        select 'cev_' || md5(${organizationId} || g::text), ${organizationId},
               'prs_' || md5(${organizationId} || (g % 5000 + 1)::text),
               (array['sms', 'email', 'phone', 'whatsapp'])[g % 4 + 1], 'withdrawn',
               'manual', now() - (g || ' seconds')::interval
        from generate_series(1, 10000) g`)
    })
    for (const table of ['prospects', 'suppression_entry', 'contact_check_log']) {
      await owner.db.execute(sql`analyze ${sql.raw(`core.${table}`)}`)
    }
    await owner.db.execute(sql`analyze core.contact_consent_event`)

    const prospectId = formatId(
      'prs',
      new Bun.CryptoHasher('md5').update(`${organizationId}1`).digest('hex')
    )
    const expectIndexed = (plan: string, index: string) => {
      expect(plan).toMatch(new RegExp(index))
      expect(plan).not.toContain('Seq Scan')
      expect(plan).not.toContain('"Node Type":"Sort"')
    }

    expectIndexed(
      await planOf(organizationId, (tx) =>
        liveSuppressionQuery(tx, organizationId, 'email', new Uint8Array(32)).getSQL()
      ),
      'suppression_entry_live_key'
    )
    expectIndexed(
      await planOf(organizationId, (tx) =>
        suppressionPageQuery(tx, organizationId, { state: 'active', limit: 51 }).getSQL()
      ),
      'suppression_entries_live_list_idx'
    )
    expectIndexed(
      await planOf(organizationId, (tx) =>
        latestConsentQuery(tx, organizationId, prospectId, 'sms').getSQL()
      ),
      // Either index serves it in one ordered read; the planner ties when a Prospect has one channel.
      'contact_consent_events_(channel|prospect)_idx'
    )
    expectIndexed(
      await planOf(organizationId, (tx) =>
        contactCheckPageQuery(tx, organizationId, { limit: 51 }).getSQL()
      ),
      'contact_check_log_list_idx'
    )
    const byProspect = await planOf(organizationId, (tx) =>
      contactCheckPageQuery(tx, organizationId, {
        limit: 51,
        prospectId: formatId('prs', '1'.repeat(32)),
      }).getSQL()
    )
    expect(byProspect).not.toContain('Seq Scan')
    const purge = await planOf(organizationId, () =>
      purgeContactChecksQuery(organizationId, new Date(Date.now() - 365 * 86_400_000), 100)
    )
    expect(purge).not.toContain('Seq Scan')
    expect(purge).not.toContain('"Node Type":"Sort"')
  })

  test('a suspended Organization is refused and logged; a deleted one is refused with no log row', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const organizationId = org.organizationId
    const body = {
      organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    }
    const setStatus = (status: 'active' | 'suspended' | 'deleted') =>
      withOrganization(service.db, organizationId, async (tx) => {
        await tx
          .update(organizations)
          .set({ status })
          .where(eq(organizations.organizationId, organizationId))
      })
    const logged = () =>
      withOrganization(service.db, organizationId, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(
          sql`select count(*)::text as n from core.contact_check_log`
        )
        return Number(rows[0]?.n)
      })

    const active = await h.post('/internal/v1/contact-checks', body)
    await setStatus('suspended')
    const suspended = await h.post('/internal/v1/contact-checks', body)
    const afterSuspended = await logged()
    await setStatus('deleted')
    const deleted = await h.post('/internal/v1/contact-checks', body)

    expect(active.body).toMatchObject({ allowed: true })
    expect(suspended.body).toMatchObject({ allowed: false, code: 'consent.missing' })
    expect(typeof suspended.body.checkId).toBe('string')
    expect(afterSuspended).toBe(2)
    expect(deleted.body).toMatchObject({ allowed: false, checkId: null })
    expect(await logged()).toBe(2)
  })
})

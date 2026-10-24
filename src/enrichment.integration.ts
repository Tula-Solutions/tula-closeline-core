import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  enrichmentInputResponseSchema,
  formatId,
  type OrganizationId,
  prospectSchema,
  writeEnrichedFieldsResponseSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, holdOrganizationLock, service, store } from '~/integration-harness'
import { publicCaller, seedOrganization, TEST_INTERNAL_SECRET } from '~/testing'

/** Counts the idempotency keys an Organization holds for the enrichment write, through the tenant-scoped login. */
async function keyCount(organizationId: OrganizationId) {
  return withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from core.idempotency_keys where route = 'enrichment.write_fields'`
    )
    return Number(rows[0]?.n)
  })
}

const FIELD = (field: string, value: string) => ({
  field,
  value,
  provider: 'apollo',
  confidence: 0.8,
  obtainedAt: '2026-10-20T10:00:00.000Z',
})

describe('Enrichment, over Postgres', () => {
  test('writes and suggests by Source, replays by run, and never crosses Organizations', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const other = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const call = (
      method: 'GET' | 'POST',
      organizationId: string,
      prospectId: string,
      suffix: string,
      body?: unknown
    ) =>
      h.app.request(`/internal/v1/prospects/${prospectId}/${suffix}`, {
        method,
        headers: {
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'content-type': 'application/json',
          'x-organization-id': organizationId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const company = (
      await api(org.owner, org.organizationId, 'POST', '/prospect-companies', { name: 'Acme' })
    ).body.id as string
    const prospect = prospectSchema.parse(
      (
        await api(org.owner, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          jobTitle: 'Head of Sales',
          companyId: company,
        })
      ).body
    )
    const runId = formatId('erun', crypto.randomUUID())
    const body = {
      runId,
      fields: [
        FIELD('jobTitle', 'VP Sales'),
        FIELD('lastName', 'Lovelace'),
        FIELD('companyDomain', 'Acme.test'),
        FIELD('employeeCount', '250'),
        FIELD('technologies', 'bun, postgres'),
      ],
    }

    const first = await call('POST', org.organizationId, prospect.id, 'enriched-fields', body)
    expect(first.status).toBe(200)
    const results = writeEnrichedFieldsResponseSchema.parse(await first.json()).results
    const applied = Object.fromEntries(results.map((r) => [r.field, r.application]))
    expect(applied).toEqual({
      jobTitle: 'suggested',
      lastName: 'written',
      companyDomain: 'written',
      employeeCount: 'written',
      technologies: 'written',
    })

    const input = enrichmentInputResponseSchema.parse(
      await (await call('GET', org.organizationId, prospect.id, 'enrichment-input')).json()
    )
    expect(input).toMatchObject({
      jobTitle: 'Head of Sales',
      lastName: 'Lovelace',
      companyName: 'Acme',
      companyDomain: 'acme.test',
    })
    expect(input.presentFields).toContain('employeeCount')

    const replay = await call('POST', org.organizationId, prospect.id, 'enriched-fields', {
      runId,
      fields: [FIELD('lastName', 'Different')],
    })
    expect(replay.status).toBe(200)
    expect(writeEnrichedFieldsResponseSchema.parse(await replay.json()).results).toEqual(results)
    const after = enrichmentInputResponseSchema.parse(
      await (await call('GET', org.organizationId, prospect.id, 'enrichment-input')).json()
    )
    expect(after.lastName).toBe('Lovelace')
    expect(await keyCount(org.organizationId)).toBe(1)

    for (const [method, suffix] of [
      ['GET', 'enrichment-input'],
      ['POST', 'enriched-fields'],
    ] as const) {
      const res = await call(
        method,
        other.organizationId,
        prospect.id,
        suffix,
        method === 'POST'
          ? { runId: formatId('erun', crypto.randomUUID()), fields: [FIELD('lastName', 'X')] }
          : undefined
      )
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'enrichment.prospect_not_found'
      )
    }
    expect(await keyCount(other.organizationId)).toBe(0)
  })

  test('the read does not wait for the Organization lock', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['rep'])
    const prospect = prospectSchema.parse(
      (
        await publicCaller(h)(org.owner, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
        })
      ).body
    )
    const held = holdOrganizationLock(org.organizationId)
    await held.hasLock
    try {
      const res = await Promise.race([
        h.app.request(`/internal/v1/prospects/${prospect.id}/enrichment-input`, {
          headers: {
            authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
            'x-organization-id': org.organizationId,
          },
        }),
        Bun.sleep(3000).then(() => null),
      ])
      expect(res?.status).toBe(200)
    } finally {
      held.release()
      await held.done
    }
  })
})

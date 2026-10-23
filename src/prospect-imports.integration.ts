import { describe, expect, test } from 'bun:test'
import {
  listProspectImportRowsResponseSchema,
  listProspectsResponseSchema,
  prospectImportSchema,
} from 'tula-closeline-contract'
import { harness, store } from '~/integration-harness'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { processImport } from '~/modules/prospect-import/process'
import { publicCaller, seedOrganization } from '~/testing'

describe('Prospect CSV import, over Postgres', () => {
  test('imports a mixed file, resumes without duplicates, replays by key and stays in its Organization', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, [])
    const api = publicCaller(h)
    const admin = org.members[1]
    if (!admin) {
      throw new Error('seed')
    }
    const csv = [
      'first_name,last_name,email,company_name,company_domain',
      'Ada,Lovelace,ada@acme.test,Acme,acme.test',
      'Grace,Hopper,grace@acme.test,,',
      'Ada,Again,ADA@acme.test,,',
      'Bad,Email,nope,,',
      '',
    ].join('\n')
    const upload = async (key: string) => {
      const form = new FormData()
      form.set('file', new File([csv], 'p.csv', { type: 'text/csv' }))
      const token = await h.bearer({
        userId: admin.userId,
        organizationId: org.organizationId,
        role: 'admin',
      })
      const response = await h.app.request('/v1/prospect-imports', {
        method: 'POST',
        headers: { ...token, 'idempotency-key': key },
        body: form,
      })
      return { status: response.status, body: prospectImportSchema.parse(await response.json()) }
    }
    const first = await upload('integration-import-key-0001')
    expect(first.status).toBe(202)
    const again = await upload('integration-import-key-0001')
    expect(again.body.id).toBe(first.body.id)

    const job = {
      organizationId: org.organizationId,
      importId: first.body.id,
      actorUserId: admin.userId,
      traceId: 'integration',
    }
    // Stop after every row, then let the queued job finish what is left.
    expect(await processImport(h.deps, job, { budgetMs: 0, batchRows: 1 })).toBe('continue')
    expect(await processImport(h.deps, job, { budgetMs: 0, batchRows: 1 })).toBe('continue')
    const signal = new AbortController().signal
    while ((await processAssignJobs(h.deps, signal)) > 0) {
      // drain
    }

    const done = prospectImportSchema.parse(
      (await api(admin, org.organizationId, 'GET', `/prospect-imports/${first.body.id}`)).body
    )
    expect(done.state).toBe('completed')
    expect([done.createdCount, done.rejectedCount]).toEqual([2, 2])
    const rows = listProspectImportRowsResponseSchema.parse(
      (await api(admin, org.organizationId, 'GET', `/prospect-imports/${first.body.id}/rows`)).body
    )
    expect(rows.items.map((r) => r.result)).toEqual(['created', 'created', 'rejected', 'rejected'])
    const prospects = listProspectsResponseSchema.parse(
      (await api(admin, org.organizationId, 'GET', '/prospects?limit=100')).body
    )
    expect(prospects.items).toHaveLength(2)

    for (const path of ['', '/rows', '/report.csv']) {
      const foreign = await api(
        other.owner,
        other.organizationId,
        'GET',
        `/prospect-imports/${first.body.id}${path}`
      )
      expect(foreign.status).toBe(404)
    }
  })
})

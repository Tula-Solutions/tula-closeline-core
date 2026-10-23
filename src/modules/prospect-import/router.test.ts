import { describe, expect, test } from 'bun:test'
import {
  listProspectImportRowsResponseSchema,
  listProspectImportsResponseSchema,
  MAX_PROSPECT_IMPORT_BYTES,
  prospectImportSchema,
  prospectSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import {
  createTestApp,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { processImport } from './process'

type Actor = { userId: SeededMember['userId']; role: Role }

const HEADER = 'first_name,last_name,email,phone,company_name,company_domain,owner_email,tags'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const [admin, manager, rep] = seeded.members.slice(1) as [
    SeededMember,
    SeededMember,
    SeededMember,
  ]
  const owner = seeded.owner
  const api = publicCaller(harness)

  const upload = async (
    actor: Actor,
    csv: string | Uint8Array,
    options: { key?: string; name?: string; type?: string; organizationId?: string } = {}
  ) => {
    const form = new FormData()
    form.set(
      'file',
      new File([csv as never], options.name ?? 'prospects.csv', {
        type: options.type ?? 'text/csv',
      })
    )
    const token = await harness.bearer({
      userId: actor.userId,
      organizationId: (options.organizationId ??
        seeded.organizationId) as typeof seeded.organizationId,
      role: actor.role,
    })
    const response = await harness.app.request('/v1/prospect-imports', {
      method: 'POST',
      headers: { ...token, ...(options.key ? { 'idempotency-key': options.key } : {}) },
      body: form,
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }
  const call = (actor: Actor, method: string, path: string, body?: unknown) =>
    api(actor, seeded.organizationId, method, path, body)
  const drain = async () => {
    const signal = new AbortController().signal
    for (;;) {
      if ((await processAssignJobs(harness.deps, signal)) === 0) {
        return
      }
    }
  }
  const run = async (csv: string, actor: Actor = admin) => {
    const response = await upload(actor, csv)
    expect(response.status).toBe(202)
    const created = prospectImportSchema.parse(response.body)
    await drain()
    const done = prospectImportSchema.parse(
      (await call(actor, 'GET', `/prospect-imports/${created.id}`)).body
    )
    const rows = listProspectImportRowsResponseSchema.parse(
      (await call(actor, 'GET', `/prospect-imports/${created.id}/rows`)).body
    )
    return { created, done, rows: rows.items }
  }
  return { store, harness, seeded, admin, manager, rep, owner, upload, call, drain, run }
}

describe('Prospect CSV import', () => {
  test('gives every row a result: good, duplicate in the file and malformed', async () => {
    const { run, rep, admin } = await setup()
    const csv = [
      HEADER,
      `Ada,Lovelace,ada@acme.test,,Acme,acme.test,${rep.email},vip;west`,
      'Grace,Hopper,grace@acme.test,,,,,',
      'Ada Again,L,ADA@acme.test,,,,,',
      'Bad,Email,not-an-email,,,,,',
      ',,,,,,,',
      `Nobody,Owner,x@acme.test,,,,${admin.email},`,
      'Too,Many,cells@acme.test,,,,,,,extra',
      '',
    ].join('\n')
    const { created, done, rows } = await run(csv)
    expect(created.state).toBe('uploaded')
    expect(done.state).toBe('completed')
    expect(done.rowCount).toBe(7)
    expect(rows.map((r) => [r.rowNumber, r.result, r.reason])).toEqual([
      [2, 'created', null],
      [3, 'created', null],
      [4, 'rejected', 'duplicate_in_file'],
      [5, 'rejected', 'invalid_email'],
      [6, 'rejected', 'missing_identity'],
      [7, 'rejected', 'owner_not_allowed'],
      [8, 'rejected', 'wrong_column_count'],
    ])
    expect([done.createdCount, done.updatedCount, done.skippedCount, done.rejectedCount]).toEqual([
      2, 0, 0, 5,
    ])
    expect(rows[0]?.prospectId).not.toBeNull()
    expect(rows[2]?.prospectId).toBeNull()
  })

  test('refuses Manager and Rep on every route', async () => {
    const { upload, call, manager, rep, admin } = await setup()
    for (const actor of [manager, rep]) {
      const response = await upload(actor, `${HEADER}\n`)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('auth.forbidden')
      expect((await call(actor, 'GET', '/prospect-imports')).status).toBe(403)
    }
    const made = await upload(admin, `${HEADER}\n`)
    for (const actor of [manager, rep]) {
      expect((await call(actor, 'GET', `/prospect-imports/${made.body.id}`)).status).toBe(403)
      expect((await call(actor, 'GET', `/prospect-imports/${made.body.id}/rows`)).status).toBe(403)
      expect(
        (await call(actor, 'GET', `/prospect-imports/${made.body.id}/report.csv`)).status
      ).toBe(403)
    }
  })

  test('parses in the queued job, never on the request path', async () => {
    const { upload, admin, call, drain } = await setup()
    const response = await upload(admin, `${HEADER}\nA,B,a@x.test,,,,,\n`)
    expect(response.body.state).toBe('uploaded')
    const before = await call(admin, 'GET', `/prospect-imports/${response.body.id}/rows`)
    expect(before.body.items).toEqual([])
    await drain()
    const after = await call(admin, 'GET', `/prospect-imports/${response.body.id}`)
    expect(after.body.state).toBe('completed')
  })

  test('the same Idempotency-Key with the same file creates nothing new', async () => {
    const { upload, admin, call, drain } = await setup()
    const csv = `${HEADER}\nA,B,a@x.test,,,,,\n`
    const first = await upload(admin, csv, { key: 'import-key-0000000001' })
    const again = await upload(admin, csv, { key: 'import-key-0000000001' })
    expect(first.status).toBe(202)
    expect(again.status).toBe(202)
    expect(again.body.id).toBe(first.body.id)
    await drain()
    const list = listProspectImportsResponseSchema.parse(
      (await call(admin, 'GET', '/prospect-imports')).body
    )
    expect(list.items).toHaveLength(1)
    const reused = await upload(admin, `${csv}C,D,c@x.test,,,,,\n`, {
      key: 'import-key-0000000001',
    })
    expect(reused.status).toBe(422)
    expect(reused.body.error.code).toBe('request.idempotency_key_reused')
  })

  test('refuses a wrong type, an oversized file and a bad header with prospect.import_invalid', async () => {
    const { upload, admin } = await setup()
    const type = await upload(admin, `${HEADER}\n`, { name: 'prospects.xlsx' })
    expect([type.status, type.body.error.code, type.body.error.details.reason]).toEqual([
      422,
      'prospect.import_invalid',
      'unsupported_type',
    ])
    // Over the app's usual 1 MiB body limit, under the import's own.
    const roomy = await upload(admin, `email\n${'a'.repeat(2 * 1024 * 1024)}@x.test\n`)
    expect(roomy.status).toBe(202)
    const big = new Uint8Array(MAX_PROSPECT_IMPORT_BYTES + 1).fill(97)
    const large = await upload(admin, big)
    expect(large.body.error.code).toBe('prospect.import_invalid')
    expect(large.body.error.details.reason).toBe('too_large')
    for (const header of ['name,age\n', 'first_name,last_name\n', 'email,email\n', '']) {
      const bad = await upload(admin, header)
      expect(bad.body.error.code).toBe('prospect.import_invalid')
      expect(bad.body.error.details.reason).toBe('header_invalid')
    }
    const binary = await upload(admin, new Uint8Array([0xff, 0xfe, 0x00]))
    expect(binary.body.error.details.reason).toBe('header_invalid')
  })

  test('fails an import of more than 50,000 rows with too_many_rows', async () => {
    const { run } = await setup()
    const lines = ['email']
    for (let i = 0; i < 50_001; i++) {
      lines.push(`p${i}@x.test`)
    }
    const { done } = await run(lines.join('\n'))
    expect(done.state).toBe('failed')
    expect(done.failureReason).toBe('too_many_rows')
    expect(done.rowCount).toBeNull()
  })

  test('fails a file the job cannot read with unreadable', async () => {
    const { run } = await setup()
    const { done } = await run('email\n"never closed\n')
    expect(done.state).toBe('failed')
    expect(done.failureReason).toBe('unreadable')
  })

  test('a second Organization cannot fetch the import, its rows or its report', async () => {
    const { run, harness, store } = await setup()
    const { created } = await run(`${HEADER}\nA,B,a@x.test,,,,,\n`)
    const other = await seedOrganization(store, [], 'Other')
    const api = publicCaller(harness)
    for (const path of ['', '/rows', '/report.csv']) {
      const response = await api(
        other.owner,
        other.organizationId,
        'GET',
        `/prospect-imports/${created.id}${path}`
      )
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('prospect.not_found')
    }
    const list = await api(other.owner, other.organizationId, 'GET', '/prospect-imports')
    expect(listProspectImportsResponseSchema.parse(list.body).items).toEqual([])
    expect(newOrganizationId()).not.toBe(other.organizationId)
  })

  test('lists rows and imports a page at a time, at most 100', async () => {
    const { run, call, admin } = await setup()
    const lines = [HEADER]
    for (let i = 0; i < 105; i++) {
      lines.push(`P${i},Q,p${i}@x.test,,,,,`)
    }
    const { created } = await run(lines.join('\n'))
    const first = listProspectImportRowsResponseSchema.parse(
      (await call(admin, 'GET', `/prospect-imports/${created.id}/rows?limit=100`)).body
    )
    expect(first.items).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    const second = listProspectImportRowsResponseSchema.parse(
      (
        await call(
          admin,
          'GET',
          `/prospect-imports/${created.id}/rows?cursor=${encodeURIComponent(first.nextCursor ?? '')}`
        )
      ).body
    )
    expect(second.items.map((r) => r.rowNumber)).toEqual([102, 103, 104, 105, 106])
    expect(second.nextCursor).toBeNull()
    expect(
      (await call(admin, 'GET', `/prospect-imports/${created.id}/rows?limit=101`)).status
    ).toBe(400)
    expect(
      (await call(admin, 'GET', `/prospect-imports/${created.id}/rows?cursor=garbage`)).status
    ).toBe(400)
    const onlyRejected = await call(
      admin,
      'GET',
      `/prospect-imports/${created.id}/rows?result=rejected`
    )
    expect(onlyRejected.body.items).toEqual([])
    const imports = await call(admin, 'GET', '/prospect-imports?limit=1')
    expect(imports.body.items).toHaveLength(1)
  })

  test('downloads the report as CSV, in pages', async () => {
    const { run, harness, admin, seeded } = await setup()
    const lines = [HEADER]
    for (let i = 0; i < 250; i++) {
      lines.push(i === 3 ? 'Bad,Row,nope,,,,,' : `P${i},Q,p${i}@x.test,,,,,`)
    }
    const { created } = await run(lines.join('\n'))
    const token = await harness.bearer({
      userId: admin.userId,
      organizationId: seeded.organizationId,
      role: admin.role,
    })
    const response = await harness.app.request(`/v1/prospect-imports/${created.id}/report.csv`, {
      headers: token,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    const text = await response.text()
    const rows = text.split('\r\n')
    expect(rows[0]).toBe('row_number,result,reason,prospect_id')
    expect(rows).toHaveLength(1 + 250 + 1)
    expect(rows[4]).toBe('5,rejected,invalid_email,')
    expect(rows[1]?.startsWith('2,created,,prs_')).toBe(true)
  })

  test('keeps manual values and reports the row as skipped', async () => {
    const { run, call, admin } = await setup()
    const made = await call(admin, 'POST', '/prospects', {
      firstName: 'Manual',
      lastName: 'Person',
      email: 'm@x.test',
    })
    expect(made.status).toBe(201)
    const manual = prospectSchema.parse(made.body)
    const first = await run(`${HEADER}\nImported,Other,m@x.test,,,,,\nSame,Name,s@x.test,,,,,\n`)
    expect(first.rows[0]).toMatchObject({
      result: 'skipped',
      reason: 'manual_values_kept',
      prospectId: manual.id,
    })
    expect(first.rows[1]?.result).toBe('created')
    const again = await run(`${HEADER}\nSame,Name,s@x.test,,,,,\n`)
    expect(again.rows[0]).toMatchObject({ result: 'skipped', reason: 'no_change' })
    const changed = await run(`${HEADER}\nNewer,Name,s@x.test,,,,,\n`)
    expect(changed.rows[0]?.result).toBe('updated')
    const after = prospectSchema.parse((await call(admin, 'GET', `/prospects/${manual.id}`)).body)
    expect(after.fields.firstName?.value).toBe('Manual')
    expect(after.fields.firstName?.source).toBe('manual')
  })

  test('rejects a row whose identities name two different Prospects', async () => {
    const { run, call, admin } = await setup()
    await call(admin, 'POST', '/prospects', { email: 'one@x.test' })
    await call(admin, 'POST', '/prospects', { phone: '+14155550101' })
    const { rows } = await run('email,phone\none@x.test,+14155550101\n')
    expect(rows[0]).toMatchObject({
      result: 'rejected',
      reason: 'identity_conflict',
      prospectId: null,
    })
  })

  test('resumes after an interrupted run without duplicates', async () => {
    const { upload, admin, harness, store, seeded, call } = await setup()
    const lines = [HEADER]
    for (let i = 0; i < 7; i++) {
      lines.push(`P${i},Q,p${i}@x.test,,,,,`)
    }
    const response = await upload(admin, lines.join('\n'))
    const job = {
      organizationId: seeded.organizationId,
      importId: response.body.id,
      actorUserId: admin.userId,
      traceId: 'trace',
    }
    const options = { budgetMs: 0, batchRows: 3 }
    expect(await processImport(harness.deps, job, options)).toBe('continue')
    const midway = await call(admin, 'GET', `/prospect-imports/${response.body.id}`)
    expect(midway.body.state).toBe('processing')
    expect(await processImport(harness.deps, job, options)).toBe('continue')
    expect(await processImport(harness.deps, job, options)).toBe('done')
    // A redelivery of a finished job does nothing.
    expect(await processImport(harness.deps, job, options)).toBe('done')
    const done = prospectImportSchema.parse(
      (await call(admin, 'GET', `/prospect-imports/${response.body.id}`)).body
    )
    expect(done.createdCount).toBe(7)
    const list = await call(admin, 'GET', '/prospects?limit=100')
    expect(list.body.items).toHaveLength(7)
    expect(store).toBeDefined()
  })

  test('the worker queues the rest of a long import and finishes it', async () => {
    const { upload, admin, harness, call } = await setup()
    const lines = [HEADER]
    for (let i = 0; i < 5; i++) {
      lines.push(`P${i},Q,p${i}@x.test,,,,,`)
    }
    const response = await upload(admin, lines.join('\n'))
    const signal = new AbortController().signal
    const options = { budgetMs: 0, batchRows: 2 }
    let rounds = 0
    while ((await processAssignJobs(harness.deps, signal, 0, options)) > 0) {
      rounds++
    }
    expect(rounds).toBe(3)
    const done = await call(admin, 'GET', `/prospect-imports/${response.body.id}`)
    expect(done.body.state).toBe('completed')
    expect(done.body.createdCount).toBe(5)
  })

  test('undoes the import and its key when the job cannot be queued', async () => {
    const { upload, admin, harness, call, drain } = await setup()
    const real = harness.deps.jobs
    harness.deps.jobs = {
      ...real,
      publishBatch: async (envelopes: readonly { id: string }[]) => ({
        published: [],
        failed: envelopes.map((e) => ({ id: e.id, code: 'InternalError', senderFault: false })),
      }),
    } as never
    const csv = `${HEADER}\nA,B,a@x.test,,,,,\n`
    const failed = await upload(admin, csv, { key: 'retry-key-00000000001' })
    expect(failed.status).toBe(503)
    expect(failed.body.error.code).toBe('server.unavailable')
    expect((await call(admin, 'GET', '/prospect-imports')).body.items).toEqual([])
    harness.deps.jobs = real
    const retried = await upload(admin, csv, { key: 'retry-key-00000000001' })
    expect(retried.status).toBe(202)
    await drain()
    expect((await call(admin, 'GET', `/prospect-imports/${retried.body.id}`)).body.state).toBe(
      'completed'
    )
  })
})

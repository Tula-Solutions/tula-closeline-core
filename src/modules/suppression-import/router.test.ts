import { describe, expect, test } from 'bun:test'
import {
  MAX_SUPPRESSION_IMPORT_BYTES,
  type Role,
  suppressionEntryPageSchema,
  suppressionImportPageSchema,
  suppressionImportRowPageSchema,
  suppressionImportSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { judgeRecord, processSuppressionImport } from './process'

type Actor = { userId: SeededMember['userId']; role: Role }

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
    options: {
      key?: string
      name?: string
      type?: string
      organizationId?: typeof seeded.organizationId
    } = {}
  ) => {
    const form = new FormData()
    form.set(
      'file',
      new File([csv as never], options.name ?? 'suppress.csv', { type: options.type ?? 'text/csv' })
    )
    const token = await harness.bearer({
      userId: actor.userId,
      organizationId: options.organizationId ?? seeded.organizationId,
      role: actor.role,
    })
    const response = await harness.app.request('/v1/suppression-imports', {
      method: 'POST',
      headers: { ...token, ...(options.key ? { 'idempotency-key': options.key } : {}) },
      body: form,
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }
  const call = (actor: Actor, method: string, path: string, body?: unknown) =>
    api(actor, seeded.organizationId, method, path, body)
  const drain = async (options = {}) => {
    const signal = new AbortController().signal
    for (;;) {
      await drainTestOutbox(harness.deps)
      if ((await processAssignJobs(harness.deps, signal, 0, options)) === 0) {
        return
      }
    }
  }
  const run = async (csv: string, actor: Actor = admin) => {
    const response = await upload(actor, csv)
    expect(response.status).toBe(202)
    const created = suppressionImportSchema.parse(response.body)
    await drain()
    const done = suppressionImportSchema.parse(
      (await call(actor, 'GET', `/suppression-imports/${created.id}`)).body
    )
    const rows = suppressionImportRowPageSchema.parse(
      (await call(actor, 'GET', `/suppression-imports/${created.id}/rows?limit=100`)).body
    )
    return { created, done, rows: rows.items }
  }
  const entries = async () =>
    suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries?limit=100')).body
    ).items
  return { store, harness, seeded, admin, manager, rep, owner, upload, call, drain, run, entries }
}

describe('judgeRecord', () => {
  test('reads an email, a phone and a LinkedIn URL, and says why anything else is invalid', () => {
    expect(judgeRecord([' Ada@Example.test '])).toEqual({
      address: { kind: 'email', value: 'ada@example.test' },
    })
    expect(judgeRecord(['+1 (415) 555-0123'])).toMatchObject({ address: { kind: 'phone' } })
    expect(judgeRecord(['https://www.linkedin.com/in/ada-l/'])).toMatchObject({
      address: { kind: 'linkedin' },
    })
    expect(judgeRecord(['not-an-email@'])).toEqual({ reason: 'unreadable_address' })
    expect(judgeRecord(['12'])).toEqual({ reason: 'unreadable_address' })
    expect(judgeRecord(['hello world'])).toEqual({ reason: 'unsupported_address' })
    expect(judgeRecord([''])).toEqual({ reason: 'unreadable_address' })
    expect(judgeRecord(['a@x.test', 'b@x.test'])).toEqual({ reason: 'unreadable_address' })
  })
})

describe('Suppression CSV import', () => {
  test('gives every row a result: added, repeated in the file, already suppressed and bad', async () => {
    const { run, call, owner, entries } = await setup()
    await call(owner, 'POST', '/suppression-entries', { email: 'old@x.test' })
    const csv = [
      'address',
      'ada@x.test',
      '+14155550123',
      'ADA@x.test',
      'old@x.test',
      'nonsense words',
      'bad@',
      '',
      'https://linkedin.com/in/grace',
      '',
    ].join('\n')
    const { created, done, rows } = await run(csv)

    expect(created.state).toBe('uploaded')
    expect(done).toMatchObject({
      state: 'completed',
      totalRows: 8,
      addedRows: 3,
      alreadySuppressedRows: 2,
      invalidRows: 3,
    })
    expect(done.completedAt).not.toBeNull()
    expect(rows.map((r) => [r.rowNumber, r.result, r.reason])).toEqual([
      [2, 'added', null],
      [3, 'added', null],
      [4, 'already_suppressed', null],
      [5, 'already_suppressed', null],
      [6, 'invalid', 'unsupported_address'],
      [7, 'invalid', 'unreadable_address'],
      [8, 'invalid', 'unreadable_address'],
      [9, 'added', null],
    ])
    expect(await entries()).toHaveLength(4)
  })

  test('only stores and queues on the request path; the job does the rows', async () => {
    const { upload, admin, call, drain, entries } = await setup()
    const response = await upload(admin, 'address\na@x.test\n')
    expect(response.body.state).toBe('uploaded')
    expect(
      (await call(admin, 'GET', `/suppression-imports/${response.body.id}/rows`)).body.items
    ).toEqual([])
    expect(await entries()).toHaveLength(0)
    await drain()
    expect((await call(admin, 'GET', `/suppression-imports/${response.body.id}`)).body.state).toBe(
      'completed'
    )
    expect(await entries()).toHaveLength(1)
  })

  test('queues 50,000 rows and reports each, bad ones included', async () => {
    const { upload, drain, admin, call } = await setup()
    const lines = ['address']
    for (let i = 0; i < 49_990; i++) {
      lines.push(`p${i}@x.test`)
    }
    for (let i = 0; i < 10; i++) {
      lines.push(`bad ${i}`)
    }
    const csv = lines.join('\n')
    const queued = await upload(admin, csv)
    expect(queued.status).toBe(202)
    expect(queued.body.state).toBe('uploaded')

    await drain()
    const done = suppressionImportSchema.parse(
      (await call(admin, 'GET', `/suppression-imports/${queued.body.id}`)).body
    )
    expect(done).toMatchObject({
      state: 'completed',
      totalRows: 50_000,
      addedRows: 49_990,
      invalidRows: 10,
    })
    const bad = suppressionImportRowPageSchema.parse(
      (await call(admin, 'GET', `/suppression-imports/${done.id}/rows?result=invalid&limit=100`))
        .body
    )
    expect(bad.items).toHaveLength(10)
    expect(bad.items[0]).toEqual({
      rowNumber: 49_992,
      result: 'invalid',
      reason: 'unsupported_address',
    })
  }, 120_000)

  test('the same Idempotency-Key with the same file creates nothing new', async () => {
    const { upload, admin, call, drain, entries } = await setup()
    const csv = 'address\na@x.test\n'
    const first = await upload(admin, csv, { key: 'import-key-0000000001' })
    const again = await upload(admin, csv, { key: 'import-key-0000000001' })
    expect([first.status, again.status]).toEqual([202, 200])
    expect(again.body.id).toBe(first.body.id)
    await drain()
    const list = suppressionImportPageSchema.parse(
      (await call(admin, 'GET', '/suppression-imports')).body
    )
    expect(list.items).toHaveLength(1)
    expect(await entries()).toHaveLength(1)
    const reused = await upload(admin, `${csv}b@x.test\n`, { key: 'import-key-0000000001' })
    expect([reused.status, reused.body.error.code]).toEqual([422, 'request.idempotency_key_reused'])
  })

  test('refuses a wrong type, an oversized file and a bad header', async () => {
    const { upload, admin } = await setup()
    const type = await upload(admin, 'address\n', { name: 'list.xlsx' })
    expect([type.status, type.body.error.code]).toEqual([400, 'request.invalid'])
    const large = await upload(admin, new Uint8Array(MAX_SUPPRESSION_IMPORT_BYTES + 1).fill(97))
    expect([large.status, large.body.error.code]).toEqual([413, 'request.too_large'])
    for (const header of ['email\n', 'address,name\n', 'address,address\n', '']) {
      const bad = await upload(admin, header)
      expect([bad.status, bad.body.error.code]).toEqual([400, 'request.invalid'])
    }
    const binary = await upload(admin, new Uint8Array([0xff, 0xfe, 0x00]))
    expect(binary.body.error.code).toBe('request.invalid')
  })

  test('fails an import of more than 50,000 rows with too_many_rows', async () => {
    const { run, entries } = await setup()
    const lines = ['address']
    for (let i = 0; i < 50_001; i++) {
      lines.push(`p${i}@x.test`)
    }
    const { done } = await run(lines.join('\n'))
    expect([done.state, done.failureReason, done.totalRows]).toEqual([
      'failed',
      'too_many_rows',
      null,
    ])
    expect(done.completedAt).not.toBeNull()
    expect(await entries()).toHaveLength(0)
  }, 120_000)

  test('fails a file the job cannot read with unreadable', async () => {
    const { run } = await setup()
    const { done } = await run('address\n"never closed\n')
    expect([done.state, done.failureReason]).toEqual(['failed', 'unreadable'])
  })

  test('refuses Manager and Rep on every route', async () => {
    const { upload, call, admin, manager, rep } = await setup()
    const made = await upload(admin, 'address\na@x.test\n')
    for (const actor of [manager, rep]) {
      expect((await upload(actor, 'address\nb@x.test\n')).status).toBe(403)
      expect((await call(actor, 'GET', '/suppression-imports')).status).toBe(403)
      expect((await call(actor, 'GET', `/suppression-imports/${made.body.id}`)).status).toBe(403)
      expect((await call(actor, 'GET', `/suppression-imports/${made.body.id}/rows`)).status).toBe(
        403
      )
    }
  })

  test('a second Organization cannot upload into, read or list the first one’s imports', async () => {
    const { store, harness, upload, admin, call, drain, seeded } = await setup()
    const made = await upload(admin, 'address\na@x.test\n')
    await drain()
    const other = await seedOrganization(store)
    const otherCall = publicCaller(harness)
    for (const path of [
      `/suppression-imports/${made.body.id}`,
      `/suppression-imports/${made.body.id}/rows`,
    ]) {
      const response = await otherCall(other.owner, other.organizationId, 'GET', path)
      expect([response.status, response.body.error?.code]).toEqual([404, 'consent.not_found'])
    }
    const list = await otherCall(other.owner, other.organizationId, 'GET', '/suppression-imports')
    expect(suppressionImportPageSchema.parse(list.body).items).toEqual([])

    const theirs = await upload(other.owner, 'address\nb@x.test\n', {
      organizationId: other.organizationId,
    })
    await drain()
    const mine = suppressionImportPageSchema.parse(
      (await call(admin, 'GET', '/suppression-imports')).body
    )
    expect(mine.items.map((i) => i.id)).toEqual([made.body.id])
    expect(theirs.status).toBe(202)
    expect(seeded.organizationId).not.toBe(other.organizationId)
    const entries = await otherCall(
      other.owner,
      other.organizationId,
      'GET',
      '/suppression-entries?limit=100'
    )
    expect(suppressionEntryPageSchema.parse(entries.body).items).toHaveLength(1)
  })

  test('lists imports and rows a page at a time', async () => {
    const { upload, admin, call, drain } = await setup()
    const first = await upload(admin, `address\n${'a@x.test\n'.repeat(1)}`)
    const second = await upload(admin, 'address\nb@x.test\nc@x.test\nd@x.test\n')
    await drain()
    const page = suppressionImportPageSchema.parse(
      (await call(admin, 'GET', '/suppression-imports?limit=1')).body
    )
    // The test clock is fixed, so the id breaks the tie: newest first is the larger id.
    const [newer, older] = [first.body.id, second.body.id].sort().reverse()
    expect(page.items.map((i) => i.id)).toEqual([newer])
    expect(page.nextCursor).not.toBeNull()
    const next = suppressionImportPageSchema.parse(
      (await call(admin, 'GET', `/suppression-imports?limit=1&cursor=${page.nextCursor}`)).body
    )
    expect(next.items.map((i) => i.id)).toEqual([older])
    expect(next.nextCursor).toBeNull()

    const rows = suppressionImportRowPageSchema.parse(
      (await call(admin, 'GET', `/suppression-imports/${second.body.id}/rows?limit=2`)).body
    )
    const rest = suppressionImportRowPageSchema.parse(
      (
        await call(
          admin,
          'GET',
          `/suppression-imports/${second.body.id}/rows?limit=2&cursor=${rows.nextCursor}`
        )
      ).body
    )
    expect([...rows.items, ...rest.items].map((r) => r.rowNumber)).toEqual([2, 3, 4])
    expect(rest.nextCursor).toBeNull()
  })

  test('resumes after an interrupted run without doing a row twice', async () => {
    const { upload, admin, harness, seeded, call, entries } = await setup()
    const lines = ['address']
    for (let i = 0; i < 7; i++) {
      lines.push(`p${i}@x.test`)
    }
    const response = await upload(admin, lines.join('\n'))
    const job = {
      organizationId: seeded.organizationId,
      importId: response.body.id,
      actorUserId: admin.userId,
      traceId: 'trace',
    }
    const options = { budgetMs: 0, batchRows: 3 }
    expect(await processSuppressionImport(harness.deps, job, options)).toBe('continue')
    expect((await call(admin, 'GET', `/suppression-imports/${response.body.id}`)).body.state).toBe(
      'processing'
    )
    expect(await processSuppressionImport(harness.deps, job, options)).toBe('continue')
    expect(await processSuppressionImport(harness.deps, job, options)).toBe('done')
    // A redelivery of a finished job does nothing.
    expect(await processSuppressionImport(harness.deps, job, options)).toBe('done')
    const done = suppressionImportSchema.parse(
      (await call(admin, 'GET', `/suppression-imports/${response.body.id}`)).body
    )
    expect([done.addedRows, done.alreadySuppressedRows, done.totalRows]).toEqual([7, 0, 7])
    expect(await entries()).toHaveLength(7)
  })

  test('the worker queues the rest of a long import and finishes it', async () => {
    const { upload, admin, harness, call, entries } = await setup()
    const lines = ['address']
    for (let i = 0; i < 5; i++) {
      lines.push(`p${i}@x.test`)
    }
    const response = await upload(admin, lines.join('\n'))
    const signal = new AbortController().signal
    const options = { budgetMs: 0, batchRows: 2 }
    await drainTestOutbox(harness.deps)
    let rounds = 0
    while ((await processAssignJobs(harness.deps, signal, 0, options)) > 0) {
      rounds++
      expect(rounds).toBeLessThan(20)
    }
    expect(rounds).toBeGreaterThan(1)
    const done = await call(admin, 'GET', `/suppression-imports/${response.body.id}`)
    expect([done.body.state, done.body.addedRows]).toEqual(['completed', 5])
    expect(await entries()).toHaveLength(5)
  })
})

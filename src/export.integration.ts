import { describe, expect, test } from 'bun:test'
import { exportJobSchema } from 'tula-closeline-contract'
import { harness, store } from '~/integration-harness'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { publicCaller, seedOrganization } from '~/testing'

const SMALL = { chunkRows: 2, stepChunks: 2 }

describe('exporting an Organization, over Postgres', () => {
  test('builds the slice, keeps the other Organization out, and enforces one at a time', async () => {
    const h = await harness()
    const mine = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['rep'])
    const api = publicCaller(h)
    const create = (key: string) =>
      api(mine.owner, mine.organizationId, 'POST', '/exports', {}, { 'idempotency-key': key })

    // Two requests at once: the database's one-active-job index lets exactly one in.
    const answers = await Promise.all([create(crypto.randomUUID()), create(crypto.randomUUID())])
    expect(answers.map((a) => a.status).sort()).toEqual([202, 409])
    const created = exportJobSchema.parse(answers.find((a) => a.status === 202)?.body)
    const refused = answers.find((a) => a.status === 409)?.body as { error?: { code?: string } }
    expect(refused.error?.code).toBe('export.already_running')

    const signal = new AbortController().signal
    while ((await processAssignJobs(h.deps, signal, 0, {}, SMALL)) > 0) {}

    const read = await api(mine.owner, mine.organizationId, 'GET', `/exports/${created.id}`)
    const finished = exportJobSchema.parse(read.body)
    expect(finished.state).toBe('ready')
    expect(finished.parts.map((p) => p.state)).toEqual(['ready'])

    const files = await h.deps.objects.list(mine.organizationId, {
      prefix: `exports/${created.id}/`,
      limit: 1000,
    })
    expect(files.items.length).toBeGreaterThan(2)
    let everything = ''
    for (const item of files.items) {
      const stored = await h.deps.objects.get(mine.organizationId, item.key)
      everything += new TextDecoder().decode(stored?.body)
    }
    expect(everything).toContain(mine.owner.email)
    expect(everything).not.toContain(other.owner.email)
    expect(everything).not.toContain(other.organizationId)

    // The list shows it, and a second export is allowed once the first is done (limit is two a day).
    const listed = await api(mine.owner, mine.organizationId, 'GET', '/exports?limit=10')
    expect((listed.body as { items: unknown[] }).items).toHaveLength(1)
    const second = await create(crypto.randomUUID())
    expect(second.status).toBe(202)
    while ((await processAssignJobs(h.deps, signal, 0, {}, SMALL)) > 0) {}
    const third = await create(crypto.randomUUID())
    expect(third.status).toBe(429)
    expect((third.body as { error?: { code?: string } }).error?.code).toBe('export.daily_limit')

    // Another Organization cannot read this export, and a Rep cannot ask for one.
    const foreign = await api(other.owner, other.organizationId, 'GET', `/exports/${created.id}`)
    expect(foreign.status).toBe(404)
    const rep = mine.members.find((m) => m.role === 'rep')
    expect(rep).toBeDefined()
    const denied = await api(
      { userId: rep?.userId ?? mine.owner.userId, role: 'rep' },
      mine.organizationId,
      'POST',
      '/exports',
      {},
      { 'idempotency-key': crypto.randomUUID() }
    )
    expect(denied.status).toBe(403)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  auditMetadataSchema,
  type ExportJob,
  type ExportJobId,
  exportDownloadSchema,
  exportJobSchema,
  formatId,
  type OrganizationId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { jobRegistry } from '~/messages'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { hashAddress } from '~/modules/suppression/address'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
  TEST_CONSENT_HASH_KEY,
} from '~/testing'
import { mintExportDownloadToken, readExportDownloadToken } from './token'

type Actor = { userId: SeededMember['userId']; role: Role }

const SMALL = { chunkRows: 2, stepChunks: 2 }
const SEALED = 'SEALED-ACCESS-TOKEN-MARKER-9f3a'
const OTHER_MARKER = 'OTHER-ORGANIZATION-MARKER-77c1'

async function setup(services = 'core') {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store, env: { EXPORT_PART_SERVICES: services } })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    organizationId: OrganizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const create = (actor: Actor = seeded.owner, key = crypto.randomUUID()) =>
    call(actor, 'POST', '/exports', {}, { 'idempotency-key': key })
  const drain = async (options = SMALL) => {
    const signal = new AbortController().signal
    for (let total = 0; ; ) {
      const n = await processAssignJobs(harness.deps, signal, 0, {}, options)
      if (n === 0) {
        return total
      }
      total += n
    }
  }
  const get = async (id: string) => {
    const response = await call(seeded.owner, 'GET', `/exports/${id}`)
    return { status: response.status, body: response.body }
  }
  const job = async (id: string): Promise<ExportJob> => {
    const response = await get(id)
    expect(response.status).toBe(200)
    return exportJobSchema.parse(response.body)
  }
  const audit = (organizationId = seeded.organizationId) =>
    store.withOrganization(organizationId, (scope) =>
      scope.listAuditEvents({
        visibility: { kind: 'all' },
        order: 'oldest',
        limit: 500,
        filter: {},
      })
    )
  const text = async (organizationId: OrganizationId, prefix: string) => {
    const out: Record<string, string> = {}
    const page = await harness.deps.objects.list(organizationId, { prefix, limit: 1000 })
    for (const entry of page.items) {
      const stored = await harness.deps.objects.get(organizationId, entry.key)
      out[entry.key] = new TextDecoder().decode(stored?.body)
    }
    return out
  }
  const lines = (body: string) =>
    body
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const send = async (
    type: 'export.part_ready' | 'export.part_failed',
    payload: Record<string, unknown>
  ) => {
    const envelope = jobRegistry.create({
      type,
      payload,
      organizationId: seeded.organizationId,
      traceId: 'trace-part',
    } as unknown as Parameters<typeof jobRegistry.create>[0])
    const result = await harness.deps.jobs.publishBatch([envelope])
    expect(result.failed).toHaveLength(0)
  }
  const prospect = async (organizationId: OrganizationId, actor: Actor, notes: string) => {
    const response = await call(
      actor,
      'POST',
      '/prospects',
      { firstName: 'Pat', lastName: 'Doe', email: `${crypto.randomUUID()}@example.test`, notes },
      {},
      organizationId
    )
    expect([200, 201]).toContain(response.status)
  }
  return {
    ...harness,
    store,
    seeded,
    call,
    create,
    drain,
    get,
    job,
    audit,
    text,
    lines,
    send,
    prospect,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

describe('requesting an export', () => {
  test('Owner and Admin get 202 with a queued job; the same key answers 200 with the same job', async () => {
    const s = await setup()
    const key = crypto.randomUUID()
    const first = await s.create(s.owner, key)

    expect(first.status).toBe(202)
    const created = exportJobSchema.parse(first.body)
    expect(created).toMatchObject({
      kind: 'organization',
      format: null,
      filter: null,
      state: 'queued',
      requestedByMembershipId: s.owner.id,
      includeRecordingLinks: false,
      failureReason: null,
      completedAt: null,
      expiresAt: null,
      parts: [{ service: 'core', state: 'pending' }],
    })

    const again = await s.create(s.owner, key)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)

    await s.drain()
    const other = await s.create(s.admin)
    expect(other.status).toBe(202)
  })

  test('a Manager or Rep is refused before anything is written', async () => {
    const s = await setup()
    for (const actor of [s.manager, s.rep]) {
      const response = await s.create(actor)
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('auth.forbidden')
    }
    expect((await s.call(s.owner, 'GET', '/exports')).body).toMatchObject({ items: [] })
  })

  test('needs an Idempotency-Key and refuses the enriched kind this job does not build', async () => {
    const s = await setup()
    const missing = await s.call(s.owner, 'POST', '/exports', {})
    expect(missing.status).toBe(400)

    const enriched = await s.call(
      s.owner,
      'POST',
      '/exports',
      { kind: 'enriched_prospects', format: 'csv' },
      { 'idempotency-key': crypto.randomUUID() }
    )
    expect(enriched.status).toBe(400)
    expect(enriched.body.error?.code).toBe('request.invalid')
  })

  test('records the request in the audit log and publishes export.requested once', async () => {
    const s = await setup()
    const response = await s.create()
    const created = exportJobSchema.parse(response.body)

    const events = (await s.audit()).filter((event) => event.action === 'export.requested')
    expect(events).toHaveLength(1)
    expect(auditMetadataSchema.safeParse(events[0]?.metadata).success).toBe(true)
    expect(events[0]).toMatchObject({
      actor: { kind: 'member', membershipId: s.owner.id },
      subject: { type: 'export', id: created.id },
    })

    await drainTestOutbox(s.deps)
    const delivered = await s.deps.events.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 60,
      waitSeconds: 0,
    })
    const requested = delivered.flatMap((delivery) =>
      delivery.kind === 'message' && delivery.envelope.type === 'export.requested'
        ? [delivery.envelope.payload]
        : []
    )
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({
      exportId: created.id,
      requestedByMembershipId: s.owner.id,
      includeRecordingLinks: false,
    })
  })

  test('only one export runs at a time', async () => {
    const s = await setup()
    await s.create()

    const second = await s.create(s.admin)

    expect(second.status).toBe(409)
    expect(second.body.error?.code).toBe('export.already_running')
  })

  test('two a day: the third request in 24 hours is export.daily_limit, then it clears', async () => {
    const s = await setup()
    for (let n = 0; n < 2; n++) {
      expect((await s.create()).status).toBe(202)
      await s.drain()
    }

    const third = await s.create()
    expect(third.status).toBe(429)
    expect(third.body.error?.code).toBe('export.daily_limit')

    s.deps.clock.advance('25h')
    expect((await s.create()).status).toBe(202)
  })

  test('an export stuck for hours is failed as timed out, and frees the slot', async () => {
    const s = await setup('core,playbook')
    const stuck = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    expect((await s.job(stuck.id)).state).toBe('running')

    s.deps.clock.advance('7h')

    const read = await s.job(stuck.id)
    expect(read).toMatchObject({ state: 'failed', failureReason: 'timed_out' })
    expect((await s.create()).status).toBe(202)
    expect((await s.audit()).some((event) => event.action === 'export.failed')).toBe(true)
  })
})

describe('building the Organization slice', () => {
  test('writes the slice as NDJSON in bounded chunks, a manifest, and completes the job', async () => {
    const s = await setup()
    for (let n = 0; n < 5; n++) {
      await s.prospect(s.seeded.organizationId, s.rep, `note ${n}`)
    }
    const created = exportJobSchema.parse((await s.create()).body)

    await s.drain()

    const done = await s.job(created.id)
    expect(done.state).toBe('ready')
    expect(done.completedAt).not.toBeNull()
    expect(Date.parse(done.expiresAt as string) - Date.parse(done.completedAt as string)).toBe(
      24 * 3_600_000
    )
    const core = done.parts.find((part) => part.service === 'core')
    expect(core?.state).toBe('ready')

    const files = await s.text(s.seeded.organizationId, `exports/${created.id}/`)
    const dataFiles = Object.entries(files).filter(([key]) => key.includes('/core/'))
    expect(dataFiles.length).toBe(core?.fileCount as number)
    for (const [key, body] of dataFiles) {
      expect(key.endsWith('.ndjson')).toBe(true)
      expect(lines(body).length).toBeLessThanOrEqual(SMALL.chunkRows)
    }
    const prospects = dataFiles
      .filter(([key]) => key.includes('/prospects-'))
      .flatMap(([, body]) => lines(body))
    expect(prospects).toHaveLength(5)
    const manifest = JSON.parse(files[`exports/${created.id}/manifest.json`] as string)
    expect(manifest.exportId).toBe(created.id)
    expect(manifest.parts[0]).toMatchObject({ service: 'core', fileCount: core?.fileCount })

    function lines(body: string) {
      return s.lines(body)
    }
  })

  test('the slice holds the Organization, Teams, members, Prospects, suppression and audit log', async () => {
    const s = await setup()
    await s.call(s.owner, 'POST', '/teams', { name: 'North' })
    await s.prospect(s.seeded.organizationId, s.rep, 'hello')
    await s.call(s.owner, 'POST', '/suppression-entries', { email: 'gone@example.test' })
    const created = exportJobSchema.parse((await s.create()).body)

    await s.drain()

    const files = await s.text(s.seeded.organizationId, `exports/${created.id}/core/`)
    const rows = (dataset: string) =>
      Object.entries(files)
        .filter(([key]) => key.includes(`/${dataset}-`))
        .flatMap(([, body]) => s.lines(body))
    expect(rows('organization')).toHaveLength(1)
    expect(rows('teams').map((row) => row.name)).toEqual(['North'])
    expect(rows('members')).toHaveLength(4)
    expect(rows('prospects')).toHaveLength(1)
    expect(rows('suppression')).toHaveLength(1)
    expect(rows('audit').length).toBeGreaterThanOrEqual(2)
  })

  test('no credential, hash or other Organization row appears, over a seeded pair', async () => {
    const s = await setup()
    const other = await seedOrganization(s.store, [], 'Other Co')
    await s.prospect(s.seeded.organizationId, s.rep, 'ours')
    await s.prospect(other.organizationId, other.owner, OTHER_MARKER)
    await s.call(s.owner, 'POST', '/suppression-entries', { email: 'Gone@Example.test' })
    await s.call(
      other.owner,
      'POST',
      '/suppression-entries',
      { email: 'x@example.test' },
      {},
      other.organizationId
    )
    await s.call(s.owner, 'POST', '/invitations', { email: 'new@example.test', role: 'rep' })
    await s.store.withOrganization(s.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.upsertCrmConnection({
        id: formatId('crn', crypto.randomUUID()),
        provider: 'hubspot',
        externalAccountId: 'acct-1',
        accountLabel: 'Acme',
        scopeLevel: 'read',
        connectedByMembershipId: s.owner.id,
        accessTokenSealed: new TextEncoder().encode(SEALED),
        refreshTokenSealed: null,
        tokenKeyId: 'k1',
        accessTokenExpiresAt: null,
        now: new Date('2026-01-01T00:00:00Z'),
      })
    })
    const created = exportJobSchema.parse((await s.create()).body)

    await s.drain()

    const files = await s.text(s.seeded.organizationId, 'exports/')
    expect(Object.keys(files).length).toBeGreaterThan(3)
    const everything = Object.values(files).join('\n')
    const addressHash = hashAddress(
      TEST_CONSENT_HASH_KEY,
      s.seeded.organizationId,
      'email',
      'gone@example.test'
    )
    for (const forbidden of [
      OTHER_MARKER,
      other.owner.email,
      other.organizationId,
      SEALED,
      Buffer.from(SEALED).toString('base64'),
      Buffer.from(addressHash).toString('hex'),
      Buffer.from(addressHash).toString('base64'),
      'tokenHash',
      'token_hash',
      'accessTokenSealed',
      'addressHash',
      'keyHash',
      'secret',
    ]) {
      expect(everything).not.toContain(forbidden)
    }
    expect((await s.job(created.id)).state).toBe('ready')
    expect(Object.keys(await s.text(other.organizationId, 'exports/'))).toHaveLength(0)
  })

  test('a redelivered job writes nothing twice', async () => {
    const s = await setup()
    await s.prospect(s.seeded.organizationId, s.rep, 'once')
    const created = exportJobSchema.parse((await s.create()).body)
    // Deliver the first build step twice, as an at-least-once queue may.
    const first = await s.deps.jobs.receive({
      maxMessages: 1,
      visibilityTimeoutSeconds: 0,
      waitSeconds: 0,
    })
    expect(first).toHaveLength(1)
    const delivery = first[0]
    if (delivery?.kind !== 'message') {
      throw new Error('expected a message')
    }
    await s.deps.jobs.publishBatch([delivery.envelope])
    await s.deps.jobs.publishBatch([delivery.envelope])

    await s.drain()

    const done = await s.job(created.id)
    expect(done.state).toBe('ready')
    const files = await s.text(s.seeded.organizationId, `exports/${created.id}/core/`)
    expect(Object.keys(files).length).toBe(done.parts[0]?.fileCount as number)
    const events = (await s.audit()).filter((event) => event.action === 'export.requested')
    expect(events).toHaveLength(1)
    const completedAt = done.completedAt
    await s.drain()
    expect((await s.job(created.id)).completedAt).toBe(completedAt)
  })

  test('a storage that keeps failing fails the part with a reason, and a retry completes the export', async () => {
    const s = await setup()
    const created = exportJobSchema.parse((await s.create()).body)
    const realPut = s.deps.objects.put.bind(s.deps.objects)
    let broken = true
    s.deps.objects.put = async (...args) => {
      if (broken) {
        throw new Error('storage is down')
      }
      return realPut(...args)
    }
    const signal = new AbortController().signal
    for (let attempt = 0; attempt < 3; attempt++) {
      await processAssignJobs(s.deps, signal, 0, {}, SMALL)
      s.deps.clock.advance('5m')
    }

    const failed = await s.job(created.id)
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'part_failed' })
    expect(failed.parts[0]).toMatchObject({ service: 'core', state: 'failed' })
    const failures = (await s.audit()).filter((event) => event.action === 'export.failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.actor).toEqual({ kind: 'system' })

    broken = false
    const retried = await s.call(s.owner, 'POST', `/exports/${created.id}/retries`, {}, {})
    expect([404, 405]).toContain(retried.status)
    const { retryExport } = await import('./service')
    const again = await retryExport(
      s.deps,
      { ...s.owner, organizationId: s.seeded.organizationId },
      created.id,
      {
        traceId: 'trace-retry',
      }
    )
    expect(again.state).toBe('queued')
    await s.drain()
    expect((await s.job(created.id)).state).toBe('ready')
  })

  test('a retry made a day after the request is not timed out at once', async () => {
    const s = await setup()
    const created = exportJobSchema.parse((await s.create()).body)
    const realPut = s.deps.objects.put.bind(s.deps.objects)
    let broken = true
    s.deps.objects.put = async (...args) => {
      if (broken) {
        throw new Error('storage is down')
      }
      return realPut(...args)
    }
    const signal = new AbortController().signal
    for (let attempt = 0; attempt < 3; attempt++) {
      await processAssignJobs(s.deps, signal, 0, {}, SMALL)
      s.deps.clock.advance('5m')
    }
    expect((await s.job(created.id)).state).toBe('failed')

    broken = false
    s.deps.clock.advance('24h')
    const { retryExport } = await import('./service')
    await retryExport(s.deps, { ...s.owner, organizationId: s.seeded.organizationId }, created.id, {
      traceId: 'trace-late-retry',
    })
    await s.drain()
    expect((await s.job(created.id)).state).toBe('ready')
  })

  test('a replayed request while the build is still queued publishes the build again', async () => {
    const s = await setup()
    const key = crypto.randomUUID()
    const first = exportJobSchema.parse((await s.create(s.owner, key)).body)
    // Lose the first build message, as a crash between commit and publish would.
    await s.deps.jobs.receive({ maxMessages: 10, visibilityTimeoutSeconds: 3600, waitSeconds: 0 })
    const again = await s.create(s.owner, key)
    expect(again.status).toBe(200)
    await s.drain()
    expect((await s.job(first.id)).state).toBe('ready')
  })
})

describe('parts from other services', () => {
  test('a part that names another service prefix is refused', async () => {
    const s = await setup('core,playbook')
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    await s.send('export.part_ready', {
      exportId: created.id,
      service: 'playbook',
      prefix: `exports/${created.id}/core`,
      fileCount: 1,
      bytes: 1,
      readyAt: s.deps.clock.now().toISOString(),
    })
    await s.drain()
    const job = await s.job(created.id)
    expect(job.state).toBe('running')
    expect(job.parts.find((part) => part.service === 'playbook')?.state).toBe('pending')
  })

  test('the export waits for every configured part, then completes with a manifest of both', async () => {
    const s = await setup('core,playbook')
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    expect((await s.job(created.id)).state).toBe('running')

    const prefix = `exports/${created.id}/playbook`
    await s.deps.objects.put(
      s.seeded.organizationId,
      `${prefix}/docs-0.ndjson`,
      new TextEncoder().encode('{"a":1}\n'),
      {
        contentType: 'application/x-ndjson',
      }
    )
    const ready = {
      exportId: created.id,
      service: 'playbook',
      prefix,
      fileCount: 1,
      bytes: 8,
      readyAt: s.deps.clock.now().toISOString(),
    }
    await s.send('export.part_ready', ready)
    await s.send('export.part_ready', ready)
    await s.drain()

    const done = await s.job(created.id)
    expect(done.state).toBe('ready')
    expect(done.parts.map((part) => [part.service, part.state])).toEqual([
      ['core', 'ready'],
      ['playbook', 'ready'],
    ])
    const files = await s.text(s.seeded.organizationId, `exports/${created.id}/manifest`)
    const manifest = JSON.parse(Object.values(files)[0] as string)
    expect(manifest.parts.map((part: { service: string }) => part.service)).toEqual([
      'core',
      'playbook',
    ])
    expect(manifest.parts[1].files).toEqual([{ key: `${prefix}/docs-0.ndjson`, bytes: 8 }])
  })

  test('a part that fails fails the export with the reason, audited; a retry then completes it', async () => {
    const s = await setup('core,playbook')
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()

    await s.send('export.part_failed', {
      exportId: created.id,
      service: 'playbook',
      reason: 'source_unavailable',
      failedAt: s.deps.clock.now().toISOString(),
    })
    await s.drain()

    const failed = await s.job(created.id)
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'part_failed' })
    expect(failed.parts.find((part) => part.service === 'playbook')?.state).toBe('failed')
    expect((await s.audit()).filter((event) => event.action === 'export.failed')).toHaveLength(1)

    const { retryExport } = await import('./service')
    const caller = { ...s.owner, organizationId: s.seeded.organizationId }
    const queued = await retryExport(s.deps, caller, created.id, { traceId: 'trace-retry' })
    expect(queued.state).toBe('queued')
    expect(queued.parts.map((part) => part.state)).toEqual(['ready', 'pending'])

    const prefix = `exports/${created.id}/playbook`
    await s.send('export.part_ready', {
      exportId: created.id,
      service: 'playbook',
      prefix,
      fileCount: 0,
      bytes: 0,
      readyAt: s.deps.clock.now().toISOString(),
    })
    await s.drain()
    expect((await s.job(created.id)).state).toBe('ready')
    expect((await s.audit()).some((event) => event.action === 'export.retried')).toBe(true)
  })

  test('a result for an export that is not there, or already done, changes nothing', async () => {
    const s = await setup()
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    const before = await s.job(created.id)

    await s.send('export.part_ready', {
      exportId: formatId('exp', crypto.randomUUID()),
      service: 'core',
      prefix: 'exports/x/core',
      fileCount: 0,
      bytes: 0,
      readyAt: s.deps.clock.now().toISOString(),
    })
    await s.send('export.part_failed', {
      exportId: created.id,
      service: 'core',
      reason: 'write_failed',
      failedAt: s.deps.clock.now().toISOString(),
    })
    await s.drain()

    expect(await s.job(created.id)).toEqual(before)
  })
})

describe('reading exports', () => {
  test('lists newest first with a cursor, never a link; an unknown or foreign id is export.not_found', async () => {
    const s = await setup()
    const ids: ExportJobId[] = []
    for (let n = 0; n < 2; n++) {
      ids.push(exportJobSchema.parse((await s.create()).body).id)
      await s.drain()
      s.deps.clock.advance('1m')
    }

    const first = await s.call(s.owner, 'GET', '/exports?limit=1')
    expect(first.status).toBe(200)
    const page = first.body as { items: ExportJob[]; nextCursor: string | null }
    expect(page.items.map((item) => item.id)).toEqual([ids[1] as ExportJob['id']])
    expect(page.nextCursor).not.toBeNull()
    const second = await s.call(s.owner, 'GET', `/exports?limit=1&cursor=${page.nextCursor}`)
    expect((second.body as { items: ExportJob[] }).items.map((item) => item.id)).toEqual([
      ids[0] as ExportJob['id'],
    ])
    expect(JSON.stringify(first.body)).not.toContain('http')
    const bad = await s.call(s.owner, 'GET', '/exports?cursor=garbage')
    expect(bad.status).toBe(400)

    const other = await seedOrganization(s.store)
    const foreign = await s.call(
      other.owner,
      'GET',
      `/exports/${ids[0]}`,
      undefined,
      {},
      other.organizationId
    )
    expect(foreign.status).toBe(404)
    expect(foreign.body.error?.code).toBe('export.not_found')
    expect((await s.get(formatId('exp', crypto.randomUUID()))).status).toBe(404)
    expect((await s.call(s.rep, 'GET', '/exports')).status).toBe(403)
  })
})

describe('the download link', () => {
  const link = (s: Awaited<ReturnType<typeof setup>>, id: string, key = crypto.randomUUID()) =>
    s.call(s.owner, 'POST', `/exports/${id}/download-links`, {}, { 'idempotency-key': key })

  test('is refused until the export is ready, and for an unknown export', async () => {
    const s = await setup()
    const created = exportJobSchema.parse((await s.create()).body)

    const early = await link(s, created.id)
    expect(early.status).toBe(409)
    expect(early.body.error?.code).toBe('export.not_ready')
    const missing = await link(s, formatId('exp', crypto.randomUUID()))
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('export.not_found')
  })

  test('is valid for 24 hours from the finish, answers the same for the same key, and is audited', async () => {
    const s = await setup()
    await s.prospect(s.seeded.organizationId, s.rep, 'x')
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    const done = await s.job(created.id)
    const key = crypto.randomUUID()

    const first = await link(s, created.id, key)

    expect(first.status).toBe(201)
    const download = exportDownloadSchema.parse(first.body)
    expect(download.exportId).toBe(created.id)
    expect(download.expiresAt).toBe(done.expiresAt as string)
    expect(download.url.startsWith('https://app.test/exports/download/')).toBe(true)
    const again = await link(s, created.id, key)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const downloads = (await s.audit()).filter((event) => event.action === 'export.downloaded')
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.actor).toEqual({ kind: 'member', membershipId: s.owner.id })
    expect(JSON.stringify(downloads)).not.toContain(download.url)
    expect(s.deps.logLines.join('\n')).not.toContain(download.url)
    expect((await s.get(created.id)).body).not.toHaveProperty('url')
    expect(
      (
        await s.call(
          s.manager,
          'POST',
          `/exports/${created.id}/download-links`,
          {},
          { 'idempotency-key': crypto.randomUUID() }
        )
      ).status
    ).toBe(403)
  })

  test('the public route lists the files with fresh presigned links, in pages', async () => {
    const s = await setup()
    for (let n = 0; n < 4; n++) {
      await s.prospect(s.seeded.organizationId, s.rep, `n${n}`)
    }
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    const download = exportDownloadSchema.parse((await link(s, created.id)).body)
    const token = download.url.split('/').at(-1) as string

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const response = await s.app.request(
        `/v1/public/export-downloads/${token}?limit=3${cursor ? `&cursor=${cursor}` : ''}`
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        items: { key: string; bytes: number; url: string }[]
        nextCursor: string | null
      }
      expect(body.items.length).toBeLessThanOrEqual(3)
      for (const item of body.items) {
        seen.push(item.key)
        expect(item.url.length).toBeGreaterThan(0)
      }
      cursor = body.nextCursor
    } while (cursor)
    const done = await s.job(created.id)
    const fileCount = (done.parts[0]?.fileCount as number) + 1
    expect(seen.length).toBe(fileCount)
    expect(seen).toContain(`exports/${created.id}/manifest.json`)
    expect(new Set(seen).size).toBe(seen.length)
  })

  test('a tampered or foreign token is export.not_found; an expired one is export.expired, audited once', async () => {
    const s = await setup()
    const created = exportJobSchema.parse((await s.create()).body)
    await s.drain()
    const download = exportDownloadSchema.parse((await link(s, created.id)).body)
    const token = download.url.split('/').at(-1) as string
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`

    const bad = await s.app.request(`/v1/public/export-downloads/${tampered}`)
    expect(bad.status).toBe(404)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('export.not_found')

    s.deps.clock.advance('25h')
    for (let n = 0; n < 2; n++) {
      const late = await s.app.request(`/v1/public/export-downloads/${token}`)
      expect(late.status).toBe(410)
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe('export.expired')
    }
    const viaApi = await link(s, created.id)
    expect(viaApi.status).toBe(410)
    expect(viaApi.body.error?.code).toBe('export.expired')
    const expired = (await s.audit()).filter((event) => event.action === 'export.expired')
    expect(expired).toHaveLength(1)
    expect(expired[0]?.actor).toEqual({ kind: 'system' })
    expect((await s.job(created.id)).state).toBe('expired')
  })
})

describe('the download token', () => {
  const claims = {
    organizationId: formatId('org', crypto.randomUUID()) as OrganizationId,
    exportId: formatId('exp', crypto.randomUUID()) as ExportJobId,
    expiresAt: new Date('2026-01-02T00:00:00Z'),
  }
  const KEY = 'k'.repeat(40)

  test('reads back what was signed, and nothing else', () => {
    const token = mintExportDownloadToken(KEY, claims)
    expect(readExportDownloadToken(KEY, token)).toEqual(claims)
    expect(readExportDownloadToken('j'.repeat(40), token)).toBeUndefined()
    expect(readExportDownloadToken(KEY, `${token}A`)).toBeUndefined()
    expect(readExportDownloadToken(KEY, 'short')).toBeUndefined()
    expect(token).not.toContain('=')
  })
})

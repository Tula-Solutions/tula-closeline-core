import { describe, expect, test } from 'bun:test'
import {
  type CrmSyncRun,
  crmSyncRunSchema,
  type OrganizationId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import type { CrmDeal } from '~/ports/crm-provider'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import * as Crm from './service'
import { CRM_SYNC_MAX_DELIVERIES } from './sync-worker'

const STAGES = [
  { stageId: 'won', label: 'Closed won', pipelineId: null, pipelineLabel: null },
  { stageId: 'lost', label: 'Closed lost', pipelineId: null, pipelineLabel: null },
  { stageId: 'open', label: 'Proposal', pipelineId: null, pipelineLabel: null },
]
const MAPPING = {
  entries: [
    { stageId: 'won', outcome: 'won' },
    { stageId: 'lost', outcome: 'lost' },
    { stageId: 'open', outcome: 'open' },
  ],
}

const deal = (id: string, stageId: string | null, minute: number, extra = {}): CrmDeal => ({
  id,
  name: `Deal ${id}`,
  stageId,
  amount: 1000,
  currency: 'USD',
  closedAt: stageId === 'open' ? null : '2026-01-02',
  version: `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`,
  ...extra,
})

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const second = await seedOrganization(memory, ['admin'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const key = () => ({ 'idempotency-key': crypto.randomUUID() })
  const call = (
    actor: SeededMember,
    method: string,
    path: string,
    body?: unknown,
    organizationId: OrganizationId = seeded.organizationId,
    headers?: Record<string, string>
  ) => api(actor, organizationId, method, path, body, headers)
  const connect = async (member: SeededMember, organizationId: OrganizationId, code: string) => {
    harness.deps.hubspot.acceptCode(code, {
      accessToken: `access-${code}`,
      refreshToken: `refresh-${code}`,
      accessTokenExpiresAt: new Date('2026-01-01T01:00:00Z'),
      externalAccountId: code,
      accountLabel: 'Acme',
      scopeLevel: 'read',
    })
    return Crm.connect(
      harness.deps,
      { organizationId, userId: member.userId, role: member.role },
      { provider: 'hubspot', code, redirectUri: 'https://core.test/cb' },
      { traceId: 'trace-1' }
    )
  }
  const drain = async (options = {}) => {
    const signal = new AbortController().signal
    for (let i = 0; i < 50; i += 1) {
      await drainTestOutbox(harness.deps)
      if ((await processAssignJobs(harness.deps, signal, 0, {}, {}, options)) === 0) {
        return
      }
    }
  }
  /** Lets a job the worker left unacknowledged come back, as the queue's visibility timeout does. */
  const redeliver = async (options = {}) => {
    harness.deps.clock.advance('3m')
    await drain(options)
  }
  const hubspot = harness.deps.hubspot
  const playbook = harness.deps.playbook
  const admin = seeded.owner
  const mapAll = async () => {
    hubspot.plantStages(STAGES)
    const response = await call(
      admin,
      'PUT',
      '/crm/connections/hubspot/stage-mapping',
      MAPPING,
      undefined,
      key()
    )
    expect(response.status).toBe(200)
  }
  const start = (actor = admin, organizationId = seeded.organizationId) =>
    call(
      actor,
      'POST',
      '/crm/connections/hubspot/sync-runs',
      { objectKind: 'deal' },
      organizationId,
      key()
    )
  const getRun = async (id: unknown, actor = admin, organizationId = seeded.organizationId) =>
    call(
      actor,
      'GET',
      `/crm/connections/hubspot/sync-runs/${String(id)}`,
      undefined,
      organizationId
    )
  const runOf = async (id: unknown): Promise<CrmSyncRun> =>
    crmSyncRunSchema.parse((await getRun(id)).body)
  return {
    ...harness,
    hubspot,
    playbook,
    memory,
    seeded,
    second,
    byRole,
    call,
    connect,
    drain,
    redeliver,
    mapAll,
    start,
    getRun,
    runOf,
    key,
    admin,
  }
}

describe('CRM Deal pull', () => {
  test('mapped stages become won, lost and open Outcomes with an idempotency key', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'lost', 2), deal('3', 'open', 3)])
    const started = await t.start()
    expect(started.status).toBe(202)
    await t.drain()
    const run = await t.runOf(started.body.id)
    expect(run.state).toBe('completed')
    expect(run.counts).toMatchObject({ created: 3, updated: 0, failed: 0 })
    const byId = Object.fromEntries(t.playbook.recorded.map((d) => [d.dealId, d]))
    expect(byId['hubspot-1']?.outcome).toBe('won')
    expect(byId['hubspot-2']?.outcome).toBe('lost')
    expect(byId['hubspot-3']?.outcome).toBe('open')
    expect(byId['hubspot-1']?.idempotencyKey).toBe(
      `crm:hubspot:deal:1:${deal('1', 'won', 1).version}`
    )
  })

  test('an unconfirmed or incomplete mapping answers crm.mapping_incomplete before syncing', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    t.hubspot.plantStages(STAGES)
    t.hubspot.plantDeals([deal('1', 'won', 1)])
    const none = await t.start()
    expect(none.status).toBe(409)
    expect(none.body.error?.code).toBe('crm.mapping_incomplete')
    await t.call(
      t.admin,
      'PUT',
      '/crm/connections/hubspot/stage-mapping',
      { entries: [{ stageId: 'won', outcome: 'won' }] },
      undefined,
      t.key()
    )
    const partial = await t.start()
    expect(partial.status).toBe(409)
    expect(partial.body.error?.code).toBe('crm.mapping_incomplete')
    expect(t.playbook.calls).toBe(0)
    expect(t.hubspot.dealReads).toBe(0)
  })

  test('a rerun creates nothing new and an unchanged Deal is not sent again', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'open', 2)])
    await t.start()
    await t.drain()
    expect(t.playbook.calls).toBe(2)
    const second = await t.start()
    await t.drain()
    const run = await t.runOf(second.body.id)
    expect(run.state).toBe('completed')
    expect(run.counts).toMatchObject({ created: 0, updated: 0 })
    expect(t.playbook.calls).toBe(2)
    // a changed Deal is an update with a new key
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'lost', 5)])
    const third = await t.start()
    await t.drain()
    expect((await t.runOf(third.body.id)).counts).toMatchObject({ created: 0, updated: 1 })
    expect(t.playbook.calls).toBe(3)
  })

  test('the cursor moves only after the page commits', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'won', 2), deal('3', 'won', 3)])
    const started = await t.start()
    // The first job commits page one (Deals 1 and 2), hands over on its budget, and the next
    // job's Playbook call fails on Deal 3: the cursor must stay where page one left it.
    await drainTestOutbox(t.deps)
    await processAssignJobs(
      t.deps,
      new AbortController().signal,
      0,
      {},
      {},
      {
        pageSize: 2,
        budgetMs: 0,
      }
    )
    t.playbook.failNext(1)
    await t.drain({ pageSize: 2 })
    const stuck = await t.memory.withOrganization(t.seeded.organizationId, (scope) =>
      scope.getCrmSyncRun(started.body.id as CrmSyncRun['id'])
    )
    expect(stuck?.cursor).toBe(String(Date.parse(deal('2', 'won', 2).version)))
    expect(stuck?.state).toBe('running')
    // the job is redelivered by the queue; the run then completes
    await t.redeliver({ pageSize: 2 })
    expect((await t.runOf(started.body.id)).state).toBe('completed')
  })

  test('a poison record is reported and does not stop the run', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals(
      [deal('1', 'won', 1), deal('2', 'won', 3)],
      [{ id: 'bad', version: '2026-01-01T00:02:00.000Z' }]
    )
    t.playbook.rejectDeal('hubspot-2')
    const started = await t.start()
    await t.drain()
    const run = await t.runOf(started.body.id)
    expect(run.state).toBe('completed')
    expect(run.counts).toMatchObject({ created: 1, failed: 2 })
    expect(run.failures).toEqual(
      expect.arrayContaining([
        { objectRef: 'bad', reason: 'invalid_record' },
        { objectRef: '2', reason: 'write_rejected' },
      ])
    )
  })

  test('failures of earlier pages survive later pages of the same job', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([
      deal('1', 'won', 1),
      deal('2', 'won', 2),
      deal('3', 'won', 3),
      deal('4', 'won', 4),
    ])
    t.playbook.rejectDeal('hubspot-1')
    t.playbook.rejectDeal('hubspot-4')
    const started = await t.start()
    await t.drain({ pageSize: 2 })
    const run = await t.runOf(started.body.id)
    expect(run.state).toBe('completed')
    expect(run.failures.map((f) => f.objectRef).sort()).toEqual(['1', '4'])
    expect(run.failures.length).toBe(run.counts.failed)
  })

  test('a Deal without a stage is skipped, an unmapped stage fails the run', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', null, 1)])
    const first = await t.start()
    await t.drain()
    const done = await t.runOf(first.body.id)
    expect(done.counts.skipped).toBe(1)
    expect(done.skipped).toEqual([{ reason: 'missing_required_field', count: 1 }])
    t.hubspot.plantDeals([deal('2', 'mystery', 2)])
    const second = await t.start()
    await t.drain()
    const failed = await t.runOf(second.body.id)
    expect(failed.state).toBe('failed')
    expect(failed.errorCode).toBe('crm.mapping_incomplete')
    expect(t.playbook.calls).toBe(0)
  })

  test('a 429 backs off through the queue and the run resumes', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1)])
    t.hubspot.throttleNext(1)
    const started = await t.start()
    await t.drain()
    expect((await t.runOf(started.body.id)).state).toBe('running')
    await t.redeliver()
    expect((await t.runOf(started.body.id)).state).toBe('completed')
  })

  test('a 429 that outlasts the delivery limit fails the run with crm.rate_limited', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1)])
    t.hubspot.throttleNext(CRM_SYNC_MAX_DELIVERIES)
    const started = await t.start()
    await t.drain()
    for (let i = 1; i < CRM_SYNC_MAX_DELIVERIES; i += 1) {
      await t.redeliver()
    }
    const run = await t.runOf(started.body.id)
    expect(run.state).toBe('failed')
    expect(run.errorCode).toBe('crm.rate_limited')
  })

  test('the budget hands the rest to a continuation job', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'won', 2), deal('3', 'won', 3)])
    const started = await t.start()
    await t.drain({ pageSize: 2, budgetMs: 0 })
    const run = await t.runOf(started.body.id)
    expect(run.state).toBe('completed')
    expect(run.counts.created).toBe(3)
    expect(t.hubspot.dealReads).toBeGreaterThan(1)
  })

  test('a start while a run is active answers that run with 200', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    const first = await t.start()
    const again = await t.start()
    expect(first.status).toBe(202)
    expect(again.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
  })

  test('preview counts without writing anything', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1), deal('2', 'open', 2)])
    const response = await t.call(
      t.admin,
      'POST',
      '/crm/connections/hubspot/sync-previews',
      { objectKind: 'deal' },
      undefined,
      t.key()
    )
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ objectKind: 'deal', total: 2, truncated: false })
    expect(t.playbook.calls).toBe(0)
    const runs = await t.call(t.admin, 'GET', '/crm/connections/hubspot/sync-runs')
    expect(runs.body.items).toEqual([])
  })

  test('a kind other than deal is refused', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    const response = await t.call(
      t.admin,
      'POST',
      '/crm/connections/hubspot/sync-runs',
      { objectKind: 'contact' },
      undefined,
      t.key()
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('request.invalid')
  })

  test('retry works only on a failed run', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'mystery', 1)])
    const first = await t.start()
    await t.drain()
    expect((await t.runOf(first.body.id)).state).toBe('failed')
    const retry = await t.call(
      t.admin,
      'POST',
      `/crm/connections/hubspot/sync-runs/${first.body.id}/retries`,
      undefined,
      undefined,
      t.key()
    )
    expect(retry.status).toBe(202)
    expect(retry.body.trigger).toBe('retry')
    expect(retry.body.retryOfRunId).toBe(first.body.id)
    t.hubspot.plantDeals([deal('1', 'won', 1)])
    await t.drain()
    const finished = await t.runOf(retry.body.id)
    expect(finished.state).toBe('completed')
    const again = await t.call(
      t.admin,
      'POST',
      `/crm/connections/hubspot/sync-runs/${retry.body.id}/retries`,
      undefined,
      undefined,
      t.key()
    )
    expect(again.status).toBe(409)
  })

  test('a Manager can read but not change the mapping or start a run', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    const manager = t.byRole('manager')
    expect((await t.call(manager, 'GET', '/crm/connections/hubspot/stage-mapping')).status).toBe(
      200
    )
    const put = await t.call(
      manager,
      'PUT',
      '/crm/connections/hubspot/stage-mapping',
      MAPPING,
      undefined,
      t.key()
    )
    expect(put.status).toBe(403)
    expect((await t.start(manager)).status).toBe(403)
  })

  test('another Organization cannot read or start the run and Deals are never mixed', async () => {
    const t = await setup()
    await t.connect(t.admin, t.seeded.organizationId, 'c1')
    await t.mapAll()
    t.hubspot.plantDeals([deal('1', 'won', 1)])
    const started = await t.start()
    await t.drain()
    const other = t.second.owner
    const read = await t.getRun(started.body.id, other, t.second.organizationId)
    expect(read.status).toBe(404)
    const list = await t.call(
      other,
      'GET',
      '/crm/connections/hubspot/sync-runs',
      undefined,
      t.second.organizationId
    )
    expect(list.status === 404 || (list.body.items as unknown[]).length === 0).toBe(true)
    const foreignStart = await t.start(other, t.second.organizationId)
    expect(foreignStart.status).toBe(404)
    expect(t.playbook.recorded.every((d) => d.organizationId === t.seeded.organizationId)).toBe(
      true
    )
  })
})

import { describe, expect, test } from 'bun:test'
import {
  bulkAssignProspectsResponseSchema,
  formatId,
  listProspectsResponseSchema,
  prospectSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  drainTestOutbox,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { processAssignJobs } from './assign-worker'

type Actor = { userId: SeededMember['userId']; role: Role }

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep'])
  const byRole = (role: Role) => seeded.members.filter((m) => m.role === role)
  const [admin] = byRole('admin') as [SeededMember]
  const [manager] = byRole('manager') as [SeededMember]
  const [rep, teammate] = byRole('rep') as [SeededMember, SeededMember]
  const api = publicCaller(harness)
  const call = (
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
    h?: Record<string, string>
  ) => api(actor, seeded.organizationId, method, path, body, h)
  const create = async (actor: Actor, firstName: string) => {
    const response = await call(actor, 'POST', '/prospects', { firstName })
    expect([200, 201]).toContain(response.status)
    return prospectSchema.parse(response.body)
  }
  const queued = async () => {
    const out: { type: string; payload: Record<string, unknown> }[] = []
    await drainTestOutbox(harness.deps)
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        return out
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          out.push({
            type: delivery.envelope.type,
            payload: delivery.envelope.payload as Record<string, unknown>,
          })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  const drain = async () => {
    const signal = new AbortController().signal
    let total = 0
    for (;;) {
      const n = await processAssignJobs(harness.deps, signal)
      if (n === 0) {
        return total
      }
      total += n
    }
  }
  const setRole = (id: SeededMember['id'], role: Role) =>
    store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.setRole(id, role, new Date())
    })
  const fakeIds = (n: number) =>
    Array.from({ length: n }, () => formatId('prs', crypto.randomUUID()))
  return {
    ...harness,
    store,
    seeded,
    call,
    create,
    queued,
    drain,
    setRole,
    fakeIds,
    owner: seeded.owner,
    admin,
    manager,
    rep,
    teammate,
  }
}

const ownerOf = async (
  s: Awaited<ReturnType<typeof setup>>,
  actor: Actor,
  id: string
): Promise<string | undefined> => {
  const response = await s.call(actor, 'GET', `/prospects/${id}`)
  return response.status === 200
    ? (prospectSchema.parse(response.body).ownerMembershipId ?? undefined)
    : undefined
}

describe('assigning one owner', () => {
  test('an Admin moves a Prospect: the new owner sees it, the old one no longer does', async () => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')
    await s.queued()

    const response = await s.call(s.admin, 'PUT', `/prospects/${prospect.id}/owner`, {
      ownerMembershipId: s.teammate.id,
    })

    expect(response.status).toBe(200)
    expect(prospectSchema.parse(response.body).ownerMembershipId).toBe(s.teammate.id)
    expect(await ownerOf(s, s.teammate, prospect.id)).toBe(s.teammate.id)
    expect(await ownerOf(s, s.rep, prospect.id)).toBeUndefined()
    const events = await s.queued()
    expect(events.map((e) => e.type)).toEqual(['prospect.updated'])
    expect(events[0]?.payload).toMatchObject({ prospectId: prospect.id, ownerChanged: true })
  })

  test('the Owner may assign, and naming the current owner changes and publishes nothing', async () => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')
    await s.queued()

    const same = await s.call(s.owner, 'PUT', `/prospects/${prospect.id}/owner`, {
      ownerMembershipId: s.rep.id,
    })

    expect(same.status).toBe(200)
    expect(await s.queued()).toEqual([])
  })

  test('a Manager can name a Manager as owner', async () => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')

    const response = await s.call(s.admin, 'PUT', `/prospects/${prospect.id}/owner`, {
      ownerMembershipId: s.manager.id,
    })

    expect(response.status).toBe(200)
  })

  test.each(['rep', 'manager'] as const)('a %s may not assign', async (role) => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')
    const actor = role === 'rep' ? s.rep : s.manager

    const response = await s.call(actor, 'PUT', `/prospects/${prospect.id}/owner`, {
      ownerMembershipId: s.teammate.id,
    })

    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('auth.forbidden')
  })

  test('an Admin or Owner Membership cannot be the owner', async () => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')

    for (const target of [s.admin, s.owner]) {
      const response = await s.call(s.owner, 'PUT', `/prospects/${prospect.id}/owner`, {
        ownerMembershipId: target.id,
      })
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('prospect.forbidden_owner')
    }
  })

  test('a Membership of another Organization cannot be the owner', async () => {
    const s = await setup()
    const prospect = await s.create(s.rep, 'Ada')
    const other = await seedOrganization(s.store, ['rep'])

    const response = await s.call(s.owner, 'PUT', `/prospects/${prospect.id}/owner`, {
      ownerMembershipId: other.members[1]?.id,
    })

    expect(response.body.error?.code).toBe('prospect.forbidden_owner')
  })

  test('an unknown Prospect is prospect.not_found', async () => {
    const s = await setup()

    const response = await s.call(
      s.owner,
      'PUT',
      `/prospects/${formatId('prs', crypto.randomUUID())}/owner`,
      { ownerMembershipId: s.rep.id }
    )

    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('prospect.not_found')
  })

  test('a Prospect of another Organization is not found', async () => {
    const s = await setup()
    const other = await seedOrganization(s.store, ['rep'])
    const api = publicCaller(s)
    const theirs = await api(
      other.members[1] as Actor,
      other.organizationId,
      'POST',
      '/prospects',
      { firstName: 'Zed' }
    )
    const id = prospectSchema.parse(theirs.body).id

    const response = await s.call(s.owner, 'PUT', `/prospects/${id}/owner`, {
      ownerMembershipId: s.rep.id,
    })

    expect(response.status).toBe(404)
  })
})

describe('bulk assigning', () => {
  test('applies the ids that exist, counts the rest as skipped and publishes for changes only', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    const b = await s.create(s.rep, 'B')
    const c = await s.create(s.teammate, 'C')
    await s.queued()

    const response = await s.call(s.admin, 'POST', '/prospects/assign', {
      prospectIds: [a.id, b.id, c.id, ...s.fakeIds(2)],
      ownerMembershipId: s.teammate.id,
    })

    expect(response.status).toBe(200)
    expect(bulkAssignProspectsResponseSchema.parse(response.body)).toEqual({
      state: 'applied',
      requested: 5,
      assigned: 3,
      skipped: 2,
    })
    const mine = listProspectsResponseSchema.parse(
      (await s.call(s.teammate, 'GET', '/prospects')).body
    )
    expect(mine.items).toHaveLength(3)
    const events = await s.queued()
    expect(events.map((e) => e.payload.prospectId).sort()).toEqual([a.id, b.id].sort())
  })

  test('ids of another Organization are skipped and nothing there changes', async () => {
    const s = await setup()
    const other = await seedOrganization(s.store, ['rep'])
    const theirRep = other.members[1] as SeededMember
    const theirs = await publicCaller(s)(theirRep, other.organizationId, 'POST', '/prospects', {
      firstName: 'Zed',
    })
    const id = prospectSchema.parse(theirs.body).id

    const response = await s.call(s.owner, 'POST', '/prospects/assign', {
      prospectIds: [id],
      ownerMembershipId: s.rep.id,
    })

    expect(bulkAssignProspectsResponseSchema.parse(response.body).skipped).toBe(1)
    const still = await publicCaller(s)(theirRep, other.organizationId, 'GET', `/prospects/${id}`)
    expect(prospectSchema.parse(still.body).ownerMembershipId).toBe(theirRep.id)
  })

  test('refuses a Rep or Manager caller and a wrong owner', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    const body = { prospectIds: [a.id], ownerMembershipId: s.teammate.id }

    const asRep = await s.call(s.rep, 'POST', '/prospects/assign', body)
    const asManager = await s.call(s.manager, 'POST', '/prospects/assign', body)
    const toAdmin = await s.call(s.owner, 'POST', '/prospects/assign', {
      ...body,
      ownerMembershipId: s.admin.id,
    })

    expect(asRep.body.error?.code).toBe('auth.forbidden')
    expect(asManager.body.error?.code).toBe('auth.forbidden')
    expect(toAdmin.body.error?.code).toBe('prospect.forbidden_owner')
  })

  test('the same Idempotency-Key answers the first answer and publishes once', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    await s.queued()
    const headers = { 'idempotency-key': 'assign-0001-abcdefghij' }
    const body = { prospectIds: [a.id], ownerMembershipId: s.teammate.id }

    const first = await s.call(s.admin, 'POST', '/prospects/assign', body, headers)
    const again = await s.call(s.admin, 'POST', '/prospects/assign', body, headers)
    const other = await s.call(
      s.admin,
      'POST',
      '/prospects/assign',
      { ...body, ownerMembershipId: s.manager.id },
      headers
    )

    expect(again.body).toEqual(first.body)
    expect(other.body.error?.code).toBe('request.idempotency_key_reused')
    expect(await s.queued()).toHaveLength(1)
  })
})

describe('bulk assigning past the synchronous limit', () => {
  const many = async (s: Awaited<ReturnType<typeof setup>>, real: string[]) => ({
    prospectIds: [...real, ...s.fakeIds(600)],
    ownerMembershipId: s.teammate.id,
  })

  test('answers 202 queued, then the chunks apply and publish', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    const b = await s.create(s.rep, 'B')
    await s.queued()

    const response = await s.call(s.admin, 'POST', '/prospects/assign', await many(s, [a.id, b.id]))

    expect(response.status).toBe(202)
    expect(bulkAssignProspectsResponseSchema.parse(response.body)).toEqual({
      state: 'queued',
      requested: 602,
      assigned: null,
      skipped: null,
    })
    expect(await ownerOf(s, s.owner, a.id)).toBe(s.rep.id)
    expect(await s.drain()).toBe(7)
    expect(await ownerOf(s, s.owner, a.id)).toBe(s.teammate.id)
    expect(await ownerOf(s, s.owner, b.id)).toBe(s.teammate.id)
    expect((await s.queued()).map((e) => e.payload.prospectId).sort()).toEqual([a.id, b.id].sort())
  })

  test('the same key queues the work once', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    const headers = { 'idempotency-key': 'assign-0002-abcdefghij' }
    const body = await many(s, [a.id])

    const first = await s.call(s.admin, 'POST', '/prospects/assign', body, headers)
    const again = await s.call(s.admin, 'POST', '/prospects/assign', body, headers)

    expect(first.status).toBe(202)
    expect(again.status).toBe(202)
    expect(await s.drain()).toBe(7)
  })

  test('is refused before queueing when the owner is not a Rep or Manager', async () => {
    const s = await setup()

    const response = await s.call(s.admin, 'POST', '/prospects/assign', {
      ...(await many(s, [])),
      ownerMembershipId: s.admin.id,
    })

    expect(response.body.error?.code).toBe('prospect.forbidden_owner')
    expect(await s.drain()).toBe(0)
  })

  test('a chunk is dropped when the actor lost the role before it ran', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    await s.call(s.admin, 'POST', '/prospects/assign', await many(s, [a.id]))
    await s.setRole(s.admin.id, 'rep')

    await s.drain()

    expect(await ownerOf(s, s.owner, a.id)).toBe(s.rep.id)
  })

  test('a chunk is dropped when the owner became an Admin before it ran', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    await s.call(s.admin, 'POST', '/prospects/assign', await many(s, [a.id]))
    await s.setRole(s.teammate.id, 'admin')

    await s.drain()

    expect(await ownerOf(s, s.owner, a.id)).toBe(s.rep.id)
  })

  test('a chunk is dropped when the Organization was suspended before it ran', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    await s.call(s.admin, 'POST', '/prospects/assign', await many(s, [a.id]))
    s.store.setOrganizationStatus(s.seeded.organizationId, 'suspended')

    await s.drain()

    s.store.setOrganizationStatus(s.seeded.organizationId, 'active')
    expect(await ownerOf(s, s.owner, a.id)).toBe(s.rep.id)
  })
})

describe('no way in from another Organization', () => {
  test('a token for another Organization cannot assign here', async () => {
    const s = await setup()
    const a = await s.create(s.rep, 'A')
    const outsider = await seedOrganization(s.store, [])

    const response = await publicCaller(s)(
      outsider.owner,
      newOrganizationId(),
      'PUT',
      `/prospects/${a.id}/owner`,
      { ownerMembershipId: s.teammate.id }
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await ownerOf(s, s.owner, a.id)).toBe(s.rep.id)
  })
})

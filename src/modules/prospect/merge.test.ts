import { describe, expect, test } from 'bun:test'
import {
  CONSENT_CHANNELS,
  formatId,
  listProspectDuplicatesResponseSchema,
  type ProspectId,
  prospectMergeSchema,
  prospectSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

type Actor = { userId: SeededMember['userId']; role: Role }

const WORDING = formatId('cwd', crypto.randomUUID())

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  store.seedConsentWording(seeded.organizationId, {
    id: WORDING,
    version: 1,
    channels: [...CONSENT_CHANNELS],
    text: 'I agree to be contacted.',
  })
  const api = publicCaller(harness)
  const call = (
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const owner = seeded.owner
  const create = async (body: Record<string, unknown>, actor: Actor = owner) => {
    const response = await call(actor, 'POST', '/prospects', body)
    expect(response.status).toBe(201)
    return prospectSchema.parse(response.body)
  }
  const read = async (id: ProspectId) =>
    prospectSchema.parse((await call(owner, 'GET', `/prospects/${id}`)).body)
  /** Gives `target` an address another Prospect held before: `holder` moves to `moved`, `target` takes the old one. */
  const share = async (
    holder: ProspectId,
    target: ProspectId,
    field: 'email' | 'phone',
    oldValue: string,
    moved: string
  ) => {
    harness.deps.clock.advance('1m')
    expect((await call(owner, 'PATCH', `/prospects/${holder}`, { [field]: moved })).status).toBe(
      200
    )
    harness.deps.clock.advance('1m')
    expect((await call(owner, 'PATCH', `/prospects/${target}`, { [field]: oldValue })).status).toBe(
      200
    )
  }
  const merge = (survivor: ProspectId, body: unknown, actor: Actor = owner, key?: string) =>
    call(
      actor,
      'POST',
      `/prospects/${survivor}/merges`,
      body,
      key ? { 'idempotency-key': key } : {}
    )
  const queued = async () => {
    const out: string[] = []
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
          out.push(delivery.envelope.type)
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  return {
    ...harness,
    store,
    clock: harness.deps.clock,
    seeded,
    call,
    create,
    read,
    share,
    merge,
    queued,
    owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

/** Two Prospects of one person: `a` now holds the email `b` had before. */
async function duplicates(s: Awaited<ReturnType<typeof setup>>) {
  const a = await s.create({ firstName: 'Ada', jobTitle: 'VP', email: 'ada@x.test' })
  const b = await s.create({ firstName: 'Adam', jobTitle: 'CTO', email: 'old@x.test' })
  await s.share(b.id, a.id, 'email', 'old@x.test', 'new@x.test')
  return { a, b }
}

describe('suspected duplicates', () => {
  test('lists a pair that shares an address, once, with the kind it matched on', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    await s.create({ firstName: 'Other', email: 'other@x.test' })

    const response = await s.call(s.owner, 'GET', '/prospect-duplicates')

    expect(response.status).toBe(200)
    const page = listProspectDuplicatesResponseSchema.parse(response.body)
    expect(page.items).toEqual([
      { prospectIds: [a.id, b.id].sort() as [ProspectId, ProspectId], matchedOn: ['email'] },
    ])
    expect(page.nextCursor).toBeNull()
  })

  test('pages with a cursor, bounded by the limit, and can be narrowed to one Prospect', async () => {
    const s = await setup()
    const pairs: ProspectId[] = []
    for (const n of [1, 2, 3]) {
      const a = await s.create({ firstName: `A${n}`, email: `a${n}@x.test` })
      const b = await s.create({ firstName: `B${n}`, email: `b${n}@x.test` })
      await s.share(b.id, a.id, 'email', `b${n}@x.test`, `c${n}@x.test`)
      pairs.push(a.id)
    }

    const first = listProspectDuplicatesResponseSchema.parse(
      (await s.call(s.owner, 'GET', '/prospect-duplicates?limit=2')).body
    )
    const second = listProspectDuplicatesResponseSchema.parse(
      (await s.call(s.owner, 'GET', `/prospect-duplicates?limit=2&cursor=${first.nextCursor}`)).body
    )
    const narrowed = listProspectDuplicatesResponseSchema.parse(
      (await s.call(s.owner, 'GET', `/prospect-duplicates?prospectId=${pairs[0]}`)).body
    )

    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(
      new Set([...first.items, ...second.items].map((i) => i.prospectIds.join()))
    ).toHaveLength(3)
    expect(narrowed.items).toHaveLength(1)
    expect((await s.call(s.owner, 'GET', '/prospect-duplicates?limit=101')).status).toBe(400)
    expect((await s.call(s.owner, 'GET', '/prospect-duplicates?cursor=nope')).status).toBe(400)
  })

  test('is for Owner and Admin only, and never crosses Organizations', async () => {
    const s = await setup()
    await duplicates(s)
    const other = (await s.store) ? await seedOrganization(s.store, ['admin']) : (null as never)

    const asRep = await s.call(s.rep, 'GET', '/prospect-duplicates')
    const asManager = await s.call(s.manager, 'GET', '/prospect-duplicates')
    const asAdmin = await s.call(s.admin, 'GET', '/prospect-duplicates')
    const foreign = await s.call(
      other.owner,
      'GET',
      '/prospect-duplicates',
      undefined,
      undefined,
      other.organizationId
    )
    const unknown = await s.call(
      other.owner,
      'GET',
      `/prospect-duplicates?prospectId=${(await s.create({ firstName: 'x' })).id}`,
      undefined,
      undefined,
      other.organizationId
    )

    expect(asRep.status).toBe(403)
    expect(asManager.status).toBe(403)
    expect(asAdmin.status).toBe(200)
    expect(listProspectDuplicatesResponseSchema.parse(foreign.body).items).toEqual([])
    expect(unknown.status).toBe(404)
    expect(unknown.body.error?.code).toBe('prospect.not_found')
  })
})

describe('merging', () => {
  test('keeps the chosen values and the other record as history, and publishes prospect.merged', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    await s.queued()

    const response = await s.merge(a.id, {
      mergedProspectIds: [b.id],
      fieldChoices: { jobTitle: b.id },
    })

    expect(response.status).toBe(201)
    const merged = prospectMergeSchema.parse(response.body)
    expect(merged.state).toBe('merged')
    expect(merged.survivorProspectId).toBe(a.id)
    expect(merged.mergedProspectIds).toEqual([b.id])
    expect(merged.mergedByUserId).toBe(s.owner.userId)
    expect(Date.parse(merged.undoableUntil) - Date.parse(merged.createdAt)).toBe(30 * 86_400_000)
    expect(JSON.stringify(response.body)).not.toContain('snapshot')
    const survivor = await s.read(a.id)
    expect(survivor.fields.jobTitle?.value).toBe('CTO')
    expect(survivor.fields.firstName?.value).toBe('Ada')
    expect(survivor.fields.email?.value).toBe('old@x.test')
    expect((await s.call(s.owner, 'GET', `/prospects/${b.id}`)).status).toBe(404)
    expect(await s.queued()).toEqual(['prospect.merged'])
    const history = await s.store.withOrganization(s.seeded.organizationId, (scope) =>
      scope.listProspectFieldHistory(a.id)
    )
    const title = history.filter((row) => row.field === 'jobTitle')
    expect(title.map((r) => [r.value, r.state, r.source]).sort()).toEqual([
      ['CTO', 'current', 'manual'],
      ['VP', 'superseded', 'manual'],
    ])
    expect(history.some((r) => r.value === 'ada@x.test' && r.state === 'superseded')).toBe(true)
    expect(history.some((r) => r.value === 'new@x.test' && r.state === 'superseded')).toBe(true)
    const listed = listProspectDuplicatesResponseSchema.parse(
      (await s.call(s.owner, 'GET', '/prospect-duplicates')).body
    )
    expect(listed.items).toEqual([])
    const read = await s.call(s.owner, 'GET', `/prospect-merges/${merged.id}`)
    expect(prospectMergeSchema.parse(read.body)).toEqual(merged)
  })

  test('moves Conversations to the survivor', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const conversationId = formatId('cnv', crypto.randomUUID())
    await s.store.withOrganization(s.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.insertConversation({
        id: conversationId,
        prospectId: b.id,
        channel: 'email',
        ownerMembershipId: null,
        now: s.clock.now(),
        lastMessageAt: s.clock.now(),
      })
    })

    await s.merge(a.id, { mergedProspectIds: [b.id] })

    const moved = await s.store.withOrganization(s.seeded.organizationId, (scope) =>
      scope.getConversation(conversationId, { kind: 'all' })
    )
    expect(moved?.prospectId).toBe(a.id)
  })

  test('answers a repeat with the same Idempotency-Key as 200 and merges once', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    await s.queued()
    const body = { mergedProspectIds: [b.id] }

    const first = await s.merge(a.id, body, s.owner, 'merge-key-0001-abcdef')
    const again = await s.merge(a.id, body, s.owner, 'merge-key-0001-abcdef')

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await s.queued()).toEqual(['prospect.merged'])
  })

  test('refuses what cannot be merged with prospect.merge_conflict', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const c = await s.create({ firstName: 'Cy' })
    const d = await s.create({ firstName: 'Di' })

    const self = await s.merge(a.id, { mergedProspectIds: [a.id] })
    const outside = await s.merge(a.id, {
      mergedProspectIds: [b.id],
      fieldChoices: { jobTitle: c.id },
    })
    const noValue = await s.merge(a.id, {
      mergedProspectIds: [d.id],
      fieldChoices: { phone: d.id },
    })
    expect(await s.merge(a.id, { mergedProspectIds: [b.id] })).toMatchObject({ status: 201 })
    const again = await s.merge(c.id, { mergedProspectIds: [b.id] })

    for (const response of [self, outside, noValue, again]) {
      expect(response.status).toBe(409)
      expect(response.body.error?.code).toBe('prospect.merge_conflict')
    }
  })

  test('refuses a Prospect that has a consent event, which stays with its own record', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const granted = await s.call(s.owner, 'POST', `/prospects/${b.id}/consents`, {
      channel: 'sms',
      source: 'manual',
      wordingId: WORDING,
      evidenceRef: 'signed form 17',
    })
    expect(granted.status).toBe(201)

    const response = await s.merge(a.id, { mergedProspectIds: [b.id] })

    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('prospect.merge_conflict')
    expect((await s.call(s.owner, 'GET', `/prospects/${b.id}`)).status).toBe(200)
  })

  test('is Owner and Admin only; an unknown Prospect is not found', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)

    const asRep = await s.merge(a.id, { mergedProspectIds: [b.id] }, s.rep)
    const asManager = await s.merge(a.id, { mergedProspectIds: [b.id] }, s.manager)
    const missing = await s.merge(a.id, {
      mergedProspectIds: [formatId('prs', crypto.randomUUID())],
    })

    expect(asRep.status).toBe(403)
    expect(asManager.status).toBe(403)
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('prospect.not_found')
    expect((await s.merge(a.id, { mergedProspectIds: [b.id] }, s.admin)).status).toBe(201)
  })

  test('cannot merge into or from another Organization', async () => {
    const s = await setup()
    const { a } = await duplicates(s)
    const other = await seedOrganization(s.store, ['admin'])
    const foreign = prospectSchema.parse(
      (
        await s.call(
          other.owner,
          'POST',
          '/prospects',
          { firstName: 'Zed' },
          undefined,
          other.organizationId
        )
      ).body
    )

    const into = await s.call(
      other.owner,
      'POST',
      `/prospects/${a.id}/merges`,
      { mergedProspectIds: [foreign.id] },
      undefined,
      other.organizationId
    )
    const from = await s.merge(a.id, { mergedProspectIds: [foreign.id] })

    expect(into.status).toBe(404)
    expect(from.status).toBe(404)
    expect(
      (
        await s.call(
          other.owner,
          'GET',
          `/prospects/${foreign.id}`,
          undefined,
          undefined,
          other.organizationId
        )
      ).status
    ).toBe(200)
  })

  test('another Organization cannot read or undo the merge', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id] })).body
    )
    const other = await seedOrganization(s.store, ['admin'])

    const read = await s.call(
      other.owner,
      'GET',
      `/prospect-merges/${merged.id}`,
      undefined,
      undefined,
      other.organizationId
    )
    const undo = await s.call(
      other.owner,
      'POST',
      `/prospect-merges/${merged.id}/undo`,
      undefined,
      undefined,
      other.organizationId
    )

    expect(read.status).toBe(404)
    expect(undo.status).toBe(404)
  })
})

describe('undoing a merge', () => {
  test('restores both records exactly, with their history, links and times', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const beforeA = await s.read(a.id)
    const beforeB = await s.read(b.id)
    const history = (id: ProspectId) =>
      s.store.withOrganization(s.seeded.organizationId, (scope) =>
        scope.listProspectFieldHistory(id)
      )
    const historyA = await history(a.id)
    const historyB = await history(b.id)
    const conversationId = formatId('cnv', crypto.randomUUID())
    await s.store.withOrganization(s.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.insertConversation({
        id: conversationId,
        prospectId: b.id,
        channel: 'email',
        ownerMembershipId: null,
        now: s.clock.now(),
        lastMessageAt: s.clock.now(),
      })
    })
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id], fieldChoices: { jobTitle: b.id } })).body
    )
    await s.queued()
    s.clock.advance('1h')

    const response = await s.call(s.owner, 'POST', `/prospect-merges/${merged.id}/undo`)

    expect(response.status).toBe(200)
    const undone = prospectMergeSchema.parse(response.body)
    expect(undone.state).toBe('undone')
    expect(undone.undoneAt).not.toBeNull()
    expect(await s.read(a.id)).toEqual(beforeA)
    expect(await s.read(b.id)).toEqual(beforeB)
    expect(await history(a.id)).toEqual(historyA)
    expect(await history(b.id)).toEqual(historyB)
    const conversation = await s.store.withOrganization(s.seeded.organizationId, (scope) =>
      scope.getConversation(conversationId, { kind: 'all' })
    )
    expect(conversation?.prospectId).toBe(b.id)
    expect(await s.queued()).toEqual(['prospect.merge_undone'])
    const again = await s.call(s.owner, 'POST', `/prospect-merges/${merged.id}/undo`)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(response.body)
    expect(await s.queued()).toEqual([])
    const listed = listProspectDuplicatesResponseSchema.parse(
      (await s.call(s.owner, 'GET', '/prospect-duplicates')).body
    )
    expect(listed.items).toHaveLength(1)
  })

  test('after thirty days it is prospect.merge_conflict', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id] })).body
    )
    s.clock.advance('30d')
    s.clock.advance('1m')

    const response = await s.call(s.owner, 'POST', `/prospect-merges/${merged.id}/undo`)

    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('prospect.merge_conflict')
    expect((await s.call(s.owner, 'GET', `/prospects/${b.id}`)).status).toBe(404)
  })

  test('is refused once the survivor was edited since the merge', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id] })).body
    )
    s.clock.advance('1h')
    expect((await s.call(s.owner, 'PATCH', `/prospects/${a.id}`, { jobTitle: 'CEO' })).status).toBe(
      200
    )

    const response = await s.call(s.owner, 'POST', `/prospect-merges/${merged.id}/undo`)

    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('prospect.merge_conflict')
  })

  test('is refused once enrichment wrote to the survivor, which leaves its updatedAt alone', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id] })).body
    )
    const written = await s.app.request(`/internal/v1/prospects/${a.id}/enriched-fields`, {
      method: 'POST',
      headers: { ...s.internal(), 'x-organization-id': s.seeded.organizationId },
      body: JSON.stringify({
        runId: formatId('erun', crypto.randomUUID()),
        fields: [
          {
            field: 'jobTitle',
            value: 'Head of Sales',
            provider: 'apollo',
            confidence: 0.9,
            obtainedAt: '2026-10-20T10:00:00.000Z',
          },
        ],
      }),
    })
    expect(written.status).toBe(200)

    const response = await s.call(s.owner, 'POST', `/prospect-merges/${merged.id}/undo`)

    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('prospect.merge_conflict')
  })

  test('is Owner and Admin only', async () => {
    const s = await setup()
    const { a, b } = await duplicates(s)
    const merged = prospectMergeSchema.parse(
      (await s.merge(a.id, { mergedProspectIds: [b.id] })).body
    )

    const asRep = await s.call(s.rep, 'POST', `/prospect-merges/${merged.id}/undo`)
    const missing = await s.call(
      s.owner,
      'POST',
      `/prospect-merges/${formatId('pmrg', crypto.randomUUID())}/undo`
    )

    expect(asRep.status).toBe(403)
    expect(missing.status).toBe(404)
  })
})

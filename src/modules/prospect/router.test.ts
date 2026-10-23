import { describe, expect, test } from 'bun:test'
import {
  formatId,
  listProspectsResponseSchema,
  prospectCompanySchema,
  prospectSchema,
  type Role,
  teamSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  drainTestOutbox,
  newMembershipId,
  newOrganizationId,
  newUserId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

type Actor = { userId: SeededMember['userId']; role: Role }

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'manager', 'rep', 'rep', 'rep'])
  const byRole = (role: Role) => seeded.members.filter((m) => m.role === role)
  const [admin] = byRole('admin') as [SeededMember]
  const [manager, otherManager] = byRole('manager') as [SeededMember, SeededMember]
  const [rep, teammate, outsider] = byRole('rep') as [SeededMember, SeededMember, SeededMember]
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
  const clock = harness.deps.clock

  const team = async (name: string, members: SeededMember[]) => {
    const created = teamSchema.parse((await call(owner, 'POST', '/teams', { name })).body)
    for (const member of members) {
      await call(owner, 'POST', `/teams/${created.id}/members`, { membershipId: member.id })
    }
  }
  await team('East', [manager, rep, teammate])
  await team('West', [otherManager, outsider])

  const create = async (actor: Actor, body: Record<string, unknown>) => {
    const response = await call(actor, 'POST', '/prospects', body)
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
  return {
    ...harness,
    store,
    clock,
    seeded,
    call,
    create,
    queued,
    owner,
    admin,
    manager,
    otherManager,
    rep,
    teammate,
    outsider,
  }
}

const ada = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }

describe('creating a Prospect', () => {
  test('creates with the Source manual, stamps every field and publishes prospect.created', async () => {
    const { call, rep, queued } = await setup()

    const response = await call(rep, 'POST', '/prospects', {
      ...ada,
      jobTitle: 'Analyst',
      tags: ['vip'],
      notes: 'met at expo',
    })

    expect(response.status).toBe(201)
    const prospect = prospectSchema.parse(response.body)
    expect(prospect.source).toBe('manual')
    expect(prospect.status).toBe('active')
    expect(prospect.tags).toEqual(['vip'])
    expect(prospect.notes).toBe('met at expo')
    expect(prospect.fields.email).toMatchObject({
      value: 'ada@example.test',
      source: 'manual',
      sourceRef: null,
      setByUserId: rep.userId,
    })
    expect(prospect.fields.jobTitle?.value).toBe('Analyst')
    const events = await queued()
    expect(events.map((e) => e.type)).toEqual(['prospect.created'])
  })

  test('a Rep owns what they create, and may not name another owner', async () => {
    const { call, create, rep, teammate } = await setup()

    const mine = await create(rep, ada)
    const forbidden = await call(rep, 'POST', '/prospects', {
      firstName: 'Bo',
      ownerMembershipId: teammate.id,
    })

    expect(mine.ownerMembershipId).toBe(rep.id)
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error?.code).toBe('prospect.forbidden_owner')
  })

  test('an Owner or Admin may name a Rep as owner, and by default leaves it unowned', async () => {
    const { create, admin, rep, manager } = await setup()

    const named = await create(admin, { firstName: 'A', ownerMembershipId: rep.id })
    const unowned = await create(admin, { firstName: 'B' })
    const toManager = await create(admin, { firstName: 'C', ownerMembershipId: manager.id })

    expect(named.ownerMembershipId).toBe(rep.id)
    expect(unowned.ownerMembershipId).toBeNull()
    expect(toManager.ownerMembershipId).toBe(manager.id)
  })

  test('an owner who is not a Rep or Manager of the Organization is refused', async () => {
    const { call, admin, owner } = await setup()

    const toAdmin = await call(owner, 'POST', '/prospects', {
      firstName: 'A',
      ownerMembershipId: admin.id,
    })
    const stranger = await call(owner, 'POST', '/prospects', {
      firstName: 'B',
      ownerMembershipId: newMembershipId(),
    })

    expect(toAdmin.body.error?.code).toBe('prospect.forbidden_owner')
    expect(stranger.body.error?.code).toBe('prospect.forbidden_owner')
  })

  test('the same Idempotency-Key answers 200 with the first Prospect and publishes once', async () => {
    const { call, rep, queued } = await setup()
    const headers = { 'idempotency-key': 'create-ada-0001-abcdef' }

    const first = await call(rep, 'POST', '/prospects', ada, headers)
    const again = await call(rep, 'POST', '/prospects', ada, headers)

    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    const list = listProspectsResponseSchema.parse((await call(rep, 'GET', '/prospects')).body)
    expect(list.items).toHaveLength(1)
    expect((await queued()).map((e) => e.type)).toEqual(['prospect.created'])
  })

  test('the same Idempotency-Key with a different body is refused', async () => {
    const { call, rep } = await setup()
    const headers = { 'idempotency-key': 'create-ada-0002-abcdef' }
    await call(rep, 'POST', '/prospects', ada, headers)

    const other = await call(rep, 'POST', '/prospects', { ...ada, firstName: 'Grace' }, headers)

    expect(other.body.error?.code).toBe('request.idempotency_key_reused')
  })

  test('an email already held by a visible Prospect is a duplicate and names it', async () => {
    const { call, create, rep } = await setup()
    const first = await create(rep, ada)

    const dup = await call(rep, 'POST', '/prospects', { email: 'ADA@example.test' })

    expect(dup.status).toBe(409)
    expect(dup.body.error?.code).toBe('prospect.duplicate_identity')
    expect(JSON.stringify(dup.body)).toContain(first.id)
  })

  test('a duplicate held by a Prospect the caller cannot see does not name it', async () => {
    const { call, create, rep, outsider } = await setup()
    const hidden = await create(outsider, ada)

    const dup = await call(rep, 'POST', '/prospects', { email: 'ada@example.test' })

    expect(dup.status).toBe(409)
    expect(dup.body.error?.code).toBe('prospect.duplicate_identity')
    expect(JSON.stringify(dup.body)).not.toContain(hidden.id)
  })

  test('a phone without a country code and a body with no identity are request.invalid', async () => {
    const { call, rep } = await setup()

    const phone = await call(rep, 'POST', '/prospects', { firstName: 'Bo', phone: '555 0100' })
    const empty = await call(rep, 'POST', '/prospects', { notes: 'nothing to go on' })

    expect(phone.status).toBe(400)
    expect(phone.body.error?.code).toBe('request.invalid')
    expect(empty.status).toBe(400)
  })

  test('a company that does not exist is prospect.not_found', async () => {
    const { call, rep } = await setup()

    const response = await call(rep, 'POST', '/prospects', {
      firstName: 'Bo',
      companyId: formatId('pco', crypto.randomUUID()),
    })

    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('prospect.not_found')
  })

  test('a source in the body is refused', async () => {
    const { call, rep } = await setup()

    const response = await call(rep, 'POST', '/prospects', { ...ada, source: 'import' })

    expect(response.status).toBe(400)
  })
})

describe('getting and updating a Prospect', () => {
  test('gets one by id', async () => {
    const { call, create, rep } = await setup()
    const made = await create(rep, ada)

    const got = await call(rep, 'GET', `/prospects/${made.id}`)

    expect(got.status).toBe(200)
    expect(prospectSchema.parse(got.body)).toEqual(made)
  })

  test('an edit is written as manual, changes the fields and publishes prospect.updated', async () => {
    const { call, create, rep, clock, queued } = await setup()
    const made = await create(rep, ada)
    await queued()
    clock.advance('1h')

    const response = await call(rep, 'PATCH', `/prospects/${made.id}`, {
      jobTitle: 'Countess',
      tags: ['vip'],
    })

    expect(response.status).toBe(200)
    const updated = prospectSchema.parse(response.body)
    expect(updated.fields.jobTitle).toMatchObject({ value: 'Countess', source: 'manual' })
    expect(updated.tags).toEqual(['vip'])
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(made.updatedAt))
    const events = await queued()
    expect(events.map((e) => e.type)).toEqual(['prospect.updated'])
    expect(events[0]?.payload).toMatchObject({ prospectId: made.id })
  })

  test('an edit that changes nothing publishes nothing and leaves updatedAt alone', async () => {
    const { call, create, rep, clock, queued } = await setup()
    const made = await create(rep, ada)
    await queued()
    clock.advance('1h')

    const response = await call(rep, 'PATCH', `/prospects/${made.id}`, {
      firstName: 'Ada',
      status: 'active',
    })

    expect(response.status).toBe(200)
    expect(prospectSchema.parse(response.body).updatedAt).toBe(made.updatedAt)
    expect(await queued()).toEqual([])
  })

  test('null clears a field, and the identity is free for another Prospect', async () => {
    const { call, create, rep } = await setup()
    const made = await create(rep, ada)

    const cleared = prospectSchema.parse(
      (await call(rep, 'PATCH', `/prospects/${made.id}`, { email: null })).body
    )
    const reuse = await call(rep, 'POST', '/prospects', { email: 'ada@example.test' })

    expect(cleared.fields.email).toBeUndefined()
    expect(reuse.status).toBe(201)
  })

  test('moving to an email another Prospect holds is a duplicate', async () => {
    const { call, create, rep } = await setup()
    await create(rep, ada)
    const bob = await create(rep, { firstName: 'Bob', email: 'bob@example.test' })

    const response = await call(rep, 'PATCH', `/prospects/${bob.id}`, { email: 'ada@example.test' })

    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('prospect.duplicate_identity')
  })

  test('archives a Prospect and sets and clears the company', async () => {
    const { call, create, rep } = await setup()
    const made = await create(rep, ada)
    const company = prospectCompanySchema.parse(
      (await call(rep, 'POST', '/prospect-companies', { name: 'Analytical' })).body
    )

    const withCompany = prospectSchema.parse(
      (
        await call(rep, 'PATCH', `/prospects/${made.id}`, {
          companyId: company.id,
          status: 'archived',
        })
      ).body
    )
    const without = prospectSchema.parse(
      (await call(rep, 'PATCH', `/prospects/${made.id}`, { companyId: null })).body
    )

    expect(withCompany.companyId).toBe(company.id)
    expect(withCompany.status).toBe('archived')
    expect(without.companyId).toBeNull()
  })

  test('an empty edit is request.invalid', async () => {
    const { call, create, rep } = await setup()
    const made = await create(rep, ada)

    expect((await call(rep, 'PATCH', `/prospects/${made.id}`, {})).status).toBe(400)
  })
})

describe('listing Prospects', () => {
  test('pages newest first with a cursor, and the last page has no cursor', async () => {
    const { call, create, rep, clock } = await setup()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await create(rep, { firstName: `P${i}`, email: `p${i}@example.test` })).id)
      clock.advance('1m')
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `/prospects?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = listProspectsResponseSchema.parse((await call(rep, 'GET', query)).body)
      seen.push(...page.items.map((p) => p.id))
      cursor = page.nextCursor
      pages++
    } while (cursor)

    expect(pages).toBe(3)
    expect(seen).toEqual([...ids].reverse())
  })

  test('a Prospect created at the same instant is not skipped or repeated across pages', async () => {
    const { call, create, rep } = await setup()
    for (let i = 0; i < 5; i++) {
      await create(rep, { firstName: `P${i}` })
    }

    const first = listProspectsResponseSchema.parse(
      (await call(rep, 'GET', '/prospects?limit=3')).body
    )
    const second = listProspectsResponseSchema.parse(
      (
        await call(
          rep,
          'GET',
          `/prospects?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`
        )
      ).body
    )

    const all = [...first.items, ...second.items].map((p) => p.id)
    expect(new Set(all).size).toBe(5)
    expect(second.nextCursor).toBeNull()
  })

  test('a limit over 100 and a garbled cursor are request.invalid', async () => {
    const { call, rep } = await setup()

    expect((await call(rep, 'GET', '/prospects?limit=101')).status).toBe(400)
    expect((await call(rep, 'GET', '/prospects?cursor=garbage')).status).toBe(400)
  })

  test('filters by status, company, owner and search text', async () => {
    const { call, create, admin, rep, teammate } = await setup()
    const company = prospectCompanySchema.parse(
      (await call(admin, 'POST', '/prospect-companies', { name: 'Analytical' })).body
    )
    const ada1 = await create(admin, { ...ada, ownerMembershipId: rep.id, companyId: company.id })
    const bob = await create(admin, {
      firstName: 'Bob',
      email: 'bob@other.test',
      ownerMembershipId: teammate.id,
    })
    await call(admin, 'PATCH', `/prospects/${bob.id}`, { status: 'archived' })
    const ids = async (query: string) =>
      listProspectsResponseSchema
        .parse((await call(admin, 'GET', `/prospects?${query}`)).body)
        .items.map((p) => p.id)

    expect(await ids('status=archived')).toEqual([bob.id])
    expect(await ids(`companyId=${company.id}`)).toEqual([ada1.id])
    expect(await ids(`ownerMembershipId=${teammate.id}`)).toEqual([bob.id])
    expect(await ids('q=lovelace')).toEqual([ada1.id])
    expect(await ids('q=OTHER.test')).toEqual([bob.id])
    expect(await ids('source=manual')).toHaveLength(2)
    expect(await ids('source=import')).toEqual([])
  })

  test('a q list with a rare owner follows nextCursor to every match, and never reaches another Organization', async () => {
    const { call, create, admin, rep, teammate, store } = await setup()
    const mine = new Set<string>()
    for (let index = 0; index < 620; index++) {
      const owned = index % 70 === 0
      const made = await create(admin, {
        firstName: `Quince${index}`,
        ownerMembershipId: owned ? rep.id : teammate.id,
      })
      if (owned) {
        mine.add(made.id)
      }
    }
    const other = await seedOrganization(store, ['admin', 'rep'])
    const [, theirAdmin, theirRep] = other.members
    if (!theirAdmin || !theirRep) {
      throw new Error('no second Organization members')
    }
    const theirs = new Set<string>()
    for (let index = 0; index < 30; index++) {
      const response = await call(
        theirAdmin,
        'POST',
        '/prospects',
        { firstName: `Quince${index}`, ownerMembershipId: theirRep.id },
        undefined,
        other.organizationId
      )
      expect([200, 201]).toContain(response.status)
      theirs.add(prospectSchema.parse(response.body).id)
    }

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const query: string = `q=quince&ownerMembershipId=${rep.id}&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const response = await call(admin, 'GET', `/prospects?${query}`)
      expect(response.status).toBe(200)
      const page = listProspectsResponseSchema.parse(response.body)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      pages += 1
    } while (cursor !== null && pages < 100)

    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual([...mine].sort())
    expect(seen).toHaveLength(9)
    expect(seen.some((id) => theirs.has(id))).toBe(false)

    const theirList = await call(
      theirAdmin,
      'GET',
      '/prospects?q=quince&limit=100',
      undefined,
      undefined,
      other.organizationId
    )
    const theirIds: string[] = listProspectsResponseSchema
      .parse(theirList.body)
      .items.map((i) => i.id)
    expect([...theirIds].sort()).toEqual([...theirs].sort())
  }, 60_000)
})

describe('who sees which Prospect', () => {
  async function seen() {
    const ctx = await setup()
    const { create, admin, rep, teammate, outsider, manager } = ctx
    const reps = await create(rep, { firstName: 'Rep', email: 'rep@example.test' })
    const mates = await create(teammate, { firstName: 'Mate', email: 'mate@example.test' })
    const far = await create(outsider, { firstName: 'Far', email: 'far@example.test' })
    const managers = await create(manager, { firstName: 'Mgr', email: 'mgr@example.test' })
    const unowned = await create(admin, { firstName: 'None', email: 'none@example.test' })
    return { ...ctx, reps, mates, far, managers, unowned }
  }
  const listed = async (ctx: Awaited<ReturnType<typeof seen>>, actor: Actor): Promise<string[]> =>
    listProspectsResponseSchema
      .parse((await ctx.call(actor, 'GET', '/prospects?limit=100')).body)
      .items.map((p) => p.id)
      .sort()

  test('Owner and Admin see every Prospect', async () => {
    const ctx = await seen()
    const everything = [ctx.reps, ctx.mates, ctx.far, ctx.managers, ctx.unowned]
      .map((p) => p.id)
      .sort()

    expect(await listed(ctx, ctx.owner)).toEqual(everything)
    expect(await listed(ctx, ctx.admin)).toEqual(everything)
  })

  test('a Rep sees only their own', async () => {
    const ctx = await seen()

    expect(await listed(ctx, ctx.rep)).toEqual([ctx.reps.id])
    expect((await ctx.call(ctx.rep, 'GET', `/prospects/${ctx.mates.id}`)).status).toBe(404)
  })

  test('a Manager sees their own and their Team Reps, not another Team or the unowned', async () => {
    const ctx = await seen()

    expect(await listed(ctx, ctx.manager)).toEqual(
      [ctx.reps.id, ctx.mates.id, ctx.managers.id].sort()
    )
    expect((await ctx.call(ctx.manager, 'GET', `/prospects/${ctx.far.id}`)).status).toBe(404)
    expect((await ctx.call(ctx.manager, 'GET', `/prospects/${ctx.unowned.id}`)).status).toBe(404)
    expect(await listed(ctx, ctx.otherManager)).toEqual([ctx.far.id])
  })

  test('an invisible Prospect is 404 prospect.not_found, never 403, for get and update', async () => {
    const ctx = await seen()

    const got = await ctx.call(ctx.rep, 'GET', `/prospects/${ctx.far.id}`)
    const patched = await ctx.call(ctx.rep, 'PATCH', `/prospects/${ctx.far.id}`, { firstName: 'X' })

    expect(got.status).toBe(404)
    expect(got.body.error?.code).toBe('prospect.not_found')
    expect(patched.status).toBe(404)
    expect(patched.body.error?.code).toBe('prospect.not_found')
    expect(await ctx.queued()).not.toContainEqual(
      expect.objectContaining({ type: 'prospect.updated' })
    )
  })

  test('a Prospect id that does not exist is the same 404', async () => {
    const { call, rep } = await setup()

    const missing = await call(rep, 'GET', `/prospects/${formatId('prs', crypto.randomUUID())}`)

    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('prospect.not_found')
  })
})

describe('another Organization', () => {
  test('cannot list, get or update the Prospects of this one', async () => {
    const ctx = await setup()
    const made = await ctx.create(ctx.rep, ada)
    const other = await seedOrganization(ctx.store, ['admin'])
    const intruder = other.owner

    const list = await ctx.call(
      intruder,
      'GET',
      '/prospects',
      undefined,
      undefined,
      other.organizationId
    )
    const get = await ctx.call(
      intruder,
      'GET',
      `/prospects/${made.id}`,
      undefined,
      undefined,
      other.organizationId
    )
    const patch = await ctx.call(
      intruder,
      'PATCH',
      `/prospects/${made.id}`,
      { firstName: 'X' },
      undefined,
      other.organizationId
    )

    expect(listProspectsResponseSchema.parse(list.body).items).toEqual([])
    expect(get.status).toBe(404)
    expect(patch.status).toBe(404)
    const still = prospectSchema.parse(
      (await ctx.call(ctx.rep, 'GET', `/prospects/${made.id}`)).body
    )
    expect(still.fields.firstName?.value).toBe('Ada')
  })

  test('the same email in two Organizations is not a duplicate', async () => {
    const ctx = await setup()
    await ctx.create(ctx.rep, ada)
    const other = await seedOrganization(ctx.store)

    const response = await ctx.call(
      other.owner,
      'POST',
      '/prospects',
      ada,
      undefined,
      other.organizationId
    )

    expect(response.status).toBe(201)
  })
})

describe('who may call', () => {
  test('a caller with no Membership in the Organization is refused', async () => {
    const ctx = await setup()

    const response = await ctx.call({ userId: newUserId(), role: 'rep' }, 'GET', '/prospects')

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  })

  test('another Organization id the caller has no token for is not a way in', async () => {
    const ctx = await setup()

    const response = await ctx.call(
      ctx.rep,
      'GET',
      '/prospects',
      undefined,
      undefined,
      newOrganizationId()
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

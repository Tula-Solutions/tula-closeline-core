import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { type MembershipId, membershipIdSchema } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { memberPageQuery } from '~/adapters/postgres/core-store'
import { harness, organizationCount, owner, service, store } from '~/integration-harness'
import { newUserId, publicCaller, seedOrganization } from '~/testing'

describe("core's copy of a member, over Postgres", () => {
  test('sign-up stores the address and name, and the member list returns them', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp({ email: 'Olive@Example.test' })

    const rows = await h.members(organizationId, { userId })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId,
      email: 'olive@example.test',
      name: 'Olive Owner',
      role: 'owner',
    })
  })

  test.each([
    ['null', { name: null }],
    ['absent', { name: undefined }],
  ])('a %s name is stored as null', async (_label, extra) => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp(extra)

    const rows = await h.members(organizationId, { userId })

    expect(rows[0]?.name).toBeNull()
  })

  test('a create without an email is refused and nothing is written', async () => {
    const h = await harness()
    const before = await organizationCount()

    const refused = await h.post('/internal/organizations', {
      userId: newUserId(),
      organizationName: 'Nobody',
    })

    expect(refused.status).toBe(400)
    expect(refused.body.error?.code).toBe('request.invalid')
    expect(await organizationCount()).toBe(before)
  })

  test('an accepted Invitation stores the request address and name', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()
    const api = publicCaller(h)
    await api({ userId, role: 'owner' }, organizationId, 'POST', '/invitations', {
      email: 'joiner@example.test',
      role: 'rep',
    })
    const joiner = newUserId()

    const accepted = await h.post('/internal/invitations/accept', {
      userId: joiner,
      email: 'Joiner@Example.TEST',
      name: 'Jo Iner',
      invitationToken: h.deps.mail.last().token,
    })
    const replay = await h.post('/internal/invitations/accept', {
      userId: joiner,
      email: 'joiner@example.test',
      name: 'Someone Else',
      invitationToken: h.deps.mail.last().token,
    })

    expect(accepted.status).toBe(200)
    expect(replay.status).toBe(200)
    const rows = await h.members(organizationId, { userId })
    expect(rows.find((row) => row.userId === joiner)).toMatchObject({
      email: 'joiner@example.test',
      name: 'Jo Iner',
    })
  })

  test("a second Organization's members never carry the first one's copy", async () => {
    const h = await harness()
    const mine = await h.signUp()
    const theirs = await seedOrganization(store, ['rep'])

    const rows = await h.members(theirs.organizationId, theirs.owner)

    expect(JSON.stringify(rows)).not.toContain(`${mine.userId}@example.test`)
    expect(rows).toHaveLength(2)
  })

  test('the member list page reads memberships_organization_id_id_key, whatever the statistics', async () => {
    const h = await harness()
    const { userId, organizationId } = await h.signUp()
    // A realistic spread: 20 Organizations of 100 members each, so a walk of the primary key
    // would read 19 other Organizations' rows for every one of this Organization's.
    const others = await Promise.all(Array.from({ length: 19 }, () => seedOrganization(store, [])))
    for (const id of [organizationId, ...others.map((other) => other.organizationId)]) {
      await withOrganization(service.db, id, (tx) =>
        tx.execute(sql`
          insert into core.memberships
            (id, organization_id, user_id, email, name, role, created_at, updated_at)
          select
            'mem_' || md5(${id} || g::text),
            ${id},
            'usr_' || md5(${id} || 'u' || g::text),
            'member' || g::text || '@example.test',
            case when g % 2 = 0 then 'Member ' || g::text end,
            'rep',
            now(),
            now()
          from generate_series(1, 100) g
        `)
      )
    }
    await owner.db.execute(sql`analyze core.memberships`)

    const planOf = (after: MembershipId | undefined) =>
      withOrganization(service.db, organizationId, async (tx) => {
        // Leave only index scans that can give the order, so the choice is between the two indexes
        // that could: the composite one (no sort) and the primary key (walks other Organizations).
        await tx.execute(sql`set local enable_seqscan = off`)
        await tx.execute(sql`set local enable_bitmapscan = off`)
        const query = memberPageQuery(tx, organizationId, after, 101)
        // The plan alone cannot tell the two orders apart when the data is spread (the planner
        // knows the Organization is constant), so the order is asserted as written too.
        expect(query.toSQL().sql).toMatch(/order by "core"."memberships"."organization_id" asc, /)
        const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
          sql`explain (format json) ${query}`
        )
        return JSON.stringify(rows[0]?.['QUERY PLAN'])
      })
    const firstPage = await planOf(undefined)
    const afterId = membershipIdSchema.parse(`mem_${'0'.repeat(32)}`)
    const nextPage = await planOf(afterId)

    for (const explained of [firstPage, nextPage]) {
      expect(explained).toContain('memberships_organization_id_id_key')
      expect(explained).not.toContain('memberships_pkey')
    }
    expect(await h.members(organizationId, { userId })).toHaveLength(100)
  })
})

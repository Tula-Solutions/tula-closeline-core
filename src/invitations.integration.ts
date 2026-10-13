import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
  encodeCursor,
  formatId,
  type InvitableRole,
  invitationSchema,
  listInvitationsResponseSchema,
  listTeamsResponseSchema,
  type OrganizationId,
  type OrganizationStatus,
  teamSchema,
  type UserId,
} from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { organizations } from 'tula-closeline-db/schema'
import {
  createPostgresCoreStore,
  expiredInvitationIdsQuery,
  invitationPageQuery,
  invitationsSinceQuery,
} from '~/adapters/postgres/core-store'
import { integrationUrls } from '~/integration-support'
import {
  INVITATION_SEND_BUDGET,
  INVITATION_SEND_WINDOW_MS,
  INVITATION_TTL_MS,
  MAX_PENDING_INVITATIONS,
  membershipIdFor,
} from '~/modules/invitation/token'
import { type ApiBody, createTestApp, newUserId, publicCaller, seedOrganization } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)
const store = createPostgresCoreStore(service.db)

afterAll(async () => {
  await service.close()
  await owner.close()
})

/** The app over Postgres, with its clock at the real time so the database's expiry agrees with it. */
async function harness(clockStart = new Date().toISOString()) {
  const app = await createTestApp({ store, env: { DATABASE_URL: urls.service }, clockStart })
  const api = publicCaller(app)
  const accept = async (body: { userId?: UserId; email?: string; invitationToken: string }) => {
    const response = await app.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: app.internal(),
      body: JSON.stringify({ userId: newUserId(), email: 'new@example.com', ...body }),
    })
    return { status: response.status, body: (await response.json()) as ApiBody }
  }
  return { ...app, api, accept }
}

async function organization(
  over: Awaited<ReturnType<typeof harness>>,
  extra: readonly ('admin' | 'rep')[] = ['rep']
) {
  const seeded = await seedOrganization(store, extra)
  const invite = async (email: string, role: InvitableRole = 'rep', teamId?: string) => {
    const made = await over.api(seeded.owner, seeded.organizationId, 'POST', '/invitations', {
      email,
      role,
      ...(teamId === undefined ? {} : { teamId }),
    })
    return { made, token: made.status === 201 ? over.deps.mail.last().token : '' }
  }
  const call = (method: string, path: string, body?: unknown) =>
    over.api(seeded.owner, seeded.organizationId, method, path, body)
  return { ...seeded, invite, call }
}

function setStatus(organizationId: OrganizationId, status: OrganizationStatus) {
  return withOrganization(service.db, organizationId, async (tx) => {
    await tx
      .update(organizations)
      .set({ status })
      .where(eq(organizations.organizationId, organizationId))
  })
}

/** Reads one number from a tenant table, inside the Organization's scope (row-level security binds the owner too). */
async function countIn(
  organizationId: OrganizationId,
  query: ReturnType<typeof sql>
): Promise<number> {
  const result = await withOrganization(service.db, organizationId, (tx) =>
    tx.execute<{ n: number }>(query)
  )
  return result.rows[0]?.n ?? 0
}

async function memberCount(organizationId: OrganizationId): Promise<number> {
  return (await store.withOrganization(organizationId, (s) => s.listMembers({ limit: 100 }))).length
}

describe('inviting and accepting, over Postgres', () => {
  test('the invitation is stored as a hash of the token and nothing else, and leaves the directory when accepted', async () => {
    const h = await harness()
    const org = await organization(h)
    const { made, token } = await org.invite('new@example.com', 'manager')
    const id = invitationSchema.parse(made.body).id
    const hash = createHash('sha256').update(token).digest('hex')

    const before = await withOrganization(service.db, org.organizationId, (tx) =>
      tx.execute<{ token_hash: string }>(
        sql`select token_hash from core.invitations where id = ${id}`
      )
    )
    const inDirectory = () =>
      owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from core.invitation_directory where token_hash = ${hash}`
      )
    const listed = await inDirectory()
    const accepted = await h.accept({ email: 'new@example.com', invitationToken: token })
    const after = await inDirectory()

    expect(before.rows[0]?.token_hash).toBe(hash)
    expect(JSON.stringify(before.rows)).not.toContain(token)
    expect(listed.rows[0]?.n).toBe(1)
    expect(accepted).toEqual({
      status: 200,
      body: { organizationId: org.organizationId, role: 'manager' },
    })
    expect(after.rows[0]?.n).toBe(0)
    expect(h.deps.logLines.join('\n')).not.toContain(token)
  })

  test('the accepted user is a member with the offered role and sits in the Invitation’s Team', async () => {
    const h = await harness()
    const org = await organization(h)
    const team = teamSchema.parse((await org.call('POST', '/teams', { name: 'Sales' })).body)
    const { made, token } = await org.invite('new@example.com', 'rep', team.id)
    const userId = newUserId()

    await h.accept({ userId, invitationToken: token })

    const view = await store.withOrganization(org.organizationId, async (scope) => ({
      member: await scope.getMembershipByUser(userId),
      places: await scope.getMembership(membershipIdFor(invitationSchema.parse(made.body).id)),
    }))
    expect(view.member).toMatchObject({ role: 'rep' })
    expect(view.places?.id).toBe(view.member?.id)
    expect(
      await countIn(
        org.organizationId,
        sql`select count(*)::int as n from core.team_members where team_id = ${team.id}`
      )
    ).toBe(1)
  })

  test('a retry by the same user answers the same, and a different user is invalid', async () => {
    const h = await harness()
    const org = await organization(h)
    const { token } = await org.invite('new@example.com')
    const userId = newUserId()

    const first = await h.accept({ userId, invitationToken: token })
    const retry = await h.accept({ userId, invitationToken: token })
    const stranger = await h.accept({ invitationToken: token })

    expect(first.status).toBe(200)
    expect(retry).toEqual(first)
    expect(stranger.status).toBe(422)
    expect(stranger.body.error?.code).toBe('invitation.invalid')
    expect(await memberCount(org.organizationId)).toBe(org.members.length + 1)
  })

  test('two accepts at once by different users leave one Membership, over many tries', async () => {
    const h = await harness()
    for (let round = 0; round < 5; round++) {
      const org = await organization(h)
      const { token } = await org.invite('new@example.com')

      const results = await Promise.all([
        h.accept({ invitationToken: token }),
        h.accept({ invitationToken: token }),
        h.accept({ invitationToken: token }),
      ])

      expect(results.map((r) => r.status).sort()).toEqual([200, 422, 422])
      expect(await memberCount(org.organizationId)).toBe(org.members.length + 1)
    }
  })

  test('two accepts at once by one user leave one Membership and both succeed', async () => {
    const h = await harness()
    for (let round = 0; round < 5; round++) {
      const org = await organization(h)
      const { token } = await org.invite('new@example.com')
      const userId = newUserId()

      const [a, b] = await Promise.all([
        h.accept({ userId, invitationToken: token }),
        h.accept({ userId, invitationToken: token }),
      ])

      expect(a.status).toBe(200)
      expect(b).toEqual(a)
      expect(await memberCount(org.organizationId)).toBe(org.members.length + 1)
    }
  })

  test('an expired, a revoked, a used, a wrong-address and a suspended-Organization token are all the unknown-token answer', async () => {
    const h = await harness()
    const old = await harness(new Date(Date.now() - 8 * 24 * 3_600_000).toISOString())
    const org = await organization(h)
    const oldOrg = await organization(old)
    const unknown = await h.accept({ invitationToken: 'x'.repeat(43) })

    const expired = (await oldOrg.invite('expired@example.com')).token
    const revokedInvite = await org.invite('revoked@example.com')
    await org.call('DELETE', `/invitations/${invitationSchema.parse(revokedInvite.made.body).id}`)
    const used = (await org.invite('used@example.com')).token
    await h.accept({ email: 'used@example.com', invitationToken: used })
    const wrong = (await org.invite('right@example.com')).token
    const suspendedOrg = await organization(h)
    const suspended = (await suspendedOrg.invite('s@example.com')).token
    await setStatus(suspendedOrg.organizationId, 'suspended')
    const deletedOrg = await organization(h)
    const deleted = (await deletedOrg.invite('d@example.com')).token
    await setStatus(deletedOrg.organizationId, 'deleted')

    const results = await Promise.all([
      h.accept({ email: 'expired@example.com', invitationToken: expired }),
      h.accept({ email: 'revoked@example.com', invitationToken: revokedInvite.token }),
      h.accept({ email: 'used@example.com', invitationToken: used }),
      h.accept({ email: 'wrong@example.com', invitationToken: wrong }),
      h.accept({ email: 's@example.com', invitationToken: suspended }),
      h.accept({ email: 'd@example.com', invitationToken: deleted }),
    ])

    expect(unknown.status).toBe(422)
    for (const result of results) {
      expect(result).toEqual(unknown)
    }
  })

  test('a user who belongs to another Organization is membership.already_member, and the Invitation survives', async () => {
    const h = await harness()
    const org = await organization(h)
    const other = await organization(h)
    const { token } = await org.invite('new@example.com')

    const refused = await h.accept({ userId: other.owner.userId, invitationToken: token })
    const later = await h.accept({ invitationToken: token })

    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe('membership.already_member')
    expect(later.status).toBe(200)
  })

  test('the 1,001st pending Invitation is rate.limited by a bounded count', async () => {
    const h = await harness()
    const org = await organization(h)
    await withOrganization(service.db, org.organizationId, (tx) =>
      tx.execute(sql`
      insert into core.invitations (id, organization_id, email, role, invited_by_user_id, token_hash, state, expires_at, created_at, updated_at)
      select 'inv_' || replace(gen_random_uuid()::text, '-', ''), ${org.organizationId}, 'bulk' || n || '@example.com', 'rep',
             ${org.owner.userId}, encode(sha256((gen_random_uuid()::text || n)::bytea), 'hex'), 'pending', now() + interval '1 day', now() - interval '1 hour', now() - interval '1 hour'
      from generate_series(1, ${MAX_PENDING_INVITATIONS - 1}) as n`)
    )

    const last = await org.invite('last@example.com')
    const over = await org.invite('over@example.com')

    expect(last.made.status).toBe(201)
    expect(over.made.status).toBe(429)
    expect(over.made.body.error?.code).toBe('rate.limited')
  })

  test('two creations for one email at once leave one pending Invitation and one invitation.already_pending', async () => {
    const h = await harness()
    const org = await organization(h)

    const results = await Promise.all([
      org.invite('same@example.com'),
      org.invite('same@example.com'),
      org.invite('same@example.com'),
    ])

    expect(results.map((r) => r.made.status).sort()).toEqual([201, 409, 409])
    const pending = listInvitationsResponseSchema.parse(
      (await org.call('GET', '/invitations')).body
    )
    expect(pending.items).toHaveLength(1)
  })

  test('a failed delivery revokes the Invitation in the database', async () => {
    const h = await harness()
    const org = await organization(h)
    h.deps.mail.failing = true

    const failed = await org.invite('lost@example.com')

    expect(failed.made.status).toBe(503)
    const revoked = listInvitationsResponseSchema.parse(
      (await org.call('GET', '/invitations?state=revoked')).body
    )
    expect(revoked.items.map((i) => i.email)).toEqual(['lost@example.com'])
  })

  test('an expired pending Invitation is replaced by a new one for the same email', async () => {
    const old = await harness(new Date(Date.now() - 8 * 24 * 3_600_000).toISOString())
    const org = await organization(old)
    await org.invite('again@example.com')
    const fresh = await harness()

    const second = await fresh.api(org.owner, org.organizationId, 'POST', '/invitations', {
      email: 'again@example.com',
      role: 'rep',
    })

    expect(second.status).toBe(201)
  })
})

describe('Teams over Postgres', () => {
  test('two creations of one name at once, in different case, leave one Team and one team.name_taken', async () => {
    const h = await harness()
    const org = await organization(h)

    const results = await Promise.all([
      org.call('POST', '/teams', { name: 'Sales' }),
      org.call('POST', '/teams', { name: 'SALES' }),
      org.call('POST', '/teams', { name: 'sales' }),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409])
    expect(results.find((r) => r.status === 409)?.body.error?.code).toBe('team.name_taken')
    expect(
      listTeamsResponseSchema.parse((await org.call('GET', '/teams')).body).items
    ).toHaveLength(1)
  })

  test('adding twice and removing twice succeed, and deleting a Team with many members takes its places with it', async () => {
    const h = await harness()
    const org = await organization(h, ['rep'])
    const team = teamSchema.parse((await org.call('POST', '/teams', { name: 'Big' })).body)
    const rep = org.members[1]
    expect(rep).toBeDefined()
    const membershipId = rep?.id
    await store.withOrganization(org.organizationId, async (scope) => {
      await scope.lockOrganization()
      for (let index = 0; index < 200; index++) {
        const id = formatId('mem', crypto.randomUUID())
        await scope.insertMembership({ id, userId: newUserId(), role: 'rep', now: new Date() })
        await scope.addTeamMember(team.id, id, new Date())
      }
    })

    const add1 = await org.call('POST', `/teams/${team.id}/members`, { membershipId })
    const add2 = await org.call('POST', `/teams/${team.id}/members`, { membershipId })
    const rm1 = await org.call('DELETE', `/teams/${team.id}/members/${membershipId}`)
    const rm2 = await org.call('DELETE', `/teams/${team.id}/members/${membershipId}`)
    const deleted = await org.call('DELETE', `/teams/${team.id}`)

    expect(add1).toEqual(add2)
    expect([rm1.status, rm2.status, deleted.status]).toEqual([204, 204, 204])
    expect(
      await countIn(
        org.organizationId,
        sql`select count(*)::int as n from core.team_members where team_id = ${team.id}`
      )
    ).toBe(0)
    expect(await memberCount(org.organizationId)).toBe(100)
  })

  test('deleting a Team clears it from a pending Invitation, which then accepts without a Team', async () => {
    const h = await harness()
    const org = await organization(h)
    const team = teamSchema.parse((await org.call('POST', '/teams', { name: 'Gone' })).body)
    const { made, token } = await org.invite('new@example.com', 'rep', team.id)
    await org.call('DELETE', `/teams/${team.id}`)

    const listed = listInvitationsResponseSchema.parse((await org.call('GET', '/invitations')).body)
    const accepted = await h.accept({ invitationToken: token })

    expect(
      listed.items.find((i) => i.id === invitationSchema.parse(made.body).id)?.teamId
    ).toBeNull()
    expect(accepted.status).toBe(200)
  })
})

describe('a second Organization can read, change or join nothing of the first, over Postgres', () => {
  test('every Invitation and Team route', async () => {
    const h = await harness()
    const a = await organization(h, ['rep'])
    const b = await organization(h, ['rep'])
    const team = teamSchema.parse((await a.call('POST', '/teams', { name: 'Sales' })).body)
    const { made } = await a.invite('x@example.com')
    const invitationId = invitationSchema.parse(made.body).id
    const aRep = a.members[1]
    const bRep = b.members[1]
    const asB = (method: string, path: string, body?: unknown) =>
      h.api(b.owner, b.organizationId, method, path, body)
    const ghostTeam = formatId('team', crypto.randomUUID())

    const results = {
      invitations: await asB('GET', '/invitations'),
      teams: await asB('GET', '/teams'),
      revoke: await asB('DELETE', `/invitations/${invitationId}`),
      rename: await asB('PATCH', `/teams/${team.id}`, { name: 'Mine' }),
      renameGhost: await asB('PATCH', `/teams/${ghostTeam}`, { name: 'Mine' }),
      remove: await asB('DELETE', `/teams/${team.id}`),
      join: await asB('POST', `/teams/${team.id}/members`, { membershipId: bRep?.id }),
      pull: await asB('POST', `/teams/${team.id}/members`, { membershipId: aRep?.id }),
      leave: await asB('DELETE', `/teams/${team.id}/members/${aRep?.id}`),
      inviteIntoTheirTeam: await asB('POST', '/invitations', {
        email: 'y@example.com',
        role: 'rep',
        teamId: team.id,
      }),
    }

    expect(listInvitationsResponseSchema.parse(results.invitations.body).items).toEqual([])
    expect(listTeamsResponseSchema.parse(results.teams.body).items).toEqual([])
    expect(results.revoke.status).toBe(404)
    expect(results.rename).toEqual(results.renameGhost)
    expect(results.remove.status).toBe(404)
    expect(results.join).toEqual(results.renameGhost)
    expect(results.pull).toEqual(results.renameGhost)
    expect(results.leave).toEqual(results.renameGhost)
    expect(results.inviteIntoTheirTeam).toEqual(results.renameGhost)
    const stillA = listTeamsResponseSchema.parse((await a.call('GET', '/teams')).body)
    expect(stillA.items.map((t) => t.name)).toEqual(['Sales'])
    expect(
      listInvitationsResponseSchema.parse((await a.call('GET', '/invitations')).body).items
    ).toHaveLength(1)
  })
})

/** Puts `count` Invitations in the Organization in one statement, `step` seconds apart, newest at `newest`. */
async function seedInvitations(
  organizationId: OrganizationId,
  invitedBy: UserId,
  options: {
    count: number
    state: 'pending' | 'revoked'
    newest: Date
    stepSeconds: number
    tag: string
  }
) {
  await withOrganization(service.db, organizationId, (tx) =>
    tx.execute(sql`
      insert into core.invitations
        (id, organization_id, email, role, invited_by_user_id, token_hash, state,
         expires_at, revoked_at, created_at, updated_at)
      select
        'inv_' || md5(${organizationId} || ${options.tag} || g::text),
        ${organizationId},
        ${options.tag} || g::text || '@example.com',
        'rep',
        ${invitedBy},
        encode(sha256(convert_to(${organizationId} || ${options.tag} || g::text, 'UTF8')), 'hex'),
        ${options.state},
        ${options.newest.toISOString()}::timestamptz + interval '7 days',
        case when ${options.state} = 'revoked' then ${options.newest.toISOString()}::timestamptz end,
        ${options.newest.toISOString()}::timestamptz - (g * ${options.stepSeconds} || ' seconds')::interval,
        ${options.newest.toISOString()}::timestamptz
      from generate_series(1, ${options.count}) g
    `)
  )
}

/** Every node type and index name in an `EXPLAIN (FORMAT JSON)` plan, and the buffers its root used when it ran. */
function planParts(explained: unknown): {
  nodeTypes: string[]
  indexNames: string[]
  buffers: number
  removedByFilter: number
} {
  const nodeTypes: string[] = []
  const indexNames: string[] = []
  let removedByFilter = 0
  const walk = (node: { [key: string]: unknown }) => {
    nodeTypes.push(String(node['Node Type']))
    removedByFilter += Number(node['Rows Removed by Filter'] ?? 0)
    if (typeof node['Index Name'] === 'string') {
      indexNames.push(node['Index Name'])
    }
    for (const child of (node.Plans as { [key: string]: unknown }[] | undefined) ?? []) {
      walk(child)
    }
  }
  const root = (explained as { Plan: { [key: string]: unknown } }[])[0]
  if (root) {
    walk(root.Plan)
  }
  const used = (name: string) => Number(root?.Plan[name] ?? 0)
  return {
    nodeTypes,
    indexNames,
    buffers: used('Shared Hit Blocks') + used('Shared Read Blocks'),
    removedByFilter,
  }
}

/** How many old Invitations the long-history test seeds: the old statement reads all of them. */
const OLD_INVITATIONS = 100_000

/** How many rows the expired sweep may read and throw away when none has expired: none, give or take. */
const MAX_ROWS_REMOVED = 5

/** The most buffers (hit plus read) the send-budget count may touch: a few index pages per state. */
const MAX_COUNT_BUFFERS = 300

describe('the Invitation list and the send budget, over Postgres', () => {
  test('Invitations created at one instant page newest id first, as the memory store does', async () => {
    const h = await harness()
    const org = await organization(h)
    const made: string[] = []
    for (let index = 0; index < 5; index++) {
      made.push(invitationSchema.parse((await org.invite(`tie${index}@example.com`)).made.body).id)
    }
    const seen: string[] = []
    let cursor: string | null = null

    for (let guard = 0; guard < 10; guard++) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`
      const page = listInvitationsResponseSchema.parse(
        (await org.call('GET', `/invitations${query}`)).body
      )
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (cursor === null) {
        break
      }
    }

    expect(seen).toEqual([...made].sort().reverse())
  })

  test('a page of revoked Invitations, first or later, reads invitations_state_list_idx and sorts nothing', async () => {
    const h = await harness()
    const org = await organization(h)
    const newest = new Date()
    await seedInvitations(org.organizationId, org.owner.userId, {
      count: 3000,
      state: 'revoked',
      newest,
      stepSeconds: 3,
      tag: 'revoked',
    })
    await seedInvitations(org.organizationId, org.owner.userId, {
      count: 300,
      state: 'pending',
      newest,
      stepSeconds: 7,
      tag: 'pending',
    })
    await owner.db.execute(sql`analyze core.invitations`)
    const explainPage = (after?: { createdAt: Date; id: ReturnType<typeof formatId<'inv'>> }) =>
      withOrganization(service.db, org.organizationId, async (tx) => {
        const query = invitationPageQuery(tx, org.organizationId, {
          state: 'revoked',
          ...(after ? { after } : {}),
          limit: 101,
        })
        const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
          sql`explain (format json) ${query}`
        )
        return planParts(rows[0]?.['QUERY PLAN'])
      })

    const first = await explainPage()
    const later = await explainPage({
      createdAt: new Date(newest.getTime() - 1_000_000),
      id: formatId('inv', 'a'.repeat(32)),
    })

    for (const plan of [first, later]) {
      expect(plan.indexNames).toEqual(['invitations_state_list_idx'])
      expect(plan.nodeTypes).toContain('Index Scan')
      expect(plan.nodeTypes.filter((type) => type.includes('Sort'))).toEqual([])
      expect(plan.nodeTypes).not.toContain('Seq Scan')
    }
  })

  test('the send-budget count of an Organization with a long history reads only the index and a few buffers', async () => {
    const h = await harness()
    const org = await organization(h)
    const newest = new Date()
    // After a while almost all of an Organization's Invitations are older than the window.
    await seedInvitations(org.organizationId, org.owner.userId, {
      count: OLD_INVITATIONS,
      state: 'revoked',
      newest: new Date(newest.getTime() - 2 * INVITATION_SEND_WINDOW_MS),
      stepSeconds: 1,
      tag: 'old',
    })
    for (const state of ['revoked', 'pending'] as const) {
      await seedInvitations(org.organizationId, org.owner.userId, {
        count: 5,
        state,
        newest,
        stepSeconds: 60,
        tag: `recent-${state}`,
      })
    }
    // Another Organization's recent Invitations make a recent `created_at` common in the table as
    // a whole, as it is on a busy platform; the planner knows no better for this Organization.
    const busy = await organization(h)
    await seedInvitations(busy.organizationId, busy.owner.userId, {
      count: OLD_INVITATIONS,
      state: 'revoked',
      newest,
      stepSeconds: 1,
      tag: 'busy',
    })
    await owner.db.execute(sql`analyze core.invitations`)
    const since = new Date(newest.getTime() - INVITATION_SEND_WINDOW_MS)

    const { plan, found } = await withOrganization(service.db, org.organizationId, async (tx) => {
      const query = invitationsSinceQuery(org.organizationId, since, INVITATION_SEND_BUDGET + 1)
      const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql`explain (analyze, buffers, format json) ${query}`
      )
      return {
        plan: planParts(rows[0]?.['QUERY PLAN']),
        found: await store.withOrganization(org.organizationId, (scope) =>
          scope.countInvitationsSince(since, INVITATION_SEND_BUDGET + 1)
        ),
      }
    })

    expect(found.count).toBe(10)
    // The pending arm may read the smaller partial index of pending Invitations instead, which is
    // ordered the same way and bounded the same way; no other index may be read.
    const allowed = new Set(['invitations_pending_list_idx', 'invitations_state_list_idx'])
    expect(plan.indexNames.length).toBeGreaterThan(0)
    expect(plan.indexNames.filter((name) => !allowed.has(name))).toEqual([])
    expect(plan.nodeTypes).not.toContain('Seq Scan')
    expect(plan.nodeTypes.some((type) => type.startsWith('Bitmap'))).toBe(false)
    expect(plan.buffers).toBeLessThan(MAX_COUNT_BUFFERS)
  })

  test('with 1,000 live pending Invitations the expired sweep reads none of them', async () => {
    const h = await harness()
    const org = await organization(h)
    const now = new Date()
    await seedInvitations(org.organizationId, org.owner.userId, {
      count: MAX_PENDING_INVITATIONS,
      state: 'pending',
      newest: now,
      stepSeconds: 1,
      tag: 'live',
    })
    await owner.db.execute(sql`analyze core.invitations`)

    const plan = await withOrganization(service.db, org.organizationId, async (tx) => {
      const query = expiredInvitationIdsQuery(
        org.organizationId,
        now,
        new Date(now.getTime() - INVITATION_TTL_MS),
        100
      )
      const { rows } = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql`explain (analyze, buffers, format json) ${query}`
      )
      return planParts(rows[0]?.['QUERY PLAN'])
    })

    expect(plan.indexNames).toEqual(['invitations_pending_list_idx'])
    expect(plan.nodeTypes).not.toContain('Seq Scan')
    expect(plan.removedByFilter).toBeLessThan(MAX_ROWS_REMOVED)
  })

  test.each([
    ['year 0', '0000-01-01T00:00:00Z'],
    ['past 9999 once moved to UTC', '9999-12-31T23:59:59-14:00'],
  ])(
    'a cursor with a time in %s is an invalid request, not a server error',
    async (_name, createdAt) => {
      const h = await harness()
      const org = await organization(h)
      const cursor = encodeCursor({
        dir: 'desc',
        createdAt,
        id: formatId('inv', crypto.randomUUID()),
      })

      const listed = await org.call('GET', `/invitations?cursor=${cursor}`)

      expect([listed.status, listed.body.error?.code]).toEqual([400, 'request.invalid'])
      expect(h.deps.reported).toEqual([])
    }
  )

  test('past the send budget the answer is rate.limited with Retry-After, and a second Organization is unaffected', async () => {
    const h = await harness()
    const org = await organization(h)
    const other = await organization(h)
    const now = h.deps.clock.now()
    await seedInvitations(org.organizationId, org.owner.userId, {
      count: INVITATION_SEND_BUDGET,
      state: 'revoked',
      newest: now,
      stepSeconds: 1,
      tag: 'budget',
    })

    const over = await org.invite('over@example.com')
    const theirs = await other.invite('fine@example.com')
    h.deps.clock.advance('1d')
    const later = await org.invite('over@example.com')

    expect(over.made.status).toBe(429)
    expect(over.made.body.error?.code).toBe('rate.limited')
    // The oldest counted row is INVITATION_SEND_BUDGET seconds older than the newest.
    expect(over.made.retryAfter).toBe(
      String(INVITATION_SEND_WINDOW_MS / 1000 - INVITATION_SEND_BUDGET)
    )
    expect(theirs.made.status).toBe(201)
    expect(later.made.status).toBe(201)
  })
})

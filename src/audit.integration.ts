import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { type AuditEventId, formatId, type MembershipId } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness as makeHarness, owner, service, store } from '~/integration-harness'
import * as Audit from '~/modules/audit/service'
import { processAuditMessages } from '~/modules/audit/worker'
import { publicCaller, seedOrganization } from '~/testing'

const eventId = () => formatId('aud', crypto.randomUUID().replaceAll('-', '')) as AuditEventId

describe('Audit log, over Postgres', () => {
  const setup = async () => {
    const harness = await makeHarness()
    const org = await seedOrganization(store, ['admin', 'manager', 'rep'])
    const api = publicCaller(harness)
    const record = (over: Record<string, unknown> = {}, organizationId = org.organizationId) =>
      Audit.consume(harness.deps, {
        organizationId,
        data: {
          auditEventId: eventId(),
          occurredAt: new Date().toISOString(),
          actor: { kind: 'system' },
          action: 'thing.done',
          subject: null,
          prospectId: null,
          instructionVersion: null,
          requestId: null,
          metadata: {},
          ...over,
        } as never,
      })
    const get = (path: string, who = org.owner, organizationId = org.organizationId) =>
      api(who, organizationId, 'GET', path)
    return { org, record, get, api, harness }
  }

  test('a redelivered audit.recorded message from the queue writes one row', async () => {
    const { org, harness } = await setup()
    const id = eventId()
    const message = {
      id,
      type: 'audit.recorded' as const,
      version: 1,
      occurredAt: new Date().toISOString(),
      organizationId: org.organizationId,
      traceId: id,
      payload: {
        actor: { kind: 'system' as const },
        action: 'voice.call_started',
        subject: { type: 'call', id: 'call_0123456789abcdef0123456789abcdef' },
      },
    }
    await harness.deps.audit.publish(message)
    await harness.deps.audit.publish(message)
    const signal = new AbortController().signal
    expect(await processAuditMessages(harness.deps, signal)).toBe(2)
    const rows = await withOrganization(service.db, org.organizationId, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from core.audit_events where id = ${id}`
      )
    )
    expect(rows.rows[0]?.n).toBe(1)
    expect(harness.deps.audit.depth()).toEqual({ visible: 0, inFlight: 0 })
  })

  test('a replay writes one row and concurrent writers keep one unbroken chain', async () => {
    const { org, record, get } = await setup()
    const id = eventId()
    expect(await record({ auditEventId: id })).toBe('written')
    expect(await record({ auditEventId: id })).toBe('replayed')
    await Promise.all(Array.from({ length: 8 }, () => record()))
    const verified = await get('/audit-verification')
    expect(verified.body).toEqual({ checked: 9, firstBrokenSequence: null, nextSequence: null })
    const rows = await withOrganization(service.db, org.organizationId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from core.audit_events`)
    )
    expect(rows.rows[0]?.n).toBe(9)
  })

  test('the service role cannot change or remove a row', async () => {
    const { org, record } = await setup()
    await record()
    for (const statement of [
      sql`update core.audit_events set action = 'x.y'`,
      sql`delete from core.audit_events`,
    ]) {
      await expect(
        withOrganization(service.db, org.organizationId, (tx) => tx.execute(statement))
      ).rejects.toThrow()
    }
  })

  test('a row changed by the owner is found by verify', async () => {
    const { org, record, get } = await setup()
    for (let n = 0; n < 3; n += 1) {
      await record()
    }
    await withOrganization(owner.db, org.organizationId, (tx) =>
      tx.execute(
        sql`update core.audit_events set action = 'forged.row'
            where organization_id = ${org.organizationId} and sequence = 2`
      )
    )
    const verified = await get('/audit-verification')
    expect(verified.body).toEqual({ checked: 2, firstBrokenSequence: 2, nextSequence: null })
  })

  test('filters, cursors, csv and Manager visibility work, and another Organization sees nothing', async () => {
    const { org, record, get, api, harness } = await setup()
    const manager = org.members.find((m) => m.role === 'manager')
    const rep = org.members.find((m) => m.role === 'rep')
    if (!manager || !rep) {
      throw new Error('seed')
    }
    const team = await api(org.owner, org.organizationId, 'POST', '/teams', { name: 'North' })
    for (const m of [manager, rep]) {
      await api(org.owner, org.organizationId, 'POST', `/teams/${team.body.id}/members`, {
        membershipId: m.id as MembershipId,
      })
    }
    const mine = (await api(rep, org.organizationId, 'POST', '/prospects', { firstName: 'Ada' }))
      .body.id
    const theirs = (
      await api(org.owner, org.organizationId, 'POST', '/prospects', { firstName: 'Bo' })
    ).body.id
    const subject = { type: 'prospect', id: String(mine) }
    await record({
      action: 'a.mine',
      prospectId: mine,
      subject,
      actor: { kind: 'member', membershipId: rep.id },
      occurredAt: '2026-03-01T00:00:00.000Z',
    })
    await record({ action: 'a.theirs', prospectId: theirs, occurredAt: '2026-03-02T00:00:00.000Z' })
    await record({ action: 'a.none', occurredAt: '2026-03-03T00:00:00.000Z' })
    const actions = async (query: string, who = org.owner) =>
      ((await get(`/audit-events${query}`, who)).body.items as { action: string }[]).map(
        (e) => e.action
      )
    // The Team set-up above is audited too, dated now; this window holds only the rows recorded here.
    const before = 'to=2026-04-01T00:00:00Z'
    expect(await actions('?action=team.created')).toEqual(['team.created'])
    expect(await actions(`?${before}`)).toEqual(['a.none', 'a.theirs', 'a.mine'])
    expect(await actions(`?actorId=${rep.id}`)).toEqual(['a.mine'])
    expect(await actions(`?actorKind=member&${before}`)).toEqual(['a.mine'])
    expect(await actions(`?subjectType=prospect&subjectId=${mine}`)).toEqual(['a.mine'])
    expect(await actions(`?prospectId=${theirs}`)).toEqual(['a.theirs'])
    expect(await actions('?from=2026-03-02T00:00:00Z&to=2026-03-02T12:00:00Z')).toEqual([
      'a.theirs',
    ])
    expect(await actions(`?${before}`, manager)).toEqual(['a.mine'])
    const page = (await get(`/audit-events?limit=2&${before}`)).body as {
      items: unknown[]
      nextCursor: string
    }
    expect(page.items).toHaveLength(2)
    const rest = (await get(`/audit-events?limit=2&${before}&cursor=${page.nextCursor}`)).body as {
      items: { action: string }[]
    }
    expect(rest.items.map((e) => e.action)).toEqual(['a.mine'])

    const csv = await harness.app.request('/v1/audit-csv?limit=2', {
      headers: await harness.bearer({
        userId: org.owner.userId,
        organizationId: org.organizationId,
        role: 'owner',
      }),
    })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('x-next-cursor')).not.toBeNull()
    expect(await actions('?action=audit.exported')).toEqual(['audit.exported'])

    const other = await seedOrganization(store, [])
    expect((await get('/audit-events', other.owner, other.organizationId)).body.items).toEqual([])
    expect((await get('/audit-verification', other.owner, other.organizationId)).body).toEqual({
      checked: 0,
      firstBrokenSequence: null,
      nextSequence: null,
    })
  })
  test('two concurrent adds of the same member to a Team record one team.member_added', async () => {
    const { org, api, get } = await setup()
    const rep = org.members[3]
    const team = (await api(org.owner, org.organizationId, 'POST', '/teams', { name: 'Race' })).body
      .id as string
    const adds = await Promise.all(
      [0, 1].map(() =>
        api(org.owner, org.organizationId, 'POST', `/teams/${team}/members`, {
          membershipId: rep?.id,
        })
      )
    )
    expect(adds.map((r) => r.status)).toEqual([200, 200])
    const added = (await get('/audit-events?action=team.member_added')).body.items as unknown[]
    expect(added).toHaveLength(1)
  })
})

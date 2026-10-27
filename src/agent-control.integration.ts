import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Role } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness as makeHarness, owner, store } from '~/integration-harness'
import { publicCaller, type SeededMember, seedOrganization } from '~/testing'

const WINDOW = {
  timeZone: 'Europe/Paris',
  days: [{ day: 'mon', windows: [{ start: '09:00', end: '17:00' }] }],
}

describe('Agent controls, over Postgres', () => {
  test('settings and the pause switch are stored per Organization and audited once', async () => {
    const harness = await makeHarness()
    const org = await seedOrganization(store, ['admin', 'manager'])
    const other = await seedOrganization(store, ['admin'], 'Other')
    const api = publicCaller(harness)
    const by = (role: Role) => org.members.find((m) => m.role === role) as SeededMember
    const admin = by('admin')
    const put = (path: string, body: unknown) =>
      api(admin, org.organizationId, 'PUT', path, body, {
        'idempotency-key': `key-${crypto.randomUUID()}`,
      })

    const first = await put('/agent-controls/inbound/email', {
      level: 'assisted',
      sendWindow: WINDOW,
      escalationRules: [],
    })
    expect(first.status).toBe(200)
    await put('/agent-controls/inbound/email', {
      level: 'autonomous',
      sendWindow: WINDOW,
      escalationRules: [],
    })
    await put('/agent-controls/inbound/default', {
      level: 'supervised',
      sendWindow: WINDOW,
      escalationRules: [],
    })
    expect((await put('/agent-controls/organization-pause', { paused: true })).status).toBe(200)

    const list = await api(by('manager'), org.organizationId, 'GET', '/agent-controls')
    const items = (list.body as { items: { channel: string | null; level: string }[] }).items
    expect(items.map((i) => [i.channel, i.level])).toEqual([
      [null, 'supervised'],
      ['email', 'autonomous'],
    ])
    const paused = await api(admin, org.organizationId, 'GET', '/agent-controls/organization-pause')
    expect(paused.body).toMatchObject({ paused: true, updatedByMembershipId: admin.id })

    const policy = await api(admin, org.organizationId, 'GET', '/approval-policies')
    expect(JSON.stringify(policy.body)).toContain('except')

    const otherAdmin = other.members.find((m) => m.role === 'admin') as SeededMember
    const theirs = await api(otherAdmin, other.organizationId, 'GET', '/agent-controls')
    expect((theirs.body as { items: unknown[] }).items).toEqual([])
    const theirPause = await api(
      otherAdmin,
      other.organizationId,
      'GET',
      '/agent-controls/organization-pause'
    )
    expect(theirPause.body).toMatchObject({ paused: false })

    const events = await api(org.owner, org.organizationId, 'GET', '/audit-events?limit=100')
    const actions = (events.body as { items: { action: string }[] }).items.map((e) => e.action)
    expect(actions.filter((a) => a === 'agent_settings.changed')).toHaveLength(3)
    expect(actions.filter((a) => a === 'agents.paused')).toHaveLength(1)
  })

  test('a stored send window from before the 08:00 to 21:00 cap reads back clamped', async () => {
    const harness = await makeHarness()
    const org = await seedOrganization(store, ['admin'])
    const api = publicCaller(harness)
    const admin = org.members.find((m) => m.role === 'admin') as SeededMember
    const saved = await api(
      admin,
      org.organizationId,
      'PUT',
      '/agent-controls/inbound/email',
      { level: 'assisted', sendWindow: WINDOW, escalationRules: [] },
      { 'idempotency-key': `key-${crypto.randomUUID()}` }
    )
    expect(saved.status).toBe(200)
    const old = {
      timeZone: 'Europe/Paris',
      days: [
        {
          day: 'mon',
          windows: [
            { start: '06:00', end: '17:00' },
            { start: '22:00', end: '23:00' },
          ],
        },
        { day: 'tue', windows: [{ start: '05:00', end: '07:00' }] },
      ],
    }
    await withOrganization(owner.db, org.organizationId, (tx) =>
      tx.execute(sql`
        update core.agent_settings set send_window = ${JSON.stringify(old)}::jsonb
        where organization_id = ${org.organizationId} and agent_kind = 'inbound'
      `)
    )

    const read = await api(admin, org.organizationId, 'GET', '/agent-controls')
    expect(read.status).toBe(200)
    const items = (read.body as { items: { sendWindow: unknown }[] }).items
    expect(items[0]?.sendWindow).toEqual({
      timeZone: 'Europe/Paris',
      days: [{ day: 'mon', windows: [{ start: '08:00', end: '17:00' }] }],
    })
  })
})

import { describe, expect, test } from 'bun:test'
import type { Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  publicCaller,
  type SeededMember,
  type SeededOrganization,
  seedOrganization,
} from '~/testing'
import * as Crm from '../crm/service'
import * as Audit from './service'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(memory, ['admin'], 'Other')
  const byRole = (org: SeededOrganization, role: Role) =>
    org.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (actor: SeededMember, method: string, path: string, body?: unknown) =>
    api(actor, seeded.organizationId, method, path, body)
  /** The audit log as the Organization's Owner reads it, oldest first. */
  const events = async (org: SeededOrganization = seeded) => {
    const page = await Audit.list(
      harness.deps,
      { organizationId: org.organizationId, userId: org.owner.userId, role: 'owner' },
      { limit: 100 }
    )
    return page.items.toReversed()
  }
  return { memory, harness, seeded, other, byRole, call, events }
}

describe('audit wiring: members', () => {
  test('a role change is recorded with who did it and the roles', async () => {
    const { seeded, byRole, call, events } = await setup()
    const rep = byRole(seeded, 'rep')
    const { status } = await call(seeded.owner, 'PATCH', `/members/${rep.id}`, { role: 'manager' })
    expect(status).toBe(200)
    const [event] = await events()
    expect(event?.action).toBe('member.role_changed')
    expect(event?.actor).toEqual({ kind: 'member', membershipId: seeded.owner.id })
    expect(event?.subject).toEqual({ type: 'membership', id: rep.id })
    expect(event?.metadata).toEqual({ fromRole: 'rep', toRole: 'manager' })
  })

  test('a refused or unchanged role change records nothing', async () => {
    const { seeded, byRole, call, events } = await setup()
    const rep = byRole(seeded, 'rep')
    await call(byRole(seeded, 'manager'), 'PATCH', `/members/${rep.id}`, { role: 'admin' })
    await call(seeded.owner, 'PATCH', `/members/${rep.id}`, { role: 'rep' })
    expect(await events()).toHaveLength(0)
  })

  test('removing a member is recorded', async () => {
    const { seeded, byRole, call, events } = await setup()
    const rep = byRole(seeded, 'rep')
    expect((await call(seeded.owner, 'DELETE', `/members/${rep.id}`)).status).toBe(204)
    const [event] = await events()
    expect(event?.action).toBe('member.removed')
    expect(event?.subject).toEqual({ type: 'membership', id: rep.id })
    expect(event?.metadata).toEqual({ role: 'rep' })
  })
})

describe('audit wiring: invitations', () => {
  test('creating and revoking an Invitation are recorded, without the address', async () => {
    const { seeded, call, events } = await setup()
    const created = await call(seeded.owner, 'POST', '/invitations', {
      email: 'new.person@example.test',
      role: 'rep',
    })
    expect(created.status).toBe(201)
    const id = created.body.id as string
    expect((await call(seeded.owner, 'DELETE', `/invitations/${id}`)).status).toBe(204)
    const log = await events()
    expect(log.map((e) => e.action)).toEqual(['invitation.created', 'invitation.revoked'])
    expect(log[0]?.subject).toEqual({ type: 'invitation', id })
    expect(log[0]?.metadata).toEqual({ role: 'rep' })
    expect(JSON.stringify(log)).not.toContain('new.person')
  })
})

describe('audit wiring: integrations', () => {
  test('connecting and disconnecting a CRM are recorded', async () => {
    const { harness, seeded, events } = await setup()
    harness.deps.hubspot.acceptCode('code-1', {
      accessToken: 'a-token-value-1',
      refreshToken: 'r-token-value-2',
      accessTokenExpiresAt: new Date('2026-01-01T01:00:00Z'),
      externalAccountId: '12345',
      accountLabel: 'Acme Sales',
      scopeLevel: 'read',
    })
    await Crm.connect(
      harness.deps,
      { organizationId: seeded.organizationId, userId: seeded.owner.userId, role: 'owner' },
      { provider: 'hubspot', code: 'code-1', redirectUri: 'https://core.test/cb' },
      { traceId: 'trace-1' }
    )
    const gone = await publicCaller(harness)(
      seeded.owner,
      seeded.organizationId,
      'DELETE',
      '/crm/connections/hubspot',
      undefined,
      { 'idempotency-key': crypto.randomUUID() }
    )
    expect(gone.status).toBe(204)
    const log = await events()
    expect(log.map((e) => e.action)).toEqual(['crm.connected', 'crm.disconnected'])
    expect(log[0]?.metadata).toEqual({ provider: 'hubspot' })
    expect(JSON.stringify(log)).not.toContain('token-value')
  })
})

describe('audit wiring: isolation', () => {
  test('a second Organization cannot see the first one’s events', async () => {
    const { seeded, other, byRole, call, harness, events } = await setup()
    await call(seeded.owner, 'DELETE', `/members/${byRole(seeded, 'rep').id}`)
    expect(await events()).toHaveLength(1)
    expect(await events(other)).toHaveLength(0)
    const api = publicCaller(harness)
    const listed = await api(other.owner, other.organizationId, 'GET', '/audit-events')
    expect((listed.body as { items: unknown[] }).items).toHaveLength(0)
  })
})

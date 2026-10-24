import { describe, expect, test } from 'bun:test'
import type { OrganizationId, Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'

type Version = {
  id: string
  number: number
  state: string
  text: string
  publishedAt: string | null
}

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(memory, ['admin'], 'Other')
  const by = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    organizationId: OrganizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const key = () => ({ 'idempotency-key': `key-${crypto.randomUUID()}` })
  const save = (text: string, kind = 'inbound', actor: SeededMember = by('admin')) =>
    call(actor, 'POST', `/agent-instructions/${kind}/versions`, { text }, key())
  const publish = (number: number, kind = 'inbound', actor: SeededMember = by('admin')) =>
    call(actor, 'POST', `/agent-instructions/${kind}/versions/${number}/publish`, undefined, key())
  const published = (kind = 'inbound', actor: SeededMember = by('manager')) =>
    call(actor, 'GET', `/agent-instructions/${kind}/published`)
  const internal = async (
    organizationId: OrganizationId,
    agentKind = 'inbound',
    headers?: Record<string, string>
  ) => {
    const response = await harness.app.request('/internal/v1/agent-instructions/published', {
      method: 'POST',
      headers: headers ?? harness.internal(),
      body: JSON.stringify({ organizationId, agentKind }),
    })
    return {
      status: response.status,
      body: (await response.json()) as { agentKind?: string; version?: Version | null },
    }
  }
  const auditActions = async () => {
    const page = await call(seeded.owner, 'GET', '/audit-events?limit=100')
    return (page.body.items as { action: string; instructionVersion: number | null }[]).map(
      (e) => `${e.action}:${e.instructionVersion}`
    )
  }
  return {
    memory,
    harness,
    seeded,
    other,
    by,
    call,
    save,
    publish,
    published,
    internal,
    auditActions,
    key,
  }
}

describe('save', () => {
  test('Admin and Owner save a draft version numbered from 1', async () => {
    const t = await setup()
    const first = await t.save('Be brief.')
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({
      number: 1,
      state: 'draft',
      text: 'Be brief.',
      publishedAt: null,
    })
    const second = await t.save('Be kind.', 'inbound', t.seeded.owner)
    expect(second.body.number).toBe(2)
    expect((await t.save('Outbound text', 'outbound')).body.number).toBe(1)
  })

  test('Manager and Rep cannot save', async () => {
    const t = await setup()
    for (const role of ['manager', 'rep'] as const) {
      const response = await t.save('x', 'inbound', t.by(role))
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('auth.forbidden')
    }
  })

  test('text over 20,000 characters is agent.instruction_too_long, exactly 20,000 is saved', async () => {
    const t = await setup()
    const over = await t.save('a'.repeat(20001))
    expect(over.status).toBe(422)
    expect(over.body.error?.code).toBe('agent.instruction_too_long')
    expect((await t.save('a'.repeat(20000))).status).toBe(201)
  })

  test('the same Idempotency-Key saves once and answers 200 the second time', async () => {
    const t = await setup()
    const headers = t.key()
    const path = '/agent-instructions/inbound/versions'
    const a = await t.call(t.by('admin'), 'POST', path, { text: 'once' }, headers)
    const b = await t.call(t.by('admin'), 'POST', path, { text: 'once' }, headers)
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.body).toEqual(a.body)
    const list = await t.call(t.by('admin'), 'GET', '/agent-instructions/inbound/versions')
    expect((list.body.items as unknown[]).length).toBe(1)
  })

  test('a retry with the same key and a very long text still saves once', async () => {
    const t = await setup()
    const headers = t.key()
    const path = '/agent-instructions/inbound/versions'
    const text = 'x'.repeat(19000)
    const a = await t.call(t.by('admin'), 'POST', path, { text }, headers)
    const b = await t.call(t.by('admin'), 'POST', path, { text }, headers)
    expect([a.status, b.status, b.body.number]).toEqual([201, 200, 1])
    expect(b.body.text).toBe(text)
    const list = await t.call(t.by('admin'), 'GET', path)
    expect((list.body.items as unknown[]).length).toBe(1)
  })

  test('a missing Idempotency-Key is refused', async () => {
    const t = await setup()
    const response = await t.call(t.by('admin'), 'POST', '/agent-instructions/inbound/versions', {
      text: 'x',
    })
    expect(response.status).toBe(400)
  })

  test('an empty text and an unknown Agent kind are refused', async () => {
    const t = await setup()
    expect((await t.save('')).status).toBe(400)
    expect((await t.save('x', 'copilot')).status).toBe(400)
  })
})

describe('publish and rollback', () => {
  test('publishing points the Agent at the version; a rollback re-points it, audited', async () => {
    const t = await setup()
    await t.save('v1 text')
    await t.save('v2 text')
    const one = await t.publish(1)
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ number: 1, state: 'published' })
    expect((await t.published()).body.version).toMatchObject({ number: 1, text: 'v1 text' })
    await t.publish(2)
    expect((await t.published()).body.version).toMatchObject({ number: 2 })
    await t.publish(1)
    expect((await t.published()).body.version).toMatchObject({ number: 1, text: 'v1 text' })
    const list = await t.call(t.by('manager'), 'GET', '/agent-instructions/inbound/versions')
    const items = list.body.items as Version[]
    expect(items.map((v) => [v.number, v.state])).toEqual([
      [2, 'draft'],
      [1, 'published'],
    ])
    const actions = await t.auditActions()
    expect(actions).toContain('agent_instructions.saved:1')
    expect(actions).toContain('agent_instructions.saved:2')
    expect(actions.filter((a) => a.startsWith('agent_instructions.published'))).toHaveLength(3)
  })

  test('republishing the published version changes nothing and records nothing', async () => {
    const t = await setup()
    await t.save('v1')
    await t.publish(1)
    const before = (await t.auditActions()).length
    const again = await t.publish(1)
    expect(again.status).toBe(200)
    expect((await t.auditActions()).length).toBe(before)
  })

  test('an unknown version is agent.version_not_found', async () => {
    const t = await setup()
    const response = await t.publish(7)
    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe('agent.version_not_found')
    const read = await t.call(t.by('admin'), 'GET', '/agent-instructions/inbound/versions/7')
    expect(read.body.error?.code).toBe('agent.version_not_found')
  })

  test('Manager cannot publish; Agent kinds are published independently', async () => {
    const t = await setup()
    await t.save('in')
    await t.save('out', 'outbound')
    expect((await t.publish(1, 'inbound', t.by('manager'))).status).toBe(403)
    await t.publish(1, 'outbound')
    expect((await t.published('inbound')).body.version).toBeNull()
    expect((await t.published('outbound')).body.version).toMatchObject({ text: 'out' })
  })
})

describe('read', () => {
  test('Manager reads; Rep does not', async () => {
    const t = await setup()
    await t.save('x')
    expect((await t.published('inbound', t.by('manager'))).status).toBe(200)
    expect((await t.published('inbound', t.by('rep'))).status).toBe(403)
    const list = await t.call(t.by('rep'), 'GET', '/agent-instructions/inbound/versions')
    expect(list.status).toBe(403)
  })

  test('the list is newest first, cursor paged and has no text', async () => {
    const t = await setup()
    for (const n of [1, 2, 3, 4, 5]) {
      await t.save(`text ${n}`)
    }
    const first = await t.call(t.by('admin'), 'GET', '/agent-instructions/inbound/versions?limit=2')
    expect((first.body.items as Version[]).map((v) => v.number)).toEqual([5, 4])
    expect((first.body.items as Record<string, unknown>[])[0]).toMatchObject({ length: 6 })
    expect((first.body.items as Record<string, unknown>[])[0]).not.toHaveProperty('text')
    const next = await t.call(
      t.by('admin'),
      'GET',
      `/agent-instructions/inbound/versions?limit=2&cursor=${first.body.nextCursor}`
    )
    expect((next.body.items as Version[]).map((v) => v.number)).toEqual([3, 2])
    const last = await t.call(
      t.by('admin'),
      'GET',
      `/agent-instructions/inbound/versions?limit=2&cursor=${next.body.nextCursor}`
    )
    expect((last.body.items as Version[]).map((v) => v.number)).toEqual([1])
    expect(last.body.nextCursor).toBeNull()
    const bad = await t.call(
      t.by('admin'),
      'GET',
      '/agent-instructions/inbound/versions?cursor=nope'
    )
    expect(bad.status).toBe(400)
    const big = await t.call(t.by('admin'), 'GET', '/agent-instructions/inbound/versions?limit=101')
    expect(big.status).toBe(400)
  })

  test('diff shows added and removed lines between two versions', async () => {
    const t = await setup()
    await t.save('keep\nold')
    await t.save('keep\nnew')
    const diff = await t.call(
      t.by('manager'),
      'GET',
      '/agent-instructions/inbound/diff?from=1&to=2'
    )
    expect(diff.status).toBe(200)
    expect(diff.body).toMatchObject({
      agentKind: 'inbound',
      from: 1,
      to: 2,
      lines: [
        { kind: 'same', text: 'keep' },
        { kind: 'removed', text: 'old' },
        { kind: 'added', text: 'new' },
      ],
    })
    const missing = await t.call(
      t.by('manager'),
      'GET',
      '/agent-instructions/inbound/diff?from=1&to=9'
    )
    expect(missing.body.error?.code).toBe('agent.version_not_found')
  })
})

describe('Organization isolation', () => {
  test("a second Organization cannot read or publish the first one's versions", async () => {
    const t = await setup()
    await t.save('secret playbook tone')
    await t.publish(1)
    const intruder = t.other.members.find((m) => m.role === 'admin') as SeededMember
    const inOther = (method: string, path: string, body?: unknown) =>
      t.call(intruder, method, path, body, t.key(), t.other.organizationId)
    const list = await inOther('GET', '/agent-instructions/inbound/versions')
    expect(list.body.items).toEqual([])
    expect((await inOther('GET', '/agent-instructions/inbound/versions/1')).status).toBe(404)
    expect((await inOther('GET', '/agent-instructions/inbound/published')).body.version).toBeNull()
    const publish = await inOther('POST', '/agent-instructions/inbound/versions/1/publish')
    expect(publish.status).toBe(404)
    expect((await t.published()).body.version).toMatchObject({ text: 'secret playbook tone' })
  })
})

describe('internal published route', () => {
  test('answers the published text and number for one Organization', async () => {
    const t = await setup()
    await t.save('say hello')
    await t.publish(1)
    const answer = await t.internal(t.seeded.organizationId)
    expect(answer.status).toBe(200)
    expect(answer.body.agentKind).toBe('inbound')
    expect(answer.body.version).toMatchObject({ number: 1, text: 'say hello', state: 'published' })
    expect((await t.internal(t.seeded.organizationId, 'outbound')).body.version).toBeNull()
    expect((await t.internal(t.other.organizationId)).body.version).toBeNull()
  })

  test('answers version: null for a suspended, deleted or unknown Organization', async () => {
    const t = await setup()
    await t.save('say hello')
    await t.publish(1)
    for (const status of ['suspended', 'deleted'] as const) {
      t.memory.setOrganizationStatus(t.seeded.organizationId, status)
      const answer = await t.internal(t.seeded.organizationId)
      expect([answer.status, answer.body.version]).toEqual([200, null])
    }
    t.memory.setOrganizationStatus(t.seeded.organizationId, 'active')
    expect((await t.internal(t.seeded.organizationId)).body.version).not.toBeNull()
    const unknown = await t.internal('org_00000000000000000000000000000000' as OrganizationId)
    expect(unknown.body.version).toBeNull()
  })

  test('needs the internal secret', async () => {
    const t = await setup()
    const response = await t.internal(t.seeded.organizationId, 'inbound', {
      'content-type': 'application/json',
    })
    expect(response.status).toBe(401)
    const wrong = await t.internal(
      t.seeded.organizationId,
      'inbound',
      t.harness.internal('k', 'wrong-secret')
    )
    expect(wrong.status).toBe(401)
  })
})

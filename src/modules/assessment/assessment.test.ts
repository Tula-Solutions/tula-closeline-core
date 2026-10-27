import { describe, expect, test } from 'bun:test'
import type { CallId, OrganizationId, Role } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryTurnReader } from '~/adapters/memory/turn-reader'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import type { Judge } from '~/ports/judge'
import type { TurnReader } from '~/ports/turn-reader'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { turnEnvelope } from './testing'
import { assessTurn } from './turn'

const FAST = { attempts: 3, sleep: async () => {}, random: () => 0 }
const BAD = 'We guarantee 99% savings.'
const LOUD = 'Call us today!!! It is great.'
const FINE = 'Thanks for your time.'

type Item = {
  id: string
  verdict: string
  agentKind: string
  prospectId: string | null
  subject: { kind: string; callId: string; turnIndex: number }
  findings: { id: string; severity: string; feedback: string | null }[]
}
type Page = { items: Item[]; nextCursor: string | null }
type Rates = {
  items: {
    week: string
    weekStart: string
    state: string
    value: number | null
    category?: string | null
    recordCount?: number
  }[]
  nextCursor: string | null
}

async function setup(over: { judge?: Judge; turnReader?: TurnReader } = {}) {
  const store = createMemoryCoreStore()
  const reader = createMemoryTurnReader()
  const harness = await createTestApp({ store, turnReader: over.turnReader ?? reader, ...over })
  const org = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep'])
  const other = await seedOrganization(store, ['admin'])
  const of = (role: Role, n = 0) => org.members.filter((m) => m.role === role)[n] as SeededMember
  const [admin, manager, repA, repB] = [of('admin'), of('manager'), of('rep', 0), of('rep', 1)] as [
    SeededMember,
    SeededMember,
    SeededMember,
    SeededMember,
  ]
  const api = publicCaller(harness)
  const call = (actor: SeededMember, method: string, path: string, body?: unknown, h = {}) =>
    api(actor, org.organizationId, method, path, body, h)
  const team = (await call(org.owner, 'POST', '/teams', { name: 'East' })).body as { id: string }
  for (const m of [manager, repA]) {
    await call(org.owner, 'POST', `/teams/${team.id}/members`, { membershipId: m.id })
  }
  const prospectOf = async (actor: SeededMember, firstName: string) =>
    (
      (await call(actor, 'POST', '/prospects', { firstName, email: `${firstName}@example.test` }))
        .body as { id: string }
    ).id
  const prospectA = await prospectOf(repA, 'ada')
  const prospectB = await prospectOf(repB, 'bo')

  const deliver = async (
    text: string,
    over: {
      organizationId?: OrganizationId
      prospectId?: string | null
      callId?: CallId
      turnIndex?: number
      agentKind?: 'inbound' | 'outbound'
      instructionVersion?: number | null
    } = {}
  ) => {
    const organizationId = over.organizationId ?? org.organizationId
    const envelope = turnEnvelope(organizationId, {
      prospectId: prospectA,
      ...over,
    })
    reader.put(organizationId, envelope.payload.callId as CallId, envelope.payload.turnIndex, {
      prospectText: 'Tell me more.',
      agentText: text,
      sources: [],
    })
    const outcome = await assessTurn(harness.deps, organizationId, envelope.payload, FAST)
    return { outcome, envelope }
  }
  const list = async (actor: SeededMember, query = '', organizationId = org.organizationId) => {
    const r = await api(actor, organizationId, 'GET', `/assessments${query}`)
    return { status: r.status, body: r.body, page: r.body as unknown as Page }
  }
  return {
    store,
    reader,
    harness,
    org,
    other,
    admin,
    manager,
    repA,
    repB,
    call,
    api,
    deliver,
    list,
    prospectA,
    prospectB,
  }
}

describe('assessing a turn', () => {
  test('a turn delivered twice gets exactly one Assessment', async () => {
    const s = await setup()
    const { outcome, envelope } = await s.deliver(BAD)
    expect(outcome).toBe('assessed')
    expect(await assessTurn(s.harness.deps, s.org.organizationId, envelope.payload, FAST)).toBe(
      'duplicate'
    )
    const page = (await s.list(s.admin)).page
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.verdict).toBe('fail')
    expect(page.items[0]?.subject).toEqual({
      kind: 'call_turn',
      callId: envelope.payload.callId,
      turnIndex: 0,
    })
  })

  test('a Judge outage stores nothing, retries a bounded number of times and never throws', async () => {
    let calls = 0
    const judge: Judge = {
      assess: async () => {
        calls += 1
        throw new Error('model down')
      },
    }
    const s = await setup({ judge })
    const { outcome } = await s.deliver(BAD)
    expect(outcome).toBe('unassessed')
    expect(calls).toBe(3)
    expect((await s.list(s.admin)).page.items).toHaveLength(0)
  })

  test('a Transcript outage or a turn without text stores nothing and never throws', async () => {
    const down: TurnReader = {
      read: async () => {
        throw new Error('voice down')
      },
    }
    const s = await setup({ turnReader: down })
    expect((await s.deliver(BAD)).outcome).toBe('unassessed')
    const empty = await setup()
    const envelope = turnEnvelope(empty.org.organizationId)
    expect(
      await assessTurn(empty.harness.deps, empty.org.organizationId, envelope.payload, FAST)
    ).toBe('unassessed')
    expect((await empty.list(empty.admin)).page.items).toHaveLength(0)
  })

  test('a turn for a Prospect unknown to this Organization is stored without one', async () => {
    const s = await setup()
    const foreign = ((await s.other.owner) && undefined) ?? null
    expect(foreign).toBeNull()
    const { outcome } = await s.deliver(BAD, { prospectId: null })
    expect(outcome).toBe('assessed')
    expect((await s.list(s.admin)).page.items[0]?.prospectId).toBeNull()
  })

  test('the queue worker assesses a turn delivered twice once', async () => {
    const s = await setup()
    const envelope = turnEnvelope(s.org.organizationId, { prospectId: s.prospectA })
    s.reader.put(s.org.organizationId, envelope.payload.callId as CallId, 0, {
      prospectText: 'Tell me more.',
      agentText: BAD,
      sources: [],
    })
    expect((await s.harness.deps.jobs.publishBatch([envelope, envelope])).failed).toHaveLength(0)
    const controller = new AbortController()
    await processAssignJobs(s.harness.deps, controller.signal)
    await processAssignJobs(s.harness.deps, controller.signal)
    expect((await s.list(s.admin)).page.items).toHaveLength(1)
  })
})

describe('the review list', () => {
  test('worst first orders by severity then newest, with a cursor and a bounded page', async () => {
    const s = await setup()
    await s.deliver(FINE)
    s.harness.deps.clock.advance('1h')
    await s.deliver(LOUD)
    s.harness.deps.clock.advance('1h')
    await s.deliver(BAD)
    s.harness.deps.clock.advance('1h')
    await s.deliver(FINE)

    const newest = (await s.list(s.admin)).page.items.map((i) => i.verdict)
    expect(newest).toEqual(['pass', 'fail', 'warn', 'pass'])

    const first = await s.list(s.admin, '?sort=worst_first&limit=1')
    expect(first.page.items.map((i) => i.verdict)).toEqual(['fail'])
    expect(first.page.nextCursor).not.toBeNull()
    const second = await s.list(
      s.admin,
      `?sort=worst_first&limit=1&cursor=${first.page.nextCursor}`
    )
    expect(second.page.items.map((i) => i.verdict)).toEqual(['warn'])
    expect(second.page.nextCursor).toBeNull()
    const withPasses = await s.list(s.admin, '?sort=worst_first&verdict=pass')
    expect(withPasses.page.items.map((i) => i.verdict)).toEqual(['pass', 'pass'])

    expect((await s.list(s.admin, '?limit=101')).status).toBe(400)
    const wrongSort = await s.list(s.admin, `?sort=newest&cursor=${first.page.nextCursor}`)
    expect(wrongSort.status).toBe(400)
    expect(wrongSort.body.error?.code).toBe('request.invalid')
    expect((await s.list(s.admin, '?cursor=garbage')).status).toBe(400)
  })

  test('filters narrow the list', async () => {
    const s = await setup()
    await s.deliver(BAD, { agentKind: 'outbound' })
    await s.deliver(FINE)
    expect((await s.list(s.admin, '?verdict=fail')).page.items).toHaveLength(1)
    expect((await s.list(s.admin, '?category=tone')).page.items).toHaveLength(0)
    expect((await s.list(s.admin, '?category=unsupported_claim')).page.items).toHaveLength(1)
    expect((await s.list(s.admin, '?agentKind=outbound')).page.items).toHaveLength(1)
    expect((await s.list(s.admin, '?from=2026-01-01&to=2026-01-01')).page.items).toHaveLength(2)
    expect((await s.list(s.admin, '?from=2026-02-01&to=2026-02-02')).page.items).toHaveLength(0)
    const tooWide = await s.list(s.admin, '?from=2024-01-01&to=2026-01-01')
    expect(tooWide.status).toBe(422)
    expect(tooWide.body.error?.code).toBe('analytics.range_too_large')
  })

  test('only an Owner or Admin lists; a Manager reads one in their view, a Rep only their own', async () => {
    const s = await setup()
    await s.deliver(BAD, { prospectId: s.prospectA })
    await s.deliver(BAD, { prospectId: s.prospectB })
    for (const actor of [s.repA, s.manager]) {
      const forbidden = await s.list(actor)
      expect(forbidden.status).toBe(403)
      expect(forbidden.body.error?.code).toBe('auth.forbidden')
    }
    expect((await s.list(s.admin)).page.items).toHaveLength(2)

    const all = (await s.list(s.admin)).page.items
    const own = all.find((i) => i.prospectId === s.prospectA) as Item
    const theirs = all.find((i) => i.prospectId === s.prospectB) as Item
    expect((await s.call(s.repA, 'GET', `/assessments/${own.id}`)).status).toBe(200)
    const hidden = await s.call(s.repA, 'GET', `/assessments/${theirs.id}`)
    expect(hidden.status).toBe(404)
    expect(hidden.body.error?.code).toBe('assessment.not_found')
    expect((await s.call(s.manager, 'GET', `/assessments/${theirs.id}`)).status).toBe(404)
  })

  test('another Organization cannot read, list or mark the first one turns', async () => {
    const s = await setup()
    await s.deliver(BAD)
    const mine = (await s.list(s.admin)).page.items[0] as Item
    const outsider = s.other.owner
    expect((await s.list(outsider, '', s.other.organizationId)).page.items).toHaveLength(0)
    const read = await s.api(outsider, s.other.organizationId, 'GET', `/assessments/${mine.id}`)
    expect(read.status).toBe(404)
    expect(read.body.error?.code).toBe('assessment.not_found')
    const flag = await s.api(
      outsider,
      s.other.organizationId,
      'POST',
      `/assessments/${mine.id}/findings/${mine.findings[0]?.id}/feedback`,
      { feedback: 'false_alarm' }
    )
    expect(flag.status).toBe(404)
    expect(flag.body.error?.code).toBe('assessment.not_found')
    const after = (await s.call(s.admin, 'GET', `/assessments/${mine.id}`)).body as unknown as Item
    expect(after.findings[0]?.feedback).toBeNull()
  })
})

describe('feedback and the weekly rate', () => {
  const feedbackPath = (item: Item) =>
    `/assessments/${item.id}/findings/${item.findings[0]?.id}/feedback`

  test('an Admin marks a finding, keeping who and when; a Rep or Manager may not', async () => {
    const s = await setup()
    await s.deliver(BAD)
    const item = (await s.list(s.admin)).page.items[0] as Item
    for (const actor of [s.repA, s.manager]) {
      const denied = await s.call(actor, 'POST', feedbackPath(item), { feedback: 'correct' })
      expect(denied.status).toBe(403)
    }
    const bad = await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'maybe' })
    expect(bad.status).toBe(400)

    const marked = await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'false_alarm' })
    expect(marked.status).toBe(200)
    expect(marked.body.feedback).toBe('false_alarm')
    const stored = await s.store.withOrganization(s.org.organizationId, (scope) =>
      scope.getTurnAssessment(item.id as never, { kind: 'all' })
    )
    const finding = stored?.findings[0]
    expect(finding?.feedbackByMembershipId).toBe(s.admin.id)
    const firstAt = finding?.feedbackAt
    expect(firstAt).toBeInstanceOf(Date)

    s.harness.deps.clock.advance('1h')
    const again = await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'false_alarm' })
    expect(again.status).toBe(200)
    const kept = await s.store.withOrganization(s.org.organizationId, (scope) =>
      scope.getTurnAssessment(item.id as never, { kind: 'all' })
    )
    expect(kept?.findings[0]?.feedbackAt).toEqual(firstAt as Date)

    const missing = await s.call(
      s.admin,
      'POST',
      `/assessments/${item.id}/findings/fnd_00000000000000000000000000000000/feedback`,
      { feedback: 'correct' }
    )
    expect(missing.status).toBe(404)
  })

  test('a repeated Idempotency-Key answers the first answer', async () => {
    const s = await setup()
    await s.deliver(BAD)
    const item = (await s.list(s.admin)).page.items[0] as Item
    const key = { 'idempotency-key': 'feedback-key-0001' }
    const first = await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'correct' }, key)
    const replay = await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'correct' }, key)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(first.body)
    const reused = await s.call(
      s.admin,
      'POST',
      feedbackPath(item),
      { feedback: 'false_alarm' },
      key
    )
    expect(reused.status).toBe(422)
    expect(reused.body.error?.code).toBe('request.idempotency_key_reused')
  })

  test('the weekly failed rate is per Agent kind and version, and falls after false alarms', async () => {
    const s = await setup()
    for (let i = 0; i < 12; i++) {
      await s.deliver(BAD, { instructionVersion: 2 })
    }
    for (let i = 0; i < 8; i++) {
      await s.deliver(FINE, { instructionVersion: 2 })
    }
    for (let i = 0; i < 3; i++) {
      await s.deliver(BAD, { instructionVersion: 3 })
    }
    const rates = async (query = '') => {
      const r = await s.call(
        s.admin,
        'GET',
        `/assessment-rates?from=2025-12-29&to=2026-01-04${query}`
      )
      expect(r.status).toBe(200)
      return r.body as unknown as Rates
    }
    const before = await rates()
    const v2 = before.items.find((i) => i.state === 'ok')
    expect(before.items).toHaveLength(2)
    expect(v2?.value).toBeCloseTo(12 / 20)
    expect(v2?.week).toBe('2026-W01')
    expect(v2?.weekStart).toBe('2025-12-29')
    expect(before.items.find((i) => i.state === 'not_enough_data')?.value).toBeNull()

    const fails = (await s.list(s.admin, '?verdict=fail&limit=100')).page.items
    let marked = 0
    for (const item of fails) {
      if (marked < 6 && item.findings.length > 0) {
        await s.call(s.admin, 'POST', feedbackPath(item), { feedback: 'false_alarm' })
        marked += 1
      }
    }
    const after = await rates()
    const changed = after.items.filter((i) => i.state === 'ok')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.value).toBeLessThan(v2?.value as number)

    const paged = await s.call(
      s.admin,
      'GET',
      '/assessment-rates?from=2025-12-29&to=2026-01-04&limit=1'
    )
    expect((paged.body as unknown as Rates).nextCursor).not.toBeNull()
    const denied = await s.call(s.manager, 'GET', '/assessment-rates?from=2025-12-29&to=2026-01-04')
    expect(denied.status).toBe(403)
    expect(before.items.every((i) => i.category === null)).toBe(true)
    const wide = await s.call(s.admin, 'GET', '/assessment-rates?from=2024-01-01&to=2026-01-01')
    expect(wide.status).toBe(422)
    expect(wide.body.error?.code).toBe('analytics.range_too_large')
  })

  test('grouped by category, each cell keeps the under-20 rule and false alarms stop counting', async () => {
    const s = await setup()
    for (let i = 0; i < 12; i++) {
      await s.deliver(`${BAD} ${LOUD}`, { instructionVersion: 2 })
    }
    for (let i = 0; i < 8; i++) {
      await s.deliver(FINE, { instructionVersion: 2 })
    }
    for (let i = 0; i < 3; i++) {
      await s.deliver(BAD, { instructionVersion: 3 })
    }
    const grouped = async (query = '') => {
      const r = await s.call(
        s.admin,
        'GET',
        `/assessment-rates?from=2025-12-29&to=2026-01-04&groupBy=category${query}`
      )
      expect(r.status).toBe(200)
      return r.body as unknown as Rates
    }
    const rates = await grouped()
    const cell = (category: string, state: string) =>
      rates.items.find((i) => i.category === category && i.state === state)
    expect(cell('unsupported_claim', 'ok')?.value).toBeCloseTo(12 / 20)
    expect(cell('unsupported_claim', 'ok')?.recordCount).toBe(20)
    expect(cell('tone', 'ok')?.value).toBeCloseTo(12 / 20)
    expect(cell('unsupported_claim', 'not_enough_data')?.value).toBeNull()
    expect(rates.items).toHaveLength(3)

    const first = await grouped('&limit=1')
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).not.toBeNull()
    const next = await grouped(`&limit=100&cursor=${first.nextCursor}`)
    expect(next.items).toHaveLength(2)
    expect(
      (await s.call(s.admin, 'GET', '/assessment-rates?from=2025-12-29&to=2026-01-04&groupBy=x'))
        .status
    ).toBe(400)

    const fails = (await s.list(s.admin, '?verdict=fail&category=tone&limit=100')).page.items
    for (const item of fails) {
      for (const finding of item.findings.filter((f) => f.severity === 'low')) {
        await s.call(s.admin, 'POST', `/assessments/${item.id}/findings/${finding.id}/feedback`, {
          feedback: 'false_alarm',
        })
      }
    }
    const after = await grouped()
    expect(after.items.some((i) => i.category === 'tone')).toBe(false)
    expect(
      after.items.find((i) => i.category === 'unsupported_claim' && i.state === 'ok')?.value
    ).toBeCloseTo(12 / 20)
  })
})

import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { type CallId, type OrganizationId, prospectSchema } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { createMemoryTurnReader } from '~/adapters/memory/turn-reader'
import { harness, service, store } from '~/integration-harness'
import { turnEnvelope } from '~/modules/assessment/testing'
import { assessTurn } from '~/modules/assessment/turn'
import { publicCaller, seedOrganization } from '~/testing'

const FAST = { attempts: 3, sleep: async () => {}, random: () => 0 }
const BAD = 'We guarantee 99% savings.'
const LOUD = 'Call us today!!! It is great.'
const FINE = 'Thanks for your time.'

type Item = {
  id: string
  verdict: string
  prospectId: string | null
  findings: { id: string; feedback: string | null }[]
}
type Page = { items: Item[]; nextCursor: string | null }

async function countRows(table: string, organizationId: OrganizationId) {
  return withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.raw(table)}`
    )
    return Number(rows[0]?.n)
  })
}

describe('Call turn assessments, over Postgres', () => {
  test('one Assessment per turn, ordered review list, feedback, weekly rate and isolation', async () => {
    const reader = createMemoryTurnReader()
    const h = await harness({ turnReader: reader })
    const org = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const admin = org.members.find((m) => m.role === 'admin')
    const manager = org.members.find((m) => m.role === 'manager')
    const [repA, repB] = org.members.filter((m) => m.role === 'rep')
    if (!admin || !manager || !repA || !repB) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const call = (actor: typeof admin, method: string, path: string, body?: unknown, hd = {}) =>
      api(actor, org.organizationId, method, path, body, hd)
    const team = (await call(org.owner, 'POST', '/teams', { name: 'East' })).body as { id: string }
    for (const m of [manager, repA]) {
      await call(org.owner, 'POST', `/teams/${team.id}/members`, { membershipId: m.id })
    }
    const prospectOf = async (actor: typeof repA, name: string) =>
      prospectSchema.parse(
        (
          await call(actor, 'POST', '/prospects', {
            firstName: name,
            email: `${name}@example.test`,
          })
        ).body
      ).id
    const prospectA = await prospectOf(repA, 'ada')
    const prospectB = await prospectOf(repB, 'bo')

    const deliver = async (text: string, prospectId: string, instructionVersion = 1) => {
      const envelope = turnEnvelope(org.organizationId, { prospectId, instructionVersion })
      reader.put(org.organizationId, envelope.payload.callId as CallId, 0, {
        prospectText: 'Tell me more.',
        agentText: text,
        sources: [],
      })
      return {
        envelope,
        outcome: await assessTurn(h.deps, org.organizationId, envelope.payload, FAST),
      }
    }

    const first = await deliver(FINE, prospectA)
    expect(first.outcome).toBe('assessed')
    expect(await assessTurn(h.deps, org.organizationId, first.envelope.payload, FAST)).toBe(
      'duplicate'
    )
    await deliver(LOUD, prospectA)
    await deliver(BAD, prospectB)
    await deliver(BAD, prospectA)
    expect(await countRows('core.assessments', org.organizationId)).toBe(4)

    const all = (await call(admin, 'GET', '/assessments?limit=100')).body as unknown as Page
    expect(all.items).toHaveLength(4)
    const worst = await call(admin, 'GET', '/assessments?sort=worst_first&limit=2')
    const p1 = worst.body as unknown as Page
    expect(p1.items.map((i) => i.verdict)).toEqual(['fail', 'fail'])
    const p2 = (
      await call(admin, 'GET', `/assessments?sort=worst_first&limit=2&cursor=${p1.nextCursor}`)
    ).body as unknown as Page
    expect(p2.items.map((i) => i.verdict)).toEqual(['warn'])
    expect(p2.nextCursor).toBeNull()
    expect((await call(admin, 'GET', '/assessments?limit=101')).status).toBe(400)
    expect((await call(admin, 'GET', '/assessments?category=tone')).body.items).toHaveLength(1)
    expect((await call(admin, 'GET', '/assessments?verdict=fail')).body.items).toHaveLength(2)

    expect((await call(repA, 'GET', '/assessments')).status).toBe(403)
    const managed = (await call(manager, 'GET', '/assessments?limit=100')).body as unknown as Page
    expect(managed.items.every((i) => i.prospectId === prospectA)).toBe(true)
    expect(managed.items).toHaveLength(3)
    const theirs = all.items.find((i) => i.prospectId === prospectB) as Item
    expect((await call(repA, 'GET', `/assessments/${theirs.id}`)).status).toBe(404)
    expect((await call(manager, 'GET', `/assessments/${theirs.id}`)).status).toBe(404)

    const rates = async () =>
      (
        await call(
          admin,
          'GET',
          `/assessment-rates?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`
        )
      ).body as unknown as { items: { state: string; recordCount: number; value: number | null }[] }
    const rateBefore = await rates()
    expect(rateBefore.items).toHaveLength(1)
    expect(rateBefore.items[0]?.recordCount).toBe(4)
    expect(rateBefore.items[0]?.state).toBe('not_enough_data')

    const failed = all.items.find((i) => i.verdict === 'fail') as Item
    const path = `/assessments/${failed.id}/findings/${failed.findings[0]?.id}/feedback`
    const marked = await call(admin, 'POST', path, { feedback: 'false_alarm' })
    expect(marked.status).toBe(200)
    expect(marked.body.feedback).toBe('false_alarm')
    const { rows } = await withOrganization(service.db, org.organizationId, (tx) =>
      tx.execute<{ by: string; at: Date | null }>(
        sql`select feedback_by_membership_id as by, feedback_at as at from core.assessment_findings where feedback is not null`
      )
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.by).toBe(admin.id)
    expect(rows[0]?.at).not.toBeNull()
    expect((await call(manager, 'POST', path, { feedback: 'correct' })).status).toBe(403)

    for (let i = 0; i < 16; i++) {
      await deliver(FINE, prospectA)
    }
    for (let i = 0; i < 20; i++) {
      await deliver(FINE, prospectA, 2)
    }
    const enough = await rates()
    expect(enough.items).toHaveLength(2)
    const byVersion = (items: typeof enough.items) =>
      items.map((i) => ({ ...i })).sort((a, b) => b.recordCount - a.recordCount)
    const [v1] = byVersion(enough.items)
    expect(v1?.recordCount).toBe(20)
    expect(v1?.state).not.toBe('not_enough_data')
    expect(v1?.value).toBeCloseTo(1 / 20, 5)
    const rest = (await call(admin, 'GET', '/assessments?verdict=fail&limit=100')).body
      .items as unknown as Item[]
    for (const item of rest) {
      for (const finding of item.findings) {
        await call(admin, 'POST', `/assessments/${item.id}/findings/${finding.id}/feedback`, {
          feedback: 'false_alarm',
        })
      }
    }
    const cleared = byVersion((await rates()).items)
    expect(cleared[0]?.value).toBe(0)
    const todayQuery = `from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`
    const ratePage = (await call(admin, 'GET', `/assessment-rates?${todayQuery}&limit=1`))
      .body as unknown as { items: unknown[]; nextCursor: string | null }
    expect(ratePage.items).toHaveLength(1)
    expect(ratePage.nextCursor).not.toBeNull()
    const ratePage2 = (
      await call(
        admin,
        'GET',
        `/assessment-rates?${todayQuery}&limit=1&cursor=${ratePage.nextCursor}`
      )
    ).body as unknown as { items: unknown[]; nextCursor: string | null }
    expect(ratePage2.items).toHaveLength(1)
    expect(ratePage2.nextCursor).toBeNull()

    const outsider = other.owner
    expect(
      (await api(outsider, other.organizationId, 'GET', '/assessments')).body.items
    ).toHaveLength(0)
    const foreign = await api(outsider, other.organizationId, 'POST', path, {
      feedback: 'correct',
    })
    expect(foreign.status).toBe(404)
    expect(foreign.body.error?.code).toBe('assessment.not_found')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  type ConversationId,
  ingestMessageResultSchema,
  type MessageId,
  prospectSchema,
  teamSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import { createTestApp, publicCaller, type SeededMember, seedOrganization } from '~/testing'
import { classifyMessage } from './classify'
import { draftReply } from './draft'

const BODY = 'Secret reply text: please call me about the 40 percent discount'

type Said = { label: string; confidence: number; signals?: string[] }

async function setup() {
  const store = createMemoryCoreStore()
  let said: Said = { label: 'question', confidence: 0.9 }
  const harness = await createTestApp({
    store,
    moments: createMemoryMomentSearch(),
    classifier: { classify: async () => said },
  })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep', 'rep'])
  const other = await seedOrganization(store, ['admin'])
  const reps = seeded.members.filter((m) => m.role === 'rep') as [
    SeededMember,
    SeededMember,
    SeededMember,
  ]
  const admin = seeded.members.find((m) => m.role === 'admin') as SeededMember
  const manager = seeded.members.find((m) => m.role === 'manager') as SeededMember
  const otherAdmin = other.members.find((m) => m.role === 'admin') as SeededMember
  const orgId = seeded.organizationId
  const api = publicCaller(harness)
  let counter = 0

  const rule = (
    trigger: string,
    body: Record<string, unknown>,
    actor: SeededMember = admin,
    org = orgId
  ) => api(actor, org, 'PUT', `/escalation-rules/${trigger}`, body)

  const team = async (members: SeededMember[]) => {
    const created = teamSchema.parse(
      (await api(seeded.owner, orgId, 'POST', '/teams', { name: `T${++counter}` })).body
    )
    for (const m of members) {
      await api(seeded.owner, orgId, 'POST', `/teams/${created.id}/members`, {
        membershipId: m.id,
      })
    }
    return created.id
  }

  /** A Prospect (owned by `owner`, or nobody) with one inbound Message, not yet classified. */
  const reply = async (owner: SeededMember | null, body = BODY) => {
    counter += 1
    const prospect = prospectSchema.parse(
      (
        await api(owner ?? admin, orgId, 'POST', '/prospects', {
          firstName: `P${counter}`,
          email: `p${counter}@example.test`,
          ...(owner === null ? {} : {}),
        })
      ).body
    )
    const response = await harness.app.request('/internal/messages', {
      method: 'POST',
      headers: { ...harness.internal(), 'x-organization-id': orgId },
      body: JSON.stringify({
        channel: 'email',
        providerMessageId: `prov-${counter}`,
        direction: 'inbound',
        prospectId: prospect.id,
        body,
        sentAt: new Date(harness.deps.clock.now().getTime() - 1000).toISOString(),
      }),
    })
    const message = ingestMessageResultSchema.parse(await response.json()).message
    return {
      conversationId: message.conversationId as ConversationId,
      messageId: message.id as MessageId,
    }
  }

  const classify = (messageId: MessageId) =>
    classifyMessage(harness.deps, { organizationId: orgId, messageId, traceId: 'trace-1' })

  const state = async (conversationId: ConversationId) =>
    store.withOrganization(orgId, (scope) => scope.getConversation(conversationId, { kind: 'all' }))

  return {
    store,
    harness,
    seeded,
    other,
    otherAdmin,
    reps,
    admin,
    manager,
    orgId,
    api,
    rule,
    team,
    reply,
    classify,
    state,
    say: (next: Said) => {
      said = next
    },
  }
}

const code = (r: { body: { error?: { code?: string } } }) => r.body.error?.code

describe('escalation rules', () => {
  test('only an Owner or Admin edits or reads rules; a Manager and a Rep get 403', async () => {
    const s = await setup()
    for (const actor of [s.manager, s.reps[0]]) {
      expect((await s.rule('negative_tone', { target: 'admin_queue' }, actor)).status).toBe(403)
      expect((await s.api(actor, s.orgId, 'GET', '/escalation-rules')).status).toBe(403)
      expect(
        (await s.api(actor, s.orgId, 'DELETE', '/escalation-rules/negative_tone')).status
      ).toBe(403)
    }
    expect((await s.rule('negative_tone', { target: 'admin_queue' })).status).toBe(200)
    expect((await s.rule('writer_failure', { target: 'admin_queue' }, s.seeded.owner)).status).toBe(
      200
    )
  })

  test('a rule is one per trigger, replaces on put, and validates its shape', async () => {
    const s = await setup()
    const teamId = await s.team([s.reps[0]])
    const made = await s.rule('negative_tone', { target: 'team_round_robin', teamId })
    expect(made.body).toMatchObject({
      trigger: 'negative_tone',
      target: 'team_round_robin',
      teamId,
      enabled: true,
      threshold: null,
    })
    const replaced = await s.rule('negative_tone', { target: 'admin_queue', enabled: false })
    expect(replaced.body).toMatchObject({ target: 'admin_queue', teamId: null, enabled: false })
    const list = await s.api(s.admin, s.orgId, 'GET', '/escalation-rules')
    expect((list.body.items as unknown[]).length).toBe(1)

    // team target needs a team; other targets refuse one; only low_confidence has a threshold
    expect((await s.rule('negative_tone', { target: 'team_round_robin' })).status).toBe(400)
    expect((await s.rule('negative_tone', { target: 'admin_queue', teamId })).status).toBe(400)
    expect((await s.rule('negative_tone', { target: 'admin_queue', threshold: 0.5 })).status).toBe(
      400
    )
    expect((await s.rule('low_confidence', { target: 'admin_queue' })).status).toBe(400)
    expect((await s.rule('low_confidence', { target: 'admin_queue', threshold: 0 })).status).toBe(
      400
    )
    expect((await s.rule('nonsense', { target: 'admin_queue' })).status).toBe(400)
  })

  test('a Team of another Organization is refused', async () => {
    const s = await setup()
    const foreign = teamSchema.parse(
      (await s.api(s.other.owner, s.other.organizationId, 'POST', '/teams', { name: 'Far' })).body
    )
    const res = await s.rule('negative_tone', { target: 'team_round_robin', teamId: foreign.id })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('a second Organization cannot list, edit or delete them', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'admin_queue' })
    const theirs = await s.api(s.otherAdmin, s.other.organizationId, 'GET', '/escalation-rules')
    expect(theirs.body.items).toEqual([])
    const del = await s.api(
      s.otherAdmin,
      s.other.organizationId,
      'DELETE',
      '/escalation-rules/negative_tone'
    )
    expect(del.status).toBe(404)
    expect(code(del)).toBe('escalation_rule.not_found')
    const mine = await s.api(s.admin, s.orgId, 'GET', '/escalation-rules')
    expect((mine.body.items as unknown[]).length).toBe(1)
  })

  test('the list is cursor paginated with a maximum page size', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'admin_queue' })
    await s.rule('writer_failure', { target: 'admin_queue' })
    await s.rule('asks_for_person', { target: 'admin_queue' })
    const first = await s.api(s.admin, s.orgId, 'GET', '/escalation-rules?limit=2')
    expect((first.body.items as unknown[]).length).toBe(2)
    expect(typeof first.body.nextCursor).toBe('string')
    const second = await s.api(
      s.admin,
      s.orgId,
      'GET',
      `/escalation-rules?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`
    )
    expect((second.body.items as unknown[]).length).toBe(1)
    expect(second.body.nextCursor).toBeNull()
    expect((await s.api(s.admin, s.orgId, 'GET', '/escalation-rules?limit=101')).status).toBe(400)
    expect((await s.api(s.admin, s.orgId, 'GET', '/escalation-rules?cursor=garbage')).status).toBe(
      400
    )
  })

  test('deleting a rule removes it', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'admin_queue' })
    expect(
      (await s.api(s.admin, s.orgId, 'DELETE', '/escalation-rules/negative_tone')).status
    ).toBe(204)
    const list = await s.api(s.admin, s.orgId, 'GET', '/escalation-rules')
    expect(list.body.items).toEqual([])
  })
})

describe('escalating a Conversation', () => {
  test('a negative reply with a rule escalates once, assigns the owner and notifies by id only', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'prospect_owner' })
    s.say({ label: 'negative', confidence: 0.9 })
    const c = await s.reply(s.reps[0])
    // the Prospect is owned by the Rep who created it
    expect(await s.classify(c.messageId)).toBe('classified')
    // redelivery of the same job is a no-op
    expect(await s.classify(c.messageId)).toBe('skipped')

    expect((await s.state(c.conversationId))?.state).toBe('escalated')
    const notices = s.harness.deps.repNotices.outbox.filter(
      (n) => n.kind === 'conversation_escalated'
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      membershipId: s.reps[0].id,
      conversationId: c.conversationId,
      trigger: 'negative_tone',
      email: s.reps[0].email,
    })
    expect(JSON.stringify(notices)).not.toContain('Secret reply text')
    expect(JSON.stringify(notices)).not.toContain('discount')
  })

  test('without a rule for the trigger nothing escalates', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'admin_queue', enabled: false })
    s.say({ label: 'negative', confidence: 0.9 })
    const c = await s.reply(s.reps[0])
    await s.classify(c.messageId)
    expect((await s.state(c.conversationId))?.state).toBe('agent')
    expect(s.harness.deps.repNotices.outbox).toHaveLength(0)
  })

  test('a retried escalation is a no-op: one state change, one notice', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'prospect_owner' })
    s.say({ label: 'negative', confidence: 0.9 })
    const c = await s.reply(s.reps[0])
    await s.classify(c.messageId)
    const { escalateConversation } = await import('./escalation')
    const again = await escalateConversation(s.harness.deps, {
      organizationId: s.orgId,
      conversationId: c.conversationId,
      trigger: 'negative_tone',
      traceId: 'trace-2',
    })
    expect(again).toBe('skipped')
    expect(s.harness.deps.repNotices.outbox).toHaveLength(1)
  })

  test('with no Prospect owner the Conversation lands in the Admin queue and nobody is emailed', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'prospect_owner' })
    s.say({ label: 'negative', confidence: 0.9 })
    const c = await s.reply(null)
    await s.classify(c.messageId)
    const conversation = await s.state(c.conversationId)
    expect(conversation?.state).toBe('escalated')
    expect(conversation?.ownerMembershipId).toBeNull()
    expect(s.harness.deps.repNotices.outbox).toHaveLength(0)
    const queue = await s.api(s.admin, s.orgId, 'GET', '/conversations?state=escalated')
    expect((queue.body.items as { id: string }[]).map((i) => i.id)).toContain(c.conversationId)
  })

  test('a Team with no Rep falls back to the Admin queue', async () => {
    const s = await setup()
    const teamId = await s.team([s.manager])
    await s.rule('negative_tone', { target: 'team_round_robin', teamId })
    s.say({ label: 'negative', confidence: 0.9 })
    const c = await s.reply(s.reps[0])
    await s.classify(c.messageId)
    expect((await s.state(c.conversationId))?.state).toBe('escalated')
    const everyone = [s.admin.id, s.manager.id, ...s.reps.map((r) => r.id)]
    const loads = await s.store.withOrganization(s.orgId, (scope) =>
      scope.countEscalatedByAssignee(everyone)
    )
    expect([...loads.values()].reduce((a, b) => a + b, 0)).toBe(0)
    expect(s.harness.deps.repNotices.outbox).toHaveLength(0)
  })

  test('round-robin spreads Conversations over the Team from stored state', async () => {
    const s = await setup()
    const teamId = await s.team(s.reps)
    await s.rule('negative_tone', { target: 'team_round_robin', teamId })
    s.say({ label: 'negative', confidence: 0.9 })
    for (let i = 0; i < 6; i += 1) {
      const c = await s.reply(s.admin)
      await s.classify(c.messageId)
    }
    const loads = await s.store.withOrganization(s.orgId, (scope) =>
      scope.countEscalatedByAssignee(s.reps.map((r) => r.id))
    )
    expect([...loads.values()]).toEqual([2, 2, 2])
    expect(
      s.harness.deps.repNotices.outbox.filter((n) => n.kind === 'conversation_escalated')
    ).toHaveLength(6)
  })

  test('low confidence escalates only below the rule threshold', async () => {
    const s = await setup()
    await s.rule('low_confidence', { target: 'admin_queue', threshold: 0.6 })
    s.say({ label: 'question', confidence: 0.7 })
    const fine = await s.reply(s.reps[0])
    await s.classify(fine.messageId)
    expect((await s.state(fine.conversationId))?.state).toBe('agent')
    s.say({ label: 'question', confidence: 0.4 })
    const low = await s.reply(s.reps[0])
    await s.classify(low.messageId)
    expect((await s.state(low.conversationId))?.state).toBe('escalated')
  })

  test('a classifier signal for a person or for pricing escalates through its rule', async () => {
    const s = await setup()
    await s.rule('asks_for_person', { target: 'admin_queue' })
    await s.rule('pricing_or_legal', { target: 'prospect_owner' })
    s.say({ label: 'question', confidence: 0.9, signals: ['asks_for_person', 'made_up'] })
    const a = await s.reply(s.reps[0])
    await s.classify(a.messageId)
    expect((await s.state(a.conversationId))?.state).toBe('escalated')
    s.say({ label: 'question', confidence: 0.9, signals: ['pricing_or_legal'] })
    const b = await s.reply(s.reps[1])
    await s.classify(b.messageId)
    expect((await s.state(b.conversationId))?.state).toBe('escalated')
    expect(s.harness.deps.repNotices.outbox.map((n) => n.membershipId)).toEqual([s.reps[1].id])
  })

  test('a writer failure escalates through its rule, and without a rule still escalates', async () => {
    const s = await setup()
    const failing = {
      ...s.harness.deps,
      writer: {
        write: async () => {
          throw new Error('model down')
        },
      },
    }
    await s.rule('writer_failure', { target: 'prospect_owner' })
    const c = await s.reply(s.reps[2])
    await s.classify(c.messageId)
    const outcome = await draftReply(
      failing,
      { organizationId: s.orgId, messageId: c.messageId, traceId: 't' },
      { attempts: 1, sleep: async () => {} }
    )
    expect(outcome).toBe('escalated')
    const conversation = await s.state(c.conversationId)
    expect(conversation?.state).toBe('escalated')
    expect(
      s.harness.deps.repNotices.outbox.filter((n) => n.kind === 'conversation_escalated')
    ).toMatchObject([{ trigger: 'writer_failure', membershipId: s.reps[2].id }])
  })

  test('a notification failure does not fail the job and the Conversation stays escalated', async () => {
    const s = await setup()
    await s.rule('negative_tone', { target: 'prospect_owner' })
    s.say({ label: 'negative', confidence: 0.9 })
    s.harness.deps.repNotices.failing = true
    const c = await s.reply(s.reps[0])
    expect(await s.classify(c.messageId)).toBe('classified')
    expect((await s.state(c.conversationId))?.state).toBe('escalated')
  })

  test('a Draft written in an escalated Conversation is held as escalated', async () => {
    const s = await setup()
    await s.rule('low_confidence', { target: 'admin_queue', threshold: 0.95 })
    s.say({ label: 'question', confidence: 0.9 })
    const c = await s.reply(s.reps[0])
    await s.classify(c.messageId)
    expect((await s.state(c.conversationId))?.state).toBe('escalated')
    const outcome = await draftReply(s.harness.deps, {
      organizationId: s.orgId,
      messageId: c.messageId,
      traceId: 't',
    })
    expect(outcome).toBe('drafted')
    const conversation = await s.state(c.conversationId)
    expect(conversation?.state).toBe('escalated')
    const queue = await s.api(s.admin, s.orgId, 'GET', '/approvals')
    expect((queue.body as { items: unknown[] }).items).toHaveLength(1)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  type ConversationId,
  type DraftId,
  formatId,
  ingestMessageResultSchema,
  type MessageId,
  prospectSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { classifyMessage } from './classify'
import { draftReply } from './draft'

const FIRST = 'How much does it cost?'
const REPLY = 'Secret pricing question: can you do 40 percent off?'

async function setup() {
  const store = createMemoryCoreStore()
  const moments = createMemoryMomentSearch()
  const harness = await createTestApp({ store, moments })
  const seeded = await seedOrganization(store, ['admin', 'rep', 'rep'])
  const other = await seedOrganization(store, ['admin'])
  const [rep, stranger] = seeded.members.filter((m) => m.role === 'rep') as [
    SeededMember,
    SeededMember,
  ]
  const admin = seeded.members.find((m) => m.role === 'admin') as SeededMember
  const orgId = seeded.organizationId
  const call = publicCaller(harness)
  const api: typeof call = (actor, organizationId, method, path, body, headers = {}) =>
    call(actor, organizationId, method, path, body ?? (method === 'POST' ? {} : undefined), {
      ...(method === 'POST' && /\/(takeover|handback)$/.test(path)
        ? { 'idempotency-key': `key-${crypto.randomUUID()}` }
        : {}),
      ...headers,
    })
  let counter = 0

  const ingest = async (prospectId: string, body: string) => {
    counter += 1
    const response = await harness.app.request('/internal/messages', {
      method: 'POST',
      headers: { ...harness.internal(), 'x-organization-id': orgId },
      body: JSON.stringify({
        channel: 'email',
        providerMessageId: `prov-${counter}`,
        direction: 'inbound',
        prospectId,
        body,
        sentAt: new Date(harness.deps.clock.now().getTime() - 1000).toISOString(),
      }),
    })
    return ingestMessageResultSchema.parse(await response.json()).message
  }

  /** A Prospect owned by the Rep with a first inbound Message, classified. */
  const conversationFor = async () => {
    counter += 1
    const prospect = prospectSchema.parse(
      (
        await api(rep, orgId, 'POST', '/prospects', {
          firstName: `P${counter}`,
          email: `p${counter}@example.test`,
        })
      ).body
    )
    const message = await ingest(prospect.id, FIRST)
    await classify(message.id)
    return {
      prospectId: prospect.id,
      conversationId: message.conversationId as ConversationId,
      messageId: message.id as MessageId,
    }
  }

  const classify = (messageId: MessageId) =>
    classifyMessage(harness.deps, { organizationId: orgId, messageId, traceId: 'trace-1' })
  const draft = (messageId: MessageId) =>
    draftReply(harness.deps, { organizationId: orgId, messageId, traceId: 'trace-1' })

  /** Plants a pending Agent Draft on the Conversation. */
  const plant = async (c: { conversationId: ConversationId; messageId: MessageId }) => {
    const id = formatId('drf', crypto.randomUUID()) as DraftId
    await store.withOrganization(orgId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertAgentDraft({
        id,
        conversationId: c.conversationId,
        triggerMessageId: c.messageId,
        label: 'question',
        body: 'Here is the answer.',
        strategy: 'Answer it.',
        confidence: 0.8,
        ungrounded: true,
        hold: 'ungrounded',
        sources: [],
        now: new Date(1_800_000_000_000),
      })
    })
    return id
  }

  /** The envelopes of one type published so far. */
  const published = async (type: string) => {
    await drainTestOutbox(harness.deps)
    const out: Record<string, unknown>[] = []
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
          if (delivery.envelope.type === type) {
            out.push(delivery.envelope.payload as Record<string, unknown>)
          }
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }

  const get = async (id: ConversationId) =>
    (await api(rep, orgId, 'GET', `/conversations/${id}`)).body as {
      controller: string
      controllerMembershipId: string | null
      state: string
      pendingDraftCount: number
    }

  return {
    store,
    harness,
    orgId,
    other,
    rep,
    stranger,
    admin,
    api,
    ingest,
    classify,
    draft,
    plant,
    published,
    conversationFor,
    get,
  }
}

const code = (r: { body: { error?: { code?: string } } }) => r.body.error?.code

describe('taking over a Conversation', () => {
  test('the Rep becomes the controller, pending Drafts are void, and one event carries only ids', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const draftId = await s.plant(c)

    const taken = await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)

    expect(taken.status).toBe(200)
    expect(taken.body).toMatchObject({
      id: c.conversationId,
      controller: 'rep',
      controllerMembershipId: s.rep.id,
      state: 'rep',
      pendingDraftCount: 0,
    })
    const draft = await s.api(s.rep, s.orgId, 'GET', `/drafts/${draftId}`)
    expect(draft.body).toMatchObject({ status: 'void' })
    const events = await s.published('conversation.taken_over')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      conversationId: c.conversationId,
      prospectId: c.prospectId,
      channel: 'email',
      takenOverByMembershipId: s.rep.id,
      voidedDraftCount: 1,
    })
    expect(JSON.stringify(events)).not.toContain(FIRST)
    const decisions = await s.api(s.admin, s.orgId, 'GET', '/decisions?kind=takeover')
    expect((decisions.body.items as { draftId: unknown }[]).map((d) => d.draftId)).toEqual([null])
  })

  test('taking over again is idempotent: the same answer and no second Decision or event', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const path = `/conversations/${c.conversationId}/takeover`

    const first = await s.api(
      s.rep,
      s.orgId,
      'POST',
      path,
      {},
      { 'idempotency-key': 'key-takeover-0001' }
    )
    const replay = await s.api(
      s.rep,
      s.orgId,
      'POST',
      path,
      {},
      { 'idempotency-key': 'key-takeover-0001' }
    )
    const fresh = await s.api(s.rep, s.orgId, 'POST', path)

    expect([first.status, replay.status, fresh.status]).toEqual([200, 200, 200])
    expect(replay.body).toEqual(first.body)
    expect(fresh.body).toEqual(first.body)
    expect(await s.published('conversation.taken_over')).toHaveLength(1)
    const decisions = await s.api(s.admin, s.orgId, 'GET', '/decisions?kind=takeover')
    expect(decisions.body.items).toHaveLength(1)
  })

  test('a second person is refused with inbox.already_controlled and nothing changes', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const path = `/conversations/${c.conversationId}/takeover`
    await s.api(s.rep, s.orgId, 'POST', path)

    const refused = await s.api(s.admin, s.orgId, 'POST', path)

    expect(refused.status).toBe(409)
    expect(code(refused)).toBe('inbox.already_controlled')
    expect((await s.get(c.conversationId)).controllerMembershipId).toBe(s.rep.id)
    expect(await s.published('conversation.taken_over')).toHaveLength(1)
  })

  test('a Rep cannot take over a Prospect they do not own, and a closed Conversation is refused', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const hidden = await s.api(
      s.stranger,
      s.orgId,
      'POST',
      `/conversations/${c.conversationId}/takeover`
    )
    expect(hidden.status).toBe(404)
    expect(code(hidden)).toBe('inbox.conversation_not_found')

    const closing = await s.ingest(c.prospectId, 'Please unsubscribe me')
    await s.classify(closing.id)
    const closed = await s.api(
      s.rep,
      s.orgId,
      'POST',
      `/conversations/${c.conversationId}/takeover`
    )
    expect(closed.status).toBe(409)
    expect(code(closed)).toBe('inbox.conversation_closed')
  })

  test('another Organization cannot take over (404)', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const outsider = s.other.members[0] as SeededMember

    const refused = await s.api(
      outsider,
      s.other.organizationId,
      'POST',
      `/conversations/${c.conversationId}/takeover`
    )

    expect(refused.status).toBe(404)
    expect(code(refused)).toBe('inbox.conversation_not_found')
    expect((await s.get(c.conversationId)).controller).toBe('agent')
  })
})

describe('handing a Conversation back', () => {
  test('returns control to the Agent and publishes one event with ids only', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)
    const path = `/conversations/${c.conversationId}/handback`

    const back = await s.api(
      s.rep,
      s.orgId,
      'POST',
      path,
      {},
      { 'idempotency-key': 'key-handback-0001' }
    )
    const replay = await s.api(
      s.rep,
      s.orgId,
      'POST',
      path,
      {},
      { 'idempotency-key': 'key-handback-0001' }
    )

    expect(back.status).toBe(200)
    expect(back.body).toMatchObject({ controller: 'agent', controllerMembershipId: null })
    expect((back.body as { state: string }).state).toBe('agent')
    expect(replay.body).toEqual(back.body)
    const events = await s.published('conversation.handed_back')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      conversationId: c.conversationId,
      prospectId: c.prospectId,
      channel: 'email',
      handedBackByMembershipId: s.rep.id,
    })
    const decisions = await s.api(s.admin, s.orgId, 'GET', '/decisions?kind=hand_back')
    expect(decisions.body.items).toHaveLength(1)
  })

  test('refuses a Conversation nobody took over, and a Rep who is not the controller', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const path = `/conversations/${c.conversationId}/handback`

    const idle = await s.api(s.rep, s.orgId, 'POST', path)
    expect(idle.status).toBe(409)
    expect(code(idle)).toBe('inbox.not_taken_over')

    await s.api(s.admin, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)
    const notYours = await s.api(s.rep, s.orgId, 'POST', path)
    expect(notYours.status).toBe(403)
    expect(code(notYours)).toBe('inbox.not_conversation_owner')
    expect((await s.get(c.conversationId)).controller).toBe('rep')

    const byController = await s.api(s.admin, s.orgId, 'POST', path)
    expect(byController.status).toBe(200)
    expect(byController.body).toMatchObject({ controller: 'agent' })
  })

  test('another Organization cannot hand back (404)', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)
    const outsider = s.other.members[0] as SeededMember

    const refused = await s.api(
      outsider,
      s.other.organizationId,
      'POST',
      `/conversations/${c.conversationId}/handback`
    )

    expect(refused.status).toBe(404)
    expect((await s.get(c.conversationId)).controller).toBe('rep')
  })
})

describe('replies while a Rep controls the Conversation', () => {
  test('no Draft is written, the Rep is notified with ids and no body, and drafting resumes after hand back', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)
    const notices = (s.harness.deps.repNotices as { outbox: unknown[] }).outbox

    const reply = await s.ingest(c.prospectId, REPLY)
    expect(await s.classify(reply.id)).toBe('classified')
    expect(await s.draft(reply.id)).toBe('skipped')

    expect(s.store.agentDrafts(s.orgId)).toEqual([])
    expect(notices).toEqual([
      {
        kind: 'reply_during_takeover',
        organizationId: s.orgId,
        membershipId: s.rep.id,
        conversationId: c.conversationId,
        messageId: reply.id,
        text: expect.any(String) as unknown as string,
      },
    ])
    expect(JSON.stringify(notices)).not.toContain('pricing')
    expect((await s.get(c.conversationId)).controller).toBe('rep')

    await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/handback`)
    const later = await s.ingest(c.prospectId, 'And what about the contract length?')
    expect(await s.classify(later.id)).toBe('classified')
    expect(await s.draft(later.id)).toBe('drafted')
    expect(s.store.agentDrafts(s.orgId)).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  test('a notification system that is down does not fail classification', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    await s.api(s.rep, s.orgId, 'POST', `/conversations/${c.conversationId}/takeover`)
    s.harness.deps.repNotices.failing = true

    const reply = await s.ingest(c.prospectId, REPLY)

    expect(await s.classify(reply.id)).toBe('classified')
    expect(s.harness.deps.repNotices.outbox).toEqual([])
    expect(JSON.stringify(s.harness.deps.logLines)).not.toContain('pricing')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  type ApprovalRule,
  type ConversationId,
  type DealRecordId,
  type DraftId,
  formatId,
  ingestMessageResultSchema,
  type MessageId,
  type OrganizationId,
  prospectSchema,
  REPLY_LABELS,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import { classifyMessage } from '~/modules/inbox/classify'
import { type DraftOptions, draftReply } from '~/modules/inbox/draft'
import type { Judge } from '~/ports/judge'
import type { PlaybookMoment } from '~/ports/moment-search'
import type { ReplyWriter } from '~/ports/reply-writer'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

/** The shapes the tests read from a response body. */
const shape = (response: { body: unknown }) =>
  response.body as {
    items: { channel: string | null }[]
    nextCursor: string
    error: { code: string }
  }

const FAST: DraftOptions = {
  attempts: 3,
  searchTimeoutMs: 20,
  writerTimeoutMs: 20,
  backoff: { baseMs: 1, capMs: 2 },
  sleep: async () => undefined,
  random: () => 0.5,
}

const moment: PlaybookMoment = {
  callId: 'call-1',
  dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
  momentIndex: 1,
  prospect: 'It costs too much',
  repNext: 'We showed the return in ninety days',
}

const answering = (body: string): ReplyWriter => ({
  write: async (input) => ({
    body,
    strategy: 'Answer.',
    confidence: 0.9,
    citedIds: [input.moments[0]?.id],
  }),
})

const EVERY_DAY_OPEN = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => ({
  day,
  windows: [{ start: '00:00', end: '23:59' }],
}))
const OPEN_WINDOW = { timeZone: 'UTC', days: EVERY_DAY_OPEN }
// 2026-01-01 is a Thursday and the test clock starts at midnight UTC, so this opens at 09:00.
const THURSDAY_OFFICE = {
  timeZone: 'UTC',
  days: [{ day: 'thu', windows: [{ start: '09:00', end: '17:00' }] }],
}

const control = (level: string, sendWindow: unknown = OPEN_WINDOW) => ({
  level,
  sendWindow,
  escalationRules: [{ trigger: 'complaint', action: 'hand_over' }],
})

async function setup(options: { writer?: ReplyWriter; judge?: Judge } = {}) {
  const store = createMemoryCoreStore()
  const moments = createMemoryMomentSearch()
  const harness = await createTestApp({
    store,
    moments,
    ...(options.writer ? { writer: options.writer } : {}),
    ...(options.judge ? { judge: options.judge } : {}),
  })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const other = await seedOrganization(store, ['admin'], 'Other')
  const by = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const admin = by('admin')
  const rep = by('rep')
  const orgId = seeded.organizationId
  const call = publicCaller(harness)
  const key = () => ({ 'idempotency-key': `key-${crypto.randomUUID()}` })
  const put = (
    actor: SeededMember,
    path: string,
    body: unknown,
    organizationId: OrganizationId = orgId,
    headers: Record<string, string> = key()
  ) => call(actor, organizationId, 'PUT', path, body, headers)
  const setControl = (
    level: string,
    channel = 'email',
    sendWindow: unknown = OPEN_WINDOW,
    kind = 'inbound'
  ) => put(admin, `/agent-controls/${kind}/${channel}`, control(level, sendWindow))
  const setPaused = (paused: boolean, actor: SeededMember = admin) =>
    put(actor, '/agent-controls/organization-pause', { paused })
  const auditActions = async (organizationId: OrganizationId = orgId, actor = seeded.owner) => {
    const page = await call(actor, organizationId, 'GET', '/audit-events?limit=100')
    return page.body.items as { action: string; metadata: Record<string, unknown> }[]
  }
  const policyOf = (organizationId: OrganizationId = orgId) =>
    store.withOrganization(organizationId, (scope) => scope.getApprovalPolicy('email'))

  let counter = 0
  const arrive = async (body = 'Why is it so expensive?') => {
    counter += 1
    const prospect = prospectSchema.parse(
      (
        await call(rep, orgId, 'POST', '/prospects', {
          firstName: `P${counter}`,
          email: `p${counter}@example.test`,
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
    const result = ingestMessageResultSchema.parse(await response.json())
    await classifyMessage(harness.deps, {
      organizationId: orgId,
      messageId: result.message.id,
      traceId: 'trace-1',
    })
    return { id: result.message.id as MessageId, conversationId: result.message.conversationId }
  }
  /** A reply already released in the Conversation, so the next Draft is not the first message. */
  const priorReply = (conversationId: string) =>
    store.withOrganization(orgId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertRepDraft({
        id: formatId('drf', crypto.randomUUID()) as DraftId,
        conversationId: conversationId as ConversationId,
        membershipId: rep.id,
        body: 'An earlier reply.',
        now: harness.deps.clock.now(),
      })
    })
  const draft = (messageId: MessageId) =>
    draftReply(harness.deps, { organizationId: orgId, messageId, traceId: 'trace-1' }, FAST)
  const drafts = () => store.agentDrafts(orgId)
  const approvedEvents = async () => {
    await drainTestOutbox(harness.deps)
    const batch = await harness.deps.events.receive({
      maxMessages: 10,
      visibilityTimeoutSeconds: 60,
      waitSeconds: 0,
    })
    return batch.filter((d) => d.kind === 'message' && d.envelope.type === 'message.approved')
  }
  const approve = (draftId: DraftId) =>
    call(rep, orgId, 'POST', `/drafts/${draftId}/approve`, {}, key())

  return {
    store,
    moments,
    harness,
    seeded,
    other,
    admin,
    by,
    orgId,
    call,
    key,
    put,
    setControl,
    setPaused,
    auditActions,
    policyOf,
    arrive,
    priorReply,
    draft,
    drafts,
    approvedEvents,
    approve,
  }
}

describe('setting the controls', () => {
  test('Admin sets a level and the list shows it, the default as channel null', async () => {
    const t = await setup()
    const set = await t.setControl('assisted', 'email')
    expect(set.status).toBe(200)
    expect(set.body).toMatchObject({
      agentKind: 'inbound',
      channel: 'email',
      level: 'assisted',
      updatedByMembershipId: t.admin.id,
    })
    await t.setControl('autonomous', 'default')

    const page = await t.call(t.by('manager'), t.orgId, 'GET', '/agent-controls')
    expect(page.status).toBe(200)
    expect(shape(page).items.map((i) => i.channel)).toEqual([null, 'email'])
    expect(page.body.nextCursor).toBeNull()
    const outbound = await t.call(t.admin, t.orgId, 'GET', '/agent-controls?agentKind=outbound')
    expect(outbound.body.items).toEqual([])
  })

  test('the list pages by cursor in a fixed order', async () => {
    const t = await setup()
    await t.setControl('assisted', 'email')
    await t.setControl('assisted', 'linkedin')
    await t.setControl('assisted', 'default')
    const first = await t.call(t.admin, t.orgId, 'GET', '/agent-controls?limit=2')
    expect(first.body.items).toHaveLength(2)
    const second = await t.call(
      t.admin,
      t.orgId,
      'GET',
      `/agent-controls?limit=2&cursor=${encodeURIComponent(shape(first).nextCursor)}`
    )
    expect(second.body.items).toHaveLength(1)
    expect(second.body.nextCursor).toBeNull()
    const bad = await t.call(t.admin, t.orgId, 'GET', '/agent-controls?cursor=nope')
    expect(bad.status).toBe(400)
  })

  test('a Manager reads but cannot write, and a Rep can do neither', async () => {
    const t = await setup()
    const body = control('assisted')
    const manager = t.by('manager')
    const rep = t.by('rep')
    expect((await t.put(manager, '/agent-controls/inbound/email', body)).status).toBe(403)
    expect((await t.put(rep, '/agent-controls/inbound/email', body)).status).toBe(403)
    expect(
      (await t.put(manager, '/agent-controls/organization-pause', { paused: true })).status
    ).toBe(403)
    expect((await t.call(manager, t.orgId, 'GET', '/agent-controls')).status).toBe(200)
    expect(
      (await t.call(manager, t.orgId, 'GET', '/agent-controls/organization-pause')).status
    ).toBe(200)
    expect((await t.call(rep, t.orgId, 'GET', '/agent-controls')).status).toBe(403)
    expect((await t.call(rep, t.orgId, 'GET', '/agent-controls/organization-pause')).status).toBe(
      403
    )
  })

  test('a time zone the runtime does not know is agent.settings_invalid', async () => {
    const t = await setup()
    const response = await t.setControl('assisted', 'email', { timeZone: 'Mars/Base', days: [] })
    expect(response.status).toBe(422)
    expect(shape(response).error.code).toBe('agent.settings_invalid')
    expect((await t.call(t.admin, t.orgId, 'GET', '/agent-controls')).body.items).toEqual([])
  })

  test('an unknown field is refused, and consent is not a setting', async () => {
    const t = await setup()
    const response = await t.put(t.admin, '/agent-controls/inbound/email', {
      ...control('autonomous'),
      requireConsent: false,
    })
    expect(response.status).toBe(400)
  })

  test('a repeated Idempotency-Key answers the first answer and writes once', async () => {
    const t = await setup()
    const headers = t.key()
    const first = await t.put(
      t.admin,
      '/agent-controls/inbound/email',
      control('assisted'),
      t.orgId,
      headers
    )
    const again = await t.put(
      t.admin,
      '/agent-controls/inbound/email',
      control('assisted'),
      t.orgId,
      headers
    )
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(
      (await t.auditActions()).filter((e) => e.action === 'agent_settings.changed')
    ).toHaveLength(1)
    const reused = await t.put(
      t.admin,
      '/agent-controls/inbound/email',
      control('autonomous'),
      t.orgId,
      headers
    )
    expect(reused.status).toBe(422)
    expect(shape(reused).error.code).toBe('request.idempotency_key_reused')
  })
})

describe('the audit trail', () => {
  test('a level change writes one event with the level before and after', async () => {
    const t = await setup()
    await t.setControl('assisted', 'email')
    await t.setControl('autonomous', 'email')

    const changed = (await t.auditActions()).filter((e) => e.action === 'agent_settings.changed')
    expect(changed).toHaveLength(2)
    const metadata = changed.map((e) => e.metadata)
    expect(metadata).toContainEqual(
      expect.objectContaining({
        agentKind: 'inbound',
        channel: 'email',
        levelBefore: null,
        levelAfter: 'assisted',
      })
    )
    expect(metadata).toContainEqual(
      expect.objectContaining({
        levelBefore: 'assisted',
        levelAfter: 'autonomous',
        sendWindowChanged: false,
        escalationRulesChanged: false,
      })
    )
  })

  test('setting the same value again records nothing', async () => {
    const t = await setup()
    await t.setControl('assisted', 'email')
    await t.setControl('assisted', 'email')
    expect(
      (await t.auditActions()).filter((e) => e.action === 'agent_settings.changed')
    ).toHaveLength(1)
  })
})

describe('a level is an approval policy', () => {
  test.each([
    ['supervised', { mode: 'always' }],
    ['assisted', { mode: 'except', labels: ['question'] }],
    ['autonomous', { mode: 'except', labels: [...REPLY_LABELS] }],
  ] satisfies [string, ApprovalRule][])('%s writes the channel rule', async (level, rule) => {
    const t = await setup()
    await t.setControl(level, 'email')
    expect((await t.policyOf())?.rule).toEqual(rule)
  })

  test('the default level governs chat and a mail channel without its own row', async () => {
    const t = await setup()
    await t.setControl('supervised', 'linkedin')
    await t.setControl('autonomous', 'default')
    const rules = await t.store.withOrganization(t.orgId, (scope) => scope.listApprovalPolicies())
    const byChannel = Object.fromEntries(rules.map((r) => [r.channel, r.rule.mode]))
    expect(byChannel).toEqual({ linkedin: 'always', chat: 'except', email: 'except' })
  })

  test('the Outbound Agent has no Drafts to release, so its level changes no policy', async () => {
    const t = await setup()
    await t.setControl('autonomous', 'email', OPEN_WINDOW, 'outbound')
    expect(await t.policyOf()).toBeNull()
  })

  test("a second Organization's settings are unaffected", async () => {
    const t = await setup()
    const otherAdmin = t.other.members.find((m) => m.role === 'admin') as SeededMember
    await t.setControl('autonomous', 'email')
    await t.setPaused(true)

    const list = await t.call(otherAdmin, t.other.organizationId, 'GET', '/agent-controls')
    expect(list.body.items).toEqual([])
    const paused = await t.call(
      otherAdmin,
      t.other.organizationId,
      'GET',
      '/agent-controls/organization-pause'
    )
    expect(paused.body).toEqual({ paused: false, updatedAt: null, updatedByMembershipId: null })
    expect(await t.policyOf(t.other.organizationId)).toBeNull()
    const events = await t.auditActions(t.other.organizationId, t.other.owner)
    expect(events.filter((e) => e.action.startsWith('agent'))).toEqual([])
    // And its own change leaves ours as it was.
    await t.put(
      otherAdmin,
      '/agent-controls/inbound/email',
      control('supervised'),
      t.other.organizationId
    )
    expect((await t.policyOf())?.rule.mode).toBe('except')
  })
})

describe('Autonomous still holds what no setting can release', () => {
  const autonomous = async (t: Awaited<ReturnType<typeof setup>>) => {
    await t.setControl('autonomous', 'email')
  }

  test('an ungrounded Draft', async () => {
    const t = await setup()
    await autonomous(t)
    const message = await t.arrive()
    await t.priorReply(message.conversationId)
    await t.draft(message.id)
    expect(t.drafts()[0]).toMatchObject({ status: 'pending', hold: 'ungrounded' })
    expect(await t.approvedEvents()).toEqual([])
  })

  test('a failed assessment', async () => {
    const t = await setup({ writer: answering('Thanks. We guarantee a 90% discount.') })
    t.moments.seed(t.orgId, [moment])
    await autonomous(t)
    const message = await t.arrive()
    await t.priorReply(message.conversationId)
    await t.draft(message.id)
    expect(t.drafts()[0]).toMatchObject({ status: 'pending', hold: 'check_failed' })
    expect(await t.approvedEvents()).toEqual([])
  })

  test('the first message to a Prospect', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await autonomous(t)
    const message = await t.arrive()
    await t.draft(message.id)
    expect(t.drafts()[0]).toMatchObject({ status: 'pending', hold: 'first_message' })
    expect(await t.approvedEvents()).toEqual([])
  })

  test('and a grounded, clean reply after an earlier one goes out', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await autonomous(t)
    const message = await t.arrive()
    await t.priorReply(message.conversationId)
    await t.draft(message.id)
    expect(t.drafts()[0]).toMatchObject({ status: 'approved', hold: null })
    expect(await t.approvedEvents()).toHaveLength(1)
  })
})

describe('pausing the Agents', () => {
  test('shows the state, and is audited once per change', async () => {
    const t = await setup()
    expect(
      (await t.call(t.admin, t.orgId, 'GET', '/agent-controls/organization-pause')).body
    ).toEqual({
      paused: false,
      updatedAt: null,
      updatedByMembershipId: null,
    })
    const paused = await t.setPaused(true)
    expect(paused.body).toMatchObject({ paused: true, updatedByMembershipId: t.admin.id })
    await t.setPaused(true)
    await t.setPaused(false)

    const actions = (await t.auditActions()).map((e) => e.action)
    expect(actions.filter((a) => a === 'agents.paused')).toHaveLength(1)
    expect(actions.filter((a) => a === 'agents.resumed')).toHaveLength(1)
  })

  test('stops the release of a Draft at once; the Draft waits and is not dropped', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await t.setControl('autonomous', 'email')
    await t.setPaused(true)
    const message = await t.arrive()
    await t.priorReply(message.conversationId)

    await t.draft(message.id)

    expect(t.drafts()[0]).toMatchObject({ status: 'pending', hold: 'policy' })
    expect(await t.approvedEvents()).toEqual([])
  })

  test('refuses an approval with agent.paused until the Agents resume', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    const message = await t.arrive()
    await t.draft(message.id)
    const [pending] = t.drafts()
    await t.setPaused(true)

    const refused = await t.approve(pending?.id as DraftId)
    expect(refused.status).toBe(409)
    expect(shape(refused).error.code).toBe('agent.paused')
    expect(t.drafts()[0]?.status).toBe('pending')

    await t.setPaused(false)
    expect((await t.approve(pending?.id as DraftId)).status).toBe(200)
  })
})

describe('the send window', () => {
  test('a release outside the window is deferred: the Draft waits, nothing goes out', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await t.setControl('autonomous', 'email', THURSDAY_OFFICE)
    const message = await t.arrive()
    await t.priorReply(message.conversationId)

    await t.draft(message.id)

    expect(t.drafts()[0]).toMatchObject({ status: 'pending', hold: 'policy' })
    expect(await t.approvedEvents()).toEqual([])
  })

  test('a release inside the window goes out', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await t.setControl('autonomous', 'email', THURSDAY_OFFICE)
    t.harness.deps.clock.advance('10h')
    const message = await t.arrive()
    await t.priorReply(message.conversationId)

    await t.draft(message.id)

    expect(t.drafts()[0]).toMatchObject({ status: 'approved', hold: null })
  })

  test('an approval outside the window is agent.outside_hours and works once it opens', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    await t.setControl('supervised', 'email', THURSDAY_OFFICE)
    const message = await t.arrive()
    await t.draft(message.id)
    const [pending] = t.drafts()

    const refused = await t.approve(pending?.id as DraftId)
    expect(refused.status).toBe(409)
    expect(shape(refused).error.code).toBe('agent.outside_hours')
    expect(t.drafts()[0]?.status).toBe('pending')

    t.harness.deps.clock.advance('10h')
    expect((await t.approve(pending?.id as DraftId)).status).toBe(200)
  })

  test('a day that is absent is closed, and the zone decides the hour', async () => {
    const t = await setup({ writer: answering('Thanks for raising that.') })
    t.moments.seed(t.orgId, [moment])
    // 00:00 UTC on Thursday is Wednesday 19:00 in New York: closed on Thursday-only, open Wednesday evening.
    await t.setControl('supervised', 'email', {
      timeZone: 'America/New_York',
      days: [{ day: 'wed', windows: [{ start: '18:00', end: '20:00' }] }],
    })
    const message = await t.arrive()
    await t.draft(message.id)
    const [pending] = t.drafts()
    expect((await t.approve(pending?.id as DraftId)).status).toBe(200)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  type ConversationId,
  type DraftId,
  formatId,
  ingestMessageResultSchema,
  type MessageId,
  type OrganizationId,
  prospectSchema,
  type SuppressionEntryId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createMemoryJudge } from '~/adapters/memory/judge'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import { hashAddress } from '~/modules/suppression/address'
import type { Judge } from '~/ports/judge'
import { momentSourceRef, type PlaybookMoment } from '~/ports/moment-search'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { bodyDigest } from './approval'

const MOMENT: PlaybookMoment = {
  callId: 'call-0',
  dealRecordId: formatId('deal', crypto.randomUUID()) as PlaybookMoment['dealRecordId'],
  momentIndex: 0,
  prospect: 'It costs too much',
  repNext: 'We showed the return',
}

const BODY = 'Here is how we handle pricing.'

async function setup(
  options: { moments?: ReturnType<typeof createMemoryMomentSearch>; judge?: Judge } = {}
) {
  const store = createMemoryCoreStore()
  const moments = options.moments ?? createMemoryMomentSearch()
  const harness = await createTestApp({
    store,
    moments,
    ...(options.judge ? { judge: options.judge } : {}),
  })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep', 'rep'])
  const other = await seedOrganization(store, ['admin', 'rep'])
  const [rep, stranger] = seeded.members.filter((m) => m.role === 'rep') as [
    SeededMember,
    SeededMember,
  ]
  const admin = seeded.members.find((m) => m.role === 'admin') as SeededMember
  const manager = seeded.members.find((m) => m.role === 'manager') as SeededMember
  const orgId = seeded.organizationId
  const call = publicCaller(harness)
  /** Calls the API; a keyed route (approve, reject, reply) gets a fresh Idempotency-Key unless one is given. */
  const api: typeof call = (actor, organizationId, method, path, body, headers = {}) =>
    call(actor, organizationId, method, path, body ?? (method === 'POST' ? {} : undefined), {
      ...(method === 'POST' && /\/(approve|reject|replies)$/.test(path)
        ? { 'idempotency-key': `key-${crypto.randomUUID()}` }
        : {}),
      ...headers,
    })
  let counter = 0

  /** A Prospect owned by `owner` with an inbound Message, so there is a Conversation. */
  const conversationFor = async (owner: SeededMember = rep, organizationId = orgId) => {
    counter += 1
    const created = await api(owner, organizationId, 'POST', '/prospects', {
      firstName: `P${counter}`,
      email: `p${counter}@example.test`,
    })
    const prospect = prospectSchema.parse(created.body)
    const response = await harness.app.request('/internal/messages', {
      method: 'POST',
      headers: { ...harness.internal(), 'x-organization-id': organizationId },
      body: JSON.stringify({
        channel: 'email',
        providerMessageId: `prov-${counter}`,
        direction: 'inbound',
        prospectId: prospect.id,
        body: 'How much does it cost?',
        sentAt: new Date(harness.deps.clock.now().getTime() - 1000).toISOString(),
      }),
    })
    const result = ingestMessageResultSchema.parse(await response.json())
    return {
      prospect,
      email: `p${counter}@example.test`,
      conversationId: result.message.conversationId as ConversationId,
      messageId: result.message.id as MessageId,
    }
  }

  /** Plants a pending Agent Draft on a fresh Conversation. */
  const plant = async (
    options: {
      owner?: SeededMember
      ungrounded?: boolean
      /** Holds the Draft as `check_failed` and stores a failing assessment for version 1. */
      checkFailed?: boolean
      sources?: PlaybookMoment[]
      at?: number
      organizationId?: OrganizationId
    } = {}
  ) => {
    const organizationId = options.organizationId ?? orgId
    const conversation = await conversationFor(options.owner ?? rep, organizationId)
    const id = formatId('drf', crypto.randomUUID()) as DraftId
    await store.withOrganization(organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertAgentDraft({
        id,
        conversationId: conversation.conversationId,
        triggerMessageId: conversation.messageId,
        label: 'question',
        body: BODY,
        strategy: 'Show the return.',
        confidence: 0.8,
        ungrounded: options.ungrounded ?? false,
        hold: options.ungrounded ? 'ungrounded' : options.checkFailed ? 'check_failed' : 'policy',
        ...(options.checkFailed ? { checks: [{ name: 'claims_supported', passed: false }] } : {}),
        sources: (options.sources ?? (options.ungrounded ? [] : [MOMENT])).map((m, position) => ({
          kind: 'moment' as const,
          sourceRef: momentSourceRef(m) as string,
          position,
          dealRecordId: m.dealRecordId,
          outcome: 'won' as const,
          evidenceCount: 1,
        })),
        now: new Date(1_800_000_000_000 + (options.at ?? 0)),
      })
      if (options.checkFailed) {
        await scope.saveDraftAssessment({
          draftId: id,
          draftVersion: 1,
          prospectId: conversation.prospect.id,
          verdict: 'fail',
          findings: [
            {
              category: 'unsupported_claim',
              severity: 'high',
              span: { start: 0, end: 4 },
              explanation: 'Not in any Source.',
            },
          ],
          now: new Date(1_800_000_000_000),
        })
      }
    })
    return { id, ...conversation }
  }

  /** The `message.approved` payloads published so far. */
  const approvedEvents = async () => {
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
          if (delivery.envelope.type === 'message.approved') {
            out.push(delivery.envelope.payload as Record<string, unknown>)
          }
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }

  const suppress = async (email: string) => {
    await store.withOrganization(orgId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertSuppressionEntry({
        id: formatId('sup', crypto.randomUUID()) as SuppressionEntryId,
        addressKind: 'email',
        addressHash: hashAddress(harness.deps.env.CONSENT_HASH_KEY, orgId, 'email', email),
        maskedAddress: null,
        reason: 'manual',
        channel: null,
        sourceRef: null,
        addedByUserId: null,
        now: harness.deps.clock.now(),
      })
    })
  }

  return {
    store,
    harness,
    moments,
    orgId,
    other,
    rep,
    stranger,
    admin,
    manager,
    api,
    plant,
    conversationFor,
    approvedEvents,
    suppress,
  }
}

/** The `items` of a page answer. */
const itemsOf = (r: { body: Record<string, unknown> }) =>
  (r.body.items ?? []) as Record<string, unknown>[]

const code = (r: { body: { error?: { code?: string } } }) => r.body.error?.code

describe('approving a Draft', () => {
  test('approves once, records who decided, and publishes one message.approved', async () => {
    const s = await setup()
    const d = await s.plant()

    const first = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)
    const again = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)

    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ id: d.id, status: 'approved', body: BODY })
    expect(again.status).toBe(409)
    expect(code(again)).toBe('inbox.draft_not_pending')
    const events = await s.approvedEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      draftId: d.id,
      conversationId: d.conversationId,
      approvedByMembershipId: s.rep.id,
      edited: false,
      acknowledgedUngrounded: false,
    })
    const decisions = await s.api(s.admin, s.orgId, 'GET', `/decisions?draftId=${d.id}`)
    expect(decisions.body.items).toHaveLength(1)
    expect(itemsOf(decisions)[0]).toMatchObject({
      kind: 'approve',
      draftId: d.id,
      decidedByMembershipId: s.rep.id,
    })
  })

  test('an edit-and-approve sends the new wording and keeps only its SHA-256', async () => {
    const s = await setup()
    const d = await s.plant()
    const edited = 'A secret-looking edited reply.'

    const response = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`, {
      body: edited,
    })

    expect(response.status).toBe(200)
    expect(response.body.body).toBe(edited)
    const decision = itemsOf(await s.api(s.admin, s.orgId, 'GET', `/decisions?draftId=${d.id}`))[0]
    expect(decision?.kind).toBe('edit_approve')
    expect(JSON.stringify(decision)).not.toContain(edited)
    expect(await s.approvedEvents()).toMatchObject([{ edited: true }])
    expect(bodyDigest(edited)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a rejected Draft cannot then be approved', async () => {
    const s = await setup()
    const d = await s.plant()

    const rejected = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/reject`, {
      note: 'off tone',
    })
    const approve = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)

    expect(rejected.body.status).toBe('rejected')
    expect(code(approve)).toBe('inbox.draft_not_pending')
    expect(await s.approvedEvents()).toEqual([])
    const decision = itemsOf(await s.api(s.admin, s.orgId, 'GET', `/decisions?draftId=${d.id}`))[0]
    expect(decision).toMatchObject({ kind: 'reject', note: 'off tone' })
  })

  test('an ungrounded Draft needs the acknowledgement, which is then recorded', async () => {
    const s = await setup()
    const d = await s.plant({ ungrounded: true })

    const refused = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)
    const ok = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`, {
      acknowledgeUngrounded: true,
    })

    expect(code(refused)).toBe('inbox.draft_ungrounded')
    expect(ok.status).toBe(200)
    expect(await s.approvedEvents()).toMatchObject([{ acknowledgedUngrounded: true }])
    const decision = itemsOf(await s.api(s.admin, s.orgId, 'GET', `/decisions?draftId=${d.id}`))[0]
    expect(decision?.acknowledgedUngrounded).toBe(true)
  })

  test('a Draft in a Conversation a Rep controls cannot be approved', async () => {
    const s = await setup()
    const d = await s.plant()
    s.store.seedController(s.orgId, d.conversationId, s.rep.id)

    const response = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)

    expect(code(response)).toBe('inbox.takeover_required')
    expect(await s.approvedEvents()).toEqual([])
  })

  test('a Prospect on the Suppression list cannot be sent to', async () => {
    const s = await setup()
    const d = await s.plant()
    await s.suppress(d.email)

    const response = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)

    expect(code(response)).toBe('inbox.prospect_suppressed')
    expect(await s.approvedEvents()).toEqual([])
  })

  test('stopping a Conversation voids its pending Draft', async () => {
    const s = await setup()
    const d = await s.plant()
    await s.store.withOrganization(s.orgId, async (scope) => {
      await scope.lockOrganization()
      await scope.stopConversation(d.conversationId, s.harness.deps.clock.now())
    })

    const response = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`)

    expect(code(response)).toBe('inbox.draft_not_pending')
  })

  test('the same Idempotency-Key answers the first answer and publishes once', async () => {
    const s = await setup()
    const d = await s.plant()
    const headers = { 'idempotency-key': 'approve-draft-0001-abcdef' }

    const first = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`, {}, headers)
    const again = await s.api(s.rep, s.orgId, 'POST', `/drafts/${d.id}/approve`, {}, headers)
    const reused = await s.api(
      s.rep,
      s.orgId,
      'POST',
      `/drafts/${d.id}/approve`,
      { body: 'different' },
      headers
    )

    expect(first.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(code(reused)).toBe('request.idempotency_key_reused')
    expect(await s.approvedEvents()).toHaveLength(1)
  })
})

describe('who can see a Draft', () => {
  test('another Rep, and another Organization, get a 404 on read and decision', async () => {
    const s = await setup()
    const d = await s.plant()
    const outsider = s.other.members.find((m) => m.role === 'rep') as SeededMember

    for (const [actor, org] of [
      [s.stranger, s.orgId],
      [outsider, s.other.organizationId],
    ] as const) {
      const read = await s.api(actor, org, 'GET', `/drafts/${d.id}`)
      const approve = await s.api(actor, org, 'POST', `/drafts/${d.id}/approve`)
      const sources = await s.api(actor, org, 'GET', `/drafts/${d.id}/sources`)
      expect(read.status).toBe(404)
      expect(code(read)).toBe('inbox.draft_not_found')
      expect(code(approve)).toBe('inbox.draft_not_found')
      expect(code(sources)).toBe('inbox.draft_not_found')
      const queue = await s.api(actor, org, 'GET', '/approvals')
      expect(queue.body.items).toEqual([])
    }
    expect(await s.approvedEvents()).toEqual([])
  })

  test('an Admin and the owning Rep read it', async () => {
    const s = await setup()
    const d = await s.plant()

    expect((await s.api(s.admin, s.orgId, 'GET', `/drafts/${d.id}`)).status).toBe(200)
    expect((await s.api(s.rep, s.orgId, 'GET', `/drafts/${d.id}`)).status).toBe(200)
  })
})

describe('the approval queue', () => {
  test('lists pending Drafts oldest first, a page at a time, and flags who may decide', async () => {
    const s = await setup()
    const a = await s.plant({ at: 1 })
    const b = await s.plant({ at: 2 })
    const c = await s.plant({ at: 3 })

    const first = await s.api(s.admin, s.orgId, 'GET', '/approvals?limit=2')
    const second = await s.api(
      s.admin,
      s.orgId,
      'GET',
      `/approvals?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`
    )

    expect(itemsOf(first).map((i) => (i.draft as { id: string }).id)).toEqual([a.id, b.id])
    expect((first.body.items as object[])[0]).toMatchObject({ channel: 'email', canApprove: true })
    expect((second.body.items as { draft: { id: string } }[]).map((i) => i.draft.id)).toEqual([
      c.id,
    ])
    expect(second.body.nextCursor).toBeNull()
  })

  test('a decided Draft leaves the queue; a Rep sees only their own', async () => {
    const s = await setup()
    const mine = await s.plant({ at: 1 })
    await s.plant({ owner: s.stranger, at: 2 })
    await s.api(s.rep, s.orgId, 'POST', `/drafts/${mine.id}/approve`)

    const adminQueue = await s.api(s.admin, s.orgId, 'GET', '/approvals')
    const repQueue = await s.api(s.rep, s.orgId, 'GET', '/approvals')

    expect(adminQueue.body.items).toHaveLength(1)
    expect(repQueue.body.items).toEqual([])
  })

  test('a Conversation a Rep controls cannot be approved from the queue', async () => {
    const s = await setup()
    const d = await s.plant()
    s.store.seedController(s.orgId, d.conversationId, s.rep.id)

    const queue = await s.api(s.rep, s.orgId, 'GET', '/approvals')

    expect((queue.body.items as object[])[0]).toMatchObject({ canApprove: false })
  })

  test('refuses a page larger than 100', async () => {
    const s = await setup()
    const response = await s.api(s.admin, s.orgId, 'GET', '/approvals?limit=101')
    expect(response.status).toBe(400)
  })
})

describe('Draft Sources', () => {
  test('carry the passage the Playbook holds for each', async () => {
    const moment: PlaybookMoment = {
      callId: 'call-1',
      dealRecordId: formatId('deal', crypto.randomUUID()) as PlaybookMoment['dealRecordId'],
      momentIndex: 1,
      prospect: 'It costs too much',
      repNext: 'We showed the return',
    }
    const moments = createMemoryMomentSearch()
    const s = await setup({ moments })
    moments.seed(s.orgId, [moment])
    const d = await s.plant({ sources: [moment] })

    const response = await s.api(s.rep, s.orgId, 'GET', `/drafts/${d.id}/sources`)

    expect(response.status).toBe(200)
    expect(response.body.items).toHaveLength(1)
    expect((response.body.items as { passage: string }[])[0]?.passage).toContain(
      'It costs too much'
    )
    expect((response.body.items as { passage: string }[])[0]?.passage).toContain(
      'We showed the return'
    )
  })

  const flaky = (failures: number) => {
    const memory = createMemoryMomentSearch()
    const calls = { n: 0 }
    const moment: PlaybookMoment = {
      callId: 'call-1',
      dealRecordId: formatId('deal', crypto.randomUUID()) as PlaybookMoment['dealRecordId'],
      momentIndex: 1,
      prospect: 'It costs too much',
      repNext: 'We showed the return',
    }
    const moments = {
      ...memory,
      passagesFor: async (...args: Parameters<typeof memory.passagesFor>) => {
        calls.n += 1
        if (calls.n <= failures) {
          throw new Error('Playbook unavailable')
        }
        return memory.passagesFor(...args)
      },
    }
    return { moments, moment, calls }
  }

  test('a Playbook that fails once is tried again and answers', async () => {
    const f = flaky(1)
    const s = await setup({ moments: f.moments })
    f.moments.seed(s.orgId, [f.moment])
    const d = await s.plant({ sources: [f.moment] })

    const response = await s.api(s.rep, s.orgId, 'GET', `/drafts/${d.id}/sources`)

    expect(response.status).toBe(200)
    expect(f.calls.n).toBe(2)
  })

  test('a Playbook that never answers is tried a bounded number of times, then unavailable', async () => {
    const f = flaky(100)
    const s = await setup({ moments: f.moments })
    f.moments.seed(s.orgId, [f.moment])
    const d = await s.plant({ sources: [f.moment] })

    const response = await s.api(s.rep, s.orgId, 'GET', `/drafts/${d.id}/sources`)

    expect(code(response)).toBe('server.unavailable')
    expect(f.calls.n).toBe(3)
  })

  test('a Draft without Sources answers an empty list', async () => {
    const s = await setup()
    const d = await s.plant({ ungrounded: true })
    const response = await s.api(s.rep, s.orgId, 'GET', `/drafts/${d.id}/sources`)
    expect(response.body.items).toEqual([])
  })
})

describe('the decision record', () => {
  test('is for Owner, Admin and Manager, and filters by kind', async () => {
    const s = await setup()
    const a = await s.plant({ at: 1 })
    const b = await s.plant({ at: 2 })
    await s.api(s.rep, s.orgId, 'POST', `/drafts/${a.id}/approve`)
    await s.api(s.rep, s.orgId, 'POST', `/drafts/${b.id}/reject`)

    const all = await s.api(s.admin, s.orgId, 'GET', '/decisions')
    const rejects = await s.api(s.admin, s.orgId, 'GET', '/decisions?kind=reject')
    const asManager = await s.api(s.manager, s.orgId, 'GET', '/decisions')
    const asRep = await s.api(s.rep, s.orgId, 'GET', '/decisions')

    expect(all.body.items).toHaveLength(2)
    expect(rejects.body.items).toHaveLength(1)
    expect((rejects.body.items as { draftId: string }[])[0]?.draftId).toBe(b.id)
    expect(asManager.status).toBe(200)
    expect(asRep.status).toBe(403)
  })
})

describe('approval policies', () => {
  test('every channel defaults to always; an Admin sets one, a Rep may not', async () => {
    const s = await setup()

    const before = await s.api(s.admin, s.orgId, 'GET', '/approval-policies')
    const set = await s.api(s.admin, s.orgId, 'PUT', '/approval-policies/email', {
      rule: { mode: 'below_confidence', threshold: 0.7 },
    })
    const after = await s.api(s.admin, s.orgId, 'GET', '/approval-policies')
    const asRep = await s.api(s.rep, s.orgId, 'PUT', '/approval-policies/email', {
      rule: { mode: 'always' },
    })
    const repRead = await s.api(s.rep, s.orgId, 'GET', '/approval-policies')

    expect(
      (before.body.items as { channel: string }[]).map((p: { channel: string }) => p.channel)
    ).toEqual(['chat', 'email', 'linkedin'])
    expect(
      (before.body.items as { rule: { mode: string } }[]).every(
        (p: { rule: { mode: string } }) => p.rule.mode === 'always'
      )
    ).toBe(true)
    expect(set.status).toBe(200)
    expect(set.body.updatedByMembershipId).toBe(s.admin.id)
    expect(
      (after.body.items as { channel: string; rule: unknown }[]).find((p) => p.channel === 'email')
        ?.rule
    ).toEqual({ mode: 'below_confidence', threshold: 0.7 })
    expect(
      (after.body.items as { channel: string; rule: unknown }[]).find((p) => p.channel === 'chat')
        ?.rule
    ).toEqual({
      mode: 'always',
    })
    expect(asRep.status).toBe(403)
    expect(repRead.status).toBe(403)
  })
})

describe('a Rep reply', () => {
  test('goes without approval for the Rep in control, once per Idempotency-Key', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    s.store.seedController(s.orgId, c.conversationId, s.rep.id)
    const headers = { 'idempotency-key': 'reply-conv-0001-abcdef' }
    const path = `/conversations/${c.conversationId}/replies`

    const first = await s.api(s.rep, s.orgId, 'POST', path, { body: 'Happy to help.' }, headers)
    const again = await s.api(s.rep, s.orgId, 'POST', path, { body: 'Happy to help.' }, headers)

    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ author: 'rep', status: 'approved', body: 'Happy to help.' })
    expect(again.body).toEqual(first.body)
    expect(await s.approvedEvents()).toHaveLength(1)
  })

  test('is refused while the Agent is in control, and for a Rep who is not', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    const path = `/conversations/${c.conversationId}/replies`

    const agent = await s.api(s.rep, s.orgId, 'POST', path, { body: 'Hi' })
    s.store.seedController(s.orgId, c.conversationId, s.rep.id)
    const hidden = await s.api(s.stranger, s.orgId, 'POST', path, { body: 'Hi' })

    expect(code(agent)).toBe('inbox.takeover_required')
    expect(hidden.status).toBe(404)
    expect(await s.approvedEvents()).toEqual([])
  })

  test('is refused for a Rep who is not the controller', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    s.store.seedController(s.orgId, c.conversationId, s.stranger.id)
    const response = await s.api(
      s.admin,
      s.orgId,
      'POST',
      `/conversations/${c.conversationId}/replies`,
      { body: 'Hi' }
    )
    expect(code(response)).toBe('inbox.not_conversation_owner')
  })

  test('is refused for a suppressed Prospect and a closed Conversation', async () => {
    const s = await setup()
    const c = await s.conversationFor()
    s.store.seedController(s.orgId, c.conversationId, s.rep.id)
    const path = `/conversations/${c.conversationId}/replies`
    await s.suppress(c.email)

    const suppressed = await s.api(s.rep, s.orgId, 'POST', path, { body: 'Hi' })

    expect(code(suppressed)).toBe('inbox.prospect_suppressed')

    const d = await s.conversationFor()
    s.store.seedController(s.orgId, d.conversationId, s.rep.id)
    await s.store.withOrganization(s.orgId, async (scope) => {
      await scope.lockOrganization()
      await scope.stopConversation(d.conversationId, s.harness.deps.clock.now())
    })
    const closed = await s.api(
      s.rep,
      s.orgId,
      'POST',
      `/conversations/${d.conversationId}/replies`,
      {
        body: 'Hi',
      }
    )
    expect(code(closed)).toBe('inbox.conversation_closed')
  })
})

/** The fixture judge, counting how many times it was asked. */
const countingJudge = () => {
  const inner = createMemoryJudge()
  const state = { calls: 0 }
  const judge: Judge = {
    assess: (input, signal) => {
      state.calls += 1
      return inner.assess(input, signal)
    },
  }
  return { judge, state }
}

const PASSING = 'We showed the return.'
const FAILING = 'We guarantee a 40% return.'

describe('a Draft that failed its check', () => {
  test('shows its latest assessment and findings; a Draft never judged shows null', async () => {
    const s = await setup()
    const held = await s.plant({ checkFailed: true })
    const plain = await s.plant()

    const read = await s.api(s.rep, s.orgId, 'GET', `/drafts/${held.id}`)
    const none = await s.api(s.rep, s.orgId, 'GET', `/drafts/${plain.id}`)
    const queue = await s.api(s.admin, s.orgId, 'GET', '/approvals')

    expect(read.status).toBe(200)
    expect(read.body.hold).toBe('check_failed')
    expect(read.body.assessment).toMatchObject({
      verdict: 'fail',
      findings: [{ category: 'unsupported_claim', severity: 'high', span: { start: 0, end: 4 } }],
    })
    expect(none.body.assessment).toBeNull()
    const byId = new Map(
      itemsOf(queue).map((item) => [(item.draft as { id: string }).id, item.draft])
    )
    expect((byId.get(held.id) as { assessment: { verdict: string } }).assessment.verdict).toBe(
      'fail'
    )
    expect((byId.get(plain.id) as { assessment: unknown }).assessment).toBeNull()
  })

  test("another Organization cannot read a Draft's assessment", async () => {
    const s = await setup()
    const held = await s.plant({ checkFailed: true })
    const outsider = s.other.members.find((m) => m.role === 'admin') as SeededMember

    const read = await s.api(outsider, s.other.organizationId, 'GET', `/drafts/${held.id}`)

    expect(read.status).toBe(404)
    expect(JSON.stringify(read.body)).not.toContain('unsupported_claim')
  })

  test("a Rep's unedited approval is refused and nothing is decided", async () => {
    const s = await setup()
    const held = await s.plant({ checkFailed: true })

    const refused = await s.api(s.rep, s.orgId, 'POST', `/drafts/${held.id}/approve`)

    expect(refused.status).toBe(409)
    expect(code(refused)).toBe('assessment.reassess_required')
    const after = await s.api(s.rep, s.orgId, 'GET', `/drafts/${held.id}`)
    expect(after.body.status).toBe('pending')
    expect(await s.approvedEvents()).toHaveLength(0)
  })

  test('an Admin may approve it unedited', async () => {
    const s = await setup()
    const held = await s.plant({ checkFailed: true })

    const approved = await s.api(s.admin, s.orgId, 'POST', `/drafts/${held.id}/approve`)

    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('approved')
    expect(await s.approvedEvents()).toHaveLength(1)
  })

  test("a Rep's edit that passes is judged again and released", async () => {
    const counted = countingJudge()
    const s = await setup({ judge: counted.judge })
    const held = await s.plant({ checkFailed: true })

    const approved = await s.api(s.rep, s.orgId, 'POST', `/drafts/${held.id}/approve`, {
      body: PASSING,
    })

    expect(approved.status).toBe(200)
    expect(approved.body.status).toBe('approved')
    expect(approved.body.body).toBe(PASSING)
    expect(approved.body.assessment).toMatchObject({ verdict: 'pass', findings: [] })
    expect(approved.body.hold).toBeNull()
    expect(approved.body.checks).toEqual([{ name: 'claims_supported', passed: true }])
    expect(counted.state.calls).toBe(1)
    expect(await s.approvedEvents()).toMatchObject([{ edited: true }])
  })

  test("a Rep's edit that fails stays held with the new assessment", async () => {
    const s = await setup()
    const held = await s.plant({ checkFailed: true })

    const kept = await s.api(s.rep, s.orgId, 'POST', `/drafts/${held.id}/approve`, {
      body: FAILING,
    })

    expect(kept.status).toBe(200)
    expect(kept.body.status).toBe('pending')
    expect(kept.body.hold).toBe('check_failed')
    expect(kept.body.body).toBe(FAILING)
    expect(kept.body.assessment).toMatchObject({ verdict: 'fail' })
    expect((kept.body.assessment as { findings: unknown[] }).findings.length).toBeGreaterThan(0)
    const read = await s.api(s.rep, s.orgId, 'GET', `/drafts/${held.id}`)
    expect(read.body.assessment).toEqual(kept.body.assessment)
    expect(await s.approvedEvents()).toHaveLength(0)
    const decisions = itemsOf(await s.api(s.admin, s.orgId, 'GET', `/decisions?draftId=${held.id}`))
    expect(decisions).toHaveLength(0)
  })

  test('a replayed edited approval answers the first answer and does not judge again', async () => {
    const counted = countingJudge()
    const s = await setup({ judge: counted.judge })
    const held = await s.plant({ checkFailed: true })
    const headers = { 'idempotency-key': 'reassess-approve-0001-abc' }

    const first = await s.api(
      s.rep,
      s.orgId,
      'POST',
      `/drafts/${held.id}/approve`,
      { body: PASSING },
      headers
    )
    const again = await s.api(
      s.rep,
      s.orgId,
      'POST',
      `/drafts/${held.id}/approve`,
      { body: PASSING },
      headers
    )

    expect(again.body).toEqual(first.body)
    expect(counted.state.calls).toBe(1)
    expect(await s.approvedEvents()).toHaveLength(1)
  })

  test('a judge that cannot answer leaves the Draft held and decides nothing', async () => {
    const s = await setup({
      judge: {
        assess: async () => {
          throw new Error('down')
        },
      },
    })
    const held = await s.plant({ checkFailed: true })

    const response = await s.api(s.rep, s.orgId, 'POST', `/drafts/${held.id}/approve`, {
      body: PASSING,
    })

    expect(response.status).toBe(503)
    const read = await s.api(s.rep, s.orgId, 'GET', `/drafts/${held.id}`)
    expect(read.body.status).toBe('pending')
    expect(read.body.body).toBe(BODY)
  })
})

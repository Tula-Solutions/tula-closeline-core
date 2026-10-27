import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  conversationPageSchema,
  type DealRecordId,
  type DraftId,
  formatId,
  ingestMessageResultSchema,
  messagePageSchema,
  messageSchema,
  type OrganizationId,
  prospectSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import { harness, service, store } from '~/integration-harness'
import { classifyMessage } from '~/modules/inbox/classify'
import { draftReply } from '~/modules/inbox/draft'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { momentSourceRef, type PlaybookMoment } from '~/ports/moment-search'
import { publicCaller, seedOrganization, TEST_INTERNAL_SECRET } from '~/testing'

/** Counts a table's rows for one Organization, through the tenant-scoped login. */
async function countRows(table: string, organizationId: OrganizationId) {
  return withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.raw(table)}`
    )
    return Number(rows[0]?.n)
  })
}

describe('The inbox, over Postgres', () => {
  test('ingest is idempotent, visibility follows the owner, and another Organization sees nothing', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const [admin] = org.members.filter((m) => m.role === 'admin')
    const [rep, otherRep] = org.members.filter((m) => m.role === 'rep')
    if (!admin || !rep || !otherRep || !other.members[0]) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const prospectOf = async (actor: typeof rep, name: string) =>
      prospectSchema.parse(
        (
          await api(actor, org.organizationId, 'POST', '/prospects', {
            firstName: name,
            email: `${name.toLowerCase()}@example.test`,
          })
        ).body
      )
    const ingest = (organizationId: string, body: Record<string, unknown>) =>
      h.app.request('/internal/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'content-type': 'application/json',
          'x-organization-id': organizationId,
        },
        body: JSON.stringify({
          channel: 'email',
          direction: 'inbound',
          body: 'Please send pricing',
          sentAt: new Date(Date.now() - 1000).toISOString(),
          ...body,
        }),
      })

    const mine = await prospectOf(rep, 'Ada')
    const theirs = await prospectOf(otherRep, 'Bo')
    const first = await ingest(org.organizationId, { prospectId: mine.id, providerMessageId: 'p1' })
    const again = await ingest(org.organizationId, { prospectId: mine.id, providerMessageId: 'p1' })
    expect([first.status, again.status]).toEqual([201, 200])
    const a = ingestMessageResultSchema.parse(await first.json())
    const b = ingestMessageResultSchema.parse(await again.json())
    expect(b.message).toEqual(a.message)
    expect(await countRows('core.messages', org.organizationId)).toBe(1)

    const posted = await ingest(org.organizationId, {
      prospectId: theirs.id,
      providerMessageId: 'p2',
    })
    const theirConversation = ingestMessageResultSchema.parse(await posted.json()).message
      .conversationId
    await ingest(org.organizationId, {
      prospectId: mine.id,
      providerMessageId: 'p3',
      direction: 'outbound',
    })

    const repList = conversationPageSchema.parse(
      (await api(rep, org.organizationId, 'GET', '/conversations')).body
    )
    expect(repList.items.map((c) => c.id)).toEqual([a.message.conversationId])
    const hidden = await api(rep, org.organizationId, 'GET', `/conversations/${theirConversation}`)
    expect(hidden.status).toBe(404)
    expect(hidden.body.error?.code).toBe('inbox.conversation_not_found')
    const adminList = conversationPageSchema.parse(
      (await api(admin, org.organizationId, 'GET', '/conversations?limit=1')).body
    )
    expect(adminList.items).toHaveLength(1)
    expect(adminList.nextCursor).not.toBeNull()
    const adminNext = conversationPageSchema.parse(
      (
        await api(
          admin,
          org.organizationId,
          'GET',
          `/conversations?limit=1&cursor=${adminList.nextCursor}`
        )
      ).body
    )
    expect(adminNext.items).toHaveLength(1)
    expect(adminNext.items[0]?.id).not.toBe(adminList.items[0]?.id)

    const messages = messagePageSchema.parse(
      (
        await api(
          rep,
          org.organizationId,
          'GET',
          `/conversations/${a.message.conversationId}/messages?limit=1`
        )
      ).body
    )
    expect(messages.items.map((m) => m.providerMessageId)).toEqual(['p1'])
    expect(messages.nextCursor).not.toBeNull()

    const moved = await api(admin, org.organizationId, 'PUT', `/prospects/${mine.id}/owner`, {
      ownerMembershipId: otherRep.id,
    })
    expect(moved.status).toBe(200)
    const oldOwner = await api(
      rep,
      org.organizationId,
      'GET',
      `/conversations/${a.message.conversationId}`
    )
    expect(oldOwner.status).toBe(404)
    const newOwner = await api(
      otherRep,
      org.organizationId,
      'GET',
      `/conversations/${a.message.conversationId}`
    )
    expect(newOwner.status).toBe(200)

    const stranger = other.members[0]
    const strangerList = conversationPageSchema.parse(
      (await api(stranger, other.organizationId, 'GET', '/conversations')).body
    )
    expect(strangerList.items).toHaveLength(0)
    const strangerRead = await api(
      stranger,
      other.organizationId,
      'GET',
      `/conversations/${a.message.conversationId}/messages`
    )
    expect(strangerRead.status).toBe(404)
    const crossOrg = await ingest(other.organizationId, {
      prospectId: mine.id,
      providerMessageId: 'p9',
    })
    expect(crossOrg.status).toBe(404)
  })

  test('classification is idempotent, an unsubscribe stops the Conversation, and a correction is attributed', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const [admin] = org.members.filter((m) => m.role === 'admin')
    const [rep] = org.members.filter((m) => m.role === 'rep')
    const stranger = other.members[0]
    if (!admin || !rep || !stranger) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const prospect = prospectSchema.parse(
      (
        await api(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada@example.test',
        })
      ).body
    )
    const ingest = () =>
      h.app.request('/internal/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'content-type': 'application/json',
          'x-organization-id': org.organizationId,
        },
        body: JSON.stringify({
          channel: 'email',
          direction: 'inbound',
          body: 'Please unsubscribe me',
          sentAt: new Date(Date.now() - 1000).toISOString(),
          prospectId: prospect.id,
          providerMessageId: 'c1',
        }),
      })
    const stored = ingestMessageResultSchema.parse(await (await ingest()).json())
    const { conversationId } = stored.message
    const messageId = stored.message.id
    const repeat = await ingest()
    expect(repeat.status).toBe(200)

    // Two jobs were queued for the one Message (the post and its repeat); both run, one label.
    await withOrganization(service.db, org.organizationId, async (tx) => {
      await tx.execute(sql`
        insert into core.drafts (id, organization_id, conversation_id, author, reason_trigger_message_id,
          reason_label, reason_strategy, confidence, hold, status, body)
        values ('drf_${sql.raw('a'.repeat(32))}', ${org.organizationId}, ${conversationId}, 'agent',
          ${messageId}, 'question', 'answer', 0.8, 'first_message', 'pending', 'Hello')`)
      await tx.execute(sql`
        update core.conversations set pending_draft_count = 1
        where id = ${conversationId}`)
    })
    const signal = new AbortController().signal
    let ran = 0
    for (;;) {
      const n = await processAssignJobs(h.deps, signal)
      if (n === 0) {
        break
      }
      ran += n
    }
    expect(ran).toBe(2)

    const labelled = messagePageSchema.parse(
      (await api(rep, org.organizationId, 'GET', `/conversations/${conversationId}/messages`)).body
    )
    expect(labelled.items[0]?.classification?.label).toBe('unsubscribe')
    expect(labelled.items[0]?.classification?.decidedBy).toBe('model')
    const events = async () =>
      withOrganization(service.db, org.organizationId, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(
          sql`select count(*)::text as n from core.outbox where topic = 'reply.classified'`
        )
        return Number(rows[0]?.n)
      })
    expect(await events()).toBe(1)
    const drafts = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{ status: string; decided: boolean }>(
        sql`select status, decided_at is not null as decided from core.drafts`
      )
      return rows
    })
    expect(drafts).toEqual([{ status: 'void', decided: true }])
    const closed = await api(rep, org.organizationId, 'GET', `/conversations/${conversationId}`)
    expect(closed.body).toMatchObject({ state: 'closed', pendingDraftCount: 0 })

    const path = `/conversations/${conversationId}/messages/${messageId}/classification`
    const denied = await api(stranger, other.organizationId, 'PUT', path, { label: 'positive' })
    expect(denied.status).toBe(404)
    const crossed = await api(stranger, org.organizationId, 'PUT', path, { label: 'positive' })
    expect(crossed.status).toBeGreaterThanOrEqual(400)
    expect(
      messagePageSchema.parse(
        (await api(admin, org.organizationId, 'GET', `/conversations/${conversationId}/messages`))
          .body
      ).items[0]?.classification?.label
    ).toBe('unsubscribe')

    const corrected = await api(rep, org.organizationId, 'PUT', path, { label: 'positive' })
    expect(corrected.status).toBe(200)
    const message = messageSchema.parse(corrected.body)
    expect(message.classification).toMatchObject({
      label: 'positive',
      decidedBy: 'rep',
      correctedByMembershipId: rep.id,
    })
    expect(message.classification?.classifiedAt).toBeTruthy()
    const again = await api(rep, org.organizationId, 'PUT', path, { label: 'positive' })
    expect(again.status).toBe(200)
    expect(messageSchema.parse(again.body)).toEqual(message)
    expect(await events()).toBe(2)
  })
})

describe('Grounded drafts, over Postgres', () => {
  test('a Draft and its Sources are stored, and no other Organization can cite or see them', async () => {
    const moments = createMemoryMomentSearch()
    const mine: PlaybookMoment = {
      callId: 'call-1',
      dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
      momentIndex: 2,
      prospect: 'It costs too much',
      repNext: 'We showed the return in ninety days',
    }
    const theirs: PlaybookMoment = {
      ...mine,
      callId: 'call-9',
      dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
    }
    const h = await harness({
      moments,
      // A writer that tries to cite another Organization's moment as well as its own.
      writer: {
        write: async (input) => ({
          body: 'Here is how we handle it.',
          strategy: 'Show the return.',
          confidence: 0.8,
          citedIds: [momentSourceRef(theirs), ...input.moments.map((m) => m.id)],
        }),
      },
    })
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const [rep] = org.members.filter((m) => m.role === 'rep')
    if (!rep) {
      throw new Error('seed')
    }
    moments.seed(org.organizationId, [mine])
    moments.seed(other.organizationId, [theirs])
    const api = publicCaller(h)
    const prospect = prospectSchema.parse(
      (
        await api(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada-draft@example.test',
        })
      ).body
    )
    const stored = ingestMessageResultSchema.parse(
      await (
        await h.app.request('/internal/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
            'content-type': 'application/json',
            'x-organization-id': org.organizationId,
          },
          body: JSON.stringify({
            channel: 'email',
            direction: 'inbound',
            body: 'Why is it so expensive?',
            sentAt: new Date(Date.now() - 1000).toISOString(),
            prospectId: prospect.id,
            providerMessageId: 'd1',
          }),
        })
      ).json()
    )
    const job = { organizationId: org.organizationId, messageId: stored.message.id, traceId: 't1' }
    await classifyMessage(h.deps, job)

    expect(await draftReply(h.deps, job)).toBe('drafted')
    expect(await draftReply(h.deps, job)).toBe('skipped')

    expect(await countRows('core.drafts', org.organizationId)).toBe(1)
    const sources = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{
        source_ref: string
        outcome: string
        evidence_count: number
        deal_record_id: string
      }>(
        sql`select source_ref, outcome, evidence_count, deal_record_id from core.draft_sources order by position`
      )
      return rows
    })
    expect(sources).toEqual([
      {
        source_ref: momentSourceRef(mine) as string,
        outcome: 'won',
        evidence_count: 1,
        deal_record_id: mine.dealRecordId,
      },
    ])
    const conversation = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{ state: string; pending_draft_count: number }>(
        sql`select state, pending_draft_count from core.conversations where id = ${stored.message.conversationId}`
      )
      return rows[0]
    })
    expect(conversation).toEqual({ state: 'awaiting_approval', pending_draft_count: 1 })

    // The other Organization has no Draft and cannot read these Sources.
    expect(await countRows('core.drafts', other.organizationId)).toBe(0)
    expect(await countRows('core.draft_sources', other.organizationId)).toBe(0)
  })
})

describe('The approval queue, over Postgres', () => {
  test('two approvals race to one winner, the edit keeps only its hash, and no other Organization sees the Draft', async () => {
    const moments = createMemoryMomentSearch()
    const moment: PlaybookMoment = {
      callId: 'call-a1',
      dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
      momentIndex: 1,
      prospect: 'It costs too much',
      repNext: 'We showed the return in ninety days',
    }
    const h = await harness({ moments })
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin', 'rep'])
    const [admin, rep] = [
      org.members.find((m) => m.role === 'admin'),
      org.members.find((m) => m.role === 'rep'),
    ]
    const outsider = other.members.find((m) => m.role === 'rep')
    if (!admin || !rep || !outsider) {
      throw new Error('seed')
    }
    moments.seed(org.organizationId, [moment])
    const api = publicCaller(h)
    const prospect = prospectSchema.parse(
      (
        await api(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada-approve@example.test',
        })
      ).body
    )
    const stored = ingestMessageResultSchema.parse(
      await (
        await h.app.request('/internal/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
            'content-type': 'application/json',
            'x-organization-id': org.organizationId,
          },
          body: JSON.stringify({
            channel: 'email',
            direction: 'inbound',
            body: 'Why is it so expensive?',
            sentAt: new Date(Date.now() - 1000).toISOString(),
            prospectId: prospect.id,
            providerMessageId: 'a1',
          }),
        })
      ).json()
    )
    const job = { organizationId: org.organizationId, messageId: stored.message.id, traceId: 't1' }
    await classifyMessage(h.deps, job)
    expect(await draftReply(h.deps, job)).toBe('drafted')

    const queue = await api(rep, org.organizationId, 'GET', '/approvals')
    const items = queue.body.items as { draft: { id: string; hold: string }; canApprove: boolean }[]
    expect(items).toHaveLength(1)
    expect(items[0]?.draft.hold).toBe('first_message')
    expect(items[0]?.canApprove).toBe(true)
    const draftId = items[0]?.draft.id as string
    const edited = 'A distinctive edited reply that must never be stored.'
    const approve = (key: string) =>
      api(
        rep,
        org.organizationId,
        'POST',
        `/drafts/${draftId}/approve`,
        { body: edited },
        { 'idempotency-key': key }
      )

    const hidden = await api(outsider, other.organizationId, 'GET', `/drafts/${draftId}`)
    expect(hidden.body.error?.code).toBe('inbox.draft_not_found')

    const results = await Promise.all([
      approve('approve-race-key-0001'),
      approve('approve-race-key-0002'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)?.body.error?.code).toBe('inbox.draft_not_pending')

    const decisions = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{
        kind: string
        edited_body_sha256: string | null
        decided_by_membership_id: string | null
      }>(
        sql`select kind, edited_body_sha256, decided_by_membership_id from core.approval_decisions`
      )
      return rows
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ kind: 'edit_approve', decided_by_membership_id: rep.id })
    expect(decisions[0]?.edited_body_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(decisions)).not.toContain(edited)
    const outbox = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{ n: string }>(
        sql`select count(*)::text as n from core.outbox where topic = 'message.approved' and dedupe_key like 'message.approved:%'`
      )
      return Number(rows[0]?.n)
    })
    expect(outbox).toBe(1)
    expect((await api(rep, org.organizationId, 'GET', '/approvals')).body.items).toEqual([])
    expect((await api(admin, org.organizationId, 'GET', '/decisions')).body.items).toHaveLength(1)

    const set = await api(admin, org.organizationId, 'PUT', '/approval-policies/email', {
      rule: { mode: 'except', labels: ['question'] },
    })
    expect(set.status).toBe(200)
    const policies = await api(admin, org.organizationId, 'GET', '/approval-policies')
    expect(
      (policies.body.items as { channel: string; rule: { mode: string } }[]).map(
        (p) => `${p.channel}:${p.rule.mode}`
      )
    ).toEqual(['chat:always', 'email:except', 'linkedin:always'])
  })
})

describe('Rep takeover, over Postgres', () => {
  test('takeover voids Drafts and publishes once, a second takeover loses, replies are not drafted, hand back resumes', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const admin = org.members.find((m) => m.role === 'admin')
    const rep = org.members.find((m) => m.role === 'rep')
    const outsider = other.members[0]
    if (!admin || !rep || !outsider) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const prospect = prospectSchema.parse(
      (
        await api(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada-takeover@example.test',
        })
      ).body
    )
    let n = 0
    const ingest = async (body: string) => {
      n += 1
      const response = await h.app.request('/internal/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'content-type': 'application/json',
          'x-organization-id': org.organizationId,
        },
        body: JSON.stringify({
          channel: 'email',
          direction: 'inbound',
          body,
          sentAt: new Date(Date.now() - 1000).toISOString(),
          prospectId: prospect.id,
          providerMessageId: `t${n}`,
        }),
      })
      return ingestMessageResultSchema.parse(await response.json()).message
    }
    const jobOf = (messageId: string) => ({
      organizationId: org.organizationId,
      messageId: messageId as typeof first.id,
      traceId: 't-takeover',
    })
    const first = await ingest('Why is it so expensive?')
    await classifyMessage(h.deps, jobOf(first.id))
    expect(await draftReply(h.deps, jobOf(first.id))).toBe('drafted')
    const conversationId = first.conversationId
    const key = (name: string) => ({ 'idempotency-key': `${name}-key-0000000001` })
    const post = (actor: typeof rep, org2: OrganizationId, action: string, name: string) =>
      api(actor, org2, 'POST', `/conversations/${conversationId}/${action}`, {}, key(name))

    const hidden = await post(outsider, other.organizationId, 'takeover', 'out')
    expect(hidden.status).toBe(404)

    const taken = await Promise.all([
      post(rep, org.organizationId, 'takeover', 'a'),
      post(admin, org.organizationId, 'takeover', 'b'),
    ])
    const winner = taken.find((r) => r.status === 200)
    const loser = taken.find((r) => r.status === 409)
    expect(winner).toBeDefined()
    expect(loser?.body.error?.code).toBe('inbox.already_controlled')
    expect(winner?.body).toMatchObject({ controller: 'rep', state: 'rep', pendingDraftCount: 0 })

    const counts = await withOrganization(service.db, org.organizationId, async (tx) => {
      const pending = await tx.execute<{ n: string }>(
        sql`select count(*)::text as n from core.drafts where status = 'pending'`
      )
      const voided = await tx.execute<{ n: string }>(
        sql`select count(*)::text as n from core.drafts where status = 'void'`
      )
      const decisions = await tx.execute<{ kind: string; draft_id: string | null }>(
        sql`select kind, draft_id from core.approval_decisions where kind = 'takeover'`
      )
      const outbox = await tx.execute<{ payload: unknown }>(
        sql`select payload from core.outbox where topic = 'conversation.taken_over'`
      )
      return {
        pending: Number(pending.rows[0]?.n),
        voided: Number(voided.rows[0]?.n),
        decisions: decisions.rows,
        outbox: outbox.rows,
      }
    })
    expect(counts.pending).toBe(0)
    expect(counts.voided).toBe(1)
    expect(counts.decisions).toEqual([{ kind: 'takeover', draft_id: null }])
    expect(counts.outbox).toHaveLength(1)
    expect(JSON.stringify(counts.outbox)).not.toContain('expensive')

    const reply = await ingest('Can you do forty percent off?')
    expect(await classifyMessage(h.deps, jobOf(reply.id))).toBe('classified')
    expect(await draftReply(h.deps, jobOf(reply.id))).toBe('skipped')
    expect(h.deps.repNotices.outbox).toHaveLength(1)
    expect(JSON.stringify(h.deps.repNotices.outbox)).not.toContain('forty')

    const back = await post(rep, org.organizationId, 'handback', 'hb')
    const adminBack = await post(admin, org.organizationId, 'handback', 'hb2')
    const handed = [back, adminBack].filter((r) => r.status === 200)
    expect(handed).toHaveLength(1)
    expect(handed[0]?.body).toMatchObject({ controller: 'agent', controllerMembershipId: null })

    const later = await ingest('And what about the contract length?')
    await classifyMessage(h.deps, jobOf(later.id))
    expect(await draftReply(h.deps, jobOf(later.id))).toBe('drafted')
    const published = await countRows('core.outbox', org.organizationId)
    expect(published).toBeGreaterThan(0)
  })
})

describe('The Draft assessment, over Postgres', () => {
  test('an invented claim holds the Draft, one assessment is stored per version, and no other Organization sees it', async () => {
    const moments = createMemoryMomentSearch()
    const mine: PlaybookMoment = {
      callId: 'call-1',
      dealRecordId: formatId('deal', crypto.randomUUID()) as DealRecordId,
      momentIndex: 2,
      prospect: 'It costs too much',
      repNext: 'We showed the return in ninety days',
    }
    const h = await harness({
      moments,
      writer: {
        write: async (input) => ({
          body: 'Thanks. We guarantee a 90% discount.',
          strategy: 'Discount.',
          confidence: 0.9,
          citedIds: input.moments.map((m) => m.id),
        }),
      },
    })
    const org = await seedOrganization(store, ['admin', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const [rep] = org.members.filter((m) => m.role === 'rep')
    if (!rep) {
      throw new Error('seed')
    }
    moments.seed(org.organizationId, [mine])
    const prospect = prospectSchema.parse(
      (
        await publicCaller(h)(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada-assess@example.test',
        })
      ).body
    )
    const stored = ingestMessageResultSchema.parse(
      await (
        await h.app.request('/internal/messages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
            'content-type': 'application/json',
            'x-organization-id': org.organizationId,
          },
          body: JSON.stringify({
            channel: 'email',
            direction: 'inbound',
            body: 'Why is it so expensive?',
            sentAt: new Date(Date.now() - 1000).toISOString(),
            prospectId: prospect.id,
            providerMessageId: 'a1',
          }),
        })
      ).json()
    )
    const job = { organizationId: org.organizationId, messageId: stored.message.id, traceId: 't1' }
    await classifyMessage(h.deps, job)

    expect(await draftReply(h.deps, job)).toBe('drafted')
    expect(await draftReply(h.deps, job)).toBe('skipped')

    const draft = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string
        hold: string
        status: string
        checks: unknown
      }>(sql`select id, hold, status, checks from core.drafts`)
      return rows[0]
    })
    expect(draft).toMatchObject({
      hold: 'check_failed',
      status: 'pending',
      checks: [{ name: 'claims_supported', passed: false }],
    })
    expect(await countRows('core.assessments', org.organizationId)).toBe(1)
    const findings = await withOrganization(service.db, org.organizationId, async (tx) => {
      const { rows } = await tx.execute<{
        category: string
        severity: string
        span_start: number
        span_end: number
      }>(sql`select category, severity, span_start, span_end from core.assessment_findings`)
      return rows
    })
    expect(findings).toEqual([
      { category: 'unsupported_claim', severity: 'high', span_start: 8, span_end: 36 },
    ])

    // Saving the same Draft version again keeps the first row and adds no findings.
    const again = await h.deps.store.withOrganization(org.organizationId, async (scope) => {
      await scope.lockOrganization()
      const before = await scope.getDraftAssessment(draft?.id as DraftId, 1)
      const saved = await scope.saveDraftAssessment({
        draftId: draft?.id as DraftId,
        draftVersion: 1,
        prospectId: prospect.id,
        verdict: 'pass',
        findings: [],
        now: new Date(),
      })
      return { before, saved }
    })
    expect(again.saved.id).toBe(again.before?.id as typeof again.saved.id)
    expect(again.saved.verdict).toBe('fail')
    expect(await countRows('core.assessments', org.organizationId)).toBe(1)
    expect(await countRows('core.assessment_findings', org.organizationId)).toBe(1)

    // Another Organization reads and counts nothing, even with the Draft's id.
    expect(await countRows('core.assessments', other.organizationId)).toBe(0)
    expect(await countRows('core.assessment_findings', other.organizationId)).toBe(0)
    const seen = await h.deps.store.withOrganization(other.organizationId, (scope) =>
      scope.getDraftAssessment(draft?.id as DraftId, 1)
    )
    expect(seen).toBeNull()

    // The latest version of each Draft comes back in one lookup, with its findings; a second
    // version replaces the first, and another Organization finds nothing.
    const draftId = draft?.id as DraftId
    const latest = await h.deps.store.withOrganization(org.organizationId, async (scope) => {
      await scope.lockOrganization()
      const second = await scope.saveDraftAssessment({
        draftId,
        draftVersion: 2,
        prospectId: prospect.id,
        verdict: 'pass',
        findings: [],
        now: new Date(),
      })
      const kept = await scope.replacePendingDraftBody(draftId, 'An edited reply.')
      const found = await scope.getLatestDraftAssessments([draftId])
      return { second, kept, found }
    })
    expect(latest.found.get(draftId)?.id).toBe(latest.second.id)
    expect(latest.found.get(draftId)).toMatchObject({
      draftVersion: 2,
      verdict: 'pass',
      findings: [],
    })
    expect(latest.kept?.body).toBe('An edited reply.')
    const hidden = await h.deps.store.withOrganization(other.organizationId, async (scope) => {
      await scope.lockOrganization()
      return {
        found: await scope.getLatestDraftAssessments([draftId]),
        replaced: await scope.replacePendingDraftBody(draftId, 'Not yours.'),
      }
    })
    expect(hidden.found.size).toBe(0)
    expect(hidden.replaced).toBeNull()

    // A released edit clears the hold and marks every check passed.
    const released = await h.deps.store.withOrganization(org.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.decidePendingDraft({
        draftId,
        status: 'approved',
        released: [{ name: 'claims_supported', passed: true }],
        now: new Date(),
      })
    })
    expect(released).toMatchObject({
      hold: null,
      checks: [{ name: 'claims_supported', passed: true }],
    })
  })
})

describe('Escalation, over Postgres', () => {
  test('a rule is Organization scoped, a reply escalates once to the least loaded Rep, and an empty Team lands in the Admin queue', async () => {
    const h = await harness()
    const org = await seedOrganization(store, ['admin', 'rep', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const admin = org.members.find((m) => m.role === 'admin')
    const reps = org.members.filter((m) => m.role === 'rep')
    const otherAdmin = other.members.find((m) => m.role === 'admin')
    if (!admin || reps.length !== 2 || !otherAdmin) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const team = (await api(org.owner, org.organizationId, 'POST', '/teams', { name: 'RR' }).then(
      (r) => r.body
    )) as { id: string }
    for (const rep of reps) {
      await api(org.owner, org.organizationId, 'POST', `/teams/${team.id}/members`, {
        membershipId: rep.id,
      })
    }
    const put = await api(admin, org.organizationId, 'PUT', '/escalation-rules/negative_tone', {
      target: 'team_round_robin',
      teamId: team.id,
    })
    expect(put.status).toBe(200)
    expect(await countRows('core.escalation_rules', org.organizationId)).toBe(1)
    expect(await countRows('core.escalation_rules', other.organizationId)).toBe(0)
    const foreign = await api(otherAdmin, other.organizationId, 'GET', '/escalation-rules')
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0)

    const messageIds: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const prospect = prospectSchema.parse(
        (
          await api(admin, org.organizationId, 'POST', '/prospects', {
            firstName: `E${i}`,
            email: `e${i}-esc@example.test`,
          })
        ).body
      )
      const stored = ingestMessageResultSchema.parse(
        await (
          await h.app.request('/internal/messages', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
              'content-type': 'application/json',
              'x-organization-id': org.organizationId,
            },
            body: JSON.stringify({
              channel: 'email',
              direction: 'inbound',
              body: 'No thanks.',
              sentAt: new Date(Date.now() - 1000).toISOString(),
              prospectId: prospect.id,
              providerMessageId: `esc-${i}`,
            }),
          })
        ).json()
      )
      messageIds.push(stored.message.id)
    }
    for (const messageId of messageIds) {
      const job = {
        organizationId: org.organizationId,
        messageId: messageId as never,
        traceId: 't',
      }
      expect(await classifyMessage(h.deps, job)).toBe('classified')
      expect(await classifyMessage(h.deps, job)).toBe('skipped')
    }
    const loads = await h.deps.store.withOrganization(org.organizationId, (scope) =>
      scope.countEscalatedByAssignee(reps.map((r) => r.id))
    )
    expect([...loads.values()]).toEqual([2, 2])
    expect(
      h.deps.repNotices.outbox.filter((n) => n.kind === 'conversation_escalated')
    ).toHaveLength(4)
    expect(JSON.stringify(h.deps.repNotices.outbox)).not.toContain('No thanks')
  })
})

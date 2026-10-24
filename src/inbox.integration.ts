import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  conversationPageSchema,
  type DealRecordId,
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

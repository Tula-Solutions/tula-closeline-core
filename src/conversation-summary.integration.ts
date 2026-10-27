import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  conversationSummarySchema,
  ingestMessageResultSchema,
  type OrganizationId,
  prospectSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { createMemoryConversationSummarizer } from '~/adapters/memory/conversation-summarizer'
import { harness, service, store } from '~/integration-harness'
import * as Summaries from '~/modules/conversation-summary/service'
import { processErase } from '~/modules/prospect/erase'
import { publicCaller, seedOrganization, TEST_INTERNAL_SECRET } from '~/testing'

describe('Conversation summaries, over Postgres', () => {
  test('a quiet Conversation is summarized once, replaced when stale, and hidden from others', async () => {
    const h = await harness({ summarizer: createMemoryConversationSummarizer() })
    const org = await seedOrganization(store, ['admin', 'rep', 'rep'])
    const other = await seedOrganization(store, ['admin'])
    const [rep, otherRep] = org.members.filter((m) => m.role === 'rep')
    const [stranger] = other.members
    if (!rep || !otherRep || !stranger) {
      throw new Error('seed')
    }
    const api = publicCaller(h)
    const prospect = prospectSchema.parse(
      (
        await api(rep, org.organizationId, 'POST', '/prospects', {
          firstName: 'Ada',
          email: 'ada-summary@example.test',
        })
      ).body
    )
    const ingest = async (providerMessageId: string) =>
      ingestMessageResultSchema.parse(
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
              body: 'Please send pricing',
              prospectId: prospect.id,
              providerMessageId,
              sentAt: new Date(Date.now() - 60_000).toISOString(),
            }),
          })
        ).json()
      ).message.conversationId
    const id = await ingest('s1')
    const path = `/conversations/${id}/summary`
    const options: Summaries.SummaryOptions = {
      attempts: 2,
      timeoutMs: 2_000,
      quietAfterMs: 0,
      backoff: { baseMs: 1, capMs: 2 },
      sleep: async () => undefined,
      random: () => 0.5,
    }
    const run = () => Summaries.summarizeConversation(h.deps, org.organizationId, id, options)

    expect((await api(rep, org.organizationId, 'GET', path)).status).toBe(404)
    // the Conversation's last Message is in the past, so a zero quiet window makes it quiet now
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await run()).toBe('summarized')
    expect(await run()).toBe('current')

    const read = conversationSummarySchema.parse(
      (await api(rep, org.organizationId, 'GET', path)).body
    )
    expect(read).toMatchObject({ conversationId: id, outcomeLabel: 'open' })

    expect((await api(otherRep, org.organizationId, 'GET', path)).status).toBe(404)
    expect((await api(stranger, other.organizationId as OrganizationId, 'GET', path)).status).toBe(
      404
    )

    const count = () =>
      withOrganization(service.db, org.organizationId, async (tx) => {
        const { rows } = await tx.execute<{ n: string }>(
          sql`select count(*)::text as n from core.conversation_summaries`
        )
        return Number(rows[0]?.n)
      })
    expect(await count()).toBe(1)
    await processErase(
      h.deps,
      {
        organizationId: org.organizationId,
        prospectId: prospect.id,
        actorUserId: org.owner.userId,
        traceId: 'trace-erase',
      },
      { batchRows: 1 }
    )
    expect(await count()).toBe(0)
  })
})

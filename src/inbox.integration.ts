import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import {
  conversationPageSchema,
  ingestMessageResultSchema,
  messagePageSchema,
  type OrganizationId,
  prospectSchema,
} from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, service, store } from '~/integration-harness'
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
})

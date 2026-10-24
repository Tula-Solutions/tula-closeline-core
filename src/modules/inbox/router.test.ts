import { describe, expect, test } from 'bun:test'
import {
  type ConversationId,
  conversationPageSchema,
  conversationSchema,
  type DraftId,
  formatId,
  ingestMessageResultSchema,
  messagePageSchema,
  type OrganizationId,
  prospectSchema,
  type Role,
  teamSchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
  TEST_INTERNAL_SECRET,
} from '~/testing'

type Actor = { userId: SeededMember['userId']; role: Role }

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'manager', 'rep', 'rep', 'rep'])
  const byRole = (role: Role) => seeded.members.filter((m) => m.role === role)
  const [admin] = byRole('admin') as [SeededMember]
  const [manager, otherManager] = byRole('manager') as [SeededMember, SeededMember]
  const [rep, teammate, outsider] = byRole('rep') as [SeededMember, SeededMember, SeededMember]
  const api = publicCaller(harness)
  const orgId = seeded.organizationId
  const call = (actor: Actor, method: string, path: string, body?: unknown, org = orgId) =>
    api(actor, org, method, path, body)
  const owner = seeded.owner

  const team = async (name: string, members: SeededMember[]) => {
    const created = teamSchema.parse((await call(owner, 'POST', '/teams', { name })).body)
    for (const member of members) {
      await call(owner, 'POST', `/teams/${created.id}/members`, { membershipId: member.id })
    }
  }
  await team('East', [manager, rep, teammate])
  await team('West', [otherManager, outsider])

  const prospectOf = async (actor: Actor & { id?: string }, firstName: string) => {
    const response = await call(actor, 'POST', '/prospects', {
      firstName,
      email: `${firstName.toLowerCase()}@example.test`,
    })
    expect([200, 201]).toContain(response.status)
    return prospectSchema.parse(response.body)
  }

  let counter = 0
  const ingest = async (
    body: Record<string, unknown>,
    options: { organizationId?: string; headers?: Record<string, string> } = {}
  ) => {
    counter += 1
    const response = await harness.app.request('/internal/messages', {
      method: 'POST',
      headers: {
        ...harness.internal(),
        'x-organization-id': options.organizationId ?? orgId,
        ...options.headers,
      },
      body: JSON.stringify({
        channel: 'email',
        providerMessageId: `prov-${counter}`,
        direction: 'inbound',
        body: 'Sounds interesting, tell me more.',
        sentAt: new Date(harness.deps.clock.now().getTime() - 1000).toISOString(),
        ...body,
      }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & {
        error?: { code: string }
      },
    }
  }

  return {
    ...harness,
    store,
    seeded,
    call,
    owner,
    admin,
    manager,
    otherManager,
    rep,
    teammate,
    outsider,
    prospectOf,
    ingest,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** One Conversation per owner, returned by Conversation id. */
async function conversationFor(s: Setup, actor: SeededMember, name: string) {
  const prospect = await s.prospectOf(actor, name)
  const posted = await s.ingest({ prospectId: prospect.id })
  expect(posted.status).toBe(201)
  return ingestMessageResultSchema.parse(posted.body).message.conversationId
}

describe('ingesting a Message', () => {
  test('stores one Message and a second post of the same provider id returns it unchanged', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')

    const first = await s.ingest({ prospectId: prospect.id, providerMessageId: 'abc-1' })
    const second = await s.ingest({ prospectId: prospect.id, providerMessageId: 'abc-1' })

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const a = ingestMessageResultSchema.parse(first.body)
    const b = ingestMessageResultSchema.parse(second.body)
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect(b.message).toEqual(a.message)
    expect(a.message.authorKind).toBe('prospect')

    const listed = await s.call(s.rep, 'GET', `/conversations/${a.message.conversationId}/messages`)
    expect(messagePageSchema.parse(listed.body).items).toHaveLength(1)
  })

  test('the same provider id on another channel is a separate Message and Conversation', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const email = ingestMessageResultSchema.parse(
      (await s.ingest({ prospectId: prospect.id, providerMessageId: 'x' })).body
    )
    const chat = await s.ingest({
      prospectId: prospect.id,
      providerMessageId: 'x',
      channel: 'chat',
    })

    expect(chat.status).toBe(201)
    const other = ingestMessageResultSchema.parse(chat.body)
    expect(other.message.id).not.toBe(email.message.id)
    expect(other.message.conversationId).not.toBe(email.message.conversationId)
  })

  test('a later Message joins the Prospect Conversation and moves latest activity forward', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const now = s.deps.clock.now().getTime()
    const first = ingestMessageResultSchema.parse(
      (
        await s.ingest({
          prospectId: prospect.id,
          sentAt: new Date(now - 5000).toISOString(),
        })
      ).body
    )
    const later = ingestMessageResultSchema.parse(
      (
        await s.ingest({
          prospectId: prospect.id,
          direction: 'outbound',
          sentAt: new Date(now - 1000).toISOString(),
        })
      ).body
    )
    expect(later.message.conversationId).toBe(first.message.conversationId)
    expect(later.message.authorKind).toBe('agent')

    const read = conversationSchema.parse(
      (await s.call(s.rep, 'GET', `/conversations/${first.message.conversationId}`)).body
    )
    expect(read.lastMessageAt).toBe(new Date(now - 1000).toISOString())
    expect(read.ownerMembershipId).toBe(s.rep.id)
    expect(read.state).toBe('agent')
  })

  test('an outbound Message from a Draft takes the Draft author', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const seed = ingestMessageResultSchema.parse((await s.ingest({ prospectId: prospect.id })).body)
    const draftId = formatId('drf', crypto.randomUUID()) as DraftId
    s.store.seedDraftRef(s.seeded.organizationId, {
      id: draftId,
      conversationId: seed.message.conversationId,
      author: 'rep',
      authorMembershipId: s.rep.id,
    })

    const sent = await s.ingest({ prospectId: prospect.id, direction: 'outbound', draftId })

    expect(sent.status).toBe(201)
    const message = ingestMessageResultSchema.parse(sent.body).message
    expect(message.authorKind).toBe('rep')
    expect(message.authorMembershipId).toBe(s.rep.id)
    expect(message.draftId).toBe(draftId)
  })

  test('a Draft that is unknown or of another Conversation is request.invalid', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const other = await s.prospectOf(s.rep, 'Bo')
    const seed = ingestMessageResultSchema.parse((await s.ingest({ prospectId: other.id })).body)
    await s.ingest({ prospectId: prospect.id })
    const draftId = formatId('drf', crypto.randomUUID()) as DraftId
    s.store.seedDraftRef(s.seeded.organizationId, {
      id: draftId,
      conversationId: seed.message.conversationId,
      author: 'agent',
      authorMembershipId: null,
    })

    const unknown = await s.ingest({
      prospectId: prospect.id,
      direction: 'outbound',
      draftId: formatId('drf', crypto.randomUUID()),
    })
    const foreign = await s.ingest({ prospectId: prospect.id, direction: 'outbound', draftId })

    expect(unknown.status).toBe(400)
    expect(unknown.body.error?.code).toBe('request.invalid')
    expect(foreign.status).toBe(400)
    expect(foreign.body.error?.code).toBe('request.invalid')
  })

  test('an inbound Message with a Draft is rejected', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const response = await s.ingest({
      prospectId: prospect.id,
      draftId: formatId('drf', crypto.randomUUID()),
    })
    expect(response.status).toBe(400)
  })

  test('an unknown Prospect, or one of another Organization, is inbox.prospect_not_found', async () => {
    const s = await setup()
    const unknown = await s.ingest({ prospectId: formatId('prs', crypto.randomUUID()) })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error?.code).toBe('inbox.prospect_not_found')

    const prospect = await s.prospectOf(s.rep, 'Ada')
    const elsewhere = await s.ingest(
      { prospectId: prospect.id },
      { organizationId: newOrganizationId() }
    )
    expect(elsewhere.status).toBe(404)
    expect(elsewhere.body.error?.code).toBe('inbox.prospect_not_found')

    const page = conversationPageSchema.parse((await s.call(s.admin, 'GET', '/conversations')).body)
    expect(page.items).toHaveLength(0)
  })

  test('requires the shared secret and a valid Organization header', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const body = JSON.stringify({
      channel: 'email',
      providerMessageId: 'p',
      prospectId: prospect.id,
      direction: 'inbound',
      body: 'hi',
      sentAt: new Date().toISOString(),
    })
    const post = (headers: Record<string, string>) =>
      s.app.request('/internal/messages', { method: 'POST', headers, body })
    const base = {
      'content-type': 'application/json',
      'x-organization-id': s.seeded.organizationId,
    }

    expect((await post(base)).status).toBe(401)
    expect((await post({ ...base, authorization: `Bearer ${TEST_INTERNAL_SECRET}x` })).status).toBe(
      401
    )
    expect(
      (
        await post({
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'content-type': 'application/json',
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post({
          ...base,
          authorization: `Bearer ${TEST_INTERNAL_SECRET}`,
          'x-organization-id': 'nope',
        })
      ).status
    ).toBe(400)
    expect((await post({ ...base, authorization: `Bearer ${TEST_INTERNAL_SECRET}` })).status).toBe(
      201
    )
  })

  test('never writes a Message body to the logs or an error report', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const secret = 'zebra-confidential-body-text'
    await s.ingest({ prospectId: prospect.id, body: secret })
    await s.ingest({ prospectId: prospect.id, body: secret, draftId: 'bad' })
    await s.ingest({ prospectId: formatId('prs', crypto.randomUUID()), body: secret })
    const conversations = conversationPageSchema.parse(
      (await s.call(s.rep, 'GET', '/conversations')).body
    )
    const id = conversations.items[0]?.id
    await s.call(s.rep, 'GET', `/conversations/${id}/messages`)

    expect(s.deps.logLines.join('\n')).not.toContain(secret)
    expect(JSON.stringify(s.deps.reported)).not.toContain(secret)
  })
})

describe('reading Conversations', () => {
  test('a Rep sees only their own and gets inbox.conversation_not_found for another Rep', async () => {
    const s = await setup()
    const mine = await conversationFor(s, s.rep, 'Ada')
    const theirs = await conversationFor(s, s.teammate, 'Bo')

    const list = conversationPageSchema.parse((await s.call(s.rep, 'GET', '/conversations')).body)
    expect(list.items.map((c) => c.id)).toEqual([mine])

    for (const path of [`/conversations/${theirs}`, `/conversations/${theirs}/messages`]) {
      const response = await s.call(s.rep, 'GET', path)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('inbox.conversation_not_found')
    }
    expect((await s.call(s.rep, 'GET', `/conversations/${mine}`)).status).toBe(200)
    expect((await s.call(s.rep, 'GET', `/conversations/${mine}/messages`)).status).toBe(200)
  })

  test('a Manager sees their own and their Team Reps, never another Team', async () => {
    const s = await setup()
    const own = await conversationFor(s, s.manager, 'Ada')
    const repOwned = await conversationFor(s, s.rep, 'Bo')
    const mate = await conversationFor(s, s.teammate, 'Cy')
    const west = await conversationFor(s, s.outsider, 'Di')
    const westManager = await conversationFor(s, s.otherManager, 'Ed')

    const list = conversationPageSchema.parse(
      (await s.call(s.manager, 'GET', '/conversations')).body
    )
    expect(list.items.map((c) => c.id).sort()).toEqual([own, repOwned, mate].sort())
    for (const hidden of [west, westManager]) {
      const response = await s.call(s.manager, 'GET', `/conversations/${hidden}`)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('inbox.conversation_not_found')
    }
  })

  test('an Admin and the Owner see every Conversation', async () => {
    const s = await setup()
    const ids = [
      await conversationFor(s, s.rep, 'Ada'),
      await conversationFor(s, s.outsider, 'Bo'),
      await conversationFor(s, s.manager, 'Cy'),
    ]
    for (const actor of [s.admin, s.owner]) {
      const list = conversationPageSchema.parse((await s.call(actor, 'GET', '/conversations')).body)
      expect(list.items.map((c) => c.id).sort()).toEqual([...ids].sort())
      for (const id of ids) {
        expect((await s.call(actor, 'GET', `/conversations/${id}`)).status).toBe(200)
        expect((await s.call(actor, 'GET', `/conversations/${id}/messages`)).status).toBe(200)
      }
    }
  })

  test('reassigning the Prospect moves who may see its Conversation, by PUT owner and by assign', async () => {
    const s = await setup()
    const id = await conversationFor(s, s.rep, 'Ada')
    const second = await conversationFor(s, s.rep, 'Bo')
    const prospects = conversationPageSchema.parse(
      (await s.call(s.rep, 'GET', '/conversations')).body
    )
    const ofProspect = (cid: string) => prospects.items.find((c) => c.id === cid)?.prospectId

    const put = await s.call(s.owner, 'PUT', `/prospects/${ofProspect(id)}/owner`, {
      ownerMembershipId: s.outsider.id,
    })
    expect(put.status).toBe(200)
    const assign = await s.call(s.owner, 'POST', '/prospects/assign', {
      prospectIds: [ofProspect(second)],
      ownerMembershipId: s.outsider.id,
    })
    expect([200, 202]).toContain(assign.status)

    for (const cid of [id, second]) {
      for (const path of [`/conversations/${cid}`, `/conversations/${cid}/messages`]) {
        const old = await s.call(s.rep, 'GET', path)
        expect(old.status).toBe(404)
        expect(old.body.error?.code).toBe('inbox.conversation_not_found')
        expect((await s.call(s.outsider, 'GET', path)).status).toBe(200)
      }
    }
    const list = conversationPageSchema.parse((await s.call(s.rep, 'GET', '/conversations')).body)
    expect(list.items).toHaveLength(0)
  })

  test('a second Organization cannot list or read any Conversation or Message', async () => {
    const s = await setup()
    const id = await conversationFor(s, s.rep, 'Ada')
    const other = await seedOrganization(s.store, ['admin'])
    const [stranger] = other.members as [SeededMember]
    const as = (path: string) =>
      s.call(stranger, 'GET', path, undefined, other.organizationId as OrganizationId)

    expect(conversationPageSchema.parse((await as('/conversations')).body).items).toHaveLength(0)
    for (const path of [`/conversations/${id}`, `/conversations/${id}/messages`]) {
      const response = await as(path)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('inbox.conversation_not_found')
    }
  })

  test('lists Conversations by latest activity with a cursor and filters', async () => {
    const s = await setup()
    const now = s.deps.clock.now().getTime()
    const ids: ConversationId[] = []
    for (const [i, name] of ['Ada', 'Bo', 'Cy'].entries()) {
      const prospect = await s.prospectOf(s.rep, name)
      const posted = await s.ingest({
        prospectId: prospect.id,
        channel: i === 2 ? 'chat' : 'email',
        sentAt: new Date(now - (10 - i) * 1000).toISOString(),
      })
      ids.push(ingestMessageResultSchema.parse(posted.body).message.conversationId)
    }

    const at = (i: number) => ids[i] as ConversationId
    const first = await s.call(s.rep, 'GET', '/conversations?limit=2')
    const page1 = conversationPageSchema.parse(first.body)
    expect(page1.items.map((c) => c.id)).toEqual([at(2), at(1)])
    expect(page1.nextCursor).not.toBeNull()
    const second = conversationPageSchema.parse(
      (await s.call(s.rep, 'GET', `/conversations?limit=2&cursor=${page1.nextCursor}`)).body
    )
    expect(second.items.map((c) => c.id)).toEqual([at(0)])
    expect(second.nextCursor).toBeNull()

    const chat = conversationPageSchema.parse(
      (await s.call(s.rep, 'GET', '/conversations?channel=chat')).body
    )
    expect(chat.items.map((c) => c.id)).toEqual([at(2)])

    expect((await s.call(s.rep, 'GET', '/conversations?limit=101')).status).toBe(400)
    const bad = await s.call(s.rep, 'GET', '/conversations?cursor=garbage')
    expect(bad.status).toBe(400)
    expect(bad.body.error?.code).toBe('request.invalid')
  })

  test('lists Messages oldest first with a cursor', async () => {
    const s = await setup()
    const prospect = await s.prospectOf(s.rep, 'Ada')
    const now = s.deps.clock.now().getTime()
    let conversationId = ''
    for (let i = 0; i < 3; i += 1) {
      const posted = await s.ingest({
        prospectId: prospect.id,
        providerMessageId: `m-${i}`,
        sentAt: new Date(now - (10 - i) * 1000).toISOString(),
      })
      conversationId = ingestMessageResultSchema.parse(posted.body).message.conversationId
    }

    const one = messagePageSchema.parse(
      (await s.call(s.rep, 'GET', `/conversations/${conversationId}/messages?limit=2`)).body
    )
    expect(one.items.map((m) => m.providerMessageId)).toEqual(['m-0', 'm-1'])
    const two = messagePageSchema.parse(
      (
        await s.call(
          s.rep,
          'GET',
          `/conversations/${conversationId}/messages?limit=2&cursor=${one.nextCursor}`
        )
      ).body
    )
    expect(two.items.map((m) => m.providerMessageId)).toEqual(['m-2'])
    expect(two.nextCursor).toBeNull()
    expect(
      (await s.call(s.rep, 'GET', `/conversations/${conversationId}/messages?cursor=zzz`)).status
    ).toBe(400)
  })
})

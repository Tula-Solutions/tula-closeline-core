import { afterAll, describe, expect, test } from 'bun:test'
import { listInvitationsResponseSchema } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { createInvitationMailer } from '~/container'
import { loadEnv } from '~/env'
import { type ApiBody, createTestApp, publicCaller, seedOrganization } from '~/testing'

type Seen = { path: string; body: string }
type Mode = 'ok' | 'fail' | 'hang'

const stands: { stop: () => Promise<void> }[] = []
afterAll(async () => {
  await Promise.all(stands.map((stand) => stand.stop()))
})

/** A stand-in for Mailpit on a loopback port; `mode` decides the answer. */
function mailbox(initial: Mode = 'ok') {
  const state = { mode: initial, seen: [] as Seen[] }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      state.seen.push({ path: new URL(request.url).pathname, body: await request.text() })
      if (state.mode === 'hang') {
        await Bun.sleep(5_000)
      }
      return state.mode === 'fail'
        ? new Response('upstream said no', { status: 500 })
        : Response.json({ ID: 'abc' })
    },
  })
  const stand = {
    state,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true)
    },
  }
  stands.push(stand)
  return stand
}

/**
 * The Invitation routes with the adapter `createContainer` would pick for `MAIL_LOCAL_URL`
 * (`createInvitationMailer`) over a mailbox at `url`, or the unconfigured one for `null`.
 */
async function setup(url: string | null, deliveryTimeoutMs?: number) {
  const store = createMemoryCoreStore()
  const settings = {
    ...(deliveryTimeoutMs === undefined
      ? {}
      : { INVITATION_DELIVERY_TIMEOUT_MS: String(deliveryTimeoutMs) }),
  }
  const env = loadEnv({
    ENVIRONMENT: 'local',
    ...settings,
    ...(url === null ? {} : { MAIL_LOCAL_URL: url }),
  })
  const harness = await createTestApp({
    store,
    env: settings,
    invitationMailer: createInvitationMailer(env, { warn: () => {} }),
  })
  const seeded = await seedOrganization(store, [])
  const api = publicCaller(harness)
  const post = async (email: string, key?: string) => {
    const token = await harness.bearer({
      userId: seeded.owner.userId,
      organizationId: seeded.organizationId,
      role: seeded.owner.role,
    })
    const response = await harness.app.request('/v1/invitations', {
      method: 'POST',
      headers: {
        ...token,
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify({ email, role: 'rep' }),
    })
    return { status: response.status, body: (await response.json()) as ApiBody }
  }
  const listed = async (state: 'pending' | 'revoked') =>
    listInvitationsResponseSchema.parse(
      (await api(seeded.owner, seeded.organizationId, 'GET', `/invitations?state=${state}`)).body
    ).items
  return { harness, post, listed }
}

describe('an Invitation over the local mailbox', () => {
  test('a delivered Invitation answers 201 and the mailbox holds one message with the link', async () => {
    const box = mailbox()
    const { post, listed } = await setup(box.url)

    const { status, body } = await post('new@example.com')

    expect(status).toBe(201)
    expect(box.state.seen).toHaveLength(1)
    expect(box.state.seen[0]?.path).toBe('/api/v1/send')
    const sent = JSON.parse(box.state.seen[0]?.body ?? '') as {
      To: { Email: string }[]
      Text: string
    }
    expect(sent.To).toEqual([{ Email: 'new@example.com' }])
    expect(sent.Text).toContain('https://app.test/sign-up#invitation=')
    expect(JSON.stringify(body)).not.toContain('invitation=')
    expect(await listed('pending')).toHaveLength(1)
    expect(await listed('revoked')).toHaveLength(0)
  })

  test('a keyed Invitation that was delivered replays its 201 and sends one message', async () => {
    const box = mailbox()
    const { post } = await setup(box.url)

    const first = await post('keyed@example.com', 'invite-key-0001-abc')
    const second = await post('keyed@example.com', 'invite-key-0001-abc')

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)
    expect(box.state.seen).toHaveLength(1)
  })

  test.each([
    ['a mailbox answering 500', 'fail'],
    ['nothing listening', 'down'],
  ] as const)(
    '%s answers what the unconfigured adapter answers and revokes the Invitation',
    async (_name, kind) => {
      const box = mailbox(kind === 'fail' ? 'fail' : 'ok')
      if (kind === 'down') {
        await box.stop()
      }
      const unconfigured = await setup(null)
      const baseline = await unconfigured.post('lost@example.com')
      const { post, listed } = await setup(box.url)

      const { status, body } = await post('lost@example.com')

      expect(baseline.status).toBe(503)
      expect(status).toBe(baseline.status)
      expect(body.error?.code).toBe(baseline.body.error?.code)
      expect(body.error?.message).toBe(baseline.body.error?.message)
      expect(box.state.seen).toHaveLength(kind === 'fail' ? 3 : 0)
      expect(await listed('pending')).toHaveLength(0)
      expect(await listed('revoked')).toHaveLength(1)
    }
  )

  test('after a failed delivery the same key sends a fresh Invitation once the mailbox is back', async () => {
    const box = mailbox('fail')
    const { post, listed } = await setup(box.url)

    const failed = await post('again@example.com', 'invite-key-0002-abc')
    box.state.mode = 'ok'
    const retried = await post('again@example.com', 'invite-key-0002-abc')

    expect(failed.status).toBe(503)
    expect(retried.status).toBe(201)
    expect(await listed('pending')).toHaveLength(1)
    expect(await listed('revoked')).toHaveLength(1)
  })

  test('a mailbox that never answers is given up on inside the route delivery bound, and the Invitation is revoked', async () => {
    const bound = 1_000
    const box = mailbox('hang')
    const { post, listed } = await setup(box.url, bound)

    const { status, body } = await post('slow@example.com')

    expect(status).toBe(503)
    expect(body.error?.code).toBe('server.unavailable')
    // The hanging mailbox and the route's abort bound the run; assert what happened, not how long.
    expect(box.state.seen.length).toBeGreaterThanOrEqual(2)
    expect(box.state.seen.length).toBeLessThanOrEqual(3)
    expect(await listed('pending')).toHaveLength(0)
    expect(await listed('revoked')).toHaveLength(1)
  })
})

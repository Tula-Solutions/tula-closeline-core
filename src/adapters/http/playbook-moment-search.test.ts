import { afterAll, describe, expect, test } from 'bun:test'
import type { OrganizationId } from 'tula-closeline-contract'
import { createPlaybookMomentSearch } from './playbook-moment-search'

const TOKEN = 'playbook-secret-0123456789-abcdefghijkl'
const ORG = 'org_0123456789abcdef0123456789abcdef' as OrganizationId
const OK = {
  items: [
    {
      callId: 'call_0123456789abcdef0123456789abcdef',
      dealRecordId: 'deal_0123456789abcdef0123456789abcdef',
      momentIndex: 2,
      score: 0.9,
      prospect: 'too pricey',
      repNext: 'let us talk value',
    },
  ],
  evidence: { moments: 1, deals: 1 },
}

type Seen = { auth: string | null; org: string | null; path: string; body: unknown }
let seen: Seen[] = []
let script: (n: number) => Response | Promise<Response> = () => Response.json(OK)
let calls = 0
const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    calls++
    seen.push({
      auth: request.headers.get('authorization'),
      org: request.headers.get('x-organization-id'),
      path: new URL(request.url).pathname,
      body: await request.json(),
    })
    return script(calls)
  },
})
afterAll(() => server.stop(true))

const search = (over: { timeoutMs?: number } = {}) =>
  createPlaybookMomentSearch({
    baseUrl: `http://127.0.0.1:${server.port}/`,
    token: TOKEN,
    sleep: async () => {},
    random: () => 0,
    ...over,
  })
const ask = (s = search()) =>
  s.searchWonMoments(
    { organizationId: ORG, query: 'price', limit: 3 },
    new AbortController().signal
  )
const reset = (next: typeof script) => {
  seen = []
  calls = 0
  script = next
}

describe('Playbook moment search', () => {
  test('posts the query for the Organization with the secret and maps the items', async () => {
    reset(() => Response.json(OK))
    const found = await ask()
    expect(seen).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        org: ORG,
        path: '/internal/v1/playbook/search/moments',
        body: { turns: [{ role: 'prospect', text: 'price' }], limit: 3 },
      },
    ])
    expect(found.evidence).toEqual({ moments: 1, deals: 1 })
    expect(found.moments[0]).toMatchObject({ momentIndex: 2, prospect: 'too pricey' })
  })

  test('retries a 503 once and then succeeds', async () => {
    reset((n) => (n === 1 ? new Response(null, { status: 503 }) : Response.json(OK)))
    expect((await ask()).moments).toHaveLength(1)
    expect(calls).toBe(2)
  })

  test('gives up after the attempts on a 503 and never retries a 401 or a bad body', async () => {
    reset(() => new Response(null, { status: 503 }))
    await expect(ask()).rejects.toThrow('the Playbook search failed')
    expect(calls).toBe(2)
    for (const make of [
      () => new Response(null, { status: 401 }),
      () => Response.json({ nope: 1 }),
    ]) {
      reset(make)
      await expect(ask()).rejects.toThrow('the Playbook search failed')
      expect(calls).toBe(1)
    }
  })

  test('a stalled Playbook times out', async () => {
    reset(() => new Promise<Response>(() => {}))
    await expect(ask(search({ timeoutMs: 30 }))).rejects.toThrow('did not answer in time')
    expect(calls).toBe(2)
  })

  test('the error carries neither the token nor the body', async () => {
    reset(() => new Response('secret body', { status: 500 }))
    const error = await ask().catch((e: Error) => e)
    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).not.toContain('secret body')
  })
})

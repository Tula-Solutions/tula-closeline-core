import { afterAll, describe, expect, test } from 'bun:test'
import type { CallId, OrganizationId } from 'tula-closeline-contract'
import { TranscriptTimeout } from '~/ports/turn-reader'
import { createVoiceTurnReader } from './voice-turn-reader'

const TOKEN = 'voice-secret-0123456789-abcdefghijklmnop'
const ORG = 'org_0123456789abcdef0123456789abcdef' as OrganizationId
const CALL = 'call_0123456789abcdef0123456789abcdef' as CallId
const OK = { around: 3, turns: [{ index: 3, role: 'agent', text: 'hello' }] }

type Seen = { auth: string | null; org: string | null; url: string }
let seen: Seen[] = []
let script: (n: number) => Response | Promise<Response> = () => Response.json(OK)
let calls = 0
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    calls++
    seen.push({
      auth: request.headers.get('authorization'),
      org: request.headers.get('x-organization-id'),
      url: new URL(request.url).pathname + new URL(request.url).search,
    })
    return script(calls)
  },
})
afterAll(() => server.stop(true))

const reader = (over: { timeoutMs?: number } = {}) =>
  createVoiceTurnReader({
    baseUrl: `http://127.0.0.1:${server.port}/`,
    token: TOKEN,
    sleep: async () => {},
    random: () => 0,
    ...over,
  })
const ask = (r = reader()) =>
  r.window(
    { organizationId: ORG, callId: CALL, turnIndex: 3, window: 2 },
    new AbortController().signal
  )
const reset = (fn: typeof script) => {
  seen = []
  calls = 0
  script = fn
}

describe('the voice turn reader', () => {
  test('sends the bearer secret and the Organization and parses the turns', async () => {
    reset(() => Response.json(OK))
    expect(await ask()).toEqual(OK as never)
    expect(seen[0]).toEqual({
      auth: `Bearer ${TOKEN}`,
      org: ORG,
      url: `/internal/v1/calls/${CALL}/turns?around=3&window=2`,
    })
  })

  test('a 404 is null and is not retried', async () => {
    reset(() => new Response('{}', { status: 404 }))
    expect(await ask()).toBeNull()
    expect(calls).toBe(1)
  })

  test('a 503 is retried and then succeeds; a persistent one gives up after three attempts', async () => {
    reset((n) => (n < 3 ? new Response('no', { status: 503 }) : Response.json(OK)))
    expect(await ask()).toEqual(OK as never)
    expect(calls).toBe(3)
    reset(() => new Response('no', { status: 503 }))
    await expect(ask()).rejects.toThrow('voice is unavailable')
    expect(calls).toBe(3)
  })

  test('a 401, a 400 and a malformed body fail at once, without the secret or body in the error', async () => {
    for (const make of [
      () => new Response('bad token ' + TOKEN, { status: 401 }),
      () => new Response('nope', { status: 400 }),
      () => Response.json({ around: 3, turns: [{ index: 'x' }] }),
      () => new Response('not json agent text'),
    ]) {
      reset(make)
      const error = await ask().then(
        () => null,
        (e: Error) => e
      )
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(TranscriptTimeout)
      expect(String(error)).not.toContain(TOKEN)
      expect(String(error)).not.toContain('agent text')
      expect(calls).toBe(1)
    }
  })

  test('a slow voice is a TranscriptTimeout after bounded attempts', async () => {
    reset(async () => {
      await Bun.sleep(200)
      return Response.json(OK)
    })
    await expect(ask(reader({ timeoutMs: 30 }))).rejects.toBeInstanceOf(TranscriptTimeout)
    expect(calls).toBe(3)
  })

  test('a refused connection is unavailable without retry', async () => {
    const dead = createVoiceTurnReader({ baseUrl: 'http://127.0.0.1:1', token: TOKEN })
    await expect(ask(dead)).rejects.toThrow('voice read failed')
  })
})

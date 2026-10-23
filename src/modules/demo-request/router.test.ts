import { describe, expect, test } from 'bun:test'
import { retryAfterDetailsSchema } from 'tula-closeline-contract'
import { DemoRequestRefusedError } from 'tula-closeline-db'
import { createMemoryDemoRequestStore } from '~/adapters/memory/demo-request-store'
import { createTestApp, newOrganizationId, newUserId, type TestApp } from '~/testing'
import { MAX_DEMO_REQUEST_BODY_BYTES } from './router'
import { RATE_LIMIT } from './service'

const PATH = '/v1/marketing/demo-requests'
const PORTAL = 'https://app.test'

const VALID = {
  name: 'Ada Visitor',
  workEmail: 'Ada@Example.test',
  companyName: 'Visitor-Co-marker',
  message: 'We would like a demo, message-marker.',
  sourcePage: '/pricing',
}

type Json = { id?: string; error?: { code: string; details?: unknown } }

function post(
  harness: TestApp,
  body: unknown,
  headers: Record<string, string> = {},
  key: string | null = crypto.randomUUID(),
  env?: { requestIP?: (request: Request) => { address: string } | null }
) {
  return harness.app.request(
    PATH,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { 'idempotency-key': key }),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env
  )
}

const fromAddress = (address: string) => ({ requestIP: () => ({ address }) })

describe('POST /v1/marketing/demo-requests', () => {
  test('takes a request with no token, stores one row and queues one notice', async () => {
    const harness = await createTestApp()
    const response = await post(harness, VALID)
    expect(response.status).toBe(201)
    const body = (await response.json()) as Json
    expect(body.id).toMatch(/^dreq_/)
    const rows = harness.deps.demos.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.workEmail).toBe('ada@example.test')
    expect(rows[0]?.status).toBe('pending')
  })

  test('the same key and body returns the first id with 200 and stores one row', async () => {
    const harness = await createTestApp()
    const key = crypto.randomUUID()
    const first = await post(harness, VALID, {}, key)
    const second = await post(harness, VALID, {}, key)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(((await second.json()) as Json).id).toBe(((await first.json()) as Json).id)
    expect(harness.deps.demos.rows()).toHaveLength(1)
  })

  test('the same key with another body is request.idempotency_key_reused', async () => {
    const harness = await createTestApp()
    const key = crypto.randomUUID()
    await post(harness, VALID, {}, key)
    const response = await post(harness, { ...VALID, companyName: 'Other' }, {}, key)
    expect(response.status).toBe(422)
    expect(((await response.json()) as Json).error?.code).toBe('request.idempotency_key_reused')
  })

  test('a filled honeypot answers 201 with a fresh id and stores nothing', async () => {
    const harness = await createTestApp()
    const response = await post(harness, { ...VALID, website: 'https://spam.test' })
    expect(response.status).toBe(201)
    expect(((await response.json()) as Json).id).toMatch(/^dreq_/)
    expect(harness.deps.demos.rows()).toHaveLength(0)
  })

  test.each([
    ['an empty body', ''],
    ['malformed JSON', '{"name":'],
    ['a missing field', { ...VALID, name: undefined }],
    ['an unknown field', { ...VALID, extra: 1 }],
    ['a bad email', { ...VALID, workEmail: 'not-an-email' }],
    ['an array', [VALID]],
  ])('%s is marketing.invalid_request', async (_name, body) => {
    const harness = await createTestApp()
    const response = await post(harness, body)
    expect(response.status).toBe(400)
    expect(((await response.json()) as Json).error?.code).toBe('marketing.invalid_request')
    expect(harness.deps.demos.rows()).toHaveLength(0)
  })

  test('a missing or bad Idempotency-Key is marketing.invalid_request', async () => {
    const harness = await createTestApp()
    for (const key of [null, 'short', 'has spaces and is not a valid key at all !!']) {
      const response = await post(harness, VALID, {}, key)
      expect(response.status).toBe(400)
      expect(((await response.json()) as Json).error?.code).toBe('marketing.invalid_request')
    }
  })

  test('a wrong content type is marketing.invalid_request', async () => {
    const harness = await createTestApp()
    const response = await post(harness, JSON.stringify(VALID), { 'content-type': 'text/plain' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as Json).error?.code).toBe('marketing.invalid_request')
  })

  test('a body over the route limit is request.too_large', async () => {
    const harness = await createTestApp()
    const response = await post(harness, {
      ...VALID,
      message: 'x'.repeat(MAX_DEMO_REQUEST_BODY_BYTES),
    })
    expect(response.status).toBe(413)
    expect(((await response.json()) as Json).error?.code).toBe('request.too_large')
  })

  test('the next request after the limit is marketing.rate_limited with the wait', async () => {
    const harness = await createTestApp()
    for (let n = 0; n < RATE_LIMIT; n += 1) {
      expect((await post(harness, VALID, {}, undefined, fromAddress('203.0.113.7'))).status).toBe(
        201
      )
    }
    const response = await post(harness, VALID, {}, undefined, fromAddress('203.0.113.7'))
    expect(response.status).toBe(429)
    const body = (await response.json()) as Json
    expect(body.error?.code).toBe('marketing.rate_limited')
    expect(retryAfterDetailsSchema.parse(body.error?.details).retryAfter).toBe(3600)
    expect(response.headers.get('retry-after')).toBe('3600')
    // Another address is not limited, and the window ends with time.
    expect((await post(harness, VALID, {}, undefined, fromAddress('203.0.113.8'))).status).toBe(201)
    harness.deps.clock.advance('1h')
    expect((await post(harness, VALID, {}, undefined, fromAddress('203.0.113.7'))).status).toBe(201)
  })

  test('X-Forwarded-For is ignored with no trusted hops, so it cannot dodge the limit', async () => {
    const harness = await createTestApp()
    for (let n = 0; n < RATE_LIMIT; n += 1) {
      await post(
        harness,
        VALID,
        { 'x-forwarded-for': `198.51.100.${n}` },
        undefined,
        fromAddress('203.0.113.7')
      )
    }
    const response = await post(
      harness,
      VALID,
      { 'x-forwarded-for': '198.51.100.99' },
      undefined,
      fromAddress('203.0.113.7')
    )
    expect(response.status).toBe(429)
  })

  test('with one trusted hop the rightmost entry counts and spoofed leftmost ones are ignored', async () => {
    const harness = await createTestApp({ env: { TRUSTED_PROXY_HOPS: '1' } })
    for (let n = 0; n < RATE_LIMIT; n += 1) {
      const response = await post(harness, VALID, { 'x-forwarded-for': `10.0.0.${n}, 203.0.113.7` })
      expect(response.status).toBe(201)
    }
    const limited = await post(harness, VALID, { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' })
    expect(limited.status).toBe(429)
    const other = await post(harness, VALID, { 'x-forwarded-for': '203.0.113.7, 203.0.113.9' })
    expect(other.status).toBe(201)
  })

  test('requests with no usable address share one bucket', async () => {
    const harness = await createTestApp()
    for (let n = 0; n < RATE_LIMIT; n += 1) {
      await post(harness, VALID)
    }
    expect((await post(harness, VALID)).status).toBe(429)
  })
})

describe('CORS on the Demo Request route', () => {
  const preflight = (harness: TestApp, origin: string) =>
    harness.app.request(PATH, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key',
      },
    })

  test('answers the portal origin exactly', async () => {
    const harness = await createTestApp()
    const response = await preflight(harness, PORTAL)
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(PORTAL)
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Content-Type, Idempotency-Key'
    )
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    expect(response.headers.get('vary')).toContain('Origin')
  })

  test.each([
    'https://evil.test',
    'https://app.test.evil.test',
    'http://app.test',
    'https://app.test:8443',
    'null',
  ])('gives %s no CORS headers', async (origin) => {
    const harness = await createTestApp()
    const response = await preflight(harness, origin)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
  })

  test('the real response carries the allow-origin only for the portal, errors included', async () => {
    const harness = await createTestApp()
    const ok = await post(harness, VALID, { origin: PORTAL })
    expect(ok.headers.get('access-control-allow-origin')).toBe(PORTAL)
    const bad = await post(harness, '{', { origin: PORTAL })
    expect(bad.status).toBe(400)
    expect(bad.headers.get('access-control-allow-origin')).toBe(PORTAL)
    const other = await post(harness, VALID, { origin: 'https://evil.test' })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('other routes get no CORS headers at all', async () => {
    const harness = await createTestApp()
    const response = await harness.app.request('/healthz', { headers: { origin: PORTAL } })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the route is public and nothing else is', () => {
  test('other /v1 routes still need a token', async () => {
    const harness = await createTestApp()
    expect((await harness.app.request('/v1/organization')).status).toBe(401)
    expect((await harness.app.request('/v1/marketing/other')).status).toBe(401)
  })

  test('a member token of any Organization cannot read Demo Requests through any route', async () => {
    const harness = await createTestApp()
    await post(harness, VALID)
    const bearer = await harness.bearer({
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner',
    })
    for (const path of [PATH, `${PATH}/dreq_x`, '/v1/demo-requests', '/internal/demo-requests']) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await harness.app.request(path, { method, headers: bearer })
        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(JSON.stringify(await response.text())).not.toContain('Visitor-Co-marker')
      }
    }
  })
})

describe('what is logged', () => {
  test('no log line or reported error holds a Visitor field', async () => {
    const harness = await createTestApp()
    await post(harness, VALID)
    await post(harness, { ...VALID, website: 'x' })
    await post(harness, '{"name":"Ada Visitor"')
    await post(harness, { ...VALID, workEmail: 'bad' })
    const key = crypto.randomUUID()
    await post(harness, VALID, {}, key)
    await post(harness, { ...VALID, companyName: 'Visitor-Co-marker2' }, {}, key)
    const everything = JSON.stringify([harness.deps.logLines, harness.deps.reported])
    for (const secret of [
      'Ada',
      'ada@example',
      'Visitor-Co',
      'message-marker',
      '/pricing',
      '203.0.113',
    ]) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe('a database failure is not a refused field', () => {
  const storeThrowing = (code: string) => ({
    ...createMemoryDemoRequestStore({ now: () => new Date() }),
    submit: async () => {
      throw new DemoRequestRefusedError({ code })
    },
  })

  test.each(['08006', '40P01', '57014'])('SQLSTATE %s answers 500, not 400', async (code) => {
    const harness = await createTestApp({ demoRequests: storeThrowing(code) })
    expect((await post(harness, VALID)).status).toBe(500)
  })

  test('an integrity violation (23514) is still marketing.invalid_request', async () => {
    const harness = await createTestApp({ demoRequests: storeThrowing('23514') })
    const response = await post(harness, VALID)
    expect(response.status).toBe(400)
    expect(((await response.json()) as Json).error?.code).toBe('marketing.invalid_request')
  })
})

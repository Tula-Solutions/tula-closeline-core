import { describe, expect, test } from 'bun:test'
import { createRoute, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { errorBodySchema, requestIdSchema } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import { createTestDeps } from '~/testing'
import { createBaseApp } from './base'

const echo = createRoute({
  method: 'post',
  path: '/echo',
  request: {
    body: {
      content: { 'application/json': { schema: z.object({ name: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      description: 'The name back.',
      content: { 'application/json': { schema: z.object({ name: z.string() }) } },
    },
  },
})

function build() {
  const deps = createTestDeps()
  const app = createBaseApp(deps)

  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/log', (c) => {
    c.get('logger').info('handled')
    return c.json({ ok: true })
  })
  app.get('/app-error', () => {
    throw new AppError({
      code: 'team.not_found',
      status: 404,
      message: 'No such team.',
      details: { id: 'team_1' },
    })
  })
  app.get('/app-error-500', () => {
    throw new AppError({ code: 'billing.vendor_down', status: 502, message: 'Vendor is down.' })
  })
  app.get('/boom', () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')
  })
  app.get('/http-400', () => {
    throw new HTTPException(400, { message: 'Malformed JSON in request body' })
  })
  app.get('/http-teapot', () => {
    throw new HTTPException(418, { message: 'short and stout' })
  })
  app.openapi(echo, (c) => c.json({ name: c.req.valid('json').name }, 200))

  return { app, deps }
}

const REQUEST_ID = /^req_[0-9a-f]{32}$/

describe('request id', () => {
  test('a request without an id is given a minted one that is echoed', async () => {
    const { app } = build()

    const response = await app.request('/ok')

    const id = response.headers.get('x-request-id')
    expect(requestIdSchema.safeParse(id).success).toBe(true)
    expect(id).toMatch(REQUEST_ID)
  })

  test('two requests get two different ids', async () => {
    const { app } = build()

    const first = await app.request('/ok')
    const second = await app.request('/ok')

    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'))
  })

  test('a well-formed inbound id is kept and echoed', async () => {
    const { app } = build()
    const inbound = `req_${'ab12'.repeat(8)}`

    const response = await app.request('/ok', { headers: { 'x-request-id': inbound } })

    expect(response.headers.get('x-request-id')).toBe(inbound)
  })

  test.each([
    ['too short', 'req_abc'],
    ['wrong prefix', `usr_${'a'.repeat(32)}`],
    ['uppercase hex', `req_${'A'.repeat(32)}`],
    ['trailing text', `req_${'a'.repeat(32)} forged=1`],
    ['empty', ''],
  ])('a malformed inbound id (%s) is replaced, not echoed', async (_name, inbound) => {
    const { app } = build()

    const response = await app.request('/ok', { headers: { 'x-request-id': inbound } })

    const id = response.headers.get('x-request-id')
    expect(id).not.toBe(inbound)
    expect(id).toMatch(REQUEST_ID)
  })

  test('the handler logger carries the request id on every line', async () => {
    const { app, deps } = build()
    const inbound = `req_${'1'.repeat(32)}`

    await app.request('/log', { headers: { 'x-request-id': inbound } })

    const line = JSON.parse(deps.logLines.at(-1) ?? '{}')
    expect(line).toMatchObject({ msg: 'handled', requestId: inbound })
  })

  test('the id is echoed on error responses too', async () => {
    const { app } = build()
    const inbound = `req_${'2'.repeat(32)}`

    const response = await app.request('/boom', { headers: { 'x-request-id': inbound } })

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe(inbound)
  })
})

describe('error handler', () => {
  test('an unexpected error is a generic 500 that leaks nothing', async () => {
    const { app } = build()

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('ECONNREFUSED')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('Error')
    const body = errorBodySchema.parse(JSON.parse(text))
    expect(body.error.code).toBe('server.internal')
  })

  test('an unexpected error goes to reportError with the request context', async () => {
    const { app, deps } = build()
    const inbound = `req_${'3'.repeat(32)}`

    await app.request('/boom?token=secret', { headers: { 'x-request-id': inbound } })

    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.error).toBeInstanceOf(Error)
    expect(deps.reported[0]?.context).toEqual({
      requestId: inbound as never,
      method: 'GET',
      path: '/boom',
    })
  })

  test('a failing reporter does not drop the response', async () => {
    const { app, deps } = build()
    deps.reportError = () => {
      throw new Error('tracker is down')
    }

    const response = await app.request('/boom')

    expect(response.status).toBe(500)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('server.internal')
  })

  test('an AppError keeps its code, status and details and is not reported', async () => {
    const { app, deps } = build()

    const response = await app.request('/app-error')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'team.not_found', message: 'No such team.', details: { id: 'team_1' } },
    })
    expect(deps.reported).toHaveLength(0)
  })

  test('an AppError with a server status is reported', async () => {
    const { app, deps } = build()

    const response = await app.request('/app-error-500')

    expect(response.status).toBe(502)
    expect(deps.reported).toHaveLength(1)
  })

  test('a body that fails its schema is a 400 request.invalid naming the field', async () => {
    const { app, deps } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(response.status).toBe(400)
    const body = errorBodySchema.parse(await response.json())
    expect(body.error.code).toBe('request.invalid')
    expect(body.error.details).toEqual({
      issues: [expect.objectContaining({ path: 'name', code: 'too_small' })],
    })
    expect(deps.reported).toHaveLength(0)
  })

  test('malformed JSON is a 400 request.invalid', async () => {
    const { app, deps } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(response.status).toBe(400)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.invalid')
    expect(deps.reported).toHaveLength(0)
  })

  test('a valid body reaches the handler', async () => {
    const { app } = build()

    const response = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: 'Acme' })
  })

  test('an HTTPException maps to the registry error for its status', async () => {
    const { app, deps } = build()

    const response = await app.request('/http-400')

    expect(response.status).toBe(400)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.invalid')
    expect(deps.reported).toHaveLength(0)
  })

  test('an HTTPException with a status the registry lacks is a reported generic 500', async () => {
    const { app, deps } = build()

    const response = await app.request('/http-teapot')

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('stout')
    expect(deps.reported).toHaveLength(1)
  })

  test('an unknown path is a 404 request.not_found in the contract body', async () => {
    const { app } = build()

    const response = await app.request('/nope')

    expect(response.status).toBe(404)
    expect(errorBodySchema.parse(await response.json()).error.code).toBe('request.not_found')
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID)
  })
})

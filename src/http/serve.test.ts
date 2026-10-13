import { describe, expect, test } from 'bun:test'
import { errorBodySchema } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createTestDeps } from '~/testing'
import { serveOptions } from './serve'

function optionsFor(env: Record<string, string>) {
  const deps = createTestDeps({ env })
  return { deps, options: serveOptions(deps, createApp(deps)) }
}

describe('Bun.serve options', () => {
  test('the error hook answers with the contract 500 body and a request id, and reports once', async () => {
    const { deps, options } = optionsFor({})

    const response = options.error(new Error('connect ECONNREFUSED password=hunter2'))

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toMatch(/^req_[0-9a-f]{32}$/)
    const text = await response.text()
    expect(text).not.toContain('hunter2')
    expect(errorBodySchema.parse(JSON.parse(text)).error.code).toBe('server.internal')
    expect(deps.reported).toHaveLength(1)
  })

  test.each([
    ['local', true],
    ['dev', false],
    ['staging', false],
    ['prod', false],
  ])('development mode in %s is %p, whatever NODE_ENV says', (environment, development) => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = environment === 'local' ? 'production' : 'development'
    try {
      expect(optionsFor({ ENVIRONMENT: environment }).options.development).toBe(development)
    } finally {
      process.env.NODE_ENV = before
    }
  })

  test('the request body size and port come from configuration', () => {
    const { options } = optionsFor({ MAX_REQUEST_BODY_BYTES: '2048', PORT: '4100' })

    expect(options.maxRequestBodySize).toBe(2048)
    expect(options.port).toBe(4100)
  })
})

import { expect, test } from 'bun:test'
import { loadEnv } from './env'

test('configuration falls back to local defaults', () => {
  expect(loadEnv({})).toEqual({
    ENVIRONMENT: 'local',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
  })
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv(source)).toThrow()
})

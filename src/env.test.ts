import { expect, test } from 'bun:test'
import { loadEnv } from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' })).toEqual({
    ENVIRONMENT: 'local',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
    REGION: 'us',
    DATABASE_URL: 'postgres://closeline_core:closeline_core_local@127.0.0.1:5432/closeline',
    AUTH_JWKS_URL: 'http://127.0.0.1:3001/.well-known/jwks.json',
    AUTH_ISSUER: 'http://127.0.0.1:3001',
    AUTH_AUDIENCE: 'closeline',
    INTERNAL_API_TOKENS: [],
    PORTAL_BASE_URL: 'http://127.0.0.1:3002',
    INVITATION_DELIVERY_TIMEOUT_MS: 5_000,
  })
})

test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
  expect(() => loadEnv({})).toThrow()
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
  ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
  ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
  ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = { ENVIRONMENT: 'local', SHUTDOWN_GRACE_MS: '30001', SHUTDOWN_TIMEOUT_MS: '30000' }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})

const SECRET_A = 'a'.repeat(32)
const SECRET_B = 'b'.repeat(40)

const DEPLOYED = {
  ENVIRONMENT: 'prod',
  REGION: 'eu',
  DATABASE_URL: 'postgres://closeline_core:pw@db.internal:5432/closeline',
  AUTH_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
  AUTH_ISSUER: 'https://auth.example.com',
  AUTH_AUDIENCE: 'closeline',
  INTERNAL_API_TOKENS: SECRET_A,
  PORTAL_BASE_URL: 'https://app.example.com',
}

test('a fully configured deployment loads, with the Region and one internal secret', () => {
  const env = loadEnv(DEPLOYED)

  expect(env.REGION).toBe('eu')
  expect(env.INTERNAL_API_TOKENS).toEqual([SECRET_A])
})

test.each([
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'INTERNAL_API_TOKENS',
  'PORTAL_BASE_URL',
])('outside local, a missing %s fails at boot naming it', (key) => {
  const { [key]: _removed, ...rest } = DEPLOYED as Record<string, string>

  expect(() => loadEnv(rest)).toThrow(new RegExp(`${key} is required`))
})

test('two internal secrets are both kept, so one can be rotated without downtime', () => {
  const env = loadEnv({ ...DEPLOYED, INTERNAL_API_TOKENS: `${SECRET_A},${SECRET_B}` })

  expect(env.INTERNAL_API_TOKENS).toEqual([SECRET_A, SECRET_B])
})

test.each([
  ['a secret of 31 characters', 'x'.repeat(31)],
  ['an empty entry from a trailing comma', `${SECRET_A},`],
  ['an empty entry from a doubled comma', `${SECRET_A},,${SECRET_B}`],
  ['a secret with a space in it', `${SECRET_A} ${SECRET_B}`],
  ['a secret with a space around it', ` ${SECRET_A}`],
  ['six secrets', Array.from({ length: 6 }, () => SECRET_A).join(',')],
  ['an empty value', ''],
])('internal secrets reject %s at boot', (_name, value) => {
  expect(() => loadEnv({ ...DEPLOYED, INTERNAL_API_TOKENS: value })).toThrow()
})

test('a rejected secret never appears in the error that fails the boot', () => {
  const short = 'short-but-secret-value'

  try {
    loadEnv({ ...DEPLOYED, INTERNAL_API_TOKENS: short })
    throw new Error('expected the boot to fail')
  } catch (error) {
    expect(String(error)).not.toContain(short)
    expect(JSON.stringify(error)).not.toContain(short)
  }
})

test('the database URL must be a postgres connection string, and is not echoed when it is not', () => {
  try {
    loadEnv({ ...DEPLOYED, DATABASE_URL: 'mysql://user:hunter2@host/db' })
    throw new Error('expected the boot to fail')
  } catch (error) {
    expect(String(error)).toContain('DATABASE_URL')
    expect(String(error)).not.toContain('hunter2')
  }
})

test('an unknown Region fails at boot', () => {
  expect(() => loadEnv({ ...DEPLOYED, REGION: 'ap' })).toThrow()
})

test.each([
  ['http outside local', { ...DEPLOYED, PORTAL_BASE_URL: 'http://app.example.com' }],
  ['a query', { ...DEPLOYED, PORTAL_BASE_URL: 'https://app.example.com/?a=1' }],
  ['a fragment', { ...DEPLOYED, PORTAL_BASE_URL: 'https://app.example.com/#x' }],
  ['credentials', { ...DEPLOYED, PORTAL_BASE_URL: 'https://u:p@app.example.com' }],
  ['text that is not a URL', { ...DEPLOYED, PORTAL_BASE_URL: 'portal' }],
])('the portal base URL is refused with %s', (_name, source) => {
  expect(() => loadEnv(source)).toThrow(/PORTAL_BASE_URL|Invalid/)
})

test('the portal base URL may be http when local', () => {
  expect(loadEnv({ ENVIRONMENT: 'local', PORTAL_BASE_URL: 'http://localhost:5173' })).toMatchObject(
    {
      PORTAL_BASE_URL: 'http://localhost:5173',
    }
  )
})

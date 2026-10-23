import { describe, expect, test } from 'bun:test'
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
    DEMO_RATE_KEY: 'local-demo-rate-key-not-a-secret-0123456789',
    DEMO_NOTICE_TO: 'team@closeline.test',
    TRUSTED_PROXY_HOPS: 0,
    AWS_REGION: 'us-east-1',
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
  DEMO_RATE_KEY: 'prod-demo-rate-key-0123456789-abcdefghijklmnop',
  DEMO_NOTICE_TO: 'sales@example.com',
  TRUSTED_PROXY_HOPS: '1',
  AWS_REGION: 'us-east-1',
  QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/core-events',
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
  'DEMO_RATE_KEY',
  'DEMO_NOTICE_TO',
  'TRUSTED_PROXY_HOPS',
  'AWS_REGION',
  'QUEUE_URL',
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

describe('the local mail settings', () => {
  const LOCAL = { ENVIRONMENT: 'local' }
  const message = (source: Record<string, string | undefined>) => {
    try {
      loadEnv(source)
    } catch (error) {
      return String(error instanceof Error ? error.message : error)
    }
    return ''
  }

  test.each([
    ['http://127.0.0.1:8025', 'http://127.0.0.1:8025'],
    ['http://127.0.0.1:8025/', 'http://127.0.0.1:8025'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://localhost:8025', 'http://localhost:8025'],
    ['http://[::1]:8025', 'http://[::1]:8025'],
    ['http://[::1]/', 'http://[::1]'],
    ['http://LOCALHOST', 'http://localhost'],
    ['http://LocalHost:1/', 'http://localhost:1'],
    ['http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
  ])('local accepts the mailbox at %s and keeps the canonical origin', (url, canonical) => {
    expect(loadEnv({ ...LOCAL, MAIL_LOCAL_URL: url }).MAIL_LOCAL_URL).toBe(canonical)
  })

  test('local runs with neither mail setting, and accepts a sender under .test', () => {
    const env = loadEnv(LOCAL)

    expect(env.MAIL_LOCAL_URL).toBeUndefined()
    expect(env.MAIL_LOCAL_FROM).toBeUndefined()
    expect(
      loadEnv({ ...LOCAL, MAIL_LOCAL_URL: 'http://127.0.0.1:8025', MAIL_LOCAL_FROM: 'a@b.test' })
        .MAIL_LOCAL_FROM
    ).toBe('a@b.test')
  })

  test.each([
    ['a non-loopback host', 'http://mail.example.com:8025'],
    ['a private address', 'http://192.168.1.5:8025'],
    ['a public address', 'http://8.8.8.8:8025'],
    ['a host that only starts like localhost', 'http://localhost.evil.example:8025'],
    ['a host hidden behind credentials', 'http://127.0.0.1@evil.example:8025'],
    ['https', 'https://127.0.0.1:8025'],
    ['another scheme', 'ftp://127.0.0.1'],
    ['credentials', 'http://user:pw@127.0.0.1:8025'],
    ['a username alone', 'http://user@127.0.0.1:8025'],
    ['a path', 'http://127.0.0.1:8025/api'],
    ['a trailing path after a slash', 'http://127.0.0.1:8025//'],
    ['a query', 'http://127.0.0.1:8025/?a=1'],
    ['an empty query', 'http://127.0.0.1:8025?'],
    ['a fragment', 'http://127.0.0.1:8025/#x'],
    ['no URL at all', 'not a url'],
    ['an empty value', ''],
    ['the unspecified address', 'http://0.0.0.0'],
    ['the unspecified address with a port', 'http://0.0.0.0:8025'],
    ['a short IPv4 form', 'http://127.1'],
    ['a decimal IPv4 form', 'http://2130706433'],
    ['a hexadecimal IPv4 form', 'http://0x7f.0.0.1'],
    ['an octal IPv4 form', 'http://0177.0.0.1'],
    ['a padded IPv4 form', 'http://127.000.000.1'],
    ['a long IPv6 form', 'http://[0:0:0:0:0:0:0:1]:8025'],
    ['an absolute host name', 'http://127.0.0.1.'],
    ['an absolute localhost', 'http://localhost.:8025'],
    ['a scheme without slashes', 'http:localhost'],
    ['an upper-case scheme', 'HTTP://localhost:8025'],
    ['a backslash form', 'http:\\\\localhost'],
    ['a leading space', ' http://localhost:8025'],
    ['a trailing space', 'http://localhost:8025 '],
    ['a trailing newline', 'http://localhost:8025\n'],
    ['a full-width host', 'http://ｌｏｃａｌｈｏｓｔ:8025'],
    ['port 0', 'http://127.0.0.1:0'],
    ['a port above 65535', 'http://127.0.0.1:65536'],
    ['a zero-padded port', 'http://127.0.0.1:08025'],
    ['an empty port', 'http://127.0.0.1:'],
  ])('local refuses %s', (_name, url) => {
    expect(() => loadEnv({ ...LOCAL, MAIL_LOCAL_URL: url })).toThrow(/MAIL_LOCAL_URL/)
  })

  test.each(['dev', 'staging', 'prod'])(
    '%s refuses the setting even for a loopback address',
    (environment) => {
      const source = { ...DEPLOYED, ENVIRONMENT: environment }

      expect(() => loadEnv({ ...source, MAIL_LOCAL_URL: 'http://127.0.0.1:8025' })).toThrow(
        /MAIL_LOCAL_URL/
      )
      expect(() => loadEnv({ ...source, MAIL_LOCAL_FROM: 'a@b.test' })).toThrow(/MAIL_LOCAL_FROM/)
    }
  )

  test('a deploy outside local still boots without the settings', () => {
    expect(loadEnv(DEPLOYED).MAIL_LOCAL_URL).toBeUndefined()
  })

  test.each([
    ['a sender that is not an address', 'not-an-address'],
    ['a sender with a display name', 'Closeline <a@b.test>'],
  ])('local refuses %s', (_name, from) => {
    expect(() =>
      loadEnv({ ...LOCAL, MAIL_LOCAL_URL: 'http://127.0.0.1:8025', MAIL_LOCAL_FROM: from })
    ).toThrow(/MAIL_LOCAL_FROM/)
  })

  test.each([
    [
      'a host that is refused',
      { ENVIRONMENT: 'local', MAIL_LOCAL_URL: 'http://token-9d2@evil.example:8025' },
    ],
    [
      'a deployment that is refused',
      { ...DEPLOYED, MAIL_LOCAL_URL: 'http://secret-host-9d2.example:8025' },
    ],
  ])('the message for %s does not print the value', (_name, extra) => {
    const text = message(extra)

    expect(text).toContain('MAIL_LOCAL_URL')
    expect(text).not.toContain('9d2')
    expect(text).not.toContain('evil')
  })
})

test.each([
  ['a key shorter than 32 characters', { DEMO_RATE_KEY: 'x'.repeat(31) }],
  ['a key with a space', { DEMO_RATE_KEY: `${'x'.repeat(31)} y` }],
  ['more than 3 trusted proxy hops', { TRUSTED_PROXY_HOPS: '4' }],
  ['a negative number of hops', { TRUSTED_PROXY_HOPS: '-1' }],
  ['a notice address that is not an email', { DEMO_NOTICE_TO: 'team' }],
])('%s fails at boot', (_name, extra) => {
  expect(() => loadEnv({ ...DEPLOYED, ...extra })).toThrow()
})

test('the trusted proxy hops are read as a number', () => {
  expect(loadEnv({ ...DEPLOYED, TRUSTED_PROXY_HOPS: '1' }).TRUSTED_PROXY_HOPS).toBe(1)
})

test('a failed key never appears in the error text', () => {
  const secret = `${'s'.repeat(10)} short`
  try {
    loadEnv({ ...DEPLOYED, DEMO_RATE_KEY: secret })
    throw new Error('should have failed')
  } catch (error) {
    expect(String((error as Error).message)).not.toContain(secret)
  }
})

test('locally the proxy hop count defaults to 0', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' }).TRUSTED_PROXY_HOPS).toBe(0)
})

test('a queue endpoint is accepted only in local and only with a queue URL', () => {
  expect(() => loadEnv({ ...DEPLOYED, QUEUE_ENDPOINT: 'http://127.0.0.1:9324' })).toThrow(
    /QUEUE_ENDPOINT is accepted only when ENVIRONMENT is local/
  )
  expect(() => loadEnv({ ENVIRONMENT: 'local', QUEUE_ENDPOINT: 'http://127.0.0.1:9324' })).toThrow(
    /QUEUE_ENDPOINT needs QUEUE_URL/
  )
  expect(
    loadEnv({
      ENVIRONMENT: 'local',
      QUEUE_URL: 'http://127.0.0.1:9324/000000000000/core-events',
      QUEUE_ENDPOINT: 'http://127.0.0.1:9324',
    }).QUEUE_ENDPOINT
  ).toBe('http://127.0.0.1:9324')
})

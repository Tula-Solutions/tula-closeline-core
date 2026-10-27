import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { FakeKms } from '~/adapters/kms/fake-kms-client'
import { MEMORY_SECRET_KEY_ID } from '~/adapters/memory/secret-box'
import { InvitationMailerNotConfigured } from '~/adapters/unconfigured/invitation-mailer'
import { SecretBoxNotConfigured } from '~/adapters/unconfigured/secret-box'
import type { InvitationMessage } from '~/ports/invitation-mailer'
import {
  createCalendar,
  createContainer,
  createInvitationMailer,
  createRepNotifier,
  createSecretBox,
  createTurnReader,
  LOCAL_CALENDAR_CODE,
  reportSafely,
} from './container'
import { type Env, loadEnv } from './env'

test('the default reportError logs the failure with its request context at error level', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'a'.repeat(32)}` as never

  container.reportError(new Error('disk on fire'), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    level: 50, // error
    msg: 'unhandled error',
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
    error: { name: 'Error', message: 'disk on fire' },
  })
})

test('the default reportError logs the stack frames and the whole cause chain', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'c'.repeat(32)}` as never
  const error = new Error('query failed', { cause: new TypeError('socket closed') })

  container.reportError(error, { requestId, method: 'GET', path: '/x', status: 500 })

  const logged = JSON.parse(lines[0] ?? '{}')
  expect(logged.error.stack.length).toBeGreaterThan(0)
  expect(logged.error.cause).toMatchObject({ name: 'TypeError', message: 'socket closed' })
})

test('the default reportError bounds a long message', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'d'.repeat(32)}` as never

  container.reportError(new Error('z'.repeat(50_000)), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect((lines[0] ?? '').length).toBeLessThan(5_000)
})

test('reportSafely swallows a reporter that throws or rejects', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
  const context = {
    requestId: `req_${'e'.repeat(32)}` as never,
    method: 'GET',
    path: '/x',
    status: 500,
  }

  try {
    container.reportError = () => {
      throw new Error('sync failure')
    }
    reportSafely(container, new Error('a'), context)
    container.reportError = (async () => {
      throw new Error('async failure')
    }) as never
    reportSafely(container, new Error('b'), context)
    await Bun.sleep(20)

    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('the default reportError records a thrown non-Error without its value', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'b'.repeat(32)}` as never

  container.reportError('password=hunter2', { requestId, method: 'GET', path: '/x', status: 500 })

  expect(lines[0]).not.toContain('hunter2')
})

test('LOG_LEVEL silences the logger', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }), {
    logDestination: { write: (l) => lines.push(l) },
  })

  container.logger.error('nothing to see')

  expect(lines).toHaveLength(0)
})

test('a container built from the environment checks the database for readiness', async () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }))

  expect(container.readinessChecks.map((check) => check.name)).toEqual(['database'])
  await container.close()
})

describe('the Invitation mailer', () => {
  const MESSAGE: InvitationMessage = {
    email: 'rep@example.com',
    role: 'rep',
    organizationName: 'Acme',
    token: 'tok-marker-77c',
    link: 'https://app.test/sign-up#invitation=tok-marker-77c',
    expiresAt: new Date('2026-02-01T00:00:00Z'),
  }
  const SIGNAL = new AbortController().signal

  test('without MAIL_LOCAL_URL the unconfigured mailer stays', async () => {
    const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))

    await expect(container.invitationMailer.deliver(MESSAGE, SIGNAL)).rejects.toBeInstanceOf(
      InvitationMailerNotConfigured
    )
  })

  test('with MAIL_LOCAL_URL the local mailbox adapter hands the message over', async () => {
    const bodies: unknown[] = []
    const mailbox = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ ID: 'x' })
      },
    })
    try {
      const container = createContainer(
        loadEnv({
          ENVIRONMENT: 'local',
          LOG_LEVEL: 'silent',
          MAIL_LOCAL_URL: `http://127.0.0.1:${mailbox.port}`,
        })
      )

      await container.invitationMailer.deliver(MESSAGE, SIGNAL)

      expect(bodies).toHaveLength(1)
      const [sent] = bodies as { path: string; body: Record<string, unknown> }[]
      expect(sent?.path).toBe('/api/v1/send')
      expect(sent?.body.From).toEqual({ Email: 'no-reply@closeline.test' })
      expect(sent?.body.To).toEqual([{ Email: 'rep@example.com' }])
      expect(String(sent?.body.Text)).toContain(MESSAGE.link)
    } finally {
      await mailbox.stop(true)
    }
  })

  test('MAIL_LOCAL_FROM changes the sender', async () => {
    const froms: unknown[] = []
    const mailbox = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        froms.push(((await request.json()) as { From: unknown }).From)
        return Response.json({ ID: 'x' })
      },
    })
    try {
      const container = createContainer(
        loadEnv({
          ENVIRONMENT: 'local',
          LOG_LEVEL: 'silent',
          MAIL_LOCAL_URL: `http://127.0.0.1:${mailbox.port}`,
          MAIL_LOCAL_FROM: 'sender@dev.test',
        })
      )

      await container.invitationMailer.deliver(MESSAGE, SIGNAL)

      expect(froms).toEqual([{ Email: 'sender@dev.test' }])
    } finally {
      await mailbox.stop(true)
    }
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'a hand-built %s Env with MAIL_LOCAL_URL set throws instead of selecting the local adapter',
    (environment) => {
      const env = {
        ...loadEnv({ ENVIRONMENT: 'local' }),
        ENVIRONMENT: environment,
        MAIL_LOCAL_URL: 'http://evil.example.com',
      } as Env

      expect(() => createInvitationMailer(env, { warn: () => {} })).toThrow(/MAIL_LOCAL_URL/)
    }
  )

  test.each(['local', 'dev', 'staging', 'prod'] as const)(
    'a hand-built %s Env without MAIL_LOCAL_URL gets the unconfigured mailer',
    async (environment) => {
      const env = {
        ...loadEnv({ ENVIRONMENT: 'local' }),
        ENVIRONMENT: environment,
      } as Env

      await expect(
        createInvitationMailer(env, { warn: () => {} }).deliver(MESSAGE, SIGNAL)
      ).rejects.toBeInstanceOf(InvitationMailerNotConfigured)
    }
  )

  test('the adapter is given the container logger, so a retry is noted with a status and attempt only', async () => {
    const mailbox = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('no', { status: 503 }),
    })
    const notes: { message: string; fields?: Record<string, unknown> }[] = []
    try {
      const env = loadEnv({
        ENVIRONMENT: 'local',
        MAIL_LOCAL_URL: `http://127.0.0.1:${mailbox.port}`,
      })

      await expect(
        createInvitationMailer(env, {
          warn: (message, fields) => void notes.push({ message, ...(fields ? { fields } : {}) }),
        }).deliver(MESSAGE, SIGNAL)
      ).rejects.toBeInstanceOf(Error)

      expect(notes).toEqual([
        {
          message: 'local mail delivery failed, retrying',
          fields: { reason: 'HTTP 503', attempt: 1 },
        },
        {
          message: 'local mail delivery failed, retrying',
          fields: { reason: 'HTTP 503', attempt: 2 },
        },
      ])
    } finally {
      await mailbox.stop(true)
    }
  })
})

describe('the secret box', () => {
  const context = {
    organizationId: formatId('org', crypto.randomUUID()),
    connectionId: formatId('crn', crypto.randomUUID()),
    purpose: 'access_token',
  } as const
  const ARN = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab'

  test('is the KMS one when CRM_TOKEN_KMS_KEY_ARN is set, with its ARN as the key id', async () => {
    const kms = new FakeKms()
    const box = createSecretBox(loadEnv({ ENVIRONMENT: 'local', CRM_TOKEN_KMS_KEY_ARN: ARN }), kms)
    const sealed = await box.seal('tok', context)
    expect(sealed.keyId).toBe(ARN)
    expect(kms.calls[0]?.context['closeline:service']).toBe('core')
  })

  test('outside local, unset stays fail-closed', async () => {
    const env = { ...loadEnv({ ENVIRONMENT: 'local' }), ENVIRONMENT: 'prod' } as Env
    await expect(createSecretBox(env).seal('tok', context)).rejects.toBeInstanceOf(
      SecretBoxNotConfigured
    )
  })

  test('in local, unset is the memory box', async () => {
    const sealed = await createSecretBox(loadEnv({ ENVIRONMENT: 'local' })).seal('tok', context)
    expect(sealed.keyId).toBe(MEMORY_SECRET_KEY_ID)
  })
})

test('outside local with no mailbox, an escalation notice fails loudly instead of passing silently', async () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const notifier = createRepNotifier(
    { ...loadEnv({ ENVIRONMENT: 'local' }), ENVIRONMENT: 'dev' } as Env,
    logger as never
  )
  await expect(
    notifier.notify(
      {
        kind: 'conversation_escalated',
        organizationId: 'org_1' as never,
        membershipId: 'mem_1' as never,
        conversationId: 'cnv_1' as never,
        email: 'rep@example.test',
        trigger: 'negative_tone',
        text: 'x',
      },
      new AbortController().signal
    )
  ).rejects.toBeInstanceOf(Error)
})

describe('the Transcript source', () => {
  const ARGS = {
    organizationId: formatId('org', 'a'.repeat(32)) as never,
    callId: formatId('call', 'b'.repeat(32)) as never,
    turnIndex: 1,
    window: 1,
  }
  const SIGNAL = new AbortController().signal

  test('local without VOICE_INTERNAL_URL keeps the memory reader', async () => {
    expect(
      await createTurnReader(loadEnv({ ENVIRONMENT: 'local' })).window(ARGS, SIGNAL)
    ).toBeNull()
  })

  test('with VOICE_INTERNAL_URL the window is read from voice over HTTP', async () => {
    const seen: string[] = []
    const voice = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        seen.push(new URL(request.url).pathname)
        return Response.json({ around: 1, turns: [{ index: 1, role: 'agent', text: 'hi' }] })
      },
    })
    try {
      const reader = createTurnReader(
        loadEnv({
          ENVIRONMENT: 'local',
          VOICE_INTERNAL_URL: `http://127.0.0.1:${voice.port}`,
          VOICE_INTERNAL_TOKEN: 'v'.repeat(40),
        })
      )
      expect((await reader.window(ARGS, SIGNAL))?.turns).toHaveLength(1)
      expect(seen[0]).toContain('/internal/v1/calls/')
    } finally {
      await voice.stop(true)
    }
  })
})

describe('createCalendar in local', () => {
  const orgId = formatId('org', crypto.randomUUID())
  const grant = (code: string, redirectUri: string) =>
    ({ organizationId: orgId, grant: { kind: 'authorization_code', code, redirectUri } }) as const

  test('accepts the documented dev code, then answers a busy call', async () => {
    const setup = createCalendar(loadEnv({ ENVIRONMENT: 'local' }))
    if (!setup) {
      throw new Error('no calendar')
    }
    const connection = await setup.port.connect(grant(LOCAL_CALENDAR_CODE, setup.redirectUri))
    const now = new Date()
    const busy = await setup.port.busy({
      organizationId: orgId,
      connection,
      from: now.toISOString(),
      to: new Date(now.getTime() + 3_600_000).toISOString(),
    })
    expect(busy).toEqual([])
  })

  test('refuses any other code', async () => {
    const setup = createCalendar(loadEnv({ ENVIRONMENT: 'local' }))
    await expect(
      setup?.port.connect(grant('some-other-code', setup.redirectUri))
    ).rejects.toMatchObject({ code: 'calendar.rejected' })
  })

  test('the redirect follows CALENDAR_REDIRECT_URI, else the portal base URL', () => {
    const portal = createCalendar(
      loadEnv({ ENVIRONMENT: 'local', PORTAL_BASE_URL: 'http://127.0.0.1:4555' })
    )
    expect(portal?.redirectUri).toBe('http://127.0.0.1:4555/calendar/callback')
    const explicit = createCalendar(
      loadEnv({ ENVIRONMENT: 'local', CALENDAR_REDIRECT_URI: 'http://127.0.0.1:1/cb' })
    )
    expect(explicit?.redirectUri).toBe('http://127.0.0.1:1/cb')
  })

  test('outside local with no Google config there is no calendar', () => {
    expect(createCalendar({ ENVIRONMENT: 'dev' } as Env)).toBeNull()
  })
})

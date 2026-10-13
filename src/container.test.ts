import { describe, expect, test } from 'bun:test'
import { InvitationMailerNotConfigured } from '~/adapters/unconfigured/invitation-mailer'
import type { InvitationMessage } from '~/ports/invitation-mailer'
import { createContainer, createInvitationMailer, reportSafely } from './container'
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
})

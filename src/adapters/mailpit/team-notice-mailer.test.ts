import { afterAll, describe, expect, test } from 'bun:test'
import type { TeamNotice } from '~/ports/team-notice-mailer'
import { MAIL_MAX_ATTEMPTS } from './sender'
import { createMailpitTeamNoticeMailer } from './team-notice-mailer'

const NOTICE: TeamNotice = {
  to: 'team@closeline.test',
  id: 'dreq_0190a7e0-0000-7000-8000-000000000000',
  name: 'Ada-marker',
  workEmail: 'ada-marker@example.test',
  companyName: 'Acme-marker',
  message: 'message-marker',
  sourcePage: '/pricing',
  submittedAt: new Date('2026-01-01T00:00:00Z'),
}
const NO_DEADLINE = new AbortController().signal

const servers: { stop: (force: boolean) => Promise<void> }[] = []
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)))
})

function stand(answer: (attempt: number) => Response) {
  const bodies: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      bodies.push(await request.text())
      return answer(bodies.length)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, bodies }
}

function connect(url: string) {
  const lines: string[] = []
  const record = (message: string, fields?: Record<string, unknown>) =>
    void lines.push(JSON.stringify({ message, fields }))
  return {
    lines,
    mailer: createMailpitTeamNoticeMailer({
      baseUrl: url,
      from: 'no-reply@closeline.test',
      logger: { warn: record },
      retryDelayMs: () => 0,
    }),
  }
}

describe('the team notice mailer', () => {
  test('sends the notice to its recipient through the send API', async () => {
    const mailpit = stand(() => Response.json({ ID: 'x' }))
    await connect(mailpit.url).mailer.deliver(NOTICE, NO_DEADLINE)
    expect(mailpit.bodies).toHaveLength(1)
    const sent = JSON.parse(mailpit.bodies[0] ?? '') as {
      To: { Email: string }[]
      Subject: string
      Text: string
    }
    expect(sent.To).toEqual([{ Email: 'team@closeline.test' }])
    expect(sent.Subject).toBe('Demo Request from Acme-marker')
    expect(sent.Text).toContain('message-marker')
  })

  test('retries a failure a bounded number of times, then rejects without logging the notice', async () => {
    const mailpit = stand(() => new Response('no', { status: 503 }))
    const { mailer, lines } = connect(mailpit.url)
    await expect(mailer.deliver(NOTICE, NO_DEADLINE)).rejects.toBeInstanceOf(Error)
    expect(mailpit.bodies).toHaveLength(MAIL_MAX_ATTEMPTS)
    const everything = lines.join('\n')
    for (const secret of ['marker', 'example.test', '/pricing']) {
      expect(everything).not.toContain(secret)
    }
  })

  test('a transient failure then success delivers once', async () => {
    const mailpit = stand((attempt) =>
      attempt === 1 ? new Response('no', { status: 503 }) : Response.json({ ID: 'x' })
    )
    await connect(mailpit.url).mailer.deliver(NOTICE, NO_DEADLINE)
    expect(mailpit.bodies).toHaveLength(2)
  })
})

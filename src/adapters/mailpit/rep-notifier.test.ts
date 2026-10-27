import { afterAll, describe, expect, test } from 'bun:test'
import type {
  ConversationId,
  MembershipId,
  MessageId,
  OrganizationId,
} from 'tula-closeline-contract'
import type { RepNotice } from '~/ports/rep-notifier'
import { createLoggingRepNotifier } from '../logging/rep-notifier'
import { createMailpitRepNotifier, ESCALATION_EMAIL_SUBJECT } from './rep-notifier'
import { MAIL_MAX_ATTEMPTS } from './sender'

const ESCALATED: RepNotice = {
  kind: 'conversation_escalated',
  organizationId: 'org_1' as OrganizationId,
  membershipId: 'mem_1' as MembershipId,
  conversationId: 'cnv_1' as ConversationId,
  email: 'rep@closeline.test',
  trigger: 'negative_tone',
  text: 'A Conversation was escalated to you and needs a person.',
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
  const warn = (message: string, fields?: Record<string, unknown>) =>
    void lines.push(JSON.stringify({ message, fields }))
  const fallbackNotices: RepNotice[] = []
  return {
    lines,
    fallbackNotices,
    notifier: createMailpitRepNotifier({
      baseUrl: url,
      from: 'no-reply@closeline.test',
      logger: { warn },
      retryDelayMs: () => 0,
      fallback: {
        notify: async (notice) => {
          fallbackNotices.push(notice)
        },
      },
    }),
  }
}

describe('the Mailpit Rep notifier', () => {
  test('mails an escalation to the Rep with a fixed subject and sentence', async () => {
    const mailpit = stand(() => Response.json({ ID: 'x' }))
    await connect(mailpit.url).notifier.notify(ESCALATED, NO_DEADLINE)
    expect(mailpit.bodies).toHaveLength(1)
    const sent = JSON.parse(mailpit.bodies[0] ?? '') as {
      To: { Email: string }[]
      Subject: string
      Text: string
    }
    expect(sent.To).toEqual([{ Email: 'rep@closeline.test' }])
    expect(sent.Subject).toBe(ESCALATION_EMAIL_SUBJECT)
    expect(sent.Text).toBe(ESCALATED.kind === 'conversation_escalated' ? ESCALATED.text : '')
  })

  test('retries a bounded number of times, then rejects without logging the address', async () => {
    const mailpit = stand(() => new Response('no', { status: 503 }))
    const { notifier, lines } = connect(mailpit.url)
    await expect(notifier.notify(ESCALATED, NO_DEADLINE)).rejects.toBeInstanceOf(Error)
    expect(mailpit.bodies).toHaveLength(MAIL_MAX_ATTEMPTS)
    expect(lines.join('\n')).not.toContain('closeline.test')
  })

  test('hands every other notice to the fallback and sends no mail', async () => {
    const mailpit = stand(() => Response.json({ ID: 'x' }))
    const { notifier, fallbackNotices } = connect(mailpit.url)
    const takeover: RepNotice = {
      kind: 'reply_during_takeover',
      organizationId: 'org_1' as OrganizationId,
      membershipId: 'mem_1' as MembershipId,
      conversationId: 'cnv_1' as ConversationId,
      messageId: 'msg_1' as MessageId,
      text: 'A Prospect replied in a Conversation you took over.',
    }
    await notifier.notify(takeover, NO_DEADLINE)
    expect(fallbackNotices).toEqual([takeover])
    expect(mailpit.bodies).toHaveLength(0)
  })
})

describe('the logging Rep notifier', () => {
  test('logs ids only for an escalation, never the address', async () => {
    const lines: string[] = []
    const notifier = createLoggingRepNotifier({
      info: (message: string, fields?: Record<string, unknown>) =>
        void lines.push(JSON.stringify({ message, fields })),
    } as Parameters<typeof createLoggingRepNotifier>[0])
    await notifier.notify(ESCALATED, NO_DEADLINE)
    expect(lines.join('\n')).not.toContain('closeline.test')
    expect(lines.join('\n')).toContain('cnv_1')
  })
})

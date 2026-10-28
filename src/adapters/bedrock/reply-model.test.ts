import { describe, expect, test } from 'bun:test'
import { formatId, type OrganizationId } from 'tula-closeline-contract'
import { createMemoryLlm } from 'tula-closeline-kit/testing'
import { narrowClassification } from '~/modules/inbox/classify'
import { narrowWrittenReply } from '~/modules/inbox/draft'
import { createMemoryReplyClassifier } from '../memory/reply-classifier'
import { createMemoryReplyWriter } from '../memory/reply-writer'
import { createBedrockReplyClassifier } from './reply-classifier'
import { createBedrockReplyWriter } from './reply-writer'

const organizationId = formatId('org', crypto.randomUUID()) as OrganizationId
const signal = () => new AbortController().signal
const fast = { sleep: async () => {}, random: () => 0.5 }

function bedrockClassifier(text: string) {
  const llm = createMemoryLlm(fast)
  llm.reply(text)
  return { llm, classifier: createBedrockReplyClassifier(llm) }
}

describe('reply classifier behaviour (both adapters)', () => {
  const adapters = {
    memory: () => createMemoryReplyClassifier(),
    bedrock: () =>
      bedrockClassifier(
        JSON.stringify({ label: 'unsubscribe', confidence: 0.97, signals: ['pricing_or_legal'] })
      ).classifier,
  }
  for (const [name, make] of Object.entries(adapters)) {
    test(`${name}: an unsubscribe reply narrows to unsubscribe`, async () => {
      const raw = await make().classify(
        {
          organizationId,
          body: 'Please unsubscribe me. Remove me, stop emailing, legal',
          channel: 'email',
        },
        signal()
      )
      expect(narrowClassification(raw).label).toBe('unsubscribe')
    })
  }
})

describe('Bedrock reply classifier', () => {
  const reply = { organizationId, body: 'hello', channel: 'email' as const }

  test('malformed or out-of-schema output narrows to other with no confidence', async () => {
    for (const text of [
      'not json',
      '{"label":"hack","confidence":2,"signals":[]}',
      '{"label":"positive"}',
    ]) {
      const { classifier } = bedrockClassifier(text)
      expect(narrowClassification(await classifier.classify(reply, signal()))).toEqual({
        label: 'other',
        confidence: 0,
      })
    }
  })

  test('an unavailable model is retried a bounded number of times, then throws', async () => {
    const llm = createMemoryLlm(fast)
    llm.failNext('llm.unavailable', 10)
    await expect(createBedrockReplyClassifier(llm).classify(reply, signal())).rejects.toThrow()
    expect(llm.requests().length).toBe(3)
  })

  test('uses the fast tier for the caller Organization', async () => {
    const { llm, classifier } = bedrockClassifier('{"label":"other","confidence":0.5,"signals":[]}')
    await classifier.classify(reply, signal())
    expect(llm.requests()[0]).toMatchObject({ tier: 'fast', organizationId })
  })
})

describe('reply writer behaviour (both adapters)', () => {
  const input = {
    organizationId,
    label: 'objection' as const,
    channel: 'email' as const,
    fencedMessage: '<<<fenced>>>',
    moments: [{ id: 'm1', prospect: 'p', repNext: 'r' }],
  }
  const good = JSON.stringify({ body: 'Thanks.', strategy: 's', confidence: 0.8, citedIds: ['m1'] })
  const adapters = {
    memory: () => createMemoryReplyWriter(),
    bedrock: () => {
      const llm = createMemoryLlm(fast)
      llm.reply(good)
      return createBedrockReplyWriter(llm)
    },
  }
  for (const [name, make] of Object.entries(adapters)) {
    test(`${name}: writes a body that cites a given moment`, async () => {
      const written = narrowWrittenReply(await make().write(input, signal()))
      expect(written?.body).not.toBe('')
      expect(written?.citedIds).toEqual(['m1'])
    })
  }
})

describe('Bedrock reply writer', () => {
  const input = {
    organizationId,
    label: 'question' as const,
    channel: 'email' as const,
    fencedMessage: 'x',
    moments: [],
  }

  test('malformed output yields no Draft instead of a partial one', async () => {
    for (const text of [
      'nope',
      '{"body":"","strategy":"s","confidence":0.5,"citedIds":[]}',
      '{"body":"hi"}',
    ]) {
      const llm = createMemoryLlm(fast)
      llm.reply(text)
      expect(
        narrowWrittenReply(await createBedrockReplyWriter(llm).write(input, signal()))
      ).toBeNull()
    }
  })

  test('uses the smart tier', async () => {
    const llm = createMemoryLlm(fast)
    llm.reply('{"body":"hi","strategy":"s","confidence":0.5,"citedIds":[]}')
    await createBedrockReplyWriter(llm).write(input, signal())
    expect(llm.requests()[0]?.tier).toBe('smart')
  })
})

// The gated live test needs real Bedrock credentials; no environment has them yet.
test.skipIf(!process.env.BEDROCK_LIVE_TEST)(
  'live Bedrock classifier answers in the schema',
  async () => {
    const { createBedrockLlm } = await import('tula-closeline-kit/llm')
    const classifier = createBedrockReplyClassifier(
      createBedrockLlm({ region: process.env.AWS_REGION ?? 'us-east-1' })
    )
    const raw = await classifier.classify(
      { organizationId, body: 'Please unsubscribe me', channel: 'email' },
      signal()
    )
    expect(narrowClassification(raw).label).toBe('unsubscribe')
  }
)

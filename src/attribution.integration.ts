import { describe, expect, test } from 'bun:test'
import {
  type DealRecordId,
  formatId,
  type MessageId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { store } from '~/integration-harness'
import { jobRegistry } from '~/messages'
import { attributeOutcome, type OutcomeChangedEnvelope } from '~/modules/analytics/attribution'
import { createTestDeps, seedOrganization } from '~/testing'

const id = (prefix: Parameters<typeof formatId>[0]) =>
  formatId(prefix, crypto.randomUUID().replaceAll('-', ''))
const DAY_MS = 86_400_000
const CHANGED_AT = new Date()
const daysBefore = (days: number) => new Date(CHANGED_AT.getTime() - days * DAY_MS)

/** A Moment reference the way a Draft stores it. */
const moment = () => `${id('call')}:${id('deal')}:2`

function outcomeJob(
  organizationId: OrganizationId,
  prospectId: ProspectId,
  outcome: 'won' | 'lost',
  dealRecordId: DealRecordId = id('deal') as DealRecordId
): OutcomeChangedEnvelope {
  return jobRegistry.create({
    type: 'deal.outcome_changed',
    organizationId,
    traceId: 'trace-attribution',
    payload: {
      dealRecordId,
      prospectId,
      previousOutcome: 'open',
      outcome,
      changedAt: CHANGED_AT.toISOString(),
    },
  }) as OutcomeChangedEnvelope
}

/** Plants a Prospect, a Conversation and outbound agent Messages, citing the given Moments. */
async function plant(organizationId: OrganizationId, sends: { days: number; source?: string }[]) {
  const prospectId = id('prs') as ProspectId
  const messageIds: MessageId[] = []
  await store.withOrganization(organizationId, async (scope) => {
    await scope.lockOrganization()
    await scope.insertProspect({
      id: prospectId,
      companyId: null,
      ownerMembershipId: null,
      source: 'manual',
      tags: [],
      notes: null,
      now: daysBefore(300),
    })
    const conversationId = id('cnv') as Parameters<typeof scope.insertConversation>[0]['id']
    await scope.insertConversation({
      id: conversationId,
      prospectId,
      channel: 'email',
      ownerMembershipId: null,
      now: daysBefore(300),
      lastMessageAt: daysBefore(300),
    })
    for (const send of sends) {
      const messageId = id('msg') as MessageId
      let draftId: Parameters<typeof scope.insertMessage>[0]['draftId'] = null
      if (send.source) {
        draftId = id('drf') as NonNullable<typeof draftId>
        const triggerMessageId = id('msg') as MessageId
        await scope.insertMessage({
          id: triggerMessageId,
          conversationId,
          channel: 'email',
          direction: 'inbound',
          authorKind: 'prospect',
          authorMembershipId: null,
          providerMessageId: id('msg'),
          draftId: null,
          body: 'text',
          sentAt: daysBefore(send.days + 1),
        })
        await scope.insertAgentDraft({
          id: draftId,
          conversationId,
          triggerMessageId,
          label: 'objection',
          body: 'text',
          strategy: 'strategy',
          confidence: 0.9,
          ungrounded: false,
          hold: null,
          sources: [
            {
              kind: 'moment',
              sourceRef: send.source,
              position: 0,
              dealRecordId: send.source.split(':')[1] as DealRecordId,
              outcome: 'won',
              evidenceCount: 1,
            },
          ],
          now: daysBefore(send.days),
        })
      }
      await scope.insertMessage({
        id: messageId,
        conversationId,
        channel: 'email',
        direction: 'outbound',
        authorKind: 'agent',
        authorMembershipId: null,
        providerMessageId: id('msg'),
        draftId,
        body: 'text',
        sentAt: daysBefore(send.days),
      })
      messageIds.push(messageId)
    }
  })
  return { prospectId, messageIds }
}

describe('Outcome attribution, over Postgres', () => {
  test('a won Deal gets first and last touch, a rerun changes nothing, and another Organization is untouched', async () => {
    const deps = createTestDeps({ store })
    const a = await seedOrganization(store, ['rep'])
    const b = await seedOrganization(store, ['rep'])
    const shared = moment()
    const mine = await plant(a.organizationId, [
      { days: 40, source: shared },
      { days: 20 },
      { days: 5, source: moment() },
    ])
    // The other Organization cites the very same Moment and wins a Deal of its own.
    const theirs = await plant(b.organizationId, [{ days: 10, source: shared }])
    const job = outcomeJob(a.organizationId, mine.prospectId, 'won')

    expect(await attributeOutcome(deps, a.organizationId, job)).toEqual({
      state: 'attributed',
      touches: 3,
      sources: 2,
    })
    const read = (organizationId: OrganizationId, dealRecordId: DealRecordId) =>
      store.withOrganization(organizationId, (scope) => scope.listDealTouches(dealRecordId, 50))
    const [m0, m1, m2] = mine.messageIds as [MessageId, MessageId, MessageId]
    const touches = await read(a.organizationId, job.payload.dealRecordId)
    expect(touches.map((t) => [t.messageId, t.firstTouch, t.lastTouch])).toEqual([
      [m0, true, false],
      [m1, false, false],
      [m2, false, true],
    ])

    const performance = () =>
      store.withOrganization(a.organizationId, (scope) =>
        scope.listSourcePerformance({ limit: 50 })
      )
    const before = await performance()
    expect(before.map((s) => [s.dealsTouched, s.dealsWon])).toEqual([
      [1, 1],
      [1, 1],
    ])
    expect(await attributeOutcome(deps, a.organizationId, job)).toEqual({
      state: 'skipped',
      reason: 'already_attributed',
    })
    expect(await performance()).toEqual(before)

    // Nothing of the first Organization reached the second, and its own Deal counts separately.
    expect(
      await store.withOrganization(b.organizationId, (scope) =>
        scope.listSourcePerformance({ limit: 50 })
      )
    ).toEqual([])
    const second = outcomeJob(b.organizationId, theirs.prospectId, 'lost')
    await attributeOutcome(deps, b.organizationId, second)
    const lost = await store.withOrganization(b.organizationId, (scope) =>
      scope.listSourcePerformance({ limit: 50 })
    )
    expect(lost.map((s) => [s.dealsTouched, s.dealsWon])).toEqual([[1, 0]])
    expect(await read(a.organizationId, second.payload.dealRecordId)).toEqual([])
    expect(await performance()).toEqual(before)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  type DealRecordId,
  formatId,
  type MembershipId,
  type MessageId,
  type OrganizationId,
  type ProspectId,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { jobRegistry } from '~/messages'
import { processAssignJobs } from '~/modules/prospect/assign-worker'
import { sourceWinRate } from '~/ports/attribution-store'
import { createTestDeps, seedOrganization } from '~/testing'
import {
  ATTRIBUTION_CANDIDATE_LIMIT,
  attributeOutcome,
  type OutcomeChangedEnvelope,
} from './attribution'

const id = (prefix: Parameters<typeof formatId>[0]) =>
  formatId(prefix, crypto.randomUUID().replaceAll('-', ''))

const CHANGED_AT = '2026-03-01T00:00:00Z'
const daysBefore = (days: number, from = CHANGED_AT) =>
  new Date(new Date(from).getTime() - days * 24 * 60 * 60 * 1000)

/** A Moment reference the way a Draft stores it. */
const moment = () => `${id('call')}:${id('deal')}:3`

type Planted = { messageId: MessageId; sentAt: Date }

function outcomeJob(
  organizationId: OrganizationId,
  prospectId: ProspectId | null,
  outcome: 'won' | 'lost' | 'open',
  over: { dealRecordId?: DealRecordId; changedAt?: string } = {}
): OutcomeChangedEnvelope {
  return jobRegistry.create({
    type: 'deal.outcome_changed',
    organizationId,
    traceId: 'trace-attribution',
    payload: {
      dealRecordId: over.dealRecordId ?? (id('deal') as DealRecordId),
      prospectId,
      previousOutcome: outcome === 'open' ? 'won' : 'open',
      outcome,
      changedAt: over.changedAt ?? CHANGED_AT,
    },
  }) as OutcomeChangedEnvelope
}

async function setup() {
  const store = createMemoryCoreStore()
  const deps = createTestDeps({ store })
  const first = await seedOrganization(store, ['rep'])
  const second = await seedOrganization(store, ['rep'])
  const rep = first.members[1]?.id as MembershipId

  /** Plants a Conversation of the Prospect and the outbound Messages sent on the given days before the Outcome. */
  const plant = async (
    organizationId: OrganizationId,
    prospectId: ProspectId,
    messages: {
      daysBefore: number
      by?: 'agent' | 'rep' | 'prospect'
      sources?: string[]
      at?: Date
    }[]
  ): Promise<Planted[]> => {
    const planted: Planted[] = []
    await store.withOrganization(organizationId, async (scope) => {
      await scope.lockOrganization()
      const conversationId = id('cnv') as Parameters<typeof scope.insertConversation>[0]['id']
      await scope.insertConversation({
        id: conversationId,
        prospectId,
        channel: 'email',
        ownerMembershipId: null,
        now: new Date('2026-01-01T00:00:00Z'),
        lastMessageAt: new Date('2026-01-01T00:00:00Z'),
      })
      for (const item of messages) {
        const sentAt = item.at ?? daysBefore(item.daysBefore)
        const by = item.by ?? 'agent'
        const messageId = id('msg') as MessageId
        let draftId: Parameters<typeof scope.insertMessage>[0]['draftId'] = null
        if (item.sources && by !== 'prospect') {
          draftId = id('drf') as NonNullable<typeof draftId>
          await scope.insertAgentDraft({
            id: draftId,
            conversationId,
            triggerMessageId: id('msg') as MessageId,
            label: 'objection',
            body: 'text',
            strategy: 'strategy',
            confidence: 0.9,
            ungrounded: false,
            hold: null,
            sources: item.sources.map((sourceRef, position) => ({
              kind: 'moment' as const,
              sourceRef,
              position,
              dealRecordId: sourceRef.split(':')[1] as DealRecordId,
              outcome: 'won' as const,
              evidenceCount: 1,
            })),
            now: sentAt,
          })
        }
        await scope.insertMessage({
          id: messageId,
          conversationId,
          channel: 'email',
          direction: by === 'prospect' ? 'inbound' : 'outbound',
          authorKind: by,
          authorMembershipId: by === 'rep' ? rep : null,
          providerMessageId: id('msg'),
          draftId,
          body: 'text',
          sentAt,
        })
        planted.push({ messageId, sentAt })
      }
    })
    return planted
  }

  const touchesOf = (organizationId: OrganizationId, dealRecordId: DealRecordId) =>
    store.withOrganization(organizationId, (scope) => scope.listDealTouches(dealRecordId, 100))
  const performance = (organizationId: OrganizationId) =>
    store.withOrganization(organizationId, (scope) => scope.listSourcePerformance({ limit: 100 }))
  const attribute = (organizationId: OrganizationId, job: OutcomeChangedEnvelope) =>
    attributeOutcome(deps, organizationId, job)
  return { store, deps, first, second, rep, plant, touchesOf, performance, attribute }
}

const prospect = () => id('prs') as ProspectId

describe('Outcome attribution', () => {
  test('a won Deal credits the earliest touch first and the latest last, and the sources they cited', async () => {
    const { first, plant, touchesOf, performance, attribute, rep } = await setup()
    const prospectId = prospect()
    const a = moment()
    const b = moment()
    const [early, middle, late] = (await plant(first.organizationId, prospectId, [
      { daysBefore: 100, by: 'rep', sources: [a] },
      { daysBefore: 50, sources: [a, b] },
      { daysBefore: 10, sources: [b] },
      { daysBefore: 30, by: 'prospect' },
      { daysBefore: 200, sources: [moment()] },
    ])) as [Planted, Planted, Planted]
    const job = outcomeJob(first.organizationId, prospectId, 'won')

    const result = await attribute(first.organizationId, job)

    expect(result).toEqual({ state: 'attributed', touches: 3, sources: 2 })
    const touches = await touchesOf(first.organizationId, job.payload.dealRecordId)
    expect(touches.map((t) => [t.messageId, t.firstTouch, t.lastTouch])).toEqual([
      [early.messageId, true, false],
      [middle.messageId, false, false],
      [late.messageId, false, true],
    ])
    expect(touches[0]?.repMembershipId).toBe(rep)
    expect(touches[1]?.repMembershipId).toBeNull()
    expect(touches[1]?.citedSources.map((s) => s.kind)).toEqual(['moment', 'moment'])
    const counts = (await performance(first.organizationId)).map((s) => [
      s.dealsTouched,
      s.dealsWon,
      s.flag,
    ])
    expect(counts).toEqual([
      [1, 1, null],
      [1, 1, null],
    ])
  })

  test('a single touch is both the first and the last', async () => {
    const { first, plant, touchesOf, attribute } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [{ daysBefore: 5 }])
    const job = outcomeJob(first.organizationId, prospectId, 'lost')
    await attribute(first.organizationId, job)
    const touches = await touchesOf(first.organizationId, job.payload.dealRecordId)
    expect(touches.map((t) => [t.firstTouch, t.lastTouch])).toEqual([[true, true]])
  })

  test('running the same job again changes nothing', async () => {
    const { first, plant, touchesOf, performance, attribute } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [
      { daysBefore: 20, sources: [moment()] },
      { daysBefore: 2, sources: [moment()] },
    ])
    const job = outcomeJob(first.organizationId, prospectId, 'won')
    await attribute(first.organizationId, job)
    const touches = await touchesOf(first.organizationId, job.payload.dealRecordId)
    const sources = await performance(first.organizationId)

    expect(await attribute(first.organizationId, job)).toEqual({
      state: 'skipped',
      reason: 'already_attributed',
    })
    expect(await attribute(first.organizationId, { ...job, id: id('msg') })).toEqual({
      state: 'skipped',
      reason: 'already_attributed',
    })

    expect(await touchesOf(first.organizationId, job.payload.dealRecordId)).toEqual(touches)
    expect(await performance(first.organizationId)).toEqual(sources)
  })

  test('a lost Deal counts the sources as touched and not won', async () => {
    const { first, plant, performance, attribute } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [{ daysBefore: 4, sources: [moment()] }])
    await attribute(first.organizationId, outcomeJob(first.organizationId, prospectId, 'lost'))
    expect(
      (await performance(first.organizationId)).map((s) => [s.dealsTouched, s.dealsWon])
    ).toEqual([[1, 0]])
  })

  test('a Deal that is open, or has no Prospect, or no touches, credits nothing', async () => {
    const { first, plant, performance, attribute } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [{ daysBefore: 4, sources: [moment()] }])
    expect(
      await attribute(first.organizationId, outcomeJob(first.organizationId, prospectId, 'open'))
    ).toEqual({
      state: 'skipped',
      reason: 'not_decided',
    })
    expect(
      await attribute(first.organizationId, outcomeJob(first.organizationId, null, 'won'))
    ).toEqual({
      state: 'skipped',
      reason: 'no_prospect',
    })
    expect(
      await attribute(first.organizationId, outcomeJob(first.organizationId, prospect(), 'won'))
    ).toEqual({
      state: 'skipped',
      reason: 'no_touches',
    })
    expect(await performance(first.organizationId)).toEqual([])
  })

  test('only Messages inside the look-back window are touches', async () => {
    const { first, plant, touchesOf, attribute } = await setup()
    const prospectId = prospect()
    const [inside, edge] = (await plant(first.organizationId, prospectId, [
      { daysBefore: 179 },
      { daysBefore: 180 },
      { daysBefore: 181 },
      { daysBefore: 0, at: new Date('2026-03-01T00:00:01Z') },
    ])) as [Planted, Planted]
    const job = outcomeJob(first.organizationId, prospectId, 'won')
    await attribute(first.organizationId, job)
    const touches = await touchesOf(first.organizationId, job.payload.dealRecordId)
    expect(touches.map((t) => t.messageId)).toEqual([edge.messageId, inside.messageId])
  })

  test('a Message already credited to another Deal stays with that Deal', async () => {
    const { first, plant, touchesOf, attribute } = await setup()
    const prospectId = prospect()
    const [old] = (await plant(first.organizationId, prospectId, [{ daysBefore: 60 }])) as [Planted]
    const earlier = outcomeJob(first.organizationId, prospectId, 'won', {
      changedAt: '2026-01-15T00:00:00Z',
    })
    await attribute(first.organizationId, earlier)
    const [fresh] = (await plant(first.organizationId, prospectId, [{ daysBefore: 3 }])) as [
      Planted,
    ]
    const later = outcomeJob(first.organizationId, prospectId, 'lost')

    await attribute(first.organizationId, later)

    expect(
      (await touchesOf(first.organizationId, earlier.payload.dealRecordId)).map((t) => t.messageId)
    ).toEqual([old.messageId])
    const credited = await touchesOf(first.organizationId, later.payload.dealRecordId)
    expect(credited.map((t) => [t.messageId, t.firstTouch, t.lastTouch])).toEqual([
      [fresh.messageId, true, true],
    ])
  })

  test('reads at most the candidate limit of Messages', async () => {
    const { first, deps, plant } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [{ daysBefore: 1 }])
    const calls: number[] = []
    const spy = {
      ...deps,
      store: {
        ...deps.store,
        withOrganization: <T>(
          organizationId: OrganizationId,
          work: Parameters<typeof deps.store.withOrganization<T>>[1]
        ) =>
          deps.store.withOrganization(organizationId, (scope) =>
            work({
              ...scope,
              listAttributionCandidates: (p, w, limit) => {
                calls.push(limit)
                return scope.listAttributionCandidates(p, w, limit)
              },
            })
          ),
      },
    } as typeof deps
    await attributeOutcome(
      spy,
      first.organizationId,
      outcomeJob(first.organizationId, prospectId, 'won')
    )
    expect(calls).toEqual([ATTRIBUTION_CANDIDATE_LIMIT])
  })

  test('another Organization never counts, and its events never change ours', async () => {
    const { first, second, plant, touchesOf, performance, attribute } = await setup()
    const prospectId = prospect()
    const shared = moment()
    // The other Organization has a Conversation under the very same Prospect id.
    await plant(second.organizationId, prospectId, [
      { daysBefore: 90, sources: [shared] },
      { daysBefore: 1, sources: [shared] },
    ])
    const ours = await plant(first.organizationId, prospectId, [
      { daysBefore: 7, sources: [shared] },
    ])
    const job = outcomeJob(first.organizationId, prospectId, 'won')

    await attribute(first.organizationId, job)

    const touches = await touchesOf(first.organizationId, job.payload.dealRecordId)
    expect(touches.map((t) => t.messageId)).toEqual(ours.map((m) => m.messageId))
    expect((await performance(first.organizationId)).map((s) => s.dealsTouched)).toEqual([1])
    expect(await performance(second.organizationId)).toEqual([])
    expect(await touchesOf(second.organizationId, job.payload.dealRecordId)).toEqual([])

    // Their Deal, with the same Deal id, counts only for them and leaves our rows as they were.
    const ourSources = await performance(first.organizationId)
    await attribute(second.organizationId, {
      ...outcomeJob(second.organizationId, prospectId, 'lost', {
        dealRecordId: job.payload.dealRecordId,
      }),
    })
    expect(await performance(first.organizationId)).toEqual(ourSources)
    expect(await touchesOf(first.organizationId, job.payload.dealRecordId)).toEqual(touches)
    expect(
      (await performance(second.organizationId)).map((s) => [s.dealsTouched, s.dealsWon])
    ).toEqual([[1, 0]])
  })

  test('an Organization that is gone attributes nothing', async () => {
    const { attribute } = await setup()
    const missing = id('org') as OrganizationId
    expect(await attribute(missing, outcomeJob(missing, prospect(), 'won'))).toEqual({
      state: 'skipped',
      reason: 'organization_gone',
    })
  })
})

describe('source win rate', () => {
  test('reads "not enough data" under 20 Deals and a rate from 20', () => {
    expect(sourceWinRate(0, 0)).toEqual({ state: 'not_enough_data', value: null })
    expect(sourceWinRate(19, 19)).toEqual({ state: 'not_enough_data', value: null })
    expect(sourceWinRate(20, 5)).toEqual({ state: 'ok', value: 0.25 })
  })

  test('carries n and flags a source cited in 20 Deals that were nearly all lost', async () => {
    const { first, plant, performance, attribute } = await setup()
    const cited = moment()
    const wins = [true, true, ...Array<boolean>(18).fill(false)]
    for (const [index, won] of wins.entries()) {
      const prospectId = prospect()
      await plant(first.organizationId, prospectId, [{ daysBefore: 5, sources: [cited] }])
      await attribute(
        first.organizationId,
        outcomeJob(first.organizationId, prospectId, won ? 'won' : 'lost')
      )
      const [row] = await performance(first.organizationId)
      expect(row?.dealsTouched).toBe(index + 1)
      expect(row?.flag).toBe(index + 1 >= 20 ? 'cited_often_lost' : null)
    }
    const [row] = await performance(first.organizationId)
    expect([row?.dealsTouched, row?.dealsWon]).toEqual([20, 2])
    expect(sourceWinRate(row?.dealsTouched ?? 0, row?.dealsWon ?? 0).state).toBe('ok')
  })
})

describe('the jobs worker', () => {
  test('attributes a queued Outcome and also counts it, and a redelivery changes nothing', async () => {
    const { first, deps, plant, touchesOf } = await setup()
    const prospectId = prospect()
    await plant(first.organizationId, prospectId, [{ daysBefore: 9, sources: [moment()] }])
    const job = outcomeJob(first.organizationId, prospectId, 'won')
    await deps.jobs.publishBatch([job, job])
    const signal = new AbortController().signal
    for (let n = await processAssignJobs(deps, signal); n > 0; ) {
      n = await processAssignJobs(deps, signal)
    }
    expect(await touchesOf(first.organizationId, job.payload.dealRecordId)).toHaveLength(1)
  })
})

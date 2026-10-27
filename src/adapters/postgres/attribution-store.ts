import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  type CitationRef,
  citationRefSchema,
  dealRecordIdSchema,
  membershipIdSchema,
  messageIdSchema,
  type OrganizationId,
  prospectIdSchema,
  touchIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  conversations,
  draftSources,
  messages,
  sourcePerformance,
  touches,
} from 'tula-closeline-db/schema'
import {
  type AttributedTouchRecord,
  type AttributionCandidate,
  type AttributionScope,
  citationOfMomentRef,
} from '~/ports/attribution-store'

/** The stored Citation references of a touch, read back through the contract's own schema. */
function citationsOf(value: unknown): CitationRef[] {
  return citationRefSchema.array().parse(value)
}

/** Builds the Attribution methods of one Organization's transaction; every statement names the Organization as well as relying on row-level security. */
export function createAttributionStore(
  tx: Transaction,
  organizationId: OrganizationId
): AttributionScope {
  return {
    hasAttributedTouches: async (dealRecordId) => {
      const found = await tx
        .select({ id: touches.id })
        .from(touches)
        .where(
          and(eq(touches.organizationId, organizationId), eq(touches.dealRecordId, dealRecordId))
        )
        .limit(1)
      return found.length > 0
    },

    listAttributionCandidates: async (prospectId, window, limit) => {
      const rows = await tx
        .select({
          id: messages.id,
          channel: messages.channel,
          authorKind: messages.authorKind,
          authorMembershipId: messages.authorMembershipId,
          draftId: messages.draftId,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .innerJoin(
          conversations,
          and(
            eq(conversations.organizationId, messages.organizationId),
            eq(conversations.id, messages.conversationId)
          )
        )
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(conversations.organizationId, organizationId),
            eq(conversations.prospectId, prospectId),
            eq(messages.direction, 'outbound'),
            inArray(messages.authorKind, ['agent', 'rep']),
            gte(messages.sentAt, window.from),
            lte(messages.sentAt, window.to)
          )
        )
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(limit)
      if (rows.length === 0) {
        return []
      }
      const draftIds = rows.flatMap((r) => (r.draftId === null ? [] : [r.draftId]))
      const sourceRows =
        draftIds.length === 0
          ? []
          : await tx
              .select({
                draftId: draftSources.draftId,
                sourceRef: draftSources.sourceRef,
              })
              .from(draftSources)
              .where(
                and(
                  eq(draftSources.organizationId, organizationId),
                  eq(draftSources.kind, 'moment'),
                  inArray(draftSources.draftId, draftIds)
                )
              )
              .orderBy(asc(draftSources.draftId), asc(draftSources.position))
      const credited = await tx
        .select({ refId: touches.refId, dealRecordId: touches.dealRecordId })
        .from(touches)
        .where(
          and(
            eq(touches.organizationId, organizationId),
            eq(touches.kind, 'message'),
            inArray(
              touches.refId,
              rows.map((r) => r.id)
            )
          )
        )
      const creditedTo = new Map(credited.map((c) => [c.refId, c.dealRecordId]))
      return rows.map((row): AttributionCandidate => {
        const sources: CitationRef[] = []
        for (const source of sourceRows) {
          const cited =
            source.draftId === row.draftId ? citationOfMomentRef(source.sourceRef) : null
          if (cited) {
            sources.push(cited)
          }
        }
        const deal = creditedTo.get(row.id)
        return {
          messageId: messageIdSchema.parse(row.id),
          channel: row.channel,
          authorKind: row.authorKind === 'rep' ? 'rep' : 'agent',
          authorMembershipId:
            row.authorMembershipId === null
              ? null
              : membershipIdSchema.parse(row.authorMembershipId),
          occurredAt: row.sentAt,
          sources,
          creditedTo: deal ? dealRecordIdSchema.parse(deal) : null,
        }
      })
    },

    attributeTouches: async (dealRecordId, input) => {
      if (input.length === 0) {
        return 0
      }
      const stored = await tx
        .insert(touches)
        .values(
          input.map((t) => ({
            id: t.id,
            organizationId,
            kind: 'message' as const,
            refId: t.messageId,
            prospectId: t.prospectId,
            channel: t.channel,
            repMembershipId: t.repMembershipId,
            occurredAt: t.occurredAt,
            dealRecordId,
            firstTouch: t.firstTouch,
            lastTouch: t.lastTouch,
            citedSources: t.citedSources,
          }))
        )
        .onConflictDoNothing({ target: [touches.organizationId, touches.kind, touches.refId] })
        .returning({ id: touches.id })
      return stored.length
    },

    creditSources: async (credits, won, rule) => {
      for (const credit of credits) {
        const touched = sql`${sourcePerformance.dealsTouched} + 1`
        const wonAfter = sql`${sourcePerformance.dealsWon} + ${won ? 1 : 0}`
        await tx
          .insert(sourcePerformance)
          .values({
            organizationId,
            sourceKind: credit.kind,
            sourceKey: credit.key,
            dealsTouched: 1,
            dealsWon: won ? 1 : 0,
            flag:
              1 >= rule.minSample && (won ? 1 : 0) / 1 < rule.winRateBelow
                ? 'cited_often_lost'
                : null,
          })
          .onConflictDoUpdate({
            target: [
              sourcePerformance.organizationId,
              sourcePerformance.sourceKind,
              sourcePerformance.sourceKey,
            ],
            set: {
              dealsTouched: touched,
              dealsWon: wonAfter,
              flag: sql`case when (${touched}) >= ${rule.minSample}
                and (${wonAfter})::double precision / (${touched}) < ${rule.winRateBelow}
                then 'cited_often_lost' else null end`,
              updatedAt: sql`now()`,
            },
          })
      }
    },

    listDealTouches: async (dealRecordId, limit) => {
      const rows = await tx
        .select()
        .from(touches)
        .where(
          and(eq(touches.organizationId, organizationId), eq(touches.dealRecordId, dealRecordId))
        )
        .orderBy(asc(touches.occurredAt), asc(touches.id))
        .limit(limit)
      return rows.map((row): AttributedTouchRecord => {
        if (row.channel === null || row.channel === 'phone') {
          throw new Error('a Message touch carries a Message channel')
        }
        return {
          id: touchIdSchema.parse(row.id),
          messageId: messageIdSchema.parse(row.refId),
          prospectId: prospectIdSchema.parse(row.prospectId),
          channel: row.channel,
          repMembershipId:
            row.repMembershipId === null ? null : membershipIdSchema.parse(row.repMembershipId),
          occurredAt: row.occurredAt,
          firstTouch: row.firstTouch,
          lastTouch: row.lastTouch,
          citedSources: citationsOf(row.citedSources),
          dealRecordId: dealRecordIdSchema.parse(row.dealRecordId),
        }
      })
    },

    listSourcePerformance: async (request) => {
      const after = request.after
      const rows = await tx
        .select()
        .from(sourcePerformance)
        .where(
          and(
            eq(sourcePerformance.organizationId, organizationId),
            request.flag === undefined ? undefined : eq(sourcePerformance.flag, request.flag),
            after === undefined
              ? undefined
              : sql`(${sourcePerformance.dealsTouched}, ${sourcePerformance.sourceKind}, ${sourcePerformance.sourceKey}) < (${after.dealsTouched}, ${after.kind}, ${after.key})`
          )
        )
        .orderBy(
          desc(sourcePerformance.dealsTouched),
          desc(sourcePerformance.sourceKind),
          desc(sourcePerformance.sourceKey)
        )
        .limit(request.limit)
      return rows.map((row) => ({
        kind: row.sourceKind,
        key: row.sourceKey,
        dealsTouched: row.dealsTouched,
        dealsWon: row.dealsWon,
        flag: row.flag,
      }))
    },
  }
}

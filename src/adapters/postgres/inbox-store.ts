import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from 'drizzle-orm'
import {
  type ApprovalRule,
  approvalRuleSchema,
  assessmentIdSchema,
  conversationIdSchema,
  type DraftId,
  dealRecordIdSchema,
  decisionIdSchema,
  documentIdSchema,
  draftIdSchema,
  findingIdSchema,
  formatId,
  MAX_FINDINGS,
  type MembershipId,
  membershipIdSchema,
  messageIdSchema,
  type OrganizationId,
  prospectIdSchema,
  teamIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  approvalDecisions,
  approvalPolicies,
  assessmentFindings,
  assessments,
  conversations,
  draftSources,
  drafts,
  escalationRules,
  messages,
  prospects,
} from 'tula-closeline-db/schema'
import type {
  ApprovalPolicyRecord,
  DraftAssessmentRecord,
  DraftCheck,
  DraftRecord,
  DraftSourceRecord,
  EscalationRuleRecord,
  InboxScope,
  MessageRecord,
} from '~/ports/inbox-store'
import { visibilityCondition } from './prospect-store'

type ConversationRow = typeof conversations.$inferSelect & { liveOwner: string | null }

const toConversation = (row: ConversationRow) => ({
  id: conversationIdSchema.parse(row.id),
  prospectId: prospectIdSchema.parse(row.prospectId),
  channel: row.channel,
  controller: row.controller,
  controllerMembershipId:
    row.controllerMembershipId === null
      ? null
      : membershipIdSchema.parse(row.controllerMembershipId),
  state: row.state,
  ownerMembershipId: row.liveOwner === null ? null : membershipIdSchema.parse(row.liveOwner),
  latestLabel: row.latestLabel,
  pendingDraftCount: row.pendingDraftCount,
  lastMessageAt: row.lastMessageAt,
  createdAt: row.createdAt,
})

const toMessage = (row: typeof messages.$inferSelect): MessageRecord => ({
  id: messageIdSchema.parse(row.id),
  conversationId: conversationIdSchema.parse(row.conversationId),
  channel: row.channel,
  direction: row.direction,
  authorKind: row.authorKind,
  authorMembershipId:
    row.authorMembershipId === null ? null : membershipIdSchema.parse(row.authorMembershipId),
  providerMessageId: row.providerMessageId,
  draftId: row.draftId === null ? null : draftIdSchema.parse(row.draftId),
  body: row.body,
  sentAt: row.sentAt,
  classification:
    row.classificationLabel === null ||
    row.classificationConfidence === null ||
    row.classificationDecidedBy === null ||
    row.classifiedAt === null
      ? null
      : {
          label: row.classificationLabel,
          confidence: row.classificationConfidence,
          decidedBy: row.classificationDecidedBy,
          correctedByMembershipId:
            row.classificationCorrectedByMembershipId === null
              ? null
              : membershipIdSchema.parse(row.classificationCorrectedByMembershipId),
          classifiedAt: row.classifiedAt,
        },
})

type DraftRow = typeof drafts.$inferSelect

const toChecks = (value: unknown): DraftCheck[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { passed?: unknown }).passed === 'boolean'
          ? [{ name: (item as DraftCheck).name, passed: (item as DraftCheck).passed }]
          : []
      )
    : []

const toDraft = (row: DraftRow, sources: DraftSourceRecord[]): DraftRecord => ({
  id: draftIdSchema.parse(row.id),
  conversationId: conversationIdSchema.parse(row.conversationId),
  author: row.author,
  authorMembershipId:
    row.authorMembershipId === null ? null : membershipIdSchema.parse(row.authorMembershipId),
  body: row.body,
  reason:
    row.reasonTriggerMessageId === null ||
    row.reasonLabel === null ||
    row.reasonStrategy === null ||
    (row.reasonLabel !== 'objection' && row.reasonLabel !== 'question')
      ? null
      : {
          triggerMessageId: messageIdSchema.parse(row.reasonTriggerMessageId),
          label: row.reasonLabel,
          strategy: row.reasonStrategy,
        },
  confidence: row.confidence,
  ungrounded: row.ungrounded,
  checks: toChecks(row.checks),
  hold: row.hold,
  status: row.status,
  createdAt: row.createdAt,
  decidedAt: row.decidedAt,
  sources,
})

const toSource = (row: typeof draftSources.$inferSelect): DraftSourceRecord => ({
  kind: row.kind,
  sourceRef: row.sourceRef,
  dealRecordId: row.dealRecordId === null ? null : dealRecordIdSchema.parse(row.dealRecordId),
  documentId: row.documentId === null ? null : documentIdSchema.parse(row.documentId),
  outcome: row.outcome,
  evidenceCount: row.evidenceCount,
})

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const

const toAssessment = (
  row: typeof assessments.$inferSelect,
  findings: (typeof assessmentFindings.$inferSelect)[]
): DraftAssessmentRecord => ({
  id: assessmentIdSchema.parse(row.id),
  draftId: draftIdSchema.parse(row.draftId),
  draftVersion: row.draftVersion ?? 1,
  verdict: row.verdict as DraftAssessmentRecord['verdict'],
  judgeSource: row.judgeSource as DraftAssessmentRecord['judgeSource'],
  createdAt: row.createdAt,
  findings: findings.map((f) => ({
    id: findingIdSchema.parse(f.id),
    category: f.category as DraftAssessmentRecord['findings'][number]['category'],
    severity: f.severity as DraftAssessmentRecord['findings'][number]['severity'],
    span: { start: f.spanStart, end: f.spanEnd },
    explanation: f.explanation,
  })),
})

const toRule = (row: typeof approvalPolicies.$inferSelect): ApprovalRule =>
  approvalRuleSchema.parse(
    row.mode === 'always'
      ? { mode: 'always' }
      : row.mode === 'below_confidence'
        ? { mode: 'below_confidence', threshold: row.threshold }
        : { mode: 'except', labels: row.labels }
  )

const toPolicy = (row: typeof approvalPolicies.$inferSelect): ApprovalPolicyRecord => ({
  channel: row.channel,
  rule: toRule(row),
  updatedAt: row.updatedAt,
  updatedByMembershipId:
    row.updatedByMembershipId === null ? null : membershipIdSchema.parse(row.updatedByMembershipId),
})

const toEscalationRule = (row: typeof escalationRules.$inferSelect): EscalationRuleRecord => ({
  id: row.id,
  trigger: row.trigger,
  target: row.target,
  teamId: row.teamId === null ? null : teamIdSchema.parse(row.teamId),
  threshold: row.threshold,
  enabled: row.enabled,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  updatedByMembershipId:
    row.updatedByMembershipId === null ? null : membershipIdSchema.parse(row.updatedByMembershipId),
})

/** The Postgres inbox methods of one Organization's transaction. */
export function createInboxStore(tx: Transaction, organizationId: OrganizationId): InboxScope {
  const readAssessment = async (draftId: string, draftVersion: number) => {
    const [row] = await tx
      .select()
      .from(assessments)
      .where(
        and(
          eq(assessments.organizationId, organizationId),
          eq(assessments.subjectKind, 'draft'),
          eq(assessments.draftId, draftId),
          eq(assessments.draftVersion, draftVersion)
        )
      )
      .limit(1)
    if (!row) {
      return null
    }
    const findings = await tx
      .select()
      .from(assessmentFindings)
      .where(
        and(
          eq(assessmentFindings.organizationId, organizationId),
          eq(assessmentFindings.assessmentId, row.id)
        )
      )
      .orderBy(asc(assessmentFindings.spanStart), asc(assessmentFindings.id))
      .limit(MAX_FINDINGS)
    return toAssessment(row, findings)
  }

  const mine = (id: string) =>
    and(eq(conversations.organizationId, organizationId), eq(conversations.id, id))

  /** The Sources of these Drafts in one read, in their order, keyed by Draft id. */
  const sourcesOf = async (draftIds: string[]): Promise<Map<string, DraftSourceRecord[]>> => {
    const bySource = new Map<string, DraftSourceRecord[]>()
    if (draftIds.length === 0) {
      return bySource
    }
    const rows = await tx
      .select()
      .from(draftSources)
      .where(
        and(
          eq(draftSources.organizationId, organizationId),
          inArray(draftSources.draftId, draftIds)
        )
      )
      .orderBy(asc(draftSources.draftId), asc(draftSources.position))
    for (const row of rows) {
      bySource.set(row.draftId, [...(bySource.get(row.draftId) ?? []), toSource(row)])
    }
    return bySource
  }

  return {
    findMessageByProviderId: async (channel, providerMessageId) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.channel, channel),
            eq(messages.providerMessageId, providerMessageId)
          )
        )
        .limit(1)
      return row ? toMessage(row) : null
    },

    findConversationOfProspect: async (prospectId, channel) => {
      const [row] = await tx
        .select({ ...getTableColumns(conversations), liveOwner: prospects.ownerMembershipId })
        .from(conversations)
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.prospectId, prospectId),
            eq(conversations.channel, channel)
          )
        )
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(1)
      return row ? toConversation(row) : null
    },

    findDraftRef: async (draftId) => {
      const [row] = await tx
        .select({
          id: drafts.id,
          conversationId: drafts.conversationId,
          author: drafts.author,
          authorMembershipId: drafts.authorMembershipId,
        })
        .from(drafts)
        .where(and(eq(drafts.organizationId, organizationId), eq(drafts.id, draftId)))
        .limit(1)
      return row
        ? {
            id: draftIdSchema.parse(row.id),
            conversationId: conversationIdSchema.parse(row.conversationId),
            author: row.author,
            authorMembershipId:
              row.authorMembershipId === null
                ? null
                : membershipIdSchema.parse(row.authorMembershipId),
          }
        : null
    },

    insertConversation: async (input) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          id: input.id,
          organizationId,
          prospectId: input.prospectId,
          channel: input.channel,
          ownerMembershipId: input.ownerMembershipId,
          lastMessageAt: input.lastMessageAt,
          createdAt: input.now,
        })
        .returning()
      if (!row) {
        throw new Error('The Conversation was not stored')
      }
      return toConversation({ ...row, liveOwner: row.ownerMembershipId })
    },

    insertMessage: async (input) => {
      const [row] = await tx
        .insert(messages)
        .values({
          id: input.id,
          organizationId,
          conversationId: input.conversationId,
          channel: input.channel,
          direction: input.direction,
          authorKind: input.authorKind,
          authorMembershipId: input.authorMembershipId,
          providerMessageId: input.providerMessageId,
          draftId: input.draftId,
          body: input.body,
          sentAt: input.sentAt,
        })
        .returning()
      if (!row) {
        throw new Error('The Message was not stored')
      }
      // Latest activity only moves forward; a newer inbound Message is not yet labelled.
      await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${input.sentAt.toISOString()}::timestamptz)`,
          ...(input.direction === 'inbound'
            ? {
                latestLabel: sql`case when ${input.sentAt.toISOString()}::timestamptz >= ${conversations.lastMessageAt} then null else ${conversations.latestLabel} end`,
              }
            : {}),
        })
        .where(mine(input.conversationId))
      return toMessage(row)
    },

    getConversation: async (id, visibility) => {
      const [row] = await tx
        .select({ ...getTableColumns(conversations), liveOwner: prospects.ownerMembershipId })
        .from(conversations)
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(and(mine(id), visibilityCondition(organizationId, visibility)))
        .limit(1)
      return row ? toConversation(row) : null
    },

    listConversations: async (request) => {
      const rows = await tx
        .select({ ...getTableColumns(conversations), liveOwner: prospects.ownerMembershipId })
        .from(conversations)
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            visibilityCondition(organizationId, request.visibility),
            request.channel === undefined ? undefined : eq(conversations.channel, request.channel),
            request.state === undefined ? undefined : eq(conversations.state, request.state),
            request.controller === undefined
              ? undefined
              : eq(conversations.controller, request.controller),
            request.label === undefined ? undefined : eq(conversations.latestLabel, request.label),
            request.prospectId === undefined
              ? undefined
              : eq(conversations.prospectId, request.prospectId),
            request.after === undefined
              ? undefined
              : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${request.after.lastMessageAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(request.limit)
      return rows.map(toConversation)
    },

    getMessage: async (id) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.organizationId, organizationId), eq(messages.id, id)))
        .limit(1)
      return row ? toMessage(row) : null
    },

    saveClassification: async (input) => {
      const [row] = await tx
        .update(messages)
        .set({
          classificationLabel: input.classification.label,
          classificationConfidence: input.classification.confidence,
          classificationDecidedBy: input.classification.decidedBy,
          classificationCorrectedByMembershipId: input.classification.correctedByMembershipId,
          classifiedAt: input.classification.classifiedAt,
        })
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.id, input.messageId),
            eq(messages.direction, 'inbound'),
            input.onlyIfUnclassified ? isNull(messages.classificationLabel) : undefined
          )
        )
        .returning()
      return row ? toMessage(row) : null
    },

    refreshLatestLabel: async (conversationId) => {
      const [newest] = await tx
        .select({ label: messages.classificationLabel })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.conversationId, conversationId),
            eq(messages.direction, 'inbound')
          )
        )
        .orderBy(desc(messages.sentAt), desc(messages.id))
        .limit(1)
      await tx
        .update(conversations)
        .set({ latestLabel: newest?.label ?? null })
        .where(mine(conversationId))
    },

    findDraftForMessage: async (messageId) => {
      const [row] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.reasonTriggerMessageId, messageId)
          )
        )
        .limit(1)
      return row ? { id: draftIdSchema.parse(row.id) } : null
    },

    insertAgentDraft: async (input) => {
      await tx.insert(drafts).values({
        id: input.id,
        organizationId,
        conversationId: input.conversationId,
        author: 'agent',
        body: input.body,
        reasonTriggerMessageId: input.triggerMessageId,
        reasonLabel: input.label,
        reasonStrategy: input.strategy,
        confidence: input.confidence,
        ungrounded: input.ungrounded,
        checks: input.checks ?? [],
        hold: input.hold,
        status: input.hold === null ? 'approved' : 'pending',
        createdAt: input.now,
        decidedAt: input.hold === null ? input.now : null,
      })
      if (input.sources.length > 0) {
        await tx.insert(draftSources).values(
          input.sources.map((source) => ({
            organizationId,
            draftId: input.id,
            kind: source.kind,
            sourceRef: source.sourceRef,
            position: source.position,
            dealRecordId: source.dealRecordId,
            outcome: source.outcome,
            evidenceCount: source.evidenceCount,
          }))
        )
      }
      if (input.hold !== null) {
        await tx
          .update(conversations)
          .set({
            pendingDraftCount: sql`${conversations.pendingDraftCount} + 1`,
            // An escalated Conversation stays escalated: the Draft is held for it, not the state.
            state: sql`case when ${conversations.state} = 'escalated' then 'escalated' else 'awaiting_approval' end`,
          })
          .where(mine(input.conversationId))
      }
    },

    saveDraftAssessment: async (input) => {
      const rank = Math.max(0, ...input.findings.map((f) => SEVERITY_RANK[f.severity]))
      const id = formatId('asm', crypto.randomUUID())
      const created = await tx
        .insert(assessments)
        .values({
          id,
          organizationId,
          subjectKind: 'draft',
          draftId: input.draftId,
          draftVersion: input.draftVersion,
          prospectId: input.prospectId,
          agentKind: 'inbound',
          verdict: input.verdict,
          judgeSource: 'model',
          worstSeverityRank: rank === 0 ? null : rank,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: assessments.id })
      if (created.length > 0 && input.findings.length > 0) {
        await tx.insert(assessmentFindings).values(
          input.findings.map((finding) => ({
            id: formatId('fnd', crypto.randomUUID()),
            organizationId,
            assessmentId: id,
            category: finding.category,
            severity: finding.severity,
            spanStart: finding.span.start,
            spanEnd: finding.span.end,
            explanation: finding.explanation,
            createdAt: input.now,
          }))
        )
      }
      const stored = await readAssessment(input.draftId, input.draftVersion)
      if (!stored) {
        throw new Error('The assessment was neither saved nor found')
      }
      return stored
    },

    getDraftAssessment: (draftId, draftVersion) => readAssessment(draftId, draftVersion),

    getLatestDraftAssessments: async (draftIds) => {
      const latest = new Map<DraftId, DraftAssessmentRecord>()
      if (draftIds.length === 0) {
        return latest
      }
      // `assessments_draft_key` (organization, draft, version) serves this: one row per Draft, its
      // highest version.
      const rows = await tx
        .selectDistinctOn([assessments.draftId])
        .from(assessments)
        .where(
          and(
            eq(assessments.organizationId, organizationId),
            eq(assessments.subjectKind, 'draft'),
            inArray(assessments.draftId, [...draftIds])
          )
        )
        .orderBy(asc(assessments.draftId), desc(assessments.draftVersion))
        .limit(draftIds.length)
      const chosen = new Map<string, typeof assessments.$inferSelect>()
      for (const row of rows) {
        if (row.draftId !== null) {
          chosen.set(row.draftId, row)
        }
      }
      const findings =
        chosen.size === 0
          ? []
          : await tx
              .select()
              .from(assessmentFindings)
              .where(
                and(
                  eq(assessmentFindings.organizationId, organizationId),
                  inArray(
                    assessmentFindings.assessmentId,
                    [...chosen.values()].map((row) => row.id)
                  )
                )
              )
              .orderBy(
                asc(assessmentFindings.assessmentId),
                asc(assessmentFindings.spanStart),
                asc(assessmentFindings.id)
              )
              .limit(chosen.size * MAX_FINDINGS)
      for (const row of chosen.values()) {
        latest.set(
          draftIdSchema.parse(row.draftId),
          toAssessment(
            row,
            findings.filter((finding) => finding.assessmentId === row.id)
          )
        )
      }
      return latest
    },

    replacePendingDraftBody: async (draftId, body) => {
      const [row] = await tx
        .update(drafts)
        .set({ body })
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.id, draftId),
            eq(drafts.status, 'pending')
          )
        )
        .returning()
      return row ? toDraft(row, (await sourcesOf([row.id])).get(row.id) ?? []) : null
    },

    escalateConversation: async (conversationId, assigneeMembershipId) => {
      const moved = await tx
        .update(conversations)
        .set({ state: 'escalated', ownerMembershipId: assigneeMembershipId })
        .where(
          and(mine(conversationId), inArray(conversations.state, ['agent', 'awaiting_approval']))
        )
        .returning({ id: conversations.id })
      return moved.length > 0
    },

    countEscalatedByAssignee: async (membershipIds) => {
      const counts = new Map<MembershipId, number>(membershipIds.map((id) => [id, 0]))
      if (membershipIds.length === 0) {
        return counts
      }
      const rows = await tx
        .select({ owner: conversations.ownerMembershipId, count: sql<number>`count(*)::int` })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.state, 'escalated'),
            inArray(conversations.ownerMembershipId, [...membershipIds])
          )
        )
        .groupBy(conversations.ownerMembershipId)
      for (const row of rows) {
        if (row.owner !== null) {
          counts.set(membershipIdSchema.parse(row.owner), row.count)
        }
      }
      return counts
    },

    getEscalationRule: async (trigger) => {
      const [row] = await tx
        .select()
        .from(escalationRules)
        .where(
          and(
            eq(escalationRules.organizationId, organizationId),
            eq(escalationRules.trigger, trigger)
          )
        )
        .limit(1)
      return row ? toEscalationRule(row) : null
    },

    listEscalationRules: async (request) => {
      const rows = await tx
        .select()
        .from(escalationRules)
        .where(
          and(
            eq(escalationRules.organizationId, organizationId),
            request.after === undefined ? undefined : gt(escalationRules.trigger, request.after)
          )
        )
        .orderBy(asc(escalationRules.trigger))
        .limit(request.limit)
      return rows.map(toEscalationRule)
    },

    upsertEscalationRule: async (input) => {
      const values = {
        target: input.target,
        teamId: input.teamId,
        threshold: input.threshold,
        enabled: input.enabled,
        updatedAt: input.now,
        updatedByMembershipId: input.membershipId,
      }
      const [row] = await tx
        .insert(escalationRules)
        .values({
          id: formatId('esr', crypto.randomUUID()),
          organizationId,
          trigger: input.trigger,
          createdAt: input.now,
          ...values,
        })
        .onConflictDoUpdate({
          target: [escalationRules.organizationId, escalationRules.trigger],
          set: values,
        })
        .returning()
      if (!row) {
        throw new Error('The escalation rule was not stored')
      }
      return toEscalationRule(row)
    },

    deleteEscalationRule: async (trigger) => {
      const gone = await tx
        .delete(escalationRules)
        .where(
          and(
            eq(escalationRules.organizationId, organizationId),
            eq(escalationRules.trigger, trigger)
          )
        )
        .returning({ id: escalationRules.id })
      return gone.length > 0
    },

    stopConversation: async (conversationId, now) => {
      await tx
        .update(drafts)
        .set({ status: 'void', decidedAt: now })
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.conversationId, conversationId),
            eq(drafts.status, 'pending')
          )
        )
      await tx
        .update(conversations)
        .set({ pendingDraftCount: 0, state: 'closed' })
        .where(mine(conversationId))
    },

    takeOverConversation: async ({ conversationId, membershipId, now }) => {
      const voided = await tx
        .update(drafts)
        .set({ status: 'void', decidedAt: now })
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.conversationId, conversationId),
            eq(drafts.status, 'pending')
          )
        )
        .returning({ id: drafts.id })
      await tx
        .update(conversations)
        .set({
          controller: 'rep',
          controllerMembershipId: membershipId,
          state: 'rep',
          pendingDraftCount: 0,
        })
        .where(mine(conversationId))
      return { voidedDraftCount: voided.length }
    },

    handBackConversation: async (conversationId) => {
      await tx
        .update(conversations)
        .set({
          controller: 'agent',
          controllerMembershipId: null,
          state: sql`case when ${conversations.state} = 'closed' then 'closed' else 'agent' end`,
        })
        .where(mine(conversationId))
    },

    getDraft: async (draftId) => {
      const [row] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.organizationId, organizationId), eq(drafts.id, draftId)))
        .limit(1)
      if (!row) {
        return null
      }
      return toDraft(row, (await sourcesOf([row.id])).get(row.id) ?? [])
    },

    listPendingDrafts: async (request) => {
      const rows = await tx
        .select({
          draft: drafts,
          conversation: getTableColumns(conversations),
          liveOwner: prospects.ownerMembershipId,
        })
        .from(drafts)
        .innerJoin(
          conversations,
          and(
            eq(conversations.organizationId, drafts.organizationId),
            eq(conversations.id, drafts.conversationId)
          )
        )
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.status, 'pending'),
            visibilityCondition(organizationId, request.visibility),
            request.channel === undefined ? undefined : eq(conversations.channel, request.channel),
            request.conversationId === undefined
              ? undefined
              : eq(drafts.conversationId, request.conversationId),
            request.after === undefined
              ? undefined
              : sql`(${drafts.createdAt}, ${drafts.id}) > (${request.after.createdAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(asc(drafts.createdAt), asc(drafts.id))
        .limit(request.limit)
      const sources = await sourcesOf(rows.map((row) => row.draft.id))
      return rows.map((row) => ({
        draft: toDraft(row.draft, sources.get(row.draft.id) ?? []),
        conversation: toConversation({ ...row.conversation, liveOwner: row.liveOwner }),
      }))
    },

    decidePendingDraft: async (input) => {
      const [row] = await tx
        .update(drafts)
        .set({
          status: input.status,
          decidedAt: input.now,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.released ? { checks: input.released, hold: null } : {}),
        })
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.id, input.draftId),
            eq(drafts.status, 'pending')
          )
        )
        .returning()
      if (!row) {
        return null
      }
      await tx
        .update(conversations)
        .set({
          pendingDraftCount: sql`greatest(${conversations.pendingDraftCount} - 1, 0)`,
          state: sql`case when greatest(${conversations.pendingDraftCount} - 1, 0) = 0 and ${conversations.state} = 'awaiting_approval' and ${conversations.controller} = 'agent' then 'agent' else ${conversations.state} end`,
        })
        .where(mine(row.conversationId))
      return toDraft(row, (await sourcesOf([row.id])).get(row.id) ?? [])
    },

    insertRepDraft: async (input) => {
      const [row] = await tx
        .insert(drafts)
        .values({
          id: input.id,
          organizationId,
          conversationId: input.conversationId,
          author: 'rep',
          authorMembershipId: input.membershipId,
          body: input.body,
          status: 'approved',
          createdAt: input.now,
          decidedAt: input.now,
        })
        .returning()
      if (!row) {
        throw new Error('The Draft was not stored')
      }
      return toDraft(row, [])
    },

    hasReleasedReply: async (conversationId) => {
      const [outbound] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.conversationId, conversationId),
            eq(messages.direction, 'outbound')
          )
        )
        .limit(1)
      if (outbound) {
        return true
      }
      const [released] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.organizationId, organizationId),
            eq(drafts.conversationId, conversationId),
            inArray(drafts.status, ['approved', 'sent'])
          )
        )
        .limit(1)
      return released !== undefined
    },

    insertDecision: async (input) => {
      await tx.insert(approvalDecisions).values({
        id: input.id,
        organizationId,
        conversationId: input.conversationId,
        draftId: input.draftId,
        kind: input.kind,
        decidedByMembershipId: input.decidedByMembershipId,
        note: input.note,
        editedBodySha256: input.editedBodySha256,
        acknowledgedUngrounded: input.acknowledgedUngrounded,
        decidedAt: input.decidedAt,
      })
    },

    listDecisions: async (request) => {
      const rows = await tx
        .select({ decision: approvalDecisions })
        .from(approvalDecisions)
        .innerJoin(
          conversations,
          and(
            eq(conversations.organizationId, approvalDecisions.organizationId),
            eq(conversations.id, approvalDecisions.conversationId)
          )
        )
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(
          and(
            eq(approvalDecisions.organizationId, organizationId),
            visibilityCondition(organizationId, request.visibility),
            request.conversationId === undefined
              ? undefined
              : eq(approvalDecisions.conversationId, request.conversationId),
            request.draftId === undefined
              ? undefined
              : eq(approvalDecisions.draftId, request.draftId),
            request.kind === undefined ? undefined : eq(approvalDecisions.kind, request.kind),
            request.from === undefined ? undefined : gte(approvalDecisions.decidedAt, request.from),
            request.to === undefined ? undefined : lte(approvalDecisions.decidedAt, request.to),
            request.after === undefined
              ? undefined
              : sql`(${approvalDecisions.decidedAt}, ${approvalDecisions.id}) < (${request.after.decidedAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(desc(approvalDecisions.decidedAt), desc(approvalDecisions.id))
        .limit(request.limit)
      return rows.map(({ decision }) => ({
        id: decisionIdSchema.parse(decision.id),
        conversationId: conversationIdSchema.parse(decision.conversationId),
        draftId: decision.draftId === null ? null : draftIdSchema.parse(decision.draftId),
        kind: decision.kind,
        decidedByMembershipId:
          decision.decidedByMembershipId === null
            ? null
            : membershipIdSchema.parse(decision.decidedByMembershipId),
        note: decision.note,
        acknowledgedUngrounded: decision.acknowledgedUngrounded,
        decidedAt: decision.decidedAt,
      }))
    },

    getApprovalPolicy: async (channel) => {
      const [row] = await tx
        .select()
        .from(approvalPolicies)
        .where(
          and(
            eq(approvalPolicies.organizationId, organizationId),
            eq(approvalPolicies.channel, channel)
          )
        )
        .limit(1)
      return row ? toPolicy(row) : null
    },

    listApprovalPolicies: async () => {
      const rows = await tx
        .select()
        .from(approvalPolicies)
        .where(eq(approvalPolicies.organizationId, organizationId))
        .orderBy(asc(approvalPolicies.channel))
      return rows.map(toPolicy)
    },

    upsertApprovalPolicy: async (input) => {
      const values = {
        mode: input.rule.mode,
        threshold: input.rule.mode === 'below_confidence' ? input.rule.threshold : null,
        labels: input.rule.mode === 'except' ? input.rule.labels : null,
        updatedAt: input.now,
        updatedByMembershipId: input.membershipId,
      }
      const [row] = await tx
        .insert(approvalPolicies)
        .values({ organizationId, channel: input.channel, ...values })
        .onConflictDoUpdate({
          target: [approvalPolicies.organizationId, approvalPolicies.channel],
          set: values,
        })
        .returning()
      if (!row) {
        throw new Error('The approval policy was not stored')
      }
      return toPolicy(row)
    },

    listMessages: async (request) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.conversationId, request.conversationId),
            request.after === undefined
              ? undefined
              : sql`(${messages.sentAt}, ${messages.id}) > (${request.after.sentAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(request.limit)
      return rows.map(toMessage)
    },
  }
}

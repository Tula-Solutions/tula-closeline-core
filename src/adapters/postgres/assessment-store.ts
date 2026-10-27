import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  agentKindSchema,
  assessmentIdSchema,
  callIdSchema,
  findingIdSchema,
  formatId,
  membershipIdSchema,
  type OrganizationId,
  prospectIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { assessmentFindings, assessments, prospects } from 'tula-closeline-db/schema'
import type {
  AssessmentRatePageRequest,
  AssessmentRateRow,
  AssessmentScope,
  FindingFeedback,
  TurnAssessmentRecord,
  TurnFindingRecord,
} from '~/ports/assessment-store'
import { visibilityCondition } from './prospect-store'

/**
 * One row per week, Agent kind, version and finding category that has a counted failing finding:
 * `failed` counts Assessments once however many findings share the category, `total` is every
 * Assessment of the cell so the row shows its share of the week.
 */
async function groupedRates(
  tx: Transaction,
  organizationId: OrganizationId,
  request: AssessmentRatePageRequest
): Promise<AssessmentRateRow[]> {
  const all = alias(assessments, 'all_turns')
  const inRange = (t: typeof assessments | typeof all) =>
    and(
      eq(t.organizationId, organizationId),
      eq(t.subjectKind, 'call_turn'),
      gte(t.createdAt, dayStart(request.from)),
      lt(t.createdAt, nextDayStart(request.to)),
      request.agentKind ? eq(t.agentKind, request.agentKind) : undefined
    )
  const weekOf = (t: typeof assessments | typeof all) =>
    sql`date_trunc('week', ${t.createdAt} at time zone 'utc')::date`
  const week = weekOf(assessments)
  const version = sql`coalesce(${assessments.instructionVersion}, 0)`
  const after = request.after
  const rows = await tx
    .select({
      weekStart: sql<string>`${week}::text`,
      agentKind: assessments.agentKind,
      instructionVersion: assessments.instructionVersion,
      category: assessmentFindings.category,
      failed: sql<number>`count(distinct ${assessments.id})::int`,
      total: sql<number>`(select count(*)::int from ${assessments} ${sql.raw('"all_turns"')}
        where ${inRange(all)}
          and ${weekOf(all)} = date_trunc('week', min(${assessments.createdAt}) at time zone 'utc')::date
          and ${all.agentKind} = ${assessments.agentKind}
          and ${all.instructionVersion} is not distinct from ${assessments.instructionVersion})`,
    })
    .from(assessments)
    .innerJoin(
      assessmentFindings,
      and(
        eq(assessmentFindings.organizationId, assessments.organizationId),
        eq(assessmentFindings.assessmentId, assessments.id)
      )
    )
    .where(
      and(
        inRange(assessments),
        eq(assessments.verdict, 'fail'),
        sql`${assessmentFindings.feedback} is distinct from 'false_alarm'`
      )
    )
    .groupBy(
      week,
      assessments.agentKind,
      assessments.instructionVersion,
      assessmentFindings.category
    )
    .having(
      after
        ? sql`(${week}, ${assessments.agentKind}, ${version}, ${assessmentFindings.category}) > (${after.weekStart}::date, ${after.agentKind}, ${after.instructionVersion ?? 0}, ${after.category ?? ''})`
        : undefined
    )
    .orderBy(week, assessments.agentKind, version, assessmentFindings.category)
    .limit(request.limit)
  return rows.map(
    (row): AssessmentRateRow => ({
      weekStart: row.weekStart,
      agentKind: agentKindSchema.parse(row.agentKind),
      instructionVersion: row.instructionVersion,
      category: row.category as TurnFindingRecord['category'],
      total: row.total,
      failed: row.failed,
    })
  )
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const

/** The most findings one Assessment holds (the contract's bound). */
const MAX_FINDINGS_PER_ASSESSMENT = 50

type FindingRow = typeof assessmentFindings.$inferSelect

const toFinding = (row: FindingRow): TurnFindingRecord => ({
  id: findingIdSchema.parse(row.id),
  category: row.category as TurnFindingRecord['category'],
  severity: row.severity as TurnFindingRecord['severity'],
  span: { start: row.spanStart, end: row.spanEnd },
  explanation: row.explanation,
  feedback: row.feedback as FindingFeedback | null,
  feedbackByMembershipId: row.feedbackByMembershipId
    ? membershipIdSchema.parse(row.feedbackByMembershipId)
    : null,
  feedbackAt: row.feedbackAt,
})

const toAssessment = (
  row: typeof assessments.$inferSelect,
  findings: FindingRow[]
): TurnAssessmentRecord => ({
  id: assessmentIdSchema.parse(row.id),
  callId: callIdSchema.parse(row.callId),
  turnIndex: row.turnIndex ?? 0,
  prospectId: row.prospectId ? prospectIdSchema.parse(row.prospectId) : null,
  agentKind: agentKindSchema.parse(row.agentKind),
  instructionVersion: row.instructionVersion,
  verdict: row.verdict as TurnAssessmentRecord['verdict'],
  findings: findings.map(toFinding),
  createdAt: row.createdAt,
})

const dayStart = (day: string) => new Date(`${day}T00:00:00.000Z`)
const nextDayStart = (day: string) => new Date(dayStart(day).getTime() + 86_400_000)

/** Builds the Assessment methods of one Organization's transaction; every statement names the Organization as well as relying on row-level security. */
export function createAssessmentStore(
  tx: Transaction,
  organizationId: OrganizationId
): AssessmentScope {
  const rankExpr = sql`coalesce(${assessments.worstSeverityRank}, 0)`

  const withFindings = async (
    rows: (typeof assessments.$inferSelect)[]
  ): Promise<TurnAssessmentRecord[]> => {
    if (rows.length === 0) {
      return []
    }
    const found = await tx
      .select()
      .from(assessmentFindings)
      .where(
        and(
          eq(assessmentFindings.organizationId, organizationId),
          inArray(
            assessmentFindings.assessmentId,
            rows.map((row) => row.id)
          )
        )
      )
      .orderBy(asc(assessmentFindings.spanStart), asc(assessmentFindings.id))
      .limit(rows.length * MAX_FINDINGS_PER_ASSESSMENT)
    const byAssessment = new Map<string, FindingRow[]>()
    for (const finding of found) {
      byAssessment.set(finding.assessmentId, [
        ...(byAssessment.get(finding.assessmentId) ?? []),
        finding,
      ])
    }
    return rows.map((row) => toAssessment(row, byAssessment.get(row.id) ?? []))
  }

  const readTurn = async (callId: string, turnIndex: number) => {
    const [row] = await tx
      .select()
      .from(assessments)
      .where(
        and(
          eq(assessments.organizationId, organizationId),
          eq(assessments.subjectKind, 'call_turn'),
          eq(assessments.callId, callId),
          eq(assessments.turnIndex, turnIndex)
        )
      )
      .limit(1)
    return row ? ((await withFindings([row]))[0] ?? null) : null
  }

  return {
    saveTurnAssessment: async (input) => {
      const rank = Math.max(0, ...input.findings.map((f) => SEVERITY_RANK[f.severity]))
      const id = formatId('asm', crypto.randomUUID())
      const created = await tx
        .insert(assessments)
        .values({
          id,
          organizationId,
          subjectKind: 'call_turn',
          callId: input.callId,
          turnIndex: input.turnIndex,
          prospectId: input.prospectId,
          agentKind: input.agentKind,
          instructionVersion: input.instructionVersion,
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
      const record = await readTurn(input.callId, input.turnIndex)
      if (!record) {
        throw new Error('The assessment was neither saved nor found')
      }
      return { record, created: created.length > 0 }
    },

    hasTurnAssessment: async (callId, turnIndex) => (await readTurn(callId, turnIndex)) !== null,

    listTurnAssessments: async (request) => {
      const worst = request.sort === 'worst_first'
      const after = request.after
      const rows = await tx
        .select({ row: assessments })
        .from(assessments)
        .leftJoin(
          prospects,
          and(
            eq(prospects.organizationId, assessments.organizationId),
            eq(prospects.id, assessments.prospectId)
          )
        )
        .where(
          and(
            eq(assessments.organizationId, organizationId),
            eq(assessments.subjectKind, 'call_turn'),
            visibilityCondition(organizationId, request.visibility, prospects.ownerMembershipId),
            request.verdict
              ? eq(assessments.verdict, request.verdict)
              : worst
                ? sql`${assessments.verdict} <> 'pass'`
                : undefined,
            request.agentKind ? eq(assessments.agentKind, request.agentKind) : undefined,
            request.category
              ? sql`exists (select 1 from ${assessmentFindings}
                  where ${assessmentFindings.organizationId} = ${organizationId}
                    and ${assessmentFindings.assessmentId} = ${assessments.id}
                    and ${assessmentFindings.category} = ${request.category})`
              : undefined,
            request.from ? gte(assessments.createdAt, dayStart(request.from)) : undefined,
            request.to ? lt(assessments.createdAt, nextDayStart(request.to)) : undefined,
            after
              ? worst
                ? sql`(${rankExpr}, ${assessments.createdAt}, ${assessments.id}) < (${after.rank}, ${after.createdAt.toISOString()}::timestamptz, ${after.id})`
                : sql`(${assessments.createdAt}, ${assessments.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id})`
              : undefined
          )
        )
        .orderBy(
          ...(worst ? [sql`${assessments.worstSeverityRank} desc nulls last`] : []),
          sql`${assessments.createdAt} desc`,
          sql`${assessments.id} desc`
        )
        .limit(request.limit)
      return withFindings(rows.map((r) => r.row))
    },

    getTurnAssessment: async (id, visibility) => {
      const [found] = await tx
        .select({ row: assessments })
        .from(assessments)
        .leftJoin(
          prospects,
          and(
            eq(prospects.organizationId, assessments.organizationId),
            eq(prospects.id, assessments.prospectId)
          )
        )
        .where(
          and(
            eq(assessments.organizationId, organizationId),
            eq(assessments.subjectKind, 'call_turn'),
            eq(assessments.id, id),
            visibilityCondition(organizationId, visibility, prospects.ownerMembershipId)
          )
        )
        .limit(1)
      return found ? ((await withFindings([found.row]))[0] ?? null) : null
    },

    setFindingFeedback: async (input) => {
      const where = and(
        eq(assessmentFindings.organizationId, organizationId),
        eq(assessmentFindings.assessmentId, input.assessmentId),
        eq(assessmentFindings.id, input.findingId)
      )
      await tx
        .update(assessmentFindings)
        .set({
          feedback: input.feedback,
          feedbackByMembershipId: input.membershipId,
          feedbackAt: input.now,
        })
        .where(and(where, sql`${assessmentFindings.feedback} is distinct from ${input.feedback}`))
      const [row] = await tx.select().from(assessmentFindings).where(where).limit(1)
      return row ? toFinding(row) : null
    },

    listAssessmentRates: async (request) => {
      if (request.groupBy === 'category') {
        return groupedRates(tx, organizationId, request)
      }
      const week = sql`date_trunc('week', ${assessments.createdAt} at time zone 'utc')::date`
      const version = sql`coalesce(${assessments.instructionVersion}, 0)`
      const after = request.after
      const rows = await tx
        .select({
          weekStart: sql<string>`${week}::text`,
          agentKind: assessments.agentKind,
          instructionVersion: assessments.instructionVersion,
          total: sql<number>`count(*)::int`,
          failed: sql<number>`(count(*) filter (where ${assessments.verdict} = 'fail'
            and exists (select 1 from ${assessmentFindings}
              where ${assessmentFindings.organizationId} = ${organizationId}
                and ${assessmentFindings.assessmentId} = ${sql.raw('"assessments"."id"')}
                and ${assessmentFindings.feedback} is distinct from 'false_alarm')))::int`,
        })
        .from(assessments)
        .where(
          and(
            eq(assessments.organizationId, organizationId),
            eq(assessments.subjectKind, 'call_turn'),
            gte(assessments.createdAt, dayStart(request.from)),
            lt(assessments.createdAt, nextDayStart(request.to)),
            request.agentKind ? eq(assessments.agentKind, request.agentKind) : undefined
          )
        )
        .groupBy(week, assessments.agentKind, assessments.instructionVersion)
        .having(
          after
            ? sql`(${week}, ${assessments.agentKind}, ${version}) > (${after.weekStart}::date, ${after.agentKind}, ${after.instructionVersion ?? 0})`
            : undefined
        )
        .orderBy(week, assessments.agentKind, version)
        .limit(request.limit)
      return rows.map(
        (row): AssessmentRateRow => ({
          weekStart: row.weekStart,
          agentKind: agentKindSchema.parse(row.agentKind),
          instructionVersion: row.instructionVersion,
          category: null,
          total: row.total,
          failed: row.failed,
        })
      )
    },
  }
}

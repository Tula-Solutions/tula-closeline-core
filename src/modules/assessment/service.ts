import {
  ASSESSMENT_ERRORS,
  type Assessment,
  type AssessmentId,
  type AssessmentRateItem,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type Finding,
  type FindingId,
  findingSchema,
  type GetAssessmentRatesQuery,
  type GetAssessmentRatesResponse,
  type ListAssessmentsQuery,
  MIN_RATE_SAMPLE,
  type Page,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { visibilityOf } from '~/modules/prospect/service'
import type {
  FindingFeedback,
  TurnAssessmentRecord,
  TurnFindingRecord,
} from '~/ports/assessment-store'
import { assessmentCursorSchema, rateCursorSchema } from './schema'

/** What reading and marking Assessments needs from the container. */
export type AssessmentDeps = Pick<Container, 'store' | 'clock' | 'logger'>

const RANK = { low: 1, medium: 2, high: 3 } as const

const toFinding = (finding: TurnFindingRecord): Finding => ({
  id: finding.id,
  category: finding.category,
  severity: finding.severity,
  span: finding.span,
  explanation: finding.explanation,
  feedback: finding.feedback,
})

const toAssessment = (record: TurnAssessmentRecord): Assessment => ({
  id: record.id,
  subject: { kind: 'call_turn', callId: record.callId, turnIndex: record.turnIndex },
  prospectId: record.prospectId,
  agentKind: record.agentKind,
  instructionVersion: record.instructionVersion,
  verdict: record.verdict,
  findings: record.findings.map(toFinding),
  judgeSource: 'model',
  createdAt: record.createdAt.toISOString(),
})

const rankOf = (record: TurnAssessmentRecord): number =>
  record.findings.reduce((worst, finding) => Math.max(worst, RANK[finding.severity]), 0)

/**
 * One page of Assessed Call turns, newest first or worst first. Owner and Admin only. A cursor made for the other sort is
 * `request.invalid`.
 */
export async function list(
  deps: AssessmentDeps,
  caller: Caller,
  query: ListAssessmentsQuery
): Promise<Page<Assessment>> {
  const decoded =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, assessmentCursorSchema)
  if (query.cursor !== undefined && (decoded === undefined || decoded.sort !== query.sort)) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'assessment.list')
    const { visibility } = await visibilityOf(scope, caller)
    const rows = await scope.listTurnAssessments({
      visibility,
      ...(query.verdict === undefined ? {} : { verdict: query.verdict }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.agentKind === undefined ? {} : { agentKind: query.agentKind }),
      ...(query.from === undefined || query.to === undefined
        ? {}
        : { from: query.from, to: query.to }),
      sort: query.sort,
      ...(decoded === undefined
        ? {}
        : {
            after: {
              rank: decoded.rank,
              createdAt: new Date(decoded.createdAt),
              id: decoded.id,
            },
          }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toAssessment),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({
              sort: query.sort,
              rank: rankOf(last),
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    }
  })
}

/** One Assessed turn, for any role within their view; anything else is `assessment.not_found`. */
export async function get(
  deps: AssessmentDeps,
  caller: Caller,
  assessmentId: AssessmentId
): Promise<Assessment> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'assessment.read')
    const { visibility } = await visibilityOf(scope, caller)
    const record = await scope.getTurnAssessment(assessmentId, visibility)
    if (!record) {
      throw domainError(ASSESSMENT_ERRORS['assessment.not_found'])
    }
    return toAssessment(record)
  })
}

/**
 * Marks a finding `correct` or `false_alarm`, keeping who and when. Owner and Admin only. The same
 * mark again changes nothing; another mark replaces it. An unknown finding, or one of another
 * Organization, is `assessment.not_found`. Idempotent by the optional Idempotency-Key.
 */
export async function giveFeedback(
  deps: AssessmentDeps,
  caller: Caller,
  target: { assessmentId: AssessmentId; findingId: FindingId },
  request: { feedback: FindingFeedback },
  options: { idempotencyKey?: string | undefined }
): Promise<IdempotentAnswer<200, Finding>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'assessments.feedback',
        request: { params: target, body: request },
        status: 200,
        response: findingSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(
          scope,
          caller,
          'assessment.feedback'
        )
        const marked = await scope.setFindingFeedback({
          ...target,
          feedback: request.feedback,
          membershipId,
          now,
        })
        if (!marked) {
          throw domainError(ASSESSMENT_ERRORS['assessment.not_found'])
        }
        return toFinding(marked)
      }
    )
  )
}

/** The ISO week label (`YYYY-Www`) of the Monday `weekStart` (`YYYY-MM-DD`). */
export function isoWeekOf(weekStart: string): string {
  const monday = new Date(`${weekStart}T00:00:00Z`)
  const thursday = new Date(monday.getTime() + 3 * 86_400_000)
  const year = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(year, 0, 4))
  const dayOfWeek = firstThursday.getUTCDay() || 7
  const week1Monday = firstThursday.getTime() - (dayOfWeek - 1) * 86_400_000
  const week = Math.floor((monday.getTime() - week1Monday) / (7 * 86_400_000)) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

const toRate = (row: {
  weekStart: string
  agentKind: 'inbound' | 'outbound'
  instructionVersion: number | null
  category: AssessmentRateItem['category']
  total: number
  failed: number
}): AssessmentRateItem => {
  const base = {
    week: isoWeekOf(row.weekStart),
    weekStart: row.weekStart,
    agentKind: row.agentKind,
    instructionVersion: row.instructionVersion,
    category: row.category,
    kind: 'rate' as const,
    recordCount: row.total,
  }
  if (row.total < MIN_RATE_SAMPLE) {
    return { ...base, state: 'not_enough_data', value: null } as AssessmentRateItem
  }
  return {
    ...base,
    state: 'ok',
    value: Math.min(1, row.failed / row.total),
  } as AssessmentRateItem
}

/**
 * The weekly failed rate by Agent kind and instruction version (and, with `groupBy=category`, by finding category) over a
 * range, oldest week first.
 * A fail whose findings Admins all marked false alarms does not count. Owner and Admin only.
 */
export async function rates(
  deps: AssessmentDeps,
  caller: Caller,
  query: GetAssessmentRatesQuery
): Promise<GetAssessmentRatesResponse> {
  const decoded =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, rateCursorSchema)
  if (query.cursor !== undefined && decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'assessment.rates')
    const rows = await scope.listAssessmentRates({
      from: query.from,
      to: query.to,
      ...(query.agentKind === undefined ? {} : { agentKind: query.agentKind }),
      ...(query.groupBy === undefined ? {} : { groupBy: query.groupBy }),
      ...(decoded === undefined ? {} : { after: decoded }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      from: query.from,
      to: query.to,
      items: page.map(toRate),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({
              weekStart: last.weekStart,
              agentKind: last.agentKind,
              instructionVersion: last.instructionVersion,
              category: last.category,
            })
          : null,
    }
  })
}

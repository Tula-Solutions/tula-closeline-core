import { type AssessmentId, formatId, type OrganizationId } from 'tula-closeline-contract'
import type {
  AssessmentRateRow,
  AssessmentScope,
  TurnAssessmentRecord,
} from '~/ports/assessment-store'
import { mayOwn, type ProspectStateView } from './prospect-state'

type StoredAssessment = TurnAssessmentRecord & { organizationId: OrganizationId }

/** What the in-memory store keeps for Call turn Assessments. */
export type AssessmentState = {
  /** Keyed by id; a record is replaced, never changed in place, by a write. */
  turnAssessments: Map<AssessmentId, StoredAssessment>
}

/** An empty {@link AssessmentState}. */
export function emptyAssessmentState(): AssessmentState {
  return { turnAssessments: new Map() }
}

/** A copy of the shell of the collection, for a transaction's first write. */
export function copyAssessmentState(state: AssessmentState): AssessmentState {
  return { turnAssessments: new Map(state.turnAssessments) }
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 } as const

const rankOf = (record: TurnAssessmentRecord): number =>
  Math.max(0, ...record.findings.map((finding) => SEVERITY_RANK[finding.severity]))

const day = (date: Date): string => date.toISOString().slice(0, 10)

/** The Monday (UTC) of the week a moment falls in, as `YYYY-MM-DD`. */
function weekStartOf(date: Date): string {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const sinceMonday = (date.getUTCDay() + 6) % 7
  return new Date(midnight - sinceMonday * 86_400_000).toISOString().slice(0, 10)
}

const compare = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0)

/** Builds the Assessment methods of one transaction's scope, with the database's own rules. */
export function createAssessmentScope(env: {
  organizationId: OrganizationId
  read: () => AssessmentState & ProspectStateView
  write: () => AssessmentState
  requireLock: () => void
}): AssessmentScope {
  const { organizationId, read, write, requireLock } = env

  const mine = (): StoredAssessment[] =>
    [...read().turnAssessments.values()].filter((row) => row.organizationId === organizationId)

  const visible = (row: StoredAssessment, visibility: Parameters<typeof mayOwn>[2]): boolean => {
    if (visibility.kind === 'all') {
      return true
    }
    const view = read()
    const owner =
      row.prospectId === null
        ? null
        : view.prospects.get(row.prospectId)?.organizationId === organizationId
          ? (view.prospects.get(row.prospectId)?.ownerMembershipId ?? null)
          : null
    return mayOwn(view, organizationId, visibility)(owner)
  }

  const strip = ({ organizationId: _organizationId, ...record }: StoredAssessment) => ({
    ...record,
    findings: record.findings.map((finding) => ({ ...finding })),
  })

  return {
    saveTurnAssessment: async (input) => {
      requireLock()
      const existing = mine().find(
        (row) => row.callId === input.callId && row.turnIndex === input.turnIndex
      )
      if (existing) {
        return { record: strip(existing), created: false }
      }
      const stored: StoredAssessment = {
        organizationId,
        id: formatId('asm', crypto.randomUUID().replaceAll('-', '')),
        callId: input.callId,
        turnIndex: input.turnIndex,
        prospectId: input.prospectId,
        agentKind: input.agentKind,
        instructionVersion: input.instructionVersion,
        verdict: input.verdict,
        findings: input.findings.map((finding) => ({
          id: formatId('fnd', crypto.randomUUID().replaceAll('-', '')),
          category: finding.category,
          severity: finding.severity,
          span: { ...finding.span },
          explanation: finding.explanation,
          feedback: null,
          feedbackByMembershipId: null,
          feedbackAt: null,
        })),
        createdAt: input.now,
      }
      write().turnAssessments.set(stored.id, stored)
      return { record: strip(stored), created: true }
    },

    hasTurnAssessment: async (callId, turnIndex) =>
      mine().some((row) => row.callId === callId && row.turnIndex === turnIndex),

    listTurnAssessments: async (request) => {
      const from = request.from ?? ''
      const to = request.to ?? '9999-12-31'
      const key = (row: StoredAssessment) => (request.sort === 'worst_first' ? rankOf(row) : 0)
      return mine()
        .filter(
          (row) =>
            visible(row, request.visibility) &&
            (request.verdict === undefined
              ? request.sort !== 'worst_first' || row.verdict !== 'pass'
              : row.verdict === request.verdict) &&
            (request.agentKind === undefined || row.agentKind === request.agentKind) &&
            (request.category === undefined ||
              row.findings.some((finding) => finding.category === request.category)) &&
            day(row.createdAt) >= from &&
            day(row.createdAt) <= to
        )
        .sort(
          (a, b) =>
            compare(key(b), key(a)) ||
            compare(b.createdAt.getTime(), a.createdAt.getTime()) ||
            compare(b.id, a.id)
        )
        .filter((row) => {
          const after = request.after
          if (!after) {
            return true
          }
          const rank = request.sort === 'worst_first' ? after.rank : 0
          return (
            compare(key(row), rank) < 0 ||
            (key(row) === rank &&
              (compare(row.createdAt.getTime(), after.createdAt.getTime()) < 0 ||
                (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id)))
          )
        })
        .slice(0, request.limit)
        .map(strip)
    },

    getTurnAssessment: async (id, visibility) => {
      const row = read().turnAssessments.get(id)
      return row && row.organizationId === organizationId && visible(row, visibility)
        ? strip(row)
        : null
    },

    setFindingFeedback: async (input) => {
      requireLock()
      const row = read().turnAssessments.get(input.assessmentId)
      if (!row || row.organizationId !== organizationId) {
        return null
      }
      const finding = row.findings.find((item) => item.id === input.findingId)
      if (!finding) {
        return null
      }
      if (finding.feedback === input.feedback) {
        return { ...finding }
      }
      const marked = {
        ...finding,
        feedback: input.feedback,
        feedbackByMembershipId: input.membershipId,
        feedbackAt: input.now,
      }
      write().turnAssessments.set(row.id, {
        ...row,
        findings: row.findings.map((item) => (item.id === finding.id ? marked : item)),
      })
      return { ...marked }
    },

    listAssessmentRates: async (request) => {
      const cells = new Map<string, AssessmentRateRow>()
      for (const row of mine()) {
        if (
          day(row.createdAt) < request.from ||
          day(row.createdAt) > request.to ||
          (request.agentKind !== undefined && row.agentKind !== request.agentKind)
        ) {
          continue
        }
        const weekStart = weekStartOf(row.createdAt)
        const id = `${weekStart}|${row.agentKind}|${row.instructionVersion ?? 0}`
        const cell = cells.get(id) ?? {
          weekStart,
          agentKind: row.agentKind,
          instructionVersion: row.instructionVersion,
          total: 0,
          failed: 0,
        }
        const flagged =
          row.verdict === 'fail' &&
          row.findings.some((finding) => finding.feedback !== 'false_alarm')
        cells.set(id, { ...cell, total: cell.total + 1, failed: cell.failed + (flagged ? 1 : 0) })
      }
      const order = (r: {
        weekStart: string
        agentKind: string
        instructionVersion: number | null
      }) => `${r.weekStart}|${r.agentKind}|${String(r.instructionVersion ?? 0).padStart(10, '0')}`
      const after = request.after ? order(request.after) : undefined
      return [...cells.values()]
        .sort((a, b) => compare(order(a), order(b)))
        .filter((row) => after === undefined || order(row) > after)
        .slice(0, request.limit)
    },
  }
}

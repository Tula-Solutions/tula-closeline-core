import type {
  AgentKind,
  AssessmentId,
  AssessmentVerdict,
  CallId,
  FINDING_FEEDBACKS,
  FindingCategory,
  FindingId,
  FindingSeverity,
  MembershipId,
  ProspectId,
} from 'tula-closeline-contract'
import type { ProspectVisibility } from './core-store'
import type { JudgedFinding } from './judge'

/** What an Admin says about a finding. */
export type FindingFeedback = (typeof FINDING_FEEDBACKS)[number]

/** One stored finding of a Call turn, with what an Admin said about it. */
export type TurnFindingRecord = {
  id: FindingId
  category: FindingCategory
  severity: FindingSeverity
  span: { start: number; end: number }
  explanation: string
  feedback: FindingFeedback | null
  feedbackByMembershipId: MembershipId | null
  feedbackAt: Date | null
}

/** One stored Assessment of an Agent's turn in a Call. No text of the turn is kept. */
export type TurnAssessmentRecord = {
  id: AssessmentId
  callId: CallId
  turnIndex: number
  prospectId: ProspectId | null
  agentKind: AgentKind
  instructionVersion: number | null
  verdict: AssessmentVerdict
  findings: TurnFindingRecord[]
  createdAt: Date
}

/** An Assessment to store for one turn; a turn that already has one keeps the first. */
export type NewTurnAssessment = {
  callId: CallId
  turnIndex: number
  prospectId: ProspectId | null
  agentKind: AgentKind
  instructionVersion: number | null
  verdict: AssessmentVerdict
  findings: JudgedFinding[]
  now: Date
}

/** A keyset position in the list: severity rank (0 for none), creation time and id. */
export type AssessmentPosition = { rank: number; createdAt: Date; id: AssessmentId }

/** A keyset page request over turn Assessments. Filters only narrow what the visibility allows. */
export type AssessmentPageRequest = {
  visibility: ProspectVisibility
  verdict?: AssessmentVerdict
  category?: FindingCategory
  agentKind?: AgentKind
  /** First and last day (`YYYY-MM-DD`, UTC), inclusive; both or neither. */
  from?: string
  to?: string
  /** `newest`: creation time then id, descending. `worst_first`: severity rank first, then the same. */
  sort: 'newest' | 'worst_first'
  after?: AssessmentPosition
  /** The most rows to return. */
  limit: number
}

/** The weekly counts of one Agent kind and instruction version. */
export type AssessmentRateRow = {
  /** The Monday of the week (`YYYY-MM-DD`, UTC). */
  weekStart: string
  agentKind: AgentKind
  instructionVersion: number | null
  /** The finding category of a grouped row; `null` when not grouped. */
  category: TurnFindingRecord['category'] | null
  /** The Assessments judged that week. */
  total: number
  /** Those with a fail verdict that has at least one finding no Admin marked a false alarm. */
  failed: number
}

/** A request for the weekly counts, in week, Agent kind and instruction version order. */
export type AssessmentRatePageRequest = {
  from: string
  to: string
  agentKind?: AgentKind
  /** `category` makes one row per week, kind, version and category with a counted failing finding. */
  groupBy?: 'category'
  /** The last row of the previous page. */
  after?: {
    weekStart: string
    agentKind: AgentKind
    instructionVersion: number | null
    category: TurnFindingRecord['category'] | null
  }
  limit: number
}

/** Assessments of Call turns, inside one Organization's transaction. */
export interface AssessmentScope {
  /**
   * Stores the Assessment of a turn and its findings, once per turn: a turn that already has one
   * keeps it (`created: false`) and nothing else is written. Needs the Organization lock.
   */
  saveTurnAssessment(
    input: NewTurnAssessment
  ): Promise<{ record: TurnAssessmentRecord; created: boolean }>
  /** Whether the turn already has an Assessment. No lock. */
  hasTurnAssessment(callId: CallId, turnIndex: number): Promise<boolean>
  /** One page of turn Assessments the visibility allows; ask for one row more than a page to know whether another follows. */
  listTurnAssessments(request: AssessmentPageRequest): Promise<TurnAssessmentRecord[]>
  /** One turn Assessment with its findings if the visibility allows it, else `null` (also for another Organization). */
  getTurnAssessment(
    id: AssessmentId,
    visibility: ProspectVisibility
  ): Promise<TurnAssessmentRecord | null>
  /**
   * Sets the mark of a finding with who and when. The same value again changes nothing (the first
   * who and when stay); another value replaces the mark. `null` when the finding does not exist in
   * this Organization's Assessment. Needs the Organization lock.
   */
  setFindingFeedback(input: {
    assessmentId: AssessmentId
    findingId: FindingId
    feedback: FindingFeedback
    membershipId: MembershipId
    now: Date
  }): Promise<TurnFindingRecord | null>
  /** The weekly counts over a range, one page. Ask for one row more than a page to know whether another follows. */
  listAssessmentRates(request: AssessmentRatePageRequest): Promise<AssessmentRateRow[]>
}

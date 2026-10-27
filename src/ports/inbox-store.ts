import type {
  ApprovalRule,
  AssessmentId,
  AssessmentVerdict,
  ConversationId,
  ConversationSummary,
  DealRecordId,
  DecisionId,
  DocumentId,
  DraftId,
  FindingId,
  MembershipId,
  MessageId,
  ProspectId,
  TeamId,
} from 'tula-closeline-contract'
import type { ProspectVisibility } from './core-store'
import type { JudgedFinding } from './judge'

/** The channels a Conversation runs on. */
export type InboxChannel = 'email' | 'linkedin' | 'chat'

/** The label a Message may carry after classification. */
export type InboxLabel =
  | 'positive'
  | 'question'
  | 'objection'
  | 'not_now'
  | 'negative'
  | 'wrong_person'
  | 'unsubscribe'
  | 'out_of_office'
  | 'bounce'
  | 'other'

/** One Conversation as the store keeps it: a Prospect on one channel. */
export type ConversationRecord = {
  id: ConversationId
  prospectId: ProspectId
  channel: InboxChannel
  controller: 'agent' | 'rep'
  controllerMembershipId: MembershipId | null
  state: 'agent' | 'awaiting_approval' | 'rep' | 'escalated' | 'closed'
  ownerMembershipId: MembershipId | null
  latestLabel: InboxLabel | null
  pendingDraftCount: number
  lastMessageAt: Date
  createdAt: Date
}

/** One Message as the store keeps it. Append-only; only the classification is ever updated. */
export type MessageRecord = {
  id: MessageId
  conversationId: ConversationId
  channel: InboxChannel
  direction: 'inbound' | 'outbound'
  authorKind: 'prospect' | 'agent' | 'rep'
  authorMembershipId: MembershipId | null
  providerMessageId: string
  draftId: DraftId | null
  body: string
  sentAt: Date
  classification: {
    label: InboxLabel
    confidence: number
    decidedBy: 'model' | 'rep'
    correctedByMembershipId: MembershipId | null
    classifiedAt: Date
  } | null
}

/** A Conversation's stored summary and Outcome label; the summary is untrusted model output, shown as text only. */
export type ConversationSummaryRecord = {
  conversationId: ConversationId
  summary: string
  outcomeLabel: ConversationSummary['outcomeLabel']
  generatedAt: Date
}

/** What a stored Draft tells the ingest: who wrote it, which Conversation it belongs to. */
export type DraftRef = {
  id: DraftId
  conversationId: ConversationId
  author: 'agent' | 'rep'
  authorMembershipId: MembershipId | null
}

/** The classification a Message carries once labelled. */
export type MessageClassification = NonNullable<MessageRecord['classification']>

/** Where a Draft stands. */
export type DraftStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'superseded' | 'void'

/** One Source of a Draft: a moment of a won Deal, stored with its Outcome and the evidence behind it. */
export type NewDraftSource = {
  kind: 'moment'
  sourceRef: string
  /** Its place in the Draft's list of Sources, from 0. */
  position: number
  dealRecordId: DealRecordId
  outcome: 'won' | 'lost' | 'open' | null
  evidenceCount: number
}

/** A new Draft written by the Agent in reply to one Message. */
export type NewAgentDraft = {
  id: DraftId
  conversationId: ConversationId
  triggerMessageId: MessageId
  label: 'objection' | 'question'
  body: string
  strategy: string
  confidence: number
  /** True when no Source backs the Draft; it is then held as `ungrounded`. */
  ungrounded: boolean
  /** The release checks the Draft ran; none are run yet, so this is empty unless given. */
  checks?: DraftCheck[]
  /** Why the Draft waits for a person; `null` releases it at once (stored `approved`). */
  hold: DraftHold | null
  sources: NewDraftSource[]
  now: Date
}

/** The judge's assessment of one Draft version, to be stored once. */
export type NewDraftAssessment = {
  draftId: DraftId
  /** The Draft's version; an Agent Draft is never edited, so it is always 1. */
  draftVersion: number
  prospectId: ProspectId
  verdict: AssessmentVerdict
  findings: JudgedFinding[]
  now: Date
}

/** A stored Draft assessment with its findings, which carry a span and a category but never text. */
export type DraftAssessmentRecord = {
  id: AssessmentId
  draftId: DraftId
  draftVersion: number
  verdict: AssessmentVerdict
  judgeSource: 'model' | 'rules'
  createdAt: Date
  findings: (JudgedFinding & { id: FindingId })[]
}

/** Why a Draft waits for a person. */
export type DraftHold = 'ungrounded' | 'check_failed' | 'escalated' | 'first_message' | 'policy'

/** One release check a Draft ran and whether it passed. */
export type DraftCheck = { name: string; passed: boolean }

/** One Source of a stored Draft. */
export type DraftSourceRecord = {
  kind: 'moment' | 'document_chunk'
  sourceRef: string
  dealRecordId: DealRecordId | null
  documentId: DocumentId | null
  outcome: 'won' | 'lost' | 'open' | null
  evidenceCount: number
}

/** A stored Draft with its Sources, as the approval queue and the Draft routes read it. */
export type DraftRecord = {
  id: DraftId
  conversationId: ConversationId
  author: 'agent' | 'rep'
  authorMembershipId: MembershipId | null
  body: string
  reason: { triggerMessageId: MessageId; label: 'objection' | 'question'; strategy: string } | null
  confidence: number | null
  ungrounded: boolean
  checks: DraftCheck[]
  hold: DraftHold | null
  status: DraftStatus
  createdAt: Date
  decidedAt: Date | null
  sources: DraftSourceRecord[]
}

/** The kinds of decision the record keeps. */
export type DecisionKind =
  | 'approve'
  | 'edit_approve'
  | 'reject'
  | 'auto_release'
  | 'takeover'
  | 'hand_back'

/** A decision to append to the record. */
export type NewDecision = {
  id: DecisionId
  conversationId: ConversationId
  draftId: DraftId | null
  kind: DecisionKind
  /** `null` for `auto_release`, the one decision no person made. */
  decidedByMembershipId: MembershipId | null
  note: string | null
  /** The SHA-256 (hex) of the edited text for `edit_approve`; the text itself is never kept. */
  editedBodySha256: string | null
  acknowledgedUngrounded: boolean
  decidedAt: Date
}

/** A decision as stored. */
export type DecisionRecord = Omit<NewDecision, 'editedBodySha256'>

/** The filters of a decision list, oldest-first never: newest first. */
export type DecisionPageRequest = {
  visibility: ProspectVisibility
  conversationId?: ConversationId
  draftId?: DraftId
  kind?: DecisionKind
  from?: Date
  to?: Date
  /** Rows strictly after this position in `(decidedAt, id)` descending order. */
  after?: { decidedAt: Date; id: DecisionId }
  limit: number
}

/** The filters of the approval queue: pending Drafts the visibility allows, oldest first. */
export type ApprovalQueueRequest = {
  visibility: ProspectVisibility
  channel?: InboxChannel
  conversationId?: ConversationId
  /** Rows strictly after this position in `(createdAt, id)` ascending order. */
  after?: { createdAt: Date; id: DraftId }
  limit: number
}

/** A stored approval policy row. */
export type ApprovalPolicyRecord = {
  channel: InboxChannel
  rule: ApprovalRule
  updatedAt: Date
  updatedByMembershipId: MembershipId | null
}

/** What fires an escalation rule; mirrors the database's `ESCALATION_TRIGGERS`. */
export type EscalationTrigger =
  | 'asks_for_person'
  | 'pricing_or_legal'
  | 'negative_tone'
  | 'low_confidence'
  | 'writer_failure'

/** Where an escalation goes; mirrors the database's `ESCALATION_TARGETS`. */
export type EscalationTarget = 'prospect_owner' | 'team_round_robin' | 'admin_queue'

/** A stored escalation rule: at most one per trigger in an Organization. */
export type EscalationRuleRecord = {
  id: string
  trigger: EscalationTrigger
  target: EscalationTarget
  /** Set exactly when the target is `team_round_robin`. */
  teamId: TeamId | null
  /** Set exactly for `low_confidence`: escalate when the confidence is below it, in (0, 1]. */
  threshold: number | null
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedByMembershipId: MembershipId | null
}

/** A new Conversation. */
export type NewConversation = {
  id: ConversationId
  prospectId: ProspectId
  channel: InboxChannel
  ownerMembershipId: MembershipId | null
  now: Date
  /** The time of the first Message. */
  lastMessageAt: Date
}

/** A new Message, to be appended to a Conversation of the same channel. */
export type NewMessage = Omit<MessageRecord, 'classification'>

/** The filters of a Conversation list, all narrowing what the visibility allows. */
export type ConversationPageRequest = {
  visibility: ProspectVisibility
  channel?: InboxChannel
  state?: ConversationRecord['state']
  controller?: ConversationRecord['controller']
  label?: InboxLabel
  prospectId?: ProspectId
  /** Latest activity first: rows strictly after this position in `(lastMessageAt, id)` descending order. */
  after?: { lastMessageAt: Date; id: ConversationId }
  limit: number
}

/** The inbox methods of one Organization's transaction. Writes need the Organization lock. */
export interface InboxScope {
  /** One Message by channel and provider id, or `null`. Reads the unique key. */
  findMessageByProviderId(
    channel: InboxChannel,
    providerMessageId: string
  ): Promise<MessageRecord | null>
  /** The Prospect's most recently created Conversation on a channel, or `null`. */
  findConversationOfProspect(
    prospectId: ProspectId,
    channel: InboxChannel
  ): Promise<ConversationRecord | null>
  /** A Draft's author and Conversation, or `null` when the Organization has no such Draft. */
  findDraftRef(draftId: DraftId): Promise<DraftRef | null>
  /** The id of the Draft written in reply to a Message, or `null` when there is none. */
  findDraftForMessage(messageId: MessageId): Promise<{ id: DraftId } | null>
  /**
   * Stores a pending Agent Draft with its Sources, counts it on its Conversation and moves the
   * Conversation to `awaiting_approval`. Needs the Organization lock.
   */
  insertAgentDraft(input: NewAgentDraft): Promise<void>
  /**
   * Stores the assessment of one Draft version with its findings. It is idempotent: a second save
   * for the same Draft version keeps the first and returns it. Needs the Organization lock.
   */
  saveDraftAssessment(input: NewDraftAssessment): Promise<DraftAssessmentRecord>
  /** The stored assessment of a Draft version, or `null` when none exists in this Organization. */
  getDraftAssessment(draftId: DraftId, draftVersion: number): Promise<DraftAssessmentRecord | null>
  /**
   * The latest assessment (highest version) of each named Draft that has one, in this
   * Organization, read with one indexed lookup for the whole list (callers pass at most a page of
   * ids). A Draft never judged has no entry.
   */
  getLatestDraftAssessments(
    draftIds: readonly DraftId[]
  ): Promise<Map<DraftId, DraftAssessmentRecord>>
  /**
   * Replaces the body of a Draft that is still pending, without deciding it, for an edit that was
   * judged again and failed. Answers the Draft, or `null` when it was not pending. Needs the
   * Organization lock.
   */
  replacePendingDraftBody(draftId: DraftId, body: string): Promise<DraftRecord | null>
  /**
   * Moves a Conversation the Agent is handling (`agent` or `awaiting_approval`) to `escalated` and
   * records who it is assigned to (`null` for the Admin queue). Answers whether it moved: a
   * Conversation already escalated, closed or with a Rep is left alone and answers `false`, which
   * is what makes an escalation happen once. Needs the Organization lock.
   */
  escalateConversation(
    conversationId: ConversationId,
    assigneeMembershipId: MembershipId | null
  ): Promise<boolean>
  /**
   * How many escalated Conversations each of the Memberships holds (those with none are 0). This
   * is the Team round-robin state, read from the Conversations themselves.
   */
  countEscalatedByAssignee(
    membershipIds: readonly MembershipId[]
  ): Promise<Map<MembershipId, number>>
  /** The escalation rule of a trigger, or `null` while none was set. */
  getEscalationRule(trigger: EscalationTrigger): Promise<EscalationRuleRecord | null>
  /** Rules in trigger order after `after` (when given), at most `limit`. */
  listEscalationRules(request: {
    after?: EscalationTrigger
    limit: number
  }): Promise<EscalationRuleRecord[]>
  /** Sets the rule of a trigger, replacing the one it had. Needs the Organization lock. */
  upsertEscalationRule(input: {
    trigger: EscalationTrigger
    target: EscalationTarget
    teamId: TeamId | null
    threshold: number | null
    enabled: boolean
    membershipId: MembershipId
    now: Date
  }): Promise<EscalationRuleRecord>
  /** Removes the rule of a trigger; answers whether one existed. Needs the Organization lock. */
  deleteEscalationRule(trigger: EscalationTrigger): Promise<boolean>
  /** Creates a Conversation in the default state: Agent in control. */
  insertConversation(input: NewConversation): Promise<ConversationRecord>
  /** Appends a Message and moves its Conversation's latest activity forward, never back. */
  insertMessage(input: NewMessage): Promise<MessageRecord>
  /** One Message of the Organization by id, or `null`. */
  getMessage(id: MessageId): Promise<MessageRecord | null>
  /**
   * Stores a classification on an inbound Message and returns the Message, or `null` when it is
   * missing, is outbound, or (with `onlyIfUnclassified`) already carries a label.
   */
  saveClassification(input: {
    messageId: MessageId
    classification: MessageClassification
    onlyIfUnclassified: boolean
  }): Promise<MessageRecord | null>
  /** Sets the Conversation's latest label to that of its newest inbound Message (none when unlabelled). */
  refreshLatestLabel(conversationId: ConversationId): Promise<void>
  /** Voids every pending Draft of the Conversation, zeroes its pending count and closes it. */
  stopConversation(conversationId: ConversationId, now: Date): Promise<void>
  /**
   * Gives the Conversation to a Rep: voids every pending Draft, zeroes the pending count, sets the
   * controller and state to `rep` and answers how many Drafts were voided. Needs the Organization lock.
   */
  takeOverConversation(input: {
    conversationId: ConversationId
    membershipId: MembershipId
    now: Date
  }): Promise<{ voidedDraftCount: number }>
  /**
   * Returns the Conversation to the Agent: the controller becomes `agent` and a Conversation in
   * state `rep` goes back to `agent`. Needs the Organization lock.
   */
  handBackConversation(conversationId: ConversationId): Promise<void>
  /** One Conversation the visibility allows, or `null`. */
  getConversation(
    id: ConversationId,
    visibility: ProspectVisibility
  ): Promise<ConversationRecord | null>
  /** Conversations the visibility allows, latest activity first, at most `limit`. */
  listConversations(request: ConversationPageRequest): Promise<ConversationRecord[]>
  /** One Draft of the Organization with its Sources, or `null`. Visibility is the caller's to check on its Conversation. */
  getDraft(draftId: DraftId): Promise<DraftRecord | null>
  /** Pending Drafts of Conversations the visibility allows, oldest first, with their Conversations, at most `limit`. */
  listPendingDrafts(
    request: ApprovalQueueRequest
  ): Promise<{ draft: DraftRecord; conversation: ConversationRecord }[]>
  /**
   * Decides a pending Draft in one statement that only matches `status = 'pending'`: sets its
   * status and time (and the body, when `body` is given), takes it off its Conversation's pending
   * count and, when none is left and the Agent is in control, returns the Conversation to `agent`.
   * Answers the decided Draft, or `null` when it was not pending, so a concurrent second decision
   * loses. Needs the Organization lock.
   */
  decidePendingDraft(input: {
    draftId: DraftId
    status: 'approved' | 'rejected'
    body?: string
    /** The checks of a re-judged edit that passed: stored as given, and the hold is cleared. */
    released?: DraftCheck[]
    now: Date
  }): Promise<DraftRecord | null>
  /** Stores a Rep's own reply as an approved Draft (no Sources, no hold). Needs the Organization lock. */
  insertRepDraft(input: {
    id: DraftId
    conversationId: ConversationId
    membershipId: MembershipId
    body: string
    now: Date
  }): Promise<DraftRecord>
  /** Whether the Conversation has an outbound Message or an approved, sent Draft behind it. */
  hasReleasedReply(conversationId: ConversationId): Promise<boolean>
  /** Appends a decision to the record. Needs the Organization lock. */
  insertDecision(input: NewDecision): Promise<void>
  /** Decisions on Conversations the visibility allows, newest first, at most `limit`. */
  listDecisions(request: DecisionPageRequest): Promise<DecisionRecord[]>
  /** The channel's approval policy row, or `null` while none was set (the rule is then `always`). */
  getApprovalPolicy(channel: InboxChannel): Promise<ApprovalPolicyRecord | null>
  /** Every approval policy row of the Organization, at most one per channel. */
  listApprovalPolicies(): Promise<ApprovalPolicyRecord[]>
  /** Sets the channel's rule, replacing a row that exists. Needs the Organization lock. */
  upsertApprovalPolicy(input: {
    channel: InboxChannel
    rule: ApprovalRule
    membershipId: MembershipId
    now: Date
  }): Promise<ApprovalPolicyRecord>
  /** The stored summary of a Conversation, or `null` while it has none. */
  getConversationSummary(conversationId: ConversationId): Promise<ConversationSummaryRecord | null>
  /** Stores the summary of a Conversation, replacing the one it had. Needs the Organization lock. */
  saveConversationSummary(input: ConversationSummaryRecord): Promise<void>
  /**
   * Ids, in ascending order and after `after`, of Conversations that are closed or have had no
   * Message since `quietBefore` and whose summary is missing or older than their last Message;
   * at most `limit`.
   */
  listSummaryCandidates(request: {
    quietBefore: Date
    after?: ConversationId
    limit: number
  }): Promise<ConversationId[]>
  /** Messages of a Conversation, oldest first, those after the position when given, at most `limit`. */
  listMessages(request: {
    conversationId: ConversationId
    after?: { sentAt: Date; id: MessageId }
    /** Take the newest `limit` instead of the oldest; the result is still oldest first. */
    newest?: boolean
    limit: number
  }): Promise<MessageRecord[]>
}

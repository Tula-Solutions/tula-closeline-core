import {
  type AssessmentId,
  type ConversationId,
  type DecisionId,
  type DraftId,
  type FindingId,
  formatId,
  type MembershipId,
  type OrganizationId,
} from 'tula-closeline-contract'
import type {
  ApprovalPolicyRecord,
  ConversationRecord,
  DecisionRecord,
  DraftAssessmentRecord,
  DraftCheck,
  DraftHold,
  DraftRecord,
  DraftRef,
  DraftStatus,
  EscalationRuleRecord,
  InboxChannel,
  InboxScope,
  MessageRecord,
  NewAgentDraft,
} from '~/ports/inbox-store'
import { mayOwn, type ProspectStateView } from './prospect-state'

/** A Draft the Agent wrote, as a test reads it back from the in-memory store. */
export type AgentDraftView = Omit<NewAgentDraft, 'now'> & { status: DraftStatus }

/** A Draft as the in-memory store keeps it: its reference and what the Draft routes read. */
export type StoredDraft = DraftRef & {
  organizationId: OrganizationId
  status: DraftStatus
  decidedAt: Date | null
  /** Set for every Draft the store writes; a planted reference has none. */
  createdAt?: Date
  body?: string
  checks?: DraftCheck[]
  hold?: DraftHold | null
  /** What a Draft written by the Agent carries beyond its reference. */
  agent?: Omit<NewAgentDraft, 'id' | 'conversationId' | 'now'>
}

/** What the in-memory store keeps for the inbox: Conversations, Messages and Draft references. */
export type InboxState = {
  /** Keyed by Conversation id; the Organization is on the record kept beside it. */
  conversations: Map<ConversationId, ConversationRecord & { organizationId: OrganizationId }>
  /** In append order; replaced, never changed in place, by a write. */
  messages: (MessageRecord & { organizationId: OrganizationId })[]
  /** Drafts: those the store writes and those a test plants. */
  draftRefs: Map<DraftId, StoredDraft>
  /** The decision record, in append order; the edited text is never kept, only its hash. */
  decisions: (DecisionRecord & {
    organizationId: OrganizationId
    editedBodySha256: string | null
  })[]
  /** One row per Organization and channel, once an Admin set the rule. */
  approvalPolicies: Map<string, ApprovalPolicyRecord & { organizationId: OrganizationId }>
  /** Escalation rules keyed by Organization and trigger: the unique key of the table. */
  escalationRules: Map<string, EscalationRuleRecord & { organizationId: OrganizationId }>
  /** Draft assessments keyed by Organization, Draft and version: the unique key of the table. */
  assessments: Map<string, DraftAssessmentRecord & { organizationId: OrganizationId }>
}

/** An empty {@link InboxState}. */
export function emptyInboxState(): InboxState {
  return {
    conversations: new Map(),
    messages: [],
    draftRefs: new Map(),
    decisions: [],
    approvalPolicies: new Map(),
    escalationRules: new Map(),
    assessments: new Map(),
  }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyInboxState(state: InboxState): InboxState {
  return {
    conversations: new Map(state.conversations),
    messages: [...state.messages],
    draftRefs: new Map(state.draftRefs),
    decisions: [...state.decisions],
    approvalPolicies: new Map(state.approvalPolicies),
    escalationRules: new Map(state.escalationRules),
    assessments: new Map(state.assessments),
  }
}

/** Removes the Conversations and Messages of a Prospect, as the database's cascade does. */
export function eraseProspectInbox(
  state: InboxState,
  organizationId: OrganizationId,
  prospectId: string
): void {
  const gone = new Set<ConversationId>()
  for (const [id, conversation] of state.conversations) {
    if (conversation.organizationId === organizationId && conversation.prospectId === prospectId) {
      gone.add(id)
      state.conversations.delete(id)
    }
  }
  state.messages = state.messages.filter(
    (m) => !(m.organizationId === organizationId && gone.has(m.conversationId))
  )
  for (const [id, draft] of state.draftRefs) {
    if (draft.organizationId === organizationId && gone.has(draft.conversationId)) {
      state.draftRefs.delete(id)
    }
  }
  state.decisions = state.decisions.filter(
    (d) => !(d.organizationId === organizationId && gone.has(d.conversationId))
  )
}

const strip = <T extends { organizationId: OrganizationId }>({
  organizationId: _organizationId,
  ...record
}: T): Omit<T, 'organizationId'> => record

/** Orders by latest activity, newest first, then by id descending. */
const newestFirst = (a: ConversationRecord, b: ConversationRecord): number =>
  b.lastMessageAt.getTime() - a.lastMessageAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** A stored Draft as the port returns it, with its Sources. */
function toDraftRecord(d: StoredDraft): DraftRecord {
  const agent = d.agent
  return {
    id: d.id,
    conversationId: d.conversationId,
    author: d.author,
    authorMembershipId: d.authorMembershipId,
    body: d.body ?? agent?.body ?? '',
    reason: agent
      ? { triggerMessageId: agent.triggerMessageId, label: agent.label, strategy: agent.strategy }
      : null,
    confidence: agent?.confidence ?? null,
    ungrounded: agent?.ungrounded ?? false,
    checks: d.checks ?? [],
    hold: d.hold ?? agent?.hold ?? null,
    status: d.status,
    createdAt: d.createdAt ?? new Date(0),
    decidedAt: d.decidedAt,
    sources: (agent?.sources ?? []).map((source) => ({
      kind: source.kind,
      sourceRef: source.sourceRef,
      dealRecordId: source.dealRecordId,
      documentId: null,
      outcome: source.outcome,
      evidenceCount: source.evidenceCount,
    })),
  }
}

/** The key of a policy row: the primary key `(organization_id, channel)`. */
const policyKey = (organizationId: OrganizationId, channel: InboxChannel): string =>
  `${organizationId}/${channel}`

/** Oldest first, then by id: the order of the approval queue. */
const oldestFirst = (a: DraftRecord, b: DraftRecord): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Builds the inbox methods of one transaction's scope, with the database's own rules. */
export function createInboxScope(env: {
  organizationId: OrganizationId
  read: () => InboxState & ProspectStateView
  write: () => InboxState
  requireLock: () => void
}): InboxScope {
  const { organizationId, read, write, requireLock } = env
  /** A Conversation is owned by whoever owns its Prospect now, as the database joins it. */
  const live = (c: ConversationRecord & { organizationId: OrganizationId }) => ({
    ...c,
    ownerMembershipId: read().prospects.get(c.prospectId)?.ownerMembershipId ?? null,
  })

  return {
    findMessageByProviderId: async (channel, providerMessageId) => {
      const found = read().messages.find(
        (m) =>
          m.organizationId === organizationId &&
          m.channel === channel &&
          m.providerMessageId === providerMessageId
      )
      return found ? strip(found) : null
    },

    findConversationOfProspect: async (prospectId, channel) => {
      const found = [...read().conversations.values()]
        .filter(
          (c) =>
            c.organizationId === organizationId &&
            c.prospectId === prospectId &&
            c.channel === channel
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )[0]
      return found ? strip(found) : null
    },

    findDraftRef: async (draftId) => {
      const found = read().draftRefs.get(draftId)
      return found?.organizationId === organizationId
        ? {
            id: found.id,
            conversationId: found.conversationId,
            author: found.author,
            authorMembershipId: found.authorMembershipId,
          }
        : null
    },

    findDraftForMessage: async (messageId) => {
      for (const draft of read().draftRefs.values()) {
        if (
          draft.organizationId === organizationId &&
          draft.agent?.triggerMessageId === messageId
        ) {
          return { id: draft.id }
        }
      }
      return null
    },

    insertAgentDraft: async (input) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(input.conversationId)
      if (conversation?.organizationId !== organizationId) {
        throw new Error('The Draft names a Conversation that does not exist')
      }
      const { id, conversationId, now, ...agent } = input
      const released = input.hold === null
      state.draftRefs.set(id, {
        id,
        conversationId,
        author: 'agent',
        authorMembershipId: null,
        organizationId,
        status: released ? 'approved' : 'pending',
        decidedAt: released ? now : null,
        createdAt: now,
        body: input.body,
        checks: input.checks ?? [],
        hold: input.hold,
        agent,
      })
      if (!released) {
        state.conversations.set(conversationId, {
          ...conversation,
          pendingDraftCount: conversation.pendingDraftCount + 1,
          state: conversation.state === 'escalated' ? 'escalated' : 'awaiting_approval',
        })
      }
    },

    saveDraftAssessment: async (input) => {
      requireLock()
      const key = `${organizationId}:${input.draftId}:${input.draftVersion}`
      const existing = read().assessments.get(key)
      if (existing) {
        return strip(existing)
      }
      const record: DraftAssessmentRecord = {
        id: formatId('asm', crypto.randomUUID()) as AssessmentId,
        draftId: input.draftId,
        draftVersion: input.draftVersion,
        verdict: input.verdict,
        judgeSource: 'model',
        createdAt: input.now,
        findings: input.findings.map((finding) => ({
          ...finding,
          id: formatId('fnd', crypto.randomUUID()) as FindingId,
        })),
      }
      write().assessments.set(key, { ...record, organizationId })
      return record
    },

    getDraftAssessment: async (draftId, draftVersion) => {
      const found = read().assessments.get(`${organizationId}:${draftId}:${draftVersion}`)
      return found ? strip(found) : null
    },

    escalateConversation: async (conversationId, assigneeMembershipId) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(conversationId)
      if (
        conversation?.organizationId === organizationId &&
        (conversation.state === 'agent' || conversation.state === 'awaiting_approval')
      ) {
        state.conversations.set(conversationId, {
          ...conversation,
          state: 'escalated',
          ownerMembershipId: assigneeMembershipId,
        })
        return true
      }
      return false
    },

    countEscalatedByAssignee: async (membershipIds) => {
      const counts = new Map<MembershipId, number>(membershipIds.map((id) => [id, 0]))
      for (const c of read().conversations.values()) {
        if (
          c.organizationId === organizationId &&
          c.state === 'escalated' &&
          c.ownerMembershipId !== null &&
          counts.has(c.ownerMembershipId)
        ) {
          counts.set(c.ownerMembershipId, (counts.get(c.ownerMembershipId) ?? 0) + 1)
        }
      }
      return counts
    },

    getEscalationRule: async (trigger) => {
      const found = read().escalationRules.get(`${organizationId}:${trigger}`)
      return found ? strip(found) : null
    },

    listEscalationRules: async (request) =>
      [...read().escalationRules.values()]
        .filter((r) => r.organizationId === organizationId)
        .filter((r) => request.after === undefined || r.trigger > request.after)
        .sort((a, b) => (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0))
        .slice(0, request.limit)
        .map(strip),

    upsertEscalationRule: async (input) => {
      requireLock()
      const key = `${organizationId}:${input.trigger}`
      const existing = read().escalationRules.get(key)
      const record: EscalationRuleRecord = {
        id: existing?.id ?? formatId('esr', crypto.randomUUID()),
        trigger: input.trigger,
        target: input.target,
        teamId: input.teamId,
        threshold: input.threshold,
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? input.now,
        updatedAt: input.now,
        updatedByMembershipId: input.membershipId,
      }
      write().escalationRules.set(key, { ...record, organizationId })
      return record
    },

    deleteEscalationRule: async (trigger) => {
      requireLock()
      const key = `${organizationId}:${trigger}`
      const had = read().escalationRules.has(key)
      write().escalationRules.delete(key)
      return had
    },

    insertConversation: async (input) => {
      requireLock()
      const record = {
        id: input.id,
        prospectId: input.prospectId,
        channel: input.channel,
        controller: 'agent' as const,
        controllerMembershipId: null,
        state: 'agent' as const,
        ownerMembershipId: input.ownerMembershipId,
        latestLabel: null,
        pendingDraftCount: 0,
        lastMessageAt: input.lastMessageAt,
        createdAt: input.now,
      }
      write().conversations.set(input.id, { ...record, organizationId })
      return record
    },

    insertMessage: async (input) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(input.conversationId)
      if (
        conversation?.organizationId !== organizationId ||
        conversation.channel !== input.channel
      ) {
        throw new Error('The Message names a Conversation that does not exist on its channel')
      }
      const record: MessageRecord = { ...input, classification: null }
      state.messages = [...state.messages, { ...record, organizationId }]
      const newest = input.sentAt.getTime() >= conversation.lastMessageAt.getTime()
      state.conversations.set(conversation.id, {
        ...conversation,
        lastMessageAt: newest ? input.sentAt : conversation.lastMessageAt,
        latestLabel: input.direction === 'inbound' && newest ? null : conversation.latestLabel,
      })
      return record
    },

    getConversation: async (id, visibility) => {
      const stored = read().conversations.get(id)
      const found = stored && live(stored)
      if (
        found?.organizationId !== organizationId ||
        !mayOwn(read(), organizationId, visibility)(found.ownerMembershipId)
      ) {
        return null
      }
      return strip(found)
    },

    listConversations: async (request) => {
      const allowed = mayOwn(read(), organizationId, request.visibility)
      return [...read().conversations.values()]
        .map(live)
        .filter(
          (c) =>
            c.organizationId === organizationId &&
            allowed(c.ownerMembershipId) &&
            (request.channel === undefined || c.channel === request.channel) &&
            (request.state === undefined || c.state === request.state) &&
            (request.controller === undefined || c.controller === request.controller) &&
            (request.label === undefined || c.latestLabel === request.label) &&
            (request.prospectId === undefined || c.prospectId === request.prospectId)
        )
        .sort(newestFirst)
        .filter(
          (c) =>
            request.after === undefined ||
            newestFirst(
              { ...c },
              { ...c, lastMessageAt: request.after.lastMessageAt, id: request.after.id }
            ) > 0
        )
        .slice(0, request.limit)
        .map(strip)
    },

    getMessage: async (id) => {
      const found = read().messages.find((m) => m.organizationId === organizationId && m.id === id)
      return found ? strip(found) : null
    },

    saveClassification: async (input) => {
      requireLock()
      const state = write()
      const found = state.messages.find(
        (m) => m.organizationId === organizationId && m.id === input.messageId
      )
      if (
        found?.direction !== 'inbound' ||
        (input.onlyIfUnclassified && found.classification !== null)
      ) {
        return null
      }
      const updated = { ...found, classification: input.classification }
      state.messages = state.messages.map((m) => (m === found ? updated : m))
      return strip(updated)
    },

    refreshLatestLabel: async (conversationId) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(conversationId)
      if (conversation?.organizationId !== organizationId) {
        return
      }
      const newest = state.messages
        .filter(
          (m) =>
            m.organizationId === organizationId &&
            m.conversationId === conversationId &&
            m.direction === 'inbound'
        )
        .sort(
          (a, b) =>
            b.sentAt.getTime() - a.sentAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
        )[0]
      state.conversations.set(conversationId, {
        ...conversation,
        latestLabel: newest?.classification?.label ?? null,
      })
    },

    stopConversation: async (conversationId, now) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(conversationId)
      if (conversation?.organizationId !== organizationId) {
        return
      }
      for (const [id, draft] of state.draftRefs) {
        if (
          draft.organizationId === organizationId &&
          draft.conversationId === conversationId &&
          draft.status === 'pending'
        ) {
          state.draftRefs.set(id, { ...draft, status: 'void', decidedAt: now })
        }
      }
      state.conversations.set(conversationId, {
        ...conversation,
        pendingDraftCount: 0,
        state: 'closed',
      })
    },

    takeOverConversation: async ({ conversationId, membershipId, now }) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(conversationId)
      if (conversation?.organizationId !== organizationId) {
        return { voidedDraftCount: 0 }
      }
      let voidedDraftCount = 0
      for (const [id, draft] of state.draftRefs) {
        if (
          draft.organizationId === organizationId &&
          draft.conversationId === conversationId &&
          draft.status === 'pending'
        ) {
          state.draftRefs.set(id, { ...draft, status: 'void', decidedAt: now })
          voidedDraftCount += 1
        }
      }
      state.conversations.set(conversationId, {
        ...conversation,
        controller: 'rep',
        controllerMembershipId: membershipId,
        state: 'rep',
        pendingDraftCount: 0,
      })
      return { voidedDraftCount }
    },

    handBackConversation: async (conversationId) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(conversationId)
      if (conversation?.organizationId !== organizationId) {
        return
      }
      state.conversations.set(conversationId, {
        ...conversation,
        controller: 'agent',
        controllerMembershipId: null,
        state: conversation.state === 'closed' ? 'closed' : 'agent',
      })
    },

    getDraft: async (draftId) => {
      const found = read().draftRefs.get(draftId)
      return found?.organizationId === organizationId ? toDraftRecord(found) : null
    },

    listPendingDrafts: async (request) => {
      const allowed = mayOwn(read(), organizationId, request.visibility)
      const rows: { draft: DraftRecord; conversation: ConversationRecord }[] = []
      for (const stored of read().draftRefs.values()) {
        const conversation = read().conversations.get(stored.conversationId)
        if (
          stored.organizationId !== organizationId ||
          stored.status !== 'pending' ||
          conversation?.organizationId !== organizationId
        ) {
          continue
        }
        const live_ = strip(live(conversation))
        if (
          !allowed(live_.ownerMembershipId) ||
          (request.channel !== undefined && live_.channel !== request.channel) ||
          (request.conversationId !== undefined && live_.id !== request.conversationId)
        ) {
          continue
        }
        rows.push({ draft: toDraftRecord(stored), conversation: live_ })
      }
      return rows
        .sort((a, b) => oldestFirst(a.draft, b.draft))
        .filter(
          ({ draft }) =>
            request.after === undefined ||
            oldestFirst(draft, {
              ...draft,
              createdAt: request.after.createdAt,
              id: request.after.id,
            }) > 0
        )
        .slice(0, request.limit)
    },

    decidePendingDraft: async (input) => {
      requireLock()
      const state = write()
      const stored = state.draftRefs.get(input.draftId)
      if (stored?.organizationId !== organizationId || stored.status !== 'pending') {
        return null
      }
      const decided = {
        ...stored,
        status: input.status,
        decidedAt: input.now,
        ...(input.body === undefined ? {} : { body: input.body }),
      }
      state.draftRefs.set(input.draftId, decided)
      const conversation = state.conversations.get(stored.conversationId)
      if (conversation?.organizationId === organizationId) {
        const pending = Math.max(0, conversation.pendingDraftCount - 1)
        state.conversations.set(conversation.id, {
          ...conversation,
          pendingDraftCount: pending,
          state:
            pending === 0 &&
            conversation.state === 'awaiting_approval' &&
            conversation.controller === 'agent'
              ? 'agent'
              : conversation.state,
        })
      }
      return toDraftRecord(decided)
    },

    insertRepDraft: async (input) => {
      requireLock()
      const state = write()
      const conversation = state.conversations.get(input.conversationId)
      if (conversation?.organizationId !== organizationId) {
        throw new Error('The Draft names a Conversation that does not exist')
      }
      const stored = {
        id: input.id,
        conversationId: input.conversationId,
        author: 'rep' as const,
        authorMembershipId: input.membershipId,
        organizationId,
        status: 'approved' as const,
        decidedAt: input.now,
        createdAt: input.now,
        body: input.body,
        checks: [],
        hold: null,
      }
      state.draftRefs.set(input.id, stored)
      return toDraftRecord(stored)
    },

    hasReleasedReply: async (conversationId) => {
      const { messages, draftRefs } = read()
      return (
        messages.some(
          (m) =>
            m.organizationId === organizationId &&
            m.conversationId === conversationId &&
            m.direction === 'outbound'
        ) ||
        [...draftRefs.values()].some(
          (d) =>
            d.organizationId === organizationId &&
            d.conversationId === conversationId &&
            (d.status === 'approved' || d.status === 'sent')
        )
      )
    },

    insertDecision: async (input) => {
      requireLock()
      const { editedBodySha256, ...rest } = input
      write().decisions = [...write().decisions, { ...rest, editedBodySha256, organizationId }]
    },

    listDecisions: async (request) => {
      const allowed = mayOwn(read(), organizationId, request.visibility)
      const compare = (
        a: { decidedAt: Date; id: DecisionId },
        b: { decidedAt: Date; id: DecisionId }
      ) => b.decidedAt.getTime() - a.decidedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      return read()
        .decisions.filter((d) => {
          const conversation = read().conversations.get(d.conversationId)
          return (
            d.organizationId === organizationId &&
            conversation?.organizationId === organizationId &&
            allowed(live(conversation).ownerMembershipId) &&
            (request.conversationId === undefined || d.conversationId === request.conversationId) &&
            (request.draftId === undefined || d.draftId === request.draftId) &&
            (request.kind === undefined || d.kind === request.kind) &&
            (request.from === undefined || d.decidedAt >= request.from) &&
            (request.to === undefined || d.decidedAt <= request.to)
          )
        })
        .sort(compare)
        .filter(
          (d) =>
            request.after === undefined ||
            compare(d, { decidedAt: request.after.decidedAt, id: request.after.id }) > 0
        )
        .slice(0, request.limit)
        .map(({ organizationId: _organizationId, editedBodySha256: _hash, ...record }) => record)
    },

    getApprovalPolicy: async (channel) => {
      const found = read().approvalPolicies.get(policyKey(organizationId, channel))
      return found ? strip(found) : null
    },

    listApprovalPolicies: async () =>
      [...read().approvalPolicies.values()]
        .filter((p) => p.organizationId === organizationId)
        .map(strip),

    upsertApprovalPolicy: async (input) => {
      requireLock()
      const record: ApprovalPolicyRecord = {
        channel: input.channel,
        rule: input.rule,
        updatedAt: input.now,
        updatedByMembershipId: input.membershipId,
      }
      write().approvalPolicies.set(policyKey(organizationId, input.channel), {
        ...record,
        organizationId,
      })
      return record
    },

    listMessages: async (request) => {
      const after = request.after
      return read()
        .messages.filter(
          (m) =>
            m.organizationId === organizationId &&
            m.conversationId === request.conversationId &&
            (after === undefined ||
              m.sentAt.getTime() > after.sentAt.getTime() ||
              (m.sentAt.getTime() === after.sentAt.getTime() && m.id > after.id))
        )
        .sort(
          (a, b) =>
            a.sentAt.getTime() - b.sentAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        )
        .slice(0, request.limit)
        .map(strip)
    },
  }
}

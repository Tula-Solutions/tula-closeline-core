import type {
  ConversationId,
  DraftId,
  MembershipId,
  MessageId,
  ProspectId,
} from 'tula-closeline-contract'
import type { ProspectVisibility } from './core-store'

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

/** What a stored Draft tells the ingest: who wrote it, which Conversation it belongs to. */
export type DraftRef = {
  id: DraftId
  conversationId: ConversationId
  author: 'agent' | 'rep'
  authorMembershipId: MembershipId | null
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
  /** Creates a Conversation in the default state: Agent in control. */
  insertConversation(input: NewConversation): Promise<ConversationRecord>
  /** Appends a Message and moves its Conversation's latest activity forward, never back. */
  insertMessage(input: NewMessage): Promise<MessageRecord>
  /** One Conversation the visibility allows, or `null`. */
  getConversation(
    id: ConversationId,
    visibility: ProspectVisibility
  ): Promise<ConversationRecord | null>
  /** Conversations the visibility allows, latest activity first, at most `limit`. */
  listConversations(request: ConversationPageRequest): Promise<ConversationRecord[]>
  /** Messages of a Conversation, oldest first, those after the position when given, at most `limit`. */
  listMessages(request: {
    conversationId: ConversationId
    after?: { sentAt: Date; id: MessageId }
    limit: number
  }): Promise<MessageRecord[]>
}

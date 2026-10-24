import type { ConversationId, DraftId, OrganizationId } from 'tula-closeline-contract'
import type { ConversationRecord, DraftRef, InboxScope, MessageRecord } from '~/ports/inbox-store'
import { mayOwn, type ProspectStateView } from './prospect-state'

/** What the in-memory store keeps for the inbox: Conversations, Messages and Draft references. */
export type InboxState = {
  /** Keyed by Conversation id; the Organization is on the record kept beside it. */
  conversations: Map<ConversationId, ConversationRecord & { organizationId: OrganizationId }>
  /** In append order; replaced, never changed in place, by a write. */
  messages: (MessageRecord & { organizationId: OrganizationId })[]
  /** Drafts planted by a test until the Draft routes exist. */
  draftRefs: Map<DraftId, DraftRef & { organizationId: OrganizationId }>
}

/** An empty {@link InboxState}. */
export function emptyInboxState(): InboxState {
  return { conversations: new Map(), messages: [], draftRefs: new Map() }
}

/** A copy of the shells of the collections, for a transaction's first write. */
export function copyInboxState(state: InboxState): InboxState {
  return {
    conversations: new Map(state.conversations),
    messages: [...state.messages],
    draftRefs: new Map(state.draftRefs),
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
}

const strip = <T extends { organizationId: OrganizationId }>({
  organizationId: _organizationId,
  ...record
}: T): Omit<T, 'organizationId'> => record

/** Orders by latest activity, newest first, then by id descending. */
const newestFirst = (a: ConversationRecord, b: ConversationRecord): number =>
  b.lastMessageAt.getTime() - a.lastMessageAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Builds the inbox methods of one transaction's scope, with the database's own rules. */
export function createInboxScope(env: {
  organizationId: OrganizationId
  read: () => InboxState & ProspectStateView
  write: () => InboxState
  requireLock: () => void
}): InboxScope {
  const { organizationId, read, write, requireLock } = env

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
      return found?.organizationId === organizationId ? strip(found) : null
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
      const found = read().conversations.get(id)
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

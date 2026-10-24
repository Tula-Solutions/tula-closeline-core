import {
  type Conversation,
  type ConversationId,
  conversationCursorSchema,
  type correctClassificationRequestSchema,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  INBOX_ERRORS,
  type IngestMessageRequest,
  type ingestMessageResultSchema,
  type ListConversationsQuery,
  type listMessagesQuerySchema,
  type Message,
  type MessageId,
  messageCursorSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { visibilityOf } from '~/modules/prospect/service'
import type { OrganizationScope } from '~/ports/core-store'
import type { ConversationRecord, MessageClassification } from '~/ports/inbox-store'
import { recordClassification } from './classify'
import { DRAFTED_LABELS, publishInboxJob } from './jobs'
import { toConversationResponse, toMessageResponse } from './schema'

/** The answer to an ingest. */
type IngestMessageResult = z.infer<typeof ingestMessageResultSchema>

/** The query of a Message list. */
type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>

/** What the inbox service needs from the container. */
export type InboxDeps = Pick<Container, 'store' | 'clock' | 'jobs'>

/** One page of a list. */
export type Page<T> = { items: T[]; nextCursor: string | null }

const conversationNotFound = () => domainError(INBOX_ERRORS['inbox.conversation_not_found'])

/**
 * Stores one Message a channel service reports, for the Organization it states, in one
 * transaction under the Organization lock. The Prospect must belong to that Organization
 * (otherwise `inbox.prospect_not_found`, and nothing is stored). A repeat of a channel and
 * provider message id answers the stored Message with `created: false` and stores nothing. The
 * Conversation of the Prospect and channel is found, or created with the Prospect's owner and the
 * Agent in control. An outbound Message that names a Draft must name one of that Conversation.
 * The body is never logged and never put in an error. An inbound Message that carries no label
 * yet gets one classify job published after the commit, a repeat of the ingest included, so a
 * queue that refused the job (`server.unavailable`, the Message is stored) is recovered by
 * posting the same Message again.
 */
export async function ingestMessage(
  deps: InboxDeps,
  organizationId: OrganizationId,
  request: IngestMessageRequest,
  options: { traceId: string } = { traceId: crypto.randomUUID() }
): Promise<IngestMessageResult> {
  const now = deps.clock.now()
  let toClassify: MessageId | null = null
  const result = await deps.store.withOrganization(organizationId, async (scope) => {
    toClassify = null
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      throw domainError(INBOX_ERRORS['inbox.prospect_not_found'])
    }
    const prospect = await scope.getProspect(request.prospectId, { kind: 'all' })
    if (!prospect) {
      throw domainError(INBOX_ERRORS['inbox.prospect_not_found'])
    }
    const repeat = await scope.findMessageByProviderId(request.channel, request.providerMessageId)
    if (repeat) {
      toClassify =
        repeat.direction === 'inbound' && repeat.classification === null ? repeat.id : null
      return { message: toMessageResponse(repeat), created: false }
    }
    // The author of an outbound Message is the Draft's author, or the Agent when there is no Draft.
    const inbound = request.direction === 'inbound'
    const draft = request.draftId === undefined ? null : await scope.findDraftRef(request.draftId)
    if (request.draftId !== undefined && (inbound || !draft)) {
      throw domainError(ERRORS['request.invalid'])
    }
    const sentAt = new Date(request.sentAt)
    const existing = await scope.findConversationOfProspect(request.prospectId, request.channel)
    if (draft && existing?.id !== draft.conversationId) {
      throw domainError(ERRORS['request.invalid'])
    }
    const conversation =
      existing ??
      (await scope.insertConversation({
        id: formatId('cnv', crypto.randomUUID()),
        prospectId: request.prospectId,
        channel: request.channel,
        ownerMembershipId: prospect.ownerMembershipId,
        now,
        lastMessageAt: sentAt,
      }))
    const author = inbound
      ? { authorKind: 'prospect' as const, authorMembershipId: null }
      : draft
        ? { authorKind: draft.author, authorMembershipId: draft.authorMembershipId }
        : { authorKind: 'agent' as const, authorMembershipId: null }
    const stored = await scope.insertMessage({
      id: formatId('msg', crypto.randomUUID()),
      conversationId: conversation.id,
      channel: request.channel,
      direction: request.direction,
      ...author,
      providerMessageId: request.providerMessageId,
      draftId: request.draftId ?? null,
      body: request.body,
      sentAt,
    })
    toClassify = inbound ? stored.id : null
    return { message: toMessageResponse(stored), created: true }
  })
  if (toClassify !== null) {
    await publishInboxJob(
      deps,
      'inbox.classify_message',
      organizationId,
      toClassify,
      options.traceId
    )
  }
  return result
}

/** Reads a Conversation the caller may see, or throws `inbox.conversation_not_found`. */
async function visibleConversation(
  scope: OrganizationScope,
  caller: Caller,
  id: ConversationId
): Promise<ConversationRecord> {
  const { visibility } = await visibilityOf(scope, caller)
  const found = await scope.getConversation(id, visibility)
  if (!found) {
    throw conversationNotFound()
  }
  return found
}

/**
 * Lists the Conversations the caller may see, latest activity first, one page at a time (at most
 * 100). A Rep sees those they own, a Manager those of their Team, an Admin and Owner all. Filters
 * only narrow that. Any role.
 */
export async function listConversations(
  deps: Pick<InboxDeps, 'store'>,
  caller: Caller,
  query: ListConversationsQuery
): Promise<Page<Conversation>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, conversationCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.list')
    const { visibility } = await visibilityOf(scope, caller)
    const rows = await scope.listConversations({
      visibility,
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.controller === undefined ? {} : { controller: query.controller }),
      ...(query.label === undefined ? {} : { label: query.label }),
      ...(query.prospectId === undefined ? {} : { prospectId: query.prospectId }),
      ...(after === undefined
        ? {}
        : { after: { lastMessageAt: new Date(after.lastMessageAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toConversationResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ lastMessageAt: last.lastMessageAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/** Reads one Conversation the caller may see; any other is `inbox.conversation_not_found`. Any role. */
export async function getConversation(
  deps: Pick<InboxDeps, 'store'>,
  caller: Caller,
  id: ConversationId
): Promise<Conversation> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.read')
    return toConversationResponse(await visibleConversation(scope, caller, id))
  })
}

/**
 * Lists the Messages of a Conversation the caller may see, oldest first, one page at a time (at
 * most 100). A Conversation the caller may not see is `inbox.conversation_not_found`. Any role.
 */
export async function listMessages(
  deps: Pick<InboxDeps, 'store'>,
  caller: Caller,
  id: ConversationId,
  query: ListMessagesQuery
): Promise<Page<Message>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, messageCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.read')
    await visibleConversation(scope, caller, id)
    const rows = await scope.listMessages({
      conversationId: id,
      ...(after === undefined ? {} : { after: { sentAt: new Date(after.sentAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toMessageResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ sentAt: last.sentAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/**
 * Corrects the label of an inbound Message to a label of the closed set, for any role, on a
 * Conversation the caller may see (otherwise `inbox.conversation_not_found`, also for another
 * Organization's). A Message that is not in that Conversation is `inbox.message_not_found`, an
 * outbound one `inbox.message_not_inbound`. The correction replaces the model's label and is
 * recorded with the Membership that made it and when. A repeat with the label already held
 * changes nothing and publishes nothing. A change publishes `reply.classified`, and one to
 * `unsubscribe` or `bounce` stops the Conversation (pending Drafts voided, Conversation closed) in
 * the same transaction. A correction away from them does not reopen anything.
 */
export async function correctClassification(
  deps: Pick<InboxDeps, 'store' | 'clock' | 'jobs'>,
  caller: Caller,
  ids: { conversationId: ConversationId; messageId: MessageId },
  request: z.infer<typeof correctClassificationRequestSchema>,
  options: { traceId: string } = { traceId: crypto.randomUUID() }
): Promise<Message> {
  const now = deps.clock.now()
  const corrected = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.correct')
    await visibleConversation(scope, caller, ids.conversationId)
    const message = await scope.getMessage(ids.messageId)
    if (!message || message.conversationId !== ids.conversationId) {
      throw domainError(INBOX_ERRORS['inbox.message_not_found'])
    }
    if (message.direction !== 'inbound') {
      throw domainError(INBOX_ERRORS['inbox.message_not_inbound'])
    }
    if (message.classification?.label === request.label) {
      return toMessageResponse(message)
    }
    const classification: MessageClassification = {
      label: request.label,
      confidence: 1,
      decidedBy: 'rep',
      correctedByMembershipId: membershipId,
      classifiedAt: now,
    }
    const stored = await scope.saveClassification({
      messageId: message.id,
      classification,
      onlyIfUnclassified: false,
    })
    if (!stored) {
      throw domainError(INBOX_ERRORS['inbox.message_not_found'])
    }
    await recordClassification(scope, {
      organizationId: caller.organizationId,
      traceId: options.traceId,
      now,
      message: stored,
      classification,
      eventId: `reply.classified:${stored.id}:${crypto.randomUUID()}`,
    })
    return toMessageResponse(stored)
  })
  if (DRAFTED_LABELS.includes(request.label)) {
    // After the label is stored: a refused publish fails this call, and the same correction sent again queues it (it is idempotent).
    await publishInboxJob(
      deps,
      'inbox.draft_reply',
      caller.organizationId,
      ids.messageId,
      options.traceId
    )
  }
  return corrected
}

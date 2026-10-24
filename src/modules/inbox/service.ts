import {
  type Conversation,
  type ConversationId,
  conversationCursorSchema,
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
  messageCursorSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization } from '~/modules/organization/access'
import { visibilityOf } from '~/modules/prospect/service'
import type { OrganizationScope } from '~/ports/core-store'
import type { ConversationRecord } from '~/ports/inbox-store'
import { toConversationResponse, toMessageResponse } from './schema'

/** The answer to an ingest. */
type IngestMessageResult = z.infer<typeof ingestMessageResultSchema>

/** The query of a Message list. */
type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>

/** What the inbox service needs from the container. */
export type InboxDeps = Pick<Container, 'store' | 'clock'>

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
 * The body is never logged and never put in an error.
 */
export async function ingestMessage(
  deps: InboxDeps,
  organizationId: OrganizationId,
  request: IngestMessageRequest
): Promise<IngestMessageResult> {
  const now = deps.clock.now()
  return deps.store.withOrganization(organizationId, async (scope) => {
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
    return { message: toMessageResponse(stored), created: true }
  })
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

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  conversationIdSchema,
  draftIdSchema,
  membershipIdSchema,
  messageIdSchema,
  type OrganizationId,
  prospectIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { conversations, drafts, messages } from 'tula-closeline-db/schema'
import type { InboxScope, MessageRecord } from '~/ports/inbox-store'
import { visibilityCondition } from './prospect-store'

const toConversation = (row: typeof conversations.$inferSelect) => ({
  id: conversationIdSchema.parse(row.id),
  prospectId: prospectIdSchema.parse(row.prospectId),
  channel: row.channel,
  controller: row.controller,
  controllerMembershipId:
    row.controllerMembershipId === null
      ? null
      : membershipIdSchema.parse(row.controllerMembershipId),
  state: row.state,
  ownerMembershipId:
    row.ownerMembershipId === null ? null : membershipIdSchema.parse(row.ownerMembershipId),
  latestLabel: row.latestLabel,
  pendingDraftCount: row.pendingDraftCount,
  lastMessageAt: row.lastMessageAt,
  createdAt: row.createdAt,
})

const toMessage = (row: typeof messages.$inferSelect): MessageRecord => ({
  id: messageIdSchema.parse(row.id),
  conversationId: conversationIdSchema.parse(row.conversationId),
  channel: row.channel,
  direction: row.direction,
  authorKind: row.authorKind,
  authorMembershipId:
    row.authorMembershipId === null ? null : membershipIdSchema.parse(row.authorMembershipId),
  providerMessageId: row.providerMessageId,
  draftId: row.draftId === null ? null : draftIdSchema.parse(row.draftId),
  body: row.body,
  sentAt: row.sentAt,
  classification:
    row.classificationLabel === null ||
    row.classificationConfidence === null ||
    row.classificationDecidedBy === null ||
    row.classifiedAt === null
      ? null
      : {
          label: row.classificationLabel,
          confidence: row.classificationConfidence,
          decidedBy: row.classificationDecidedBy,
          correctedByMembershipId:
            row.classificationCorrectedByMembershipId === null
              ? null
              : membershipIdSchema.parse(row.classificationCorrectedByMembershipId),
          classifiedAt: row.classifiedAt,
        },
})

/** The Postgres inbox methods of one Organization's transaction. */
export function createInboxStore(tx: Transaction, organizationId: OrganizationId): InboxScope {
  const mine = (id: string) =>
    and(eq(conversations.organizationId, organizationId), eq(conversations.id, id))

  return {
    findMessageByProviderId: async (channel, providerMessageId) => {
      const [row] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.channel, channel),
            eq(messages.providerMessageId, providerMessageId)
          )
        )
        .limit(1)
      return row ? toMessage(row) : null
    },

    findConversationOfProspect: async (prospectId, channel) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.prospectId, prospectId),
            eq(conversations.channel, channel)
          )
        )
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(1)
      return row ? toConversation(row) : null
    },

    findDraftRef: async (draftId) => {
      const [row] = await tx
        .select({
          id: drafts.id,
          conversationId: drafts.conversationId,
          author: drafts.author,
          authorMembershipId: drafts.authorMembershipId,
        })
        .from(drafts)
        .where(and(eq(drafts.organizationId, organizationId), eq(drafts.id, draftId)))
        .limit(1)
      return row
        ? {
            id: draftIdSchema.parse(row.id),
            conversationId: conversationIdSchema.parse(row.conversationId),
            author: row.author,
            authorMembershipId:
              row.authorMembershipId === null
                ? null
                : membershipIdSchema.parse(row.authorMembershipId),
          }
        : null
    },

    insertConversation: async (input) => {
      const [row] = await tx
        .insert(conversations)
        .values({
          id: input.id,
          organizationId,
          prospectId: input.prospectId,
          channel: input.channel,
          ownerMembershipId: input.ownerMembershipId,
          lastMessageAt: input.lastMessageAt,
          createdAt: input.now,
        })
        .returning()
      if (!row) {
        throw new Error('The Conversation was not stored')
      }
      return toConversation(row)
    },

    insertMessage: async (input) => {
      const [row] = await tx
        .insert(messages)
        .values({
          id: input.id,
          organizationId,
          conversationId: input.conversationId,
          channel: input.channel,
          direction: input.direction,
          authorKind: input.authorKind,
          authorMembershipId: input.authorMembershipId,
          providerMessageId: input.providerMessageId,
          draftId: input.draftId,
          body: input.body,
          sentAt: input.sentAt,
        })
        .returning()
      if (!row) {
        throw new Error('The Message was not stored')
      }
      // Latest activity only moves forward; a newer inbound Message is not yet labelled.
      await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${input.sentAt.toISOString()}::timestamptz)`,
          ...(input.direction === 'inbound'
            ? {
                latestLabel: sql`case when ${input.sentAt.toISOString()}::timestamptz >= ${conversations.lastMessageAt} then null else ${conversations.latestLabel} end`,
              }
            : {}),
        })
        .where(mine(input.conversationId))
      return toMessage(row)
    },

    getConversation: async (id, visibility) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            mine(id),
            visibilityCondition(organizationId, visibility, conversations.ownerMembershipId)
          )
        )
        .limit(1)
      return row ? toConversation(row) : null
    },

    listConversations: async (request) => {
      const rows = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            visibilityCondition(
              organizationId,
              request.visibility,
              conversations.ownerMembershipId
            ),
            request.channel === undefined ? undefined : eq(conversations.channel, request.channel),
            request.state === undefined ? undefined : eq(conversations.state, request.state),
            request.controller === undefined
              ? undefined
              : eq(conversations.controller, request.controller),
            request.label === undefined ? undefined : eq(conversations.latestLabel, request.label),
            request.prospectId === undefined
              ? undefined
              : eq(conversations.prospectId, request.prospectId),
            request.after === undefined
              ? undefined
              : sql`(${conversations.lastMessageAt}, ${conversations.id}) < (${request.after.lastMessageAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
        .limit(request.limit)
      return rows.map(toConversation)
    },

    listMessages: async (request) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.conversationId, request.conversationId),
            request.after === undefined
              ? undefined
              : sql`(${messages.sentAt}, ${messages.id}) > (${request.after.sentAt.toISOString()}::timestamptz, ${request.after.id})`
          )
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(request.limit)
      return rows.map(toMessage)
    },
  }
}

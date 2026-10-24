import { type Conversation, type Message, organizationIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { ConversationRecord, MessageRecord } from '~/ports/inbox-store'

/** The header a channel service names the Organization in, as ADR 0013's shared-secret caller does. */
export const ORGANIZATION_HEADER = 'x-organization-id'

/** The `X-Organization-Id` header of an ingest call. */
export const organizationHeaderSchema = z.object({ [ORGANIZATION_HEADER]: organizationIdSchema })

/** A stored Conversation as the contract's Conversation. */
export function toConversationResponse(record: ConversationRecord): Conversation {
  return {
    id: record.id,
    prospectId: record.prospectId,
    channel: record.channel,
    controller: record.controller,
    controllerMembershipId: record.controllerMembershipId,
    state: record.state,
    ownerMembershipId: record.ownerMembershipId,
    latestLabel: record.latestLabel,
    pendingDraftCount: record.pendingDraftCount,
    lastMessageAt: record.lastMessageAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  }
}

/** A stored Message as the contract's Message. */
export function toMessageResponse(record: MessageRecord): Message {
  return {
    id: record.id,
    conversationId: record.conversationId,
    direction: record.direction,
    authorKind: record.authorKind,
    authorMembershipId: record.authorMembershipId,
    providerMessageId: record.providerMessageId,
    draftId: record.draftId,
    body: record.body,
    sentAt: record.sentAt.toISOString(),
    classification: record.classification
      ? {
          label: record.classification.label,
          confidence: record.classification.confidence,
          decidedBy: record.classification.decidedBy,
          correctedByMembershipId: record.classification.correctedByMembershipId,
          classifiedAt: record.classification.classifiedAt.toISOString(),
        }
      : null,
  }
}

import type {
  ConversationId,
  MembershipId,
  MessageId,
  OrganizationId,
} from 'tula-closeline-contract'
import type { EscalationTrigger } from './inbox-store'

/**
 * What a Rep is told when something happens in a Conversation they control. It names ids and a
 * fixed sentence; it never carries a Message body, so no adapter can leak one.
 */
export type RepNotice =
  | {
      kind: 'reply_during_takeover'
      organizationId: OrganizationId
      membershipId: MembershipId
      conversationId: ConversationId
      messageId: MessageId
      /** A fixed sentence chosen by core, never derived from a Message. */
      text: string
    }
  | {
      kind: 'conversation_escalated'
      organizationId: OrganizationId
      membershipId: MembershipId
      conversationId: ConversationId
      /** The Rep's address, for the mail adapter only; adapters must not log it. */
      email: string
      /** The rule trigger that escalated the Conversation. */
      trigger: EscalationTrigger
      /** A fixed sentence chosen by core, never derived from a Message. */
      text: string
    }

/** Tells a Rep something happened; throws when the notice could not be handed over. */
export interface RepNotifier {
  /** Hands the notice over; aborts when `signal` does. */
  notify(notice: RepNotice, signal: AbortSignal): Promise<void>
}

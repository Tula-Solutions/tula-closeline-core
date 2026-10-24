import {
  type Conversation,
  type ConversationId,
  conversationSchema,
  type DecisionId,
  formatId,
  INBOX_ERRORS,
} from 'tula-closeline-contract'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganizationForWrite } from '~/modules/organization/access'
import {
  conversationHandedBackEvent,
  conversationTakenOverEvent,
  enqueueEvents,
} from '~/modules/prospect/events'
import type { ApprovalDeps } from './approval'
import { toConversationResponse } from './schema'
import { visibleConversation } from './service'

type KeyedOptions = { idempotencyKey: string | undefined; traceId: string }

const newDecisionId = (): DecisionId => formatId('dcs', crypto.randomUUID()) as DecisionId

/**
 * Gives a Conversation to the calling Rep in one step. A Rep may take over a Conversation of
 * their own Prospect, a Manager one of their Team, an Admin and Owner any; one the caller may not
 * see (or of another Organization) is `inbox.conversation_not_found`. Taking over what the caller
 * already controls answers the Conversation again and records and publishes nothing more. A
 * closed Conversation is `inbox.conversation_closed`, one another person controls
 * `inbox.already_controlled`. Every pending Draft is voided, a `takeover` Decision is recorded and
 * `conversation.taken_over` (ids and the voided count, no text) is written to the outbox in the
 * same transaction. The Idempotency-Key makes a retry answer the first answer.
 */
export async function takeOverConversation(
  deps: ApprovalDeps,
  caller: Caller,
  conversationId: ConversationId,
  options: KeyedOptions
): Promise<IdempotentAnswer<200, Conversation>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'conversations.takeover',
        request: { params: { conversationId } },
        status: 200,
        response: conversationSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.reply')
        const conversation = await visibleConversation(scope, caller, conversationId)
        if (
          conversation.controller === 'rep' &&
          conversation.controllerMembershipId === membershipId
        ) {
          return toConversationResponse(conversation)
        }
        if (conversation.state === 'closed') {
          throw domainError(INBOX_ERRORS['inbox.conversation_closed'])
        }
        if (conversation.controller === 'rep') {
          throw domainError(INBOX_ERRORS['inbox.already_controlled'])
        }
        const { voidedDraftCount } = await scope.takeOverConversation({
          conversationId,
          membershipId,
          now,
        })
        const decisionId = newDecisionId()
        await scope.insertDecision({
          id: decisionId,
          conversationId,
          draftId: null,
          kind: 'takeover',
          decidedByMembershipId: membershipId,
          note: null,
          editedBodySha256: null,
          acknowledgedUngrounded: false,
          decidedAt: now,
        })
        await enqueueEvents(scope, caller.organizationId, options.traceId, [
          conversationTakenOverEvent(decisionId, {
            conversationId,
            prospectId: conversation.prospectId,
            channel: conversation.channel,
            takenOverByMembershipId: membershipId,
            voidedDraftCount,
            takenOverAt: now.toISOString(),
          }),
        ])
        const updated = await scope.getConversation(conversationId, { kind: 'all' })
        return toConversationResponse(updated ?? conversation)
      }
    )
  )
}

/**
 * Returns a Conversation to the Agent. Only the Rep who took it over, or an Admin or Owner, may
 * (`inbox.not_conversation_owner` for anyone else); one the Agent already handles is
 * `inbox.not_taken_over`, one the caller may not see `inbox.conversation_not_found`. A
 * `hand_back` Decision is recorded and `conversation.handed_back` (ids only) is written to the
 * outbox in the same transaction. New replies are classified and drafted again from then on. The
 * Idempotency-Key makes a retry answer the first answer and publish once.
 */
export async function handBackConversation(
  deps: ApprovalDeps,
  caller: Caller,
  conversationId: ConversationId,
  options: KeyedOptions
): Promise<IdempotentAnswer<200, Conversation>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'conversations.handback',
        request: { params: { conversationId } },
        status: 200,
        response: conversationSchema,
      },
      async () => {
        const { membershipId, role } = await openOrganizationForWrite(scope, caller, 'inbox.reply')
        const conversation = await visibleConversation(scope, caller, conversationId)
        if (conversation.controller !== 'rep') {
          throw domainError(INBOX_ERRORS['inbox.not_taken_over'])
        }
        const mayHandBack =
          conversation.controllerMembershipId === membershipId ||
          role === 'admin' ||
          role === 'owner'
        if (!mayHandBack) {
          throw domainError(INBOX_ERRORS['inbox.not_conversation_owner'])
        }
        await scope.handBackConversation(conversationId)
        const decisionId = newDecisionId()
        await scope.insertDecision({
          id: decisionId,
          conversationId,
          draftId: null,
          kind: 'hand_back',
          decidedByMembershipId: membershipId,
          note: null,
          editedBodySha256: null,
          acknowledgedUngrounded: false,
          decidedAt: now,
        })
        await enqueueEvents(scope, caller.organizationId, options.traceId, [
          conversationHandedBackEvent(decisionId, {
            conversationId,
            prospectId: conversation.prospectId,
            channel: conversation.channel,
            handedBackByMembershipId: membershipId,
            handedBackAt: now.toISOString(),
          }),
        ])
        const updated = await scope.getConversation(conversationId, { kind: 'all' })
        return toConversationResponse(updated ?? conversation)
      }
    )
  )
}

import { createHash } from 'node:crypto'
import {
  AGENT_ERRORS,
  type ApprovalPolicy,
  type ApprovalQueueItem,
  type ApprovalRule,
  type ApproveDraftRequest,
  approvalQueueCursorSchema,
  type ConversationId,
  type Decision,
  type DecisionId,
  type Draft,
  type DraftId,
  decisionCursorSchema,
  decodeCursor,
  draftSchema,
  type draftSourcesSchema,
  ERRORS,
  encodeCursor,
  formatId,
  INBOX_ERRORS,
  type InboxChannel,
  type listApprovalQueueQuerySchema,
  type listDecisionsQuerySchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import { backoffDelayMs, rest } from '~/backoff'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { releaseGate } from '~/modules/agent-control/gate'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { enqueueEvents, messageApprovedEvent } from '~/modules/prospect/events'
import { visibilityOf } from '~/modules/prospect/service'
import { hashAddress } from '~/modules/suppression/address'
import type { OrganizationScope } from '~/ports/core-store'
import type {
  ApprovalPolicyRecord,
  ConversationRecord,
  DecisionRecord,
  DraftRecord,
} from '~/ports/inbox-store'
import { type InboxDeps, type Page, visibleConversation } from './service'

/** What the approval routes need from the container. */
export type ApprovalDeps = Pick<InboxDeps, 'store' | 'clock'> &
  Pick<Container, 'logger' | 'env' | 'moments'>

/** The rule a channel follows until an Admin sets one: every Draft waits for a person. */
export const DEFAULT_APPROVAL_RULE: ApprovalRule = { mode: 'always' }

/** How many times the Playbook is asked for passages before giving up. */
const PASSAGES_ATTEMPTS = 3

/** The jittered rest between those attempts. */
const PASSAGES_BACKOFF = { baseMs: 50, capMs: 400 }

/** How long one Playbook attempt may take to resolve the passages of a Draft's Sources. */
const PASSAGES_TIMEOUT_MS = 8_000

type KeyedOptions = { idempotencyKey: string | undefined; traceId: string }

/** A stored Draft as the contract's Draft. */
export function toDraftResponse(record: DraftRecord): Draft {
  return {
    id: record.id,
    conversationId: record.conversationId,
    author: record.author,
    authorMembershipId: record.authorMembershipId,
    body: record.body,
    reason:
      record.reason === null
        ? null
        : {
            triggerMessageId: record.reason.triggerMessageId,
            label: record.reason.label,
            strategy: record.reason.strategy,
          },
    sources: record.sources.map((source) => ({ ...source })),
    confidence: record.confidence,
    ungrounded: record.ungrounded,
    checks: record.checks.map((check) => ({ ...check })),
    hold: record.hold,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    decidedAt: record.decidedAt?.toISOString() ?? null,
  }
}

const toDecisionResponse = (record: DecisionRecord): Decision => ({
  id: record.id,
  conversationId: record.conversationId,
  draftId: record.draftId,
  kind: record.kind,
  decidedByMembershipId: record.decidedByMembershipId,
  note: record.note,
  acknowledgedUngrounded: record.acknowledgedUngrounded,
  decidedAt: record.decidedAt.toISOString(),
})

const toPolicyResponse = (record: ApprovalPolicyRecord): ApprovalPolicy => ({
  channel: record.channel,
  rule: record.rule,
  updatedAt: record.updatedAt.toISOString(),
  updatedByMembershipId: record.updatedByMembershipId,
})

/** The SHA-256, as lowercase hex, of an edited body: all the Decision keeps of it. */
export const bodyDigest = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex')

/** A Draft whose Conversation the caller may see, or `inbox.draft_not_found` (never 403) for any other. */
async function visibleDraft(
  scope: OrganizationScope,
  caller: Caller,
  draftId: DraftId
): Promise<{ draft: DraftRecord; conversation: ConversationRecord }> {
  const draft = await scope.getDraft(draftId)
  const notFound = () => domainError(INBOX_ERRORS['inbox.draft_not_found'])
  if (!draft) {
    throw notFound()
  }
  const { visibility } = await visibilityOf(scope, caller)
  const conversation = await scope.getConversation(draft.conversationId, visibility)
  if (!conversation) {
    throw notFound()
  }
  return { draft, conversation }
}

/** True when the Prospect's address on the Conversation's channel is on the Suppression list. */
export async function isSuppressed(
  env: Pick<ApprovalDeps['env'], 'CONSENT_HASH_KEY'>,
  scope: OrganizationScope,
  organizationId: OrganizationId,
  conversation: ConversationRecord
): Promise<boolean> {
  const kind =
    conversation.channel === 'email'
      ? 'email'
      : conversation.channel === 'linkedin'
        ? 'linkedin'
        : null
  if (kind === null) {
    return false
  }
  const address = await scope.getProspectIdentity(conversation.prospectId, kind)
  if (address === null) {
    return false
  }
  const hash = hashAddress(env.CONSENT_HASH_KEY, organizationId, kind, address)
  return (await scope.findLiveSuppression(kind, [hash])).length > 0
}

/** Refuses a send to a Prospect whose address on the Conversation's channel is on the Suppression list. */
async function refuseSuppressed(
  deps: Pick<ApprovalDeps, 'env'>,
  scope: OrganizationScope,
  organizationId: OrganizationId,
  conversation: ConversationRecord
): Promise<void> {
  if (await isSuppressed(deps.env, scope, organizationId, conversation)) {
    throw domainError(INBOX_ERRORS['inbox.prospect_suppressed'])
  }
}

const newDecisionId = (): DecisionId => formatId('dcs', crypto.randomUUID()) as DecisionId

/**
 * Approves a pending Draft, or approves it with the caller's own wording (`body`), for any role
 * that may see its Conversation (any other Draft is `inbox.draft_not_found`). One that is no
 * longer pending is `inbox.draft_not_pending`; an ungrounded one needs `acknowledgeUngrounded`
 * (`inbox.draft_ungrounded`); a Prospect on the Suppression list is `inbox.prospect_suppressed`
 * and a closed Conversation `inbox.conversation_closed`. The decision is one statement that only
 * matches a pending Draft, so of two concurrent approvals exactly one wins, records the Decision
 * (who, when, the SHA-256 of an edit, never its text) and publishes one `message.approved`. The
 * Idempotency-Key makes a retry answer the first answer.
 */
export async function approveDraft(
  deps: ApprovalDeps,
  caller: Caller,
  draftId: DraftId,
  request: ApproveDraftRequest,
  options: KeyedOptions
): Promise<IdempotentAnswer<200, Draft>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'drafts.approve',
        request: { params: { draftId }, body: request },
        status: 200,
        response: draftSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.approve')
        const { draft, conversation } = await visibleDraft(scope, caller, draftId)
        if (draft.status !== 'pending') {
          throw domainError(INBOX_ERRORS['inbox.draft_not_pending'])
        }
        if (draft.ungrounded && !request.acknowledgeUngrounded) {
          throw domainError(INBOX_ERRORS['inbox.draft_ungrounded'])
        }
        if (conversation.state === 'closed') {
          throw domainError(INBOX_ERRORS['inbox.conversation_closed'])
        }
        if (conversation.controller !== 'agent') {
          throw domainError(INBOX_ERRORS['inbox.takeover_required'])
        }
        await refuseSuppressed(deps, scope, caller.organizationId, conversation)
        const gate = await releaseGate(scope, conversation.channel, now)
        if (gate !== 'open') {
          // Nothing is decided: the Draft stays pending and can be approved when the gate opens.
          throw domainError(
            gate === 'paused' ? AGENT_ERRORS['agent.paused'] : AGENT_ERRORS['agent.outside_hours']
          )
        }
        const edited = request.body !== undefined
        const decided = await scope.decidePendingDraft({
          draftId,
          status: 'approved',
          ...(edited ? { body: request.body } : {}),
          now,
        })
        if (!decided) {
          throw domainError(INBOX_ERRORS['inbox.draft_not_pending'])
        }
        const acknowledgedUngrounded = draft.ungrounded && request.acknowledgeUngrounded
        await scope.insertDecision({
          id: newDecisionId(),
          conversationId: conversation.id,
          draftId,
          kind: edited ? 'edit_approve' : 'approve',
          decidedByMembershipId: membershipId,
          note: null,
          editedBodySha256: request.body === undefined ? null : bodyDigest(request.body),
          acknowledgedUngrounded,
          decidedAt: now,
        })
        await enqueueEvents(scope, caller.organizationId, options.traceId, [
          messageApprovedEvent(draftId, {
            draftId,
            conversationId: conversation.id,
            prospectId: conversation.prospectId,
            channel: conversation.channel,
            approvedByMembershipId: membershipId,
            edited,
            acknowledgedUngrounded,
            approvedAt: now.toISOString(),
          }),
        ])
        return toDraftResponse(decided)
      }
    )
  )
}

/**
 * Rejects a pending Draft with an optional note, for any role that may see its Conversation. The
 * Draft is never sent. A Draft that is not pending is `inbox.draft_not_pending`. The Decision
 * keeps who, when and the note; the Idempotency-Key makes a retry answer the first answer.
 */
export async function rejectDraft(
  deps: ApprovalDeps,
  caller: Caller,
  draftId: DraftId,
  request: { note?: string | undefined },
  options: KeyedOptions
): Promise<IdempotentAnswer<200, Draft>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'drafts.reject',
        request: { params: { draftId }, body: request },
        status: 200,
        response: draftSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.approve')
        const { draft, conversation } = await visibleDraft(scope, caller, draftId)
        if (draft.status !== 'pending') {
          throw domainError(INBOX_ERRORS['inbox.draft_not_pending'])
        }
        const decided = await scope.decidePendingDraft({ draftId, status: 'rejected', now })
        if (!decided) {
          throw domainError(INBOX_ERRORS['inbox.draft_not_pending'])
        }
        await scope.insertDecision({
          id: newDecisionId(),
          conversationId: conversation.id,
          draftId,
          kind: 'reject',
          decidedByMembershipId: membershipId,
          note: request.note ?? null,
          editedBodySha256: null,
          acknowledgedUngrounded: false,
          decidedAt: now,
        })
        return toDraftResponse(decided)
      }
    )
  )
}

/**
 * Sends the controlling Rep's own reply: an approved Rep Draft and one `message.approved`, with
 * no approval in between. Only the Rep in control may (`inbox.takeover_required` while the Agent
 * is, `inbox.not_conversation_owner` for anyone else); a Conversation the caller may not see is
 * `inbox.conversation_not_found`; a closed one is `inbox.conversation_closed` and a Prospect on
 * the Suppression list `inbox.prospect_suppressed`. Idempotent by the Idempotency-Key.
 */
export async function replyToConversation(
  deps: ApprovalDeps,
  caller: Caller,
  conversationId: ConversationId,
  request: { body: string },
  options: KeyedOptions
): Promise<IdempotentAnswer<202, Draft>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'conversations.reply',
        request: { params: { conversationId }, body: request },
        status: 202,
        response: draftSchema,
      },
      async () => {
        const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.reply')
        const conversation = await visibleConversation(scope, caller, conversationId)
        if (conversation.controller !== 'rep') {
          throw domainError(INBOX_ERRORS['inbox.takeover_required'])
        }
        if (conversation.controllerMembershipId !== membershipId) {
          throw domainError(INBOX_ERRORS['inbox.not_conversation_owner'])
        }
        if (conversation.state === 'closed') {
          throw domainError(INBOX_ERRORS['inbox.conversation_closed'])
        }
        await refuseSuppressed(deps, scope, caller.organizationId, conversation)
        const draftId = formatId('drf', crypto.randomUUID()) as DraftId
        const stored = await scope.insertRepDraft({
          id: draftId,
          conversationId,
          membershipId,
          body: request.body,
          now,
        })
        await enqueueEvents(scope, caller.organizationId, options.traceId, [
          messageApprovedEvent(draftId, {
            draftId,
            conversationId,
            prospectId: conversation.prospectId,
            channel: conversation.channel,
            approvedByMembershipId: membershipId,
            edited: false,
            acknowledgedUngrounded: false,
            approvedAt: now.toISOString(),
          }),
        ])
        return toDraftResponse(stored)
      }
    )
  )
}

/** Reads the cursor of a list or refuses it as `request.invalid`. */
function cursorOf<T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (cursor === undefined) {
    return undefined
  }
  const decoded = decodeCursor(cursor, schema)
  if (decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return decoded
}

/**
 * Lists the pending Drafts the caller may see, oldest first, with their channel, Prospect, the
 * Prospect's owner and whether the caller may decide each, one page at a time (at most 100). Any
 * role; an Owner and Admin see every one, a Manager those of their Team, a Rep their own.
 */
export async function listApprovalQueue(
  deps: Pick<ApprovalDeps, 'store'>,
  caller: Caller,
  query: z.infer<typeof listApprovalQueueQuerySchema>
): Promise<Page<ApprovalQueueItem>> {
  const after = cursorOf(query.cursor, approvalQueueCursorSchema)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.list')
    const { visibility } = await visibilityOf(scope, caller)
    const rows = await scope.listPendingDrafts({
      visibility,
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
      ...(after === undefined
        ? {}
        : { after: { createdAt: new Date(after.createdAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(({ draft, conversation }) => ({
        draft: toDraftResponse(draft),
        channel: conversation.channel,
        prospectId: conversation.prospectId,
        ownerMembershipId: conversation.ownerMembershipId,
        canApprove: conversation.controller === 'agent' && conversation.state !== 'closed',
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.draft.createdAt.toISOString(), id: last.draft.id })
          : null,
    }
  })
}

/** Reads one Draft the caller may see; any other is `inbox.draft_not_found`. Any role. */
export async function getDraft(
  deps: Pick<ApprovalDeps, 'store'>,
  caller: Caller,
  draftId: DraftId
): Promise<Draft> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.read')
    return toDraftResponse((await visibleDraft(scope, caller, draftId)).draft)
  })
}

/**
 * Reads the Sources of a Draft the caller may see with the passage of each, resolved from the
 * Playbook for display only. The transaction is closed before the Playbook is called, and a
 * Playbook that does not answer in time is `server.timeout`, one that is down `server.unavailable`.
 * A Source the Playbook no longer holds has an empty passage. Any role.
 */
export async function getDraftSources(
  deps: Pick<ApprovalDeps, 'store' | 'moments'>,
  caller: Caller,
  draftId: DraftId
): Promise<z.infer<typeof draftSourcesSchema>> {
  const { sources } = await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.read')
    return (await visibleDraft(scope, caller, draftId)).draft
  })
  if (sources.length === 0) {
    return { items: [] }
  }
  const refs = sources.map((x) => x.sourceRef)
  let passages: Map<string, string> | null = null
  let timedOut = false
  for (let attempt = 1; passages === null; attempt++) {
    const signal = AbortSignal.timeout(PASSAGES_TIMEOUT_MS)
    try {
      passages = await Promise.race([
        deps.moments.passagesFor({ organizationId: caller.organizationId, refs }, signal),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      ])
    } catch {
      timedOut = signal.aborted
      if (attempt >= PASSAGES_ATTEMPTS) {
        throw domainError(ERRORS[timedOut ? 'server.timeout' : 'server.unavailable'])
      }
      await rest(backoffDelayMs(attempt, PASSAGES_BACKOFF), new AbortController().signal)
    }
  }
  return {
    items: sources.map((source) => ({
      source: { ...source },
      passage: passages.get(source.sourceRef) ?? '',
    })),
  }
}

/**
 * Lists the Decisions on Conversations the caller may see, newest first, one page at a time (at
 * most 100), with the filters of the query. Owner, Admin and Manager.
 */
export async function listDecisions(
  deps: Pick<ApprovalDeps, 'store'>,
  caller: Caller,
  query: z.infer<typeof listDecisionsQuerySchema>
): Promise<Page<Decision>> {
  const after = cursorOf(query.cursor, decisionCursorSchema)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.decisions')
    const { visibility } = await visibilityOf(scope, caller)
    const rows = await scope.listDecisions({
      visibility,
      ...(query.conversationId === undefined ? {} : { conversationId: query.conversationId }),
      ...(query.draftId === undefined ? {} : { draftId: query.draftId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(after === undefined
        ? {}
        : { after: { decidedAt: new Date(after.decidedAt), id: after.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toDecisionResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ decidedAt: last.decidedAt.toISOString(), id: last.id })
          : null,
    }
  })
}

const CHANNELS: readonly InboxChannel[] = ['chat', 'email', 'linkedin']

/**
 * Lists the approval policy of every channel (a channel nobody set follows `always`, with no
 * update time). Owner and Admin.
 */
export async function listApprovalPolicies(
  deps: Pick<ApprovalDeps, 'store'>,
  caller: Caller
): Promise<{ items: ApprovalPolicy[] }> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'inbox.policy_read')
    const set = new Map((await scope.listApprovalPolicies()).map((row) => [row.channel, row]))
    return {
      items: CHANNELS.map((channel) => {
        const row = set.get(channel)
        return row
          ? toPolicyResponse(row)
          : { channel, rule: DEFAULT_APPROVAL_RULE, updatedAt: null, updatedByMembershipId: null }
      }),
    }
  })
}

/**
 * Sets the approval rule of one channel, replacing the one it had. Owner and Admin. The rule
 * only ever lets a Draft go without a person when nothing else holds it: an ungrounded Draft,
 * one that failed a check, one for an escalated Conversation and a first message to a Prospect
 * always wait (see `holdReasonFor`).
 */
export async function setApprovalPolicy(
  deps: Pick<ApprovalDeps, 'store' | 'clock'>,
  caller: Caller,
  channel: InboxChannel,
  rule: ApprovalRule
): Promise<ApprovalPolicy> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const { membershipId } = await openOrganizationForWrite(scope, caller, 'inbox.policy_write')
    return toPolicyResponse(await scope.upsertApprovalPolicy({ channel, rule, membershipId, now }))
  })
}

/** The rule that governs a channel right now: the one an Admin set, else `always`. */
export async function ruleOf(
  scope: Pick<OrganizationScope, 'getApprovalPolicy'>,
  channel: InboxChannel
): Promise<ApprovalRule> {
  return (await scope.getApprovalPolicy(channel))?.rule ?? DEFAULT_APPROVAL_RULE
}

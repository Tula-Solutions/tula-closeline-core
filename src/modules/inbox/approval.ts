import { createHash } from 'node:crypto'
import {
  AGENT_ERRORS,
  type ApprovalPolicy,
  type ApprovalQueueItem,
  type ApprovalRule,
  type ApproveDraftRequest,
  ASSESSMENT_ERRORS,
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
  DraftAssessmentRecord,
  DraftRecord,
} from '~/ports/inbox-store'
import { type AssessInput, type Assessment, assessDraft, holdsRelease } from './assess'
import { type InboxDeps, type Page, visibleConversation } from './service'

/** What the approval routes need from the container. */
export type ApprovalDeps = Pick<InboxDeps, 'store' | 'clock'> &
  Pick<Container, 'logger' | 'env' | 'moments' | 'judge'>

/** The rule a channel follows until an Admin sets one: every Draft waits for a person. */
export const DEFAULT_APPROVAL_RULE: ApprovalRule = { mode: 'always' }

/** How many times the Playbook is asked for passages before giving up. */
const PASSAGES_ATTEMPTS = 3

/** The jittered rest between those attempts. */
const PASSAGES_BACKOFF = { baseMs: 50, capMs: 400 }

/** How long one Playbook attempt may take to resolve the passages of a Draft's Sources. */
const PASSAGES_TIMEOUT_MS = 8_000

type KeyedOptions = { idempotencyKey: string | undefined; traceId: string }

/** A stored assessment as the contract's Draft assessment; its findings carry no feedback yet. */
const toAssessmentResponse = (record: DraftAssessmentRecord | null): Draft['assessment'] =>
  record === null
    ? null
    : {
        id: record.id,
        verdict: record.verdict,
        findings: record.findings.map((finding) => ({
          id: finding.id,
          category: finding.category,
          severity: finding.severity,
          span: { ...finding.span },
          explanation: finding.explanation,
          feedback: null,
        })),
      }

/** A stored Draft, with its latest assessment (`null` when never judged), as the contract's Draft. */
export function toDraftResponse(
  record: DraftRecord,
  assessment: DraftAssessmentRecord | null
): Draft {
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
    assessment: toAssessmentResponse(assessment),
  }
}

/** The latest assessment of one Draft, by an indexed lookup in the caller's Organization. */
async function latestAssessment(
  scope: OrganizationScope,
  draftId: DraftId
): Promise<DraftAssessmentRecord | null> {
  return (await scope.getLatestDraftAssessments([draftId])).get(draftId) ?? null
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

/** The longest part of the Prospect's Message the judge is shown, as when the Draft was first judged. */
const MAX_MESSAGE_SHOWN = 4000

/** Thrown inside the first attempt of an approval that needs the judge, to roll it back and carry what the judge reads. */
class ReassessmentNeeded extends Error {
  constructor(readonly input: AssessInput) {
    super('The edited Draft must be judged before it can be released')
  }
}

/**
 * Approves a pending Draft, or approves it with the caller's own wording (`body`), for any role
 * that may see its Conversation (any other Draft is `inbox.draft_not_found`). One that is no
 * longer pending is `inbox.draft_not_pending`; an ungrounded one needs `acknowledgeUngrounded`
 * (`inbox.draft_ungrounded`); a Prospect on the Suppression list is `inbox.prospect_suppressed`
 * and a closed Conversation `inbox.conversation_closed`. The decision is one statement that only
 * matches a pending Draft, so of two concurrent approvals exactly one wins, records the Decision
 * (who, when, the SHA-256 of an edit, never its text) and publishes one `message.approved`. The
 * Idempotency-Key makes a retry answer the first answer.
 *
 * A Draft held as `check_failed` is approved unedited only by an Owner or Admin; anyone else is
 * `assessment.reassess_required` unless the approval carries an edited body. An edited body is
 * judged again, outside any transaction, before anything is decided: a pass (or warn) releases
 * it, a fail keeps it pending and held with the new body and assessment. A judge that cannot
 * answer is `server.unavailable` and decides nothing. A replay answers the stored answer before
 * the judge is asked.
 */
export async function approveDraft(
  deps: ApprovalDeps,
  caller: Caller,
  draftId: DraftId,
  request: ApproveDraftRequest,
  options: KeyedOptions
): Promise<IdempotentAnswer<200, Draft>> {
  try {
    return await approveOnce(deps, caller, draftId, request, options, undefined)
  } catch (error) {
    if (!(error instanceof ReassessmentNeeded)) {
      throw error
    }
    const assessment = await judgeEdit(deps, caller.organizationId, error.input)
    return approveOnce(deps, caller, draftId, request, options, assessment)
  }
}

/** Judges an edited body against the passages of the Sources the Draft cites; anything but a verdict is `server.unavailable`. */
async function judgeEdit(
  deps: Pick<ApprovalDeps, 'judge' | 'moments'>,
  organizationId: OrganizationId,
  asked: AssessInput
): Promise<Assessment & { status: 'judged' }> {
  const passages =
    asked.sources.length === 0
      ? new Map<string, string>()
      : await resolvePassages(
          deps,
          organizationId,
          asked.sources.map((source) => source.id)
        )
  const assessment = await assessDraft(deps, {
    ...asked,
    sources: asked.sources.flatMap((source) => {
      const passage = passages.get(source.id) ?? ''
      return passage === '' ? [] : [{ id: source.id, prospect: passage, repNext: '' }]
    }),
  })
  if (assessment.status !== 'judged') {
    throw domainError(ERRORS['server.unavailable'])
  }
  return assessment
}

/** One run of the approval in one transaction; `judged` is the answer of the judge on an edit, once asked. */
async function approveOnce(
  deps: ApprovalDeps,
  caller: Caller,
  draftId: DraftId,
  request: ApproveDraftRequest,
  options: KeyedOptions,
  judged: (Assessment & { status: 'judged' }) | undefined
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
        const { membershipId, role } = await openOrganizationForWrite(
          scope,
          caller,
          'inbox.approve'
        )
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
        if (draft.hold === 'check_failed') {
          if (request.body === undefined) {
            if (role !== 'owner' && role !== 'admin') {
              throw domainError(ASSESSMENT_ERRORS['assessment.reassess_required'])
            }
          } else {
            if (!judged) {
              throw new ReassessmentNeeded(
                await judgeInputOf(scope, draft, conversation, request.body)
              )
            }
            const latest = await latestAssessment(scope, draftId)
            const saved = await scope.saveDraftAssessment({
              draftId,
              draftVersion: (latest?.draftVersion ?? 0) + 1,
              prospectId: conversation.prospectId,
              verdict: judged.verdict,
              findings: judged.findings,
              now,
            })
            if (holdsRelease(judged)) {
              // Still failing: the edit is kept as the Draft's body, with its findings, and waits.
              const kept = await scope.replacePendingDraftBody(draftId, request.body)
              if (!kept) {
                throw domainError(INBOX_ERRORS['inbox.draft_not_pending'])
              }
              return toDraftResponse(kept, saved)
            }
          }
        }
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
        return toDraftResponse(decided, await latestAssessment(scope, draftId))
      }
    )
  )
}

/** What the judge reads for an edited Draft: the edit, the Message it answers and the ids of the Sources it cites. */
async function judgeInputOf(
  scope: OrganizationScope,
  draft: DraftRecord,
  conversation: ConversationRecord,
  body: string
): Promise<AssessInput> {
  const trigger =
    draft.reason === null ? null : await scope.getMessage(draft.reason.triggerMessageId)
  return {
    channel: conversation.channel,
    inboundBody: trigger?.body.slice(0, MAX_MESSAGE_SHOWN) ?? '',
    draftBody: body,
    sources: draft.sources.map((source) => ({ id: source.sourceRef, prospect: '', repNext: '' })),
  }
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
        return toDraftResponse(decided, await latestAssessment(scope, draftId))
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
        return toDraftResponse(stored, null)
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
    // One lookup for the whole page, never one per Draft.
    const assessed = await scope.getLatestDraftAssessments(page.map(({ draft }) => draft.id))
    return {
      items: page.map(({ draft, conversation }) => ({
        draft: toDraftResponse(draft, assessed.get(draft.id) ?? null),
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
    const { draft } = await visibleDraft(scope, caller, draftId)
    return toDraftResponse(draft, await latestAssessment(scope, draftId))
  })
}

/**
 * The passage of each Source ref from the Playbook, for display and for judging. Each attempt has a
 * timeout and the retries are bounded and jittered; a Playbook that does not answer in time is
 * `server.timeout`, one that is down `server.unavailable`.
 */
async function resolvePassages(
  deps: Pick<ApprovalDeps, 'moments'>,
  organizationId: OrganizationId,
  refs: string[]
): Promise<Map<string, string>> {
  let passages: Map<string, string> | null = null
  let timedOut = false
  for (let attempt = 1; passages === null; attempt++) {
    const signal = AbortSignal.timeout(PASSAGES_TIMEOUT_MS)
    try {
      passages = await Promise.race([
        deps.moments.passagesFor({ organizationId, refs }, signal),
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
  return passages
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
  const passages = await resolvePassages(
    deps,
    caller.organizationId,
    sources.map((x) => x.sourceRef)
  )
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

import {
  CORE_ERRORS,
  type ConversationId,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type MembershipId,
  type OrganizationId,
  type TeamId,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { OrganizationScope } from '~/ports/core-store'
import type { EscalationRuleRecord, EscalationTrigger } from '~/ports/inbox-store'
import {
  ESCALATION_RULE_NOT_FOUND,
  escalationRuleCursorSchema,
  type escalationRuleSchema,
  type listEscalationRulesQuerySchema,
  type setEscalationRuleRequestSchema,
  toEscalationRuleResponse,
} from './escalation-schema'
import type { Page } from './service'

/** What escalating needs from the container. */
export type EscalationDeps = Pick<Container, 'store' | 'clock' | 'repNotifier' | 'logger'>

/** How long the Rep notification may take before it is abandoned. */
const NOTIFY_TIMEOUT_MS = 5_000

/** The most Team members considered when a Conversation is dealt out round-robin. */
export const ROUND_ROBIN_MAX_REPS = 200

/** The fixed sentence a Rep is told; it never holds any part of a Message. */
const ESCALATION_TEXT = 'A Conversation was escalated to you and needs a person.'

/** The notice owed to the Rep an escalation was assigned to, handed over after the commit. */
export type EscalationNotice = {
  organizationId: OrganizationId
  conversationId: ConversationId
  trigger: EscalationTrigger
  membershipId: MembershipId
  email: string
}

/** What one escalation did: the Rep to tell, or `null` when it went to the Admin queue. */
export type Escalated = { notice: EscalationNotice | null }

/** Reads the cursor of a list or refuses it as `request.invalid`. */
function ruleCursorOf(cursor: string | undefined): EscalationTrigger | undefined {
  if (cursor === undefined) {
    return undefined
  }
  const decoded = decodeCursor(cursor, escalationRuleCursorSchema)
  if (decoded === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return decoded.trigger
}

/**
 * Lists the Organization's escalation rules in trigger order, one page at a time (at most 100).
 * Owner and Admin only.
 */
export async function listEscalationRules(
  deps: Pick<Container, 'store'>,
  caller: Caller,
  query: z.infer<typeof listEscalationRulesQuerySchema>
): Promise<Page<z.infer<typeof escalationRuleSchema>>> {
  const after = ruleCursorOf(query.cursor)
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'escalation_rule.read')
    const rows = await scope.listEscalationRules({
      ...(after === undefined ? {} : { after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toEscalationRuleResponse),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ trigger: last.trigger }) : null,
    }
  })
}

/** Refuses a rule whose parts do not fit its trigger and target, as the table's checks would. */
function checkShape(
  trigger: EscalationTrigger,
  request: z.infer<typeof setEscalationRuleRequestSchema>
): void {
  const needsTeam = request.target === 'team_round_robin'
  const needsThreshold = trigger === 'low_confidence'
  if (
    needsTeam !== (request.teamId !== undefined) ||
    needsThreshold !== (request.threshold !== undefined)
  ) {
    throw domainError(ERRORS['request.invalid'])
  }
}

/**
 * Sets the rule of a trigger, replacing the one it had. Owner and Admin only. A Team target needs
 * a Team of this Organization (any other is `team.not_found`) and `low_confidence` needs a
 * threshold; no other combination carries either.
 */
export async function setEscalationRule(
  deps: Pick<Container, 'store' | 'clock'>,
  caller: Caller,
  trigger: EscalationTrigger,
  request: z.infer<typeof setEscalationRuleRequestSchema>
): Promise<z.infer<typeof escalationRuleSchema>> {
  checkShape(trigger, request)
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const { membershipId } = await openOrganizationForWrite(scope, caller, 'escalation_rule.write')
    if (request.teamId !== undefined && !(await scope.getTeam(request.teamId))) {
      throw domainError(CORE_ERRORS['team.not_found'])
    }
    const stored = await scope.upsertEscalationRule({
      trigger,
      target: request.target,
      teamId: request.teamId ?? null,
      threshold: request.threshold ?? null,
      enabled: request.enabled,
      membershipId,
      now,
    })
    return toEscalationRuleResponse(stored)
  })
}

/** Removes the rule of a trigger; one that was never set is `escalation_rule.not_found`. Owner and Admin only. */
export async function deleteEscalationRule(
  deps: Pick<Container, 'store'>,
  caller: Caller,
  trigger: EscalationTrigger
): Promise<void> {
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'escalation_rule.write')
    if (!(await scope.deleteEscalationRule(trigger))) {
      throw domainError(ESCALATION_RULE_NOT_FOUND)
    }
  })
}

/** The Rep with the fewest escalated Conversations among a Team's Reps, ties by id; `null` when it has none. */
async function pickRoundRobin(
  scope: OrganizationScope,
  teamId: TeamId
): Promise<{ id: MembershipId; email: string } | null> {
  const members = await scope.listTeamMembers({ teamId, limit: ROUND_ROBIN_MAX_REPS })
  const reps = members.filter((member) => member.role === 'rep')
  if (reps.length === 0) {
    return null
  }
  const loads = await scope.countEscalatedByAssignee(reps.map((rep) => rep.id))
  const sorted = [...reps].sort(
    (a, b) => (loads.get(a.id) ?? 0) - (loads.get(b.id) ?? 0) || (a.id < b.id ? -1 : 1)
  )
  const [first] = sorted
  return first ? { id: first.id, email: first.email } : null
}

/** The Rep a rule sends a Conversation to, or `null` for the Admin queue (also when no Rep is left to take it). */
async function resolveAssignee(
  scope: OrganizationScope,
  rule: Pick<EscalationRuleRecord, 'target' | 'teamId'> | null,
  conversation: { prospectId: Parameters<OrganizationScope['getProspect']>[0] }
): Promise<{ id: MembershipId; email: string } | null> {
  if (rule?.target === 'prospect_owner') {
    const prospect = await scope.getProspect(conversation.prospectId, { kind: 'all' })
    const owner = prospect?.ownerMembershipId
      ? await scope.getMembership(prospect.ownerMembershipId)
      : null
    return owner ? { id: owner.id, email: owner.email } : null
  }
  if (rule?.target === 'team_round_robin' && rule.teamId !== null) {
    return pickRoundRobin(scope, rule.teamId)
  }
  return null
}

/**
 * Escalates one Conversation inside the caller's transaction, under the Organization lock the
 * caller already holds. It does nothing (`null`) unless the Agent is handling the Conversation and
 * an enabled rule matches the trigger (a `low_confidence` rule only when `confidence` is below its
 * threshold). A failed writer is the exception: with no enabled rule it still goes to the Admin
 * queue, because nothing else will answer the Prospect. The move is one guarded statement, so a
 * Conversation already escalated is left alone and a retry escalates nothing twice. The Rep it was
 * assigned to, when there is one, comes back to be told after the commit.
 */
export async function applyEscalation(
  scope: OrganizationScope,
  input: {
    organizationId: OrganizationId
    conversationId: ConversationId
    trigger: EscalationTrigger
    confidence?: number
  }
): Promise<Escalated | null> {
  const conversation = await scope.getConversation(input.conversationId, { kind: 'all' })
  if (
    !conversation ||
    conversation.controller !== 'agent' ||
    (conversation.state !== 'agent' && conversation.state !== 'awaiting_approval')
  ) {
    return null
  }
  const stored = await scope.getEscalationRule(input.trigger)
  const rule = stored?.enabled ? stored : null
  if (rule === null && input.trigger !== 'writer_failure') {
    return null
  }
  if (
    rule?.trigger === 'low_confidence' &&
    (input.confidence === undefined ||
      rule.threshold === null ||
      input.confidence >= rule.threshold)
  ) {
    return null
  }
  const assignee = await resolveAssignee(scope, rule, conversation)
  if (!(await scope.escalateConversation(conversation.id, assignee?.id ?? null))) {
    return null
  }
  return {
    notice: assignee
      ? {
          organizationId: input.organizationId,
          conversationId: conversation.id,
          trigger: input.trigger,
          membershipId: assignee.id,
          email: assignee.email,
        }
      : null,
  }
}

/**
 * Tells the Rep an escalation was assigned to, with ids, their address and a fixed sentence only
 * (never a Message). Best effort and bounded: a failure is logged without any text and never fails
 * the job, because the Conversation is already escalated.
 */
export async function notifyEscalated(
  deps: Pick<EscalationDeps, 'repNotifier' | 'logger'>,
  escalated: Escalated | null
): Promise<void> {
  if (!escalated?.notice) {
    return
  }
  const { notice } = escalated
  try {
    await deps.repNotifier.notify(
      { kind: 'conversation_escalated', ...notice, text: ESCALATION_TEXT },
      AbortSignal.timeout(NOTIFY_TIMEOUT_MS)
    )
  } catch (error) {
    deps.logger.warn('escalation notice failed', {
      conversationId: notice.conversationId,
      error: error instanceof Error ? error.name : 'unknown',
    })
  }
}

/** What names one escalation. */
export type EscalationInput = {
  organizationId: OrganizationId
  conversationId: ConversationId
  trigger: EscalationTrigger
  traceId: string
  confidence?: number
}

/**
 * Escalates a Conversation on a trigger, exactly once: see {@link applyEscalation}. Takes the
 * Organization lock, commits, then tells the Rep. Answers `skipped` when nothing moved.
 */
export async function escalateConversation(
  deps: EscalationDeps,
  input: EscalationInput
): Promise<'escalated' | 'skipped'> {
  const escalated = await deps.store.withOrganization(input.organizationId, async (scope) => {
    const organization = await scope.lockOrganization()
    if (!organization || organization.status === 'deleted') {
      return null
    }
    return applyEscalation(scope, input)
  })
  await notifyEscalated(deps, escalated)
  return escalated === null ? 'skipped' : 'escalated'
}

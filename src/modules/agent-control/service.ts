import {
  AGENT_ERRORS,
  type AgentControl,
  type AgentKind,
  type AgentsPaused,
  type ApprovalRule,
  agentControlSchema,
  agentsPausedSchema,
  type ControlLevel,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type InboxChannel,
  REPLY_LABELS,
  type SetAgentControlRequest,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { AgentControlChannelParam } from '~/ports/agent-settings-store'
import type { OrganizationScope } from '~/ports/core-store'
import {
  controlListCursorSchema,
  type controlParamsSchema,
  toControlResponse,
  toPausedResponse,
} from './schema'
import { isKnownTimeZone } from './window'

/** What the Agent control service needs from the container. */
export type AgentControlDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** What a write call is given besides its request: the validated `Idempotency-Key`. */
export type AgentControlCallOptions = { idempotencyKey?: string | undefined }

/** One page of the controls list. */
export type ControlPage = { items: AgentControl[]; nextCursor: string | null }

/**
 * The approval rule each level stands for on an inbox channel. Supervised: every Draft waits.
 * Assisted: a plain question goes out, anything else waits. Autonomous: every label goes out, yet
 * the holds no rule turns off (an ungrounded Draft, a failed check, an escalated Conversation, the
 * first message to a Prospect) still apply, because `holdReasonFor` asks them first.
 */
export function ruleForLevel(level: ControlLevel): ApprovalRule {
  switch (level) {
    case 'supervised':
      return { mode: 'always' }
    case 'assisted':
      return { mode: 'except', labels: ['question'] }
    case 'autonomous':
      return { mode: 'except', labels: [...REPLY_LABELS] }
  }
}

/** The inbox channels a row of the Inbound Agent's controls governs. */
async function inboxChannelsOf(
  scope: OrganizationScope,
  channel: AgentControlChannelParam
): Promise<InboxChannel[]> {
  if (channel === 'email' || channel === 'linkedin') {
    return [channel]
  }
  if (channel !== 'default') {
    return []
  }
  // The default governs chat, and any mail channel that has no row of its own.
  const own = await Promise.all(
    (['email', 'linkedin'] as const).map(
      async (c) => [c, await scope.getAgentSetting('inbound', c)] as const
    )
  )
  return ['chat', ...own.filter(([, row]) => row === null).map(([c]) => c)]
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Sets the controls of an Agent kind on a channel (or its default): level, send window and
 * escalation rules, replacing the whole value. Owner and Admin only. A time zone the runtime does
 * not know is `agent.settings_invalid`. For the Inbound Agent the level is written as the approval
 * policy of the inbox channels it governs, in the same transaction. A change writes one audit event
 * with the level before and after; setting the same value again changes and records nothing.
 * Idempotent on the key.
 */
export async function setControl(
  deps: AgentControlDeps,
  caller: Caller,
  params: z.infer<typeof controlParamsSchema>,
  request: SetAgentControlRequest,
  options: AgentControlCallOptions
): Promise<{ status: 200; body: AgentControl; replayed: boolean }> {
  const now = deps.clock.now()
  const { agentKind, channel } = params
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'agent_controls.set',
        request: { params, body: request },
        status: 200,
        response: agentControlSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'agent_controls.write')
        if (!isKnownTimeZone(request.sendWindow.timeZone)) {
          throw domainError(AGENT_ERRORS['agent.settings_invalid'])
        }
        const before = await scope.getAgentSetting(agentKind, channel)
        const levelChanged = before?.level !== request.level
        const windowChanged = !sameJson(before?.sendWindow, request.sendWindow)
        const rulesChanged = !sameJson(before?.escalationRules, request.escalationRules)
        const saved =
          before && !levelChanged && !windowChanged && !rulesChanged
            ? before
            : await scope.upsertAgentSetting({
                agentKind,
                channel,
                level: request.level,
                sendWindow: request.sendWindow,
                escalationRules: request.escalationRules,
                membershipId: access.membershipId,
                now,
              })
        if (agentKind === 'inbound') {
          for (const inboxChannel of await inboxChannelsOf(scope, channel)) {
            await scope.upsertApprovalPolicy({
              channel: inboxChannel,
              rule: ruleForLevel(request.level),
              membershipId: access.membershipId,
              now,
            })
          }
        }
        if (saved !== before) {
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: access.membershipId },
            action: 'agent_settings.changed',
            subject: { type: 'organization', id: caller.organizationId },
            metadata: {
              agentKind,
              channel,
              levelBefore: before?.level ?? null,
              levelAfter: request.level,
              sendWindowChanged: windowChanged,
              escalationRulesChanged: rulesChanged,
            },
          })
        }
        return toControlResponse(saved)
      }
    )
  )
  return { status: 200, body: answer.body, replayed: answer.replayed }
}

/**
 * One page of the stored controls, ordered by Agent kind then channel (the kind's default first),
 * optionally of one kind. Owner, Admin, Manager. A cursor that is not ours is `request.invalid`.
 */
export async function list(
  deps: AgentControlDeps,
  caller: Caller,
  query: { cursor?: string | undefined; limit: number; agentKind?: AgentKind | undefined }
): Promise<ControlPage> {
  let after: z.infer<typeof controlListCursorSchema> | undefined
  if (query.cursor !== undefined) {
    after = decodeCursor(query.cursor, controlListCursorSchema)
    if (after === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_controls.read')
    const rows = await scope.listAgentSettings({
      limit: query.limit + 1,
      ...(query.agentKind === undefined ? {} : { agentKind: query.agentKind }),
      ...(after === undefined ? {} : { after }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toControlResponse),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({
              agentKind: last.agentKind,
              channel: last.channel,
            } satisfies z.infer<typeof controlListCursorSchema>)
          : null,
    }
  })
}

/** Whether every Agent of the Organization is paused. Owner, Admin, Manager. */
export async function getPaused(deps: AgentControlDeps, caller: Caller): Promise<AgentsPaused> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_controls.read')
    return toPausedResponse(await scope.getAgentsPaused())
  })
}

/**
 * Pauses or resumes every Agent of the Organization. Owner and Admin only. While paused no Draft
 * is released, by the Agent or by approval (`agent.paused`). A change is audited; setting the
 * state it already has changes and records nothing. Idempotent on the key.
 */
export async function setPaused(
  deps: AgentControlDeps,
  caller: Caller,
  paused: boolean,
  options: AgentControlCallOptions
): Promise<{ status: 200; body: AgentsPaused }> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'agent_controls.pause',
        request: { paused },
        status: 200,
        response: agentsPausedSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'agent_controls.write')
        const before = await scope.getAgentsPaused()
        if ((before?.paused ?? false) === paused) {
          return toPausedResponse(before)
        }
        const saved = await scope.setAgentsPaused({
          paused,
          membershipId: access.membershipId,
          now,
        })
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: paused ? 'agents.paused' : 'agents.resumed',
          subject: { type: 'organization', id: caller.organizationId },
          metadata: { paused },
        })
        return toPausedResponse(saved)
      }
    )
  )
  return { status: 200, body: answer.body }
}

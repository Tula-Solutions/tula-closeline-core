import {
  AGENT_ERRORS,
  type AgentInstructionVersionId,
  type AgentKind,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type InstructionDiff,
  type InstructionVersion,
  type InstructionVersionSummary,
  instructionDiffSchema,
  MAX_AGENT_INSTRUCTION_LENGTH,
  type OrganizationId,
  type PublishedInstructions,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import type { OrganizationScope } from '~/ports/core-store'
import type { InstructionVersionRecord } from '~/ports/instruction-store'
import { diffLines } from './diff'
import {
  type internalPublishedRequestSchema,
  toSummaryResponse,
  toVersionResponse,
  versionListCursorSchema,
  versionRefSchema,
} from './schema'

/** What the instruction service needs from the container. */
export type AgentInstructionDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** What a write call is given besides its request: the validated `Idempotency-Key`. */
export type AgentInstructionCallOptions = { idempotencyKey?: string | undefined }

/** One page of the version list. */
export type VersionPage = { items: InstructionVersionSummary[]; nextCursor: string | null }

/** The version `number` of `agentKind`, or `agent.version_not_found`. */
async function requireVersion(
  scope: OrganizationScope,
  agentKind: AgentKind,
  number: number
): Promise<InstructionVersionRecord> {
  const found = await scope.findInstructionVersion(agentKind, number)
  if (!found) {
    throw domainError(AGENT_ERRORS['agent.version_not_found'])
  }
  return found
}

/**
 * Saves `text` as the next draft version of `agentKind`. Owner and Admin only. A text over 20,000
 * characters is `agent.instruction_too_long`. Audited. Idempotent on the key (200 on a replay).
 */
export async function save(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind,
  text: string,
  options: AgentInstructionCallOptions
): Promise<{ status: 200 | 201; body: InstructionVersion }> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'agent_instructions.save',
        request: { agentKind, text },
        status: 201,
        response: versionRefSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'agent_instructions.write')
        if (text.length > MAX_AGENT_INSTRUCTION_LENGTH) {
          throw domainError(AGENT_ERRORS['agent.instruction_too_long'])
        }
        const record = await scope.insertInstructionVersion({
          id: formatId('ains', crypto.randomUUID()) as AgentInstructionVersionId,
          agentKind,
          text,
          authorMembershipId: access.membershipId,
          now,
        })
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'agent_instructions.saved',
          subject: { type: 'agent_instruction', id: record.id },
          instructionVersion: record.number,
          metadata: { agentKind, version: record.number, length: text.length },
        })
        return { agentKind, number: record.number }
      }
    )
  )
  return {
    status: answer.replayed ? 200 : 201,
    body: await get(deps, caller, agentKind, answer.body.number),
  }
}

/**
 * Makes version `number` the one `agentKind` runs under; an earlier number is a rollback. Owner and
 * Admin only. Publishing the version that is already published changes and records nothing.
 */
export async function publish(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind,
  number: number,
  options: AgentInstructionCallOptions
): Promise<{ status: 200; body: InstructionVersion }> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'agent_instructions.publish',
        request: { agentKind, number },
        status: 200,
        response: versionRefSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'agent_instructions.write')
        const record = await requireVersion(scope, agentKind, number)
        const current = await scope.getInstructionPointer(agentKind)
        if (current?.versionNumber === number) {
          return { agentKind, number }
        }
        await scope.setInstructionPointer({
          agentKind,
          versionNumber: number,
          publishedByMembershipId: access.membershipId,
          now,
        })
        const previous = current?.versionNumber ?? null
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: access.membershipId },
          action: 'agent_instructions.published',
          subject: { type: 'agent_instruction', id: record.id },
          instructionVersion: number,
          metadata: {
            agentKind,
            version: number,
            previousVersion: previous,
            rollback: previous !== null && number < previous,
          },
        })
        return { agentKind, number }
      }
    )
  )
  return { status: 200, body: await get(deps, caller, agentKind, answer.body.number) }
}

/** A page of versions of `agentKind` without their text, newest first. Owner, Admin, Manager. */
export async function list(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind,
  query: { cursor?: string | undefined; limit: number }
): Promise<VersionPage> {
  let before: number | undefined
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(query.cursor, versionListCursorSchema)
    if (decoded === undefined) {
      throw domainError(ERRORS['request.invalid'])
    }
    before = decoded.before
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_instructions.read')
    const rows = await scope.listInstructionVersions({
      agentKind,
      limit: query.limit + 1,
      ...(before === undefined ? {} : { before }),
    })
    const pointer = await scope.getInstructionPointer(agentKind)
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) => toSummaryResponse(row, pointer)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ before: last.number } satisfies z.infer<typeof versionListCursorSchema>)
          : null,
    }
  })
}

/** One version with its text, or `agent.version_not_found`. Owner, Admin, Manager. */
export async function get(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind,
  number: number
): Promise<InstructionVersion> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_instructions.read')
    const record = await requireVersion(scope, agentKind, number)
    return toVersionResponse(record, await scope.getInstructionPointer(agentKind))
  })
}

/** The published version of `agentKind`, or `version: null`. Owner, Admin, Manager. */
export async function published(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind
): Promise<PublishedInstructions> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_instructions.read')
    return publishedIn(scope, agentKind)
  })
}

/** The published version of `agentKind` inside an open scope: two indexed reads. */
async function publishedIn(
  scope: OrganizationScope,
  agentKind: AgentKind
): Promise<PublishedInstructions> {
  const pointer = await scope.getInstructionPointer(agentKind)
  if (!pointer) {
    return { agentKind, version: null }
  }
  const record = await scope.findInstructionVersion(agentKind, pointer.versionNumber)
  return { agentKind, version: record ? toVersionResponse(record, pointer) : null }
}

/**
 * The published text and number for an Agent service, which names the Organization in the body and
 * is trusted by the internal secret. A missing, suspended or deleted Organization has none
 * (`version: null`). Nothing is written.
 */
export async function internalPublished(
  deps: AgentInstructionDeps,
  request: z.infer<typeof internalPublishedRequestSchema>
): Promise<PublishedInstructions> {
  return deps.store.withOrganization(request.organizationId as OrganizationId, async (scope) => {
    const organization = await scope.getOrganization()
    if (organization?.status !== 'active') {
      return { agentKind: request.agentKind, version: null }
    }
    return publishedIn(scope, request.agentKind)
  })
}

/** The line difference between versions `from` and `to`. Owner, Admin, Manager. */
export async function diff(
  deps: AgentInstructionDeps,
  caller: Caller,
  agentKind: AgentKind,
  query: { from: number; to: number }
): Promise<InstructionDiff> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'agent_instructions.read')
    const from = await requireVersion(scope, agentKind, query.from)
    const to = await requireVersion(scope, agentKind, query.to)
    return instructionDiffSchema.parse({
      agentKind,
      from: from.number,
      to: to.number,
      lines: diffLines(from.text, to.text),
    })
  })
}

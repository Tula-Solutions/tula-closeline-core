import { type CallId, formatId, type OrganizationId } from 'tula-closeline-contract'
import { jobRegistry } from '~/messages'
import type { TurnEnvelope } from './turn'

/** A new Call id for tests. */
export const newCallId = (): CallId =>
  formatId('call', crypto.randomUUID().replaceAll('-', '')) as CallId

/** A `call.turn_completed` envelope for tests. */
export function turnEnvelope(
  organizationId: OrganizationId,
  over: {
    callId?: CallId
    turnIndex?: number
    agentKind?: 'inbound' | 'outbound'
    instructionVersion?: number | null
    prospectId?: string | null
  } = {}
): TurnEnvelope {
  return jobRegistry.create({
    type: 'call.turn_completed',
    organizationId,
    traceId: 'trace-turn',
    payload: {
      callId: over.callId ?? newCallId(),
      turnIndex: over.turnIndex ?? 0,
      agentKind: over.agentKind ?? 'inbound',
      instructionVersion: over.instructionVersion === undefined ? 1 : over.instructionVersion,
      prospectId: over.prospectId ?? null,
      citedSources: [],
      completedAt: '2026-01-01T00:00:00.000Z',
    },
  }) as TurnEnvelope
}

import type { OrganizationId, ProspectId } from 'tula-closeline-contract'
import type { AuditEventRecord, AuditScope } from '~/ports/audit-store'
import { mayOwn } from './prospect-state'

/** What the in-memory store keeps for the audit log: each Organization's chain, in sequence order. */
export type AuditState = {
  /** The arrays are replaced, never changed in place, once a transaction has taken its copy. */
  auditChains: Map<OrganizationId, AuditEventRecord[]>
}

/** An empty {@link AuditState}. */
export function emptyAuditState(): AuditState {
  return { auditChains: new Map() }
}

/** A copy of the shell of the map, for a transaction's first write. */
export function copyAuditState(state: AuditState): AuditState {
  return { auditChains: new Map(state.auditChains) }
}

/** The prospect-visibility view the audit read needs from the whole state. */
type View = AuditState & Parameters<typeof mayOwn>[0]

/** Builds the audit methods of one transaction's scope, with the database's own rules. */
export function createAuditScope(env: {
  organizationId: OrganizationId
  read: () => View
  write: () => AuditState
  requireLock: () => void
}): AuditScope {
  const { organizationId, read, write, requireLock } = env
  const chainOf = (state: AuditState): AuditEventRecord[] =>
    state.auditChains.get(organizationId) ?? []

  const visible = (
    view: View,
    visibility: Parameters<typeof mayOwn>[2]
  ): ((event: AuditEventRecord) => boolean) => {
    if (visibility.kind === 'all') {
      return () => true
    }
    const allowed = mayOwn(view, organizationId, visibility)
    return (event) => {
      if (event.prospectId === null) {
        return false
      }
      const prospect = view.prospects.get(event.prospectId as ProspectId)
      return prospect?.organizationId === organizationId && allowed(prospect.ownerMembershipId)
    }
  }

  return {
    lastAuditEvent: async () => {
      const last = chainOf(read()).at(-1)
      return last ? { sequence: last.sequence, hash: last.hash } : null
    },

    insertAuditEvent: async (event) => {
      requireLock()
      const chain = chainOf(write())
      if (chain.some((stored) => stored.id === event.id)) {
        return false
      }
      const last = chain.at(-1)
      if (
        (last?.sequence ?? 0) + 1 !== event.sequence ||
        (last?.hash ?? null) !== event.previousHash
      ) {
        throw new Error('audit_events_chain: an event must extend the chain of its Organization')
      }
      write().auditChains.set(organizationId, [...chain, event])
      return true
    },

    listAuditEvents: async (request) => {
      const view = read()
      const mayRead = visible(view, request.visibility)
      const { filter, after } = request
      const matches = chainOf(view).filter(
        (event) =>
          mayRead(event) &&
          (filter.actorKind === undefined || event.actor.kind === filter.actorKind) &&
          (filter.actorId === undefined ||
            (event.actor.kind === 'member' && event.actor.membershipId === filter.actorId) ||
            (event.actor.kind === 'api_key' && event.actor.apiKeyId === filter.actorId) ||
            (event.actor.kind === 'agent' && event.actor.agentKind === filter.actorId)) &&
          (filter.action === undefined || event.action === filter.action) &&
          (filter.subjectType === undefined || event.subject?.type === filter.subjectType) &&
          (filter.subjectId === undefined || event.subject?.id === filter.subjectId) &&
          (filter.prospectId === undefined || event.prospectId === filter.prospectId) &&
          (filter.from === undefined || event.occurredAt >= filter.from) &&
          (filter.to === undefined || event.occurredAt <= filter.to)
      )
      if (request.order === 'oldest') {
        return matches
          .filter((event) => after === undefined || event.sequence > after.sequence)
          .slice(0, request.limit)
      }
      return matches
        .filter(
          (event) =>
            after === undefined ||
            event.occurredAt.getTime() < after.occurredAt.getTime() ||
            (event.occurredAt.getTime() === after.occurredAt.getTime() &&
              event.sequence < after.sequence)
        )
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.sequence - a.sequence)
        .slice(0, request.limit)
    },

    getAuditEvent: async (id, visibility) => {
      const view = read()
      const event = chainOf(view).find((stored) => stored.id === id)
      return event && visible(view, visibility)(event) ? event : null
    },

    readAuditChain: async (fromSequence, count) =>
      chainOf(read()).filter(
        (event) =>
          event.sequence >= Math.max(1, fromSequence - 1) && event.sequence < fromSequence + count
      ),
  }
}

/** Replaces one stored event's fields, as someone with the database owner's rights could: for tests of the verify. */
export function tamperAuditEvent(
  state: AuditState,
  organizationId: OrganizationId,
  sequence: number,
  patch: Partial<AuditEventRecord>
): AuditState {
  const chain = state.auditChains.get(organizationId) ?? []
  const auditChains = new Map(state.auditChains)
  auditChains.set(
    organizationId,
    chain.map((event) => (event.sequence === sequence ? { ...event, ...patch } : event))
  )
  return { auditChains }
}

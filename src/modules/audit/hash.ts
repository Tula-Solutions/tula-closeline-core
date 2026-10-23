import { createHash } from 'node:crypto'
import type { OrganizationId } from 'tula-closeline-contract'
import type { AuditEventRecord } from '~/ports/audit-store'

/** Serialises a value with object keys sorted at every depth, so equal content is equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The hash of an audit event: SHA-256, in lowercase hex, over the canonical JSON of everything the
 * event says (including the Organization, its place in the chain and the previous event's hash),
 * so changing any field of an event, or the event before it, changes this hash. O(event size).
 */
export function hashAuditEvent(
  organizationId: OrganizationId,
  event: Omit<AuditEventRecord, 'hash'>
): string {
  return createHash('sha256')
    .update(
      canonical({
        organizationId,
        id: event.id,
        sequence: event.sequence,
        occurredAt: event.occurredAt.toISOString(),
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        prospectId: event.prospectId,
        instructionVersion: event.instructionVersion,
        requestId: event.requestId,
        metadata: event.metadata,
        previousHash: event.previousHash,
      })
    )
    .digest('hex')
}

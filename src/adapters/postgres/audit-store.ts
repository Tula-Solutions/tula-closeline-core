import { and, asc, eq, gte, lt, lte, or, type SQL, sql } from 'drizzle-orm'
import {
  type AuditActor,
  auditActorSchema,
  auditEventIdSchema,
  auditMetadataSchema,
  type OrganizationId,
  prospectIdSchema,
  requestIdSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { auditEvents, prospects } from 'tula-closeline-db/schema'
import type { AuditEventRecord, AuditScope } from '~/ports/audit-store'
import type { ProspectVisibility } from '~/ports/core-store'
import { visibilityCondition } from './prospect-store'

type Row = typeof auditEvents.$inferSelect

/** The actor an event's columns hold, through the contract's schema, which refuses an inconsistent one. */
function actorOf(row: Row): AuditActor {
  switch (row.actorKind) {
    case 'member':
      return auditActorSchema.parse({ kind: 'member', membershipId: row.actorMembershipId })
    case 'agent':
      return auditActorSchema.parse({ kind: 'agent', agentKind: row.actorAgentKind })
    case 'api_key':
      return auditActorSchema.parse({ kind: 'api_key', apiKeyId: row.actorApiKeyId })
    case 'system':
      return auditActorSchema.parse({ kind: 'system' })
  }
}

const toRecord = (row: Row): AuditEventRecord => ({
  id: auditEventIdSchema.parse(row.id),
  sequence: row.sequence,
  occurredAt: row.occurredAt,
  actor: actorOf(row),
  action: row.action,
  subject:
    row.subjectType !== null && row.subjectId !== null
      ? { type: row.subjectType, id: row.subjectId }
      : null,
  prospectId: row.prospectId === null ? null : prospectIdSchema.parse(row.prospectId),
  instructionVersion: row.instructionVersion,
  requestId: row.requestId === null ? null : requestIdSchema.parse(row.requestId),
  metadata: auditMetadataSchema.parse(row.metadata),
  previousHash: row.previousHash,
  hash: row.hash,
})

/** The condition a visibility adds: none for everything, else the event's Prospect must be one the viewer may see. */
function visibleEvents(
  organizationId: OrganizationId,
  visibility: ProspectVisibility
): SQL | undefined {
  if (visibility.kind === 'all') {
    return undefined
  }
  return sql`exists (
    select 1 from ${prospects}
    where ${prospects.organizationId} = ${organizationId}
      and ${prospects.id} = ${auditEvents.prospectId}
      and ${visibilityCondition(organizationId, visibility)})`
}

/** Builds the audit methods of one transaction's scope, under the transaction's row-level security. */
export function createAuditStore(tx: Transaction, organizationId: OrganizationId): AuditScope {
  const inOrganization = eq(auditEvents.organizationId, organizationId)

  return {
    lastAuditEvent: async () => {
      const rows = await tx
        .select({ sequence: auditEvents.sequence, hash: auditEvents.hash })
        .from(auditEvents)
        .where(inOrganization)
        .orderBy(sql`${auditEvents.sequence} desc`)
        .limit(1)
      return rows[0] ?? null
    },

    insertAuditEvent: async (event) => {
      const inserted = await tx
        .insert(auditEvents)
        .values({
          id: event.id,
          organizationId,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          actorKind: event.actor.kind,
          actorMembershipId: event.actor.kind === 'member' ? event.actor.membershipId : null,
          actorAgentKind: event.actor.kind === 'agent' ? event.actor.agentKind : null,
          actorApiKeyId: event.actor.kind === 'api_key' ? event.actor.apiKeyId : null,
          action: event.action,
          subjectType: event.subject?.type ?? null,
          subjectId: event.subject?.id ?? null,
          prospectId: event.prospectId,
          instructionVersion: event.instructionVersion,
          requestId: event.requestId,
          metadata: event.metadata,
          previousHash: event.previousHash,
          hash: event.hash,
        })
        .onConflictDoNothing({ target: [auditEvents.organizationId, auditEvents.id] })
        .returning({ id: auditEvents.id })
      return inserted.length === 1
    },

    listAuditEvents: async (request) => {
      const { filter, after } = request
      const newest = request.order === 'newest'
      const position =
        after === undefined
          ? undefined
          : newest
            ? sql`(${auditEvents.occurredAt}, ${auditEvents.sequence}) < (${after.occurredAt.toISOString()}::timestamptz, ${after.sequence})`
            : sql`${auditEvents.sequence} > ${after.sequence}`
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(
          and(
            inOrganization,
            visibleEvents(organizationId, request.visibility),
            filter.actorKind === undefined
              ? undefined
              : eq(auditEvents.actorKind, filter.actorKind),
            filter.actorId === undefined
              ? undefined
              : or(
                  eq(auditEvents.actorMembershipId, filter.actorId),
                  eq(auditEvents.actorApiKeyId, filter.actorId),
                  sql`${auditEvents.actorAgentKind} = ${filter.actorId}`
                ),
            filter.action === undefined ? undefined : eq(auditEvents.action, filter.action),
            filter.subjectType === undefined
              ? undefined
              : eq(auditEvents.subjectType, filter.subjectType),
            filter.subjectId === undefined
              ? undefined
              : eq(auditEvents.subjectId, filter.subjectId),
            filter.prospectId === undefined
              ? undefined
              : eq(auditEvents.prospectId, filter.prospectId),
            filter.from === undefined ? undefined : gte(auditEvents.occurredAt, filter.from),
            filter.to === undefined ? undefined : lte(auditEvents.occurredAt, filter.to),
            position
          )
        )
        .orderBy(
          ...(newest
            ? [
                sql`${auditEvents.occurredAt} desc nulls last`,
                sql`${auditEvents.sequence} desc nulls last`,
              ]
            : [asc(auditEvents.sequence)])
        )
        .limit(request.limit)
      return rows.map(toRecord)
    },

    getAuditEvent: async (id, visibility) => {
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(
          and(inOrganization, eq(auditEvents.id, id), visibleEvents(organizationId, visibility))
        )
        .limit(1)
      return rows[0] ? toRecord(rows[0]) : null
    },

    readAuditChain: async (fromSequence, count) => {
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(
          and(
            inOrganization,
            gte(auditEvents.sequence, Math.max(1, fromSequence - 1)),
            lt(auditEvents.sequence, fromSequence + count)
          )
        )
        .orderBy(asc(auditEvents.sequence))
        .limit(count + 1)
      return rows.map(toRecord)
    },
  }
}

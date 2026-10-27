import { and, asc, desc, eq, gt, gte, lt, ne, type SQL, sql } from 'drizzle-orm'
import {
  bookingTypeIdSchema,
  type MembershipId,
  membershipIdSchema,
  type OrganizationId,
  prospectIdSchema,
  type RoutingTarget,
  routingConditionsSchema,
  routingDecisionIdSchema,
  routingResultSchema,
  routingRuleIdSchema,
  routingTargetSchema,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import {
  bookings,
  routingDecisions,
  routingRules,
  routingState,
  teamMembers,
} from 'tula-closeline-db/schema'
import type { RoutingRuleRecord, RoutingScope } from '~/ports/routing-store'

/** The routing methods of the Postgres scope. */
export type RoutingStoreMethods = RoutingScope

type RuleRow = typeof routingRules.$inferSelect

/** The columns of a rule row that hold its target. */
const targetColumns = (target: RoutingTarget, name: string) => ({
  targetKind: target.kind,
  targetMembershipId: target.kind === 'rep' ? target.membershipId : null,
  targetTeamId: target.kind === 'team' ? target.teamId : null,
  poolName: target.kind === 'pool' ? name.slice(0, 100).trim() : null,
  poolMembershipIds: target.kind === 'pool' ? target.membershipIds : null,
})

const toTarget = (row: RuleRow): RoutingTarget =>
  routingTargetSchema.parse(
    row.targetKind === 'rep'
      ? { kind: 'rep', membershipId: row.targetMembershipId }
      : row.targetKind === 'team'
        ? { kind: 'team', teamId: row.targetTeamId }
        : { kind: 'pool', membershipIds: row.poolMembershipIds }
  )

const toRecord = (row: RuleRow): RoutingRuleRecord => ({
  id: routingRuleIdSchema.parse(row.id),
  name: row.name,
  conditions: routingConditionsSchema.parse(row.conditions),
  target: toTarget(row),
  position: row.position,
  createdAt: row.createdAt,
})

/** Builds the routing methods over one transaction of `organizationId`. */
export function createRoutingStore(
  tx: Transaction,
  organizationId: OrganizationId
): RoutingStoreMethods {
  const own = (id: string): SQL | undefined =>
    and(eq(routingRules.organizationId, organizationId), eq(routingRules.id, id))
  const stateRow = (targetKey: string): SQL | undefined =>
    and(eq(routingState.organizationId, organizationId), eq(routingState.targetKey, targetKey))
  const lastOf = (value: string | null | undefined): { lastMembershipId: MembershipId | null } => ({
    lastMembershipId: value ? membershipIdSchema.parse(value) : null,
  })

  return {
    listRoutingRules: async ({ limit, afterPosition }) => {
      const rows = await tx
        .select()
        .from(routingRules)
        .where(
          and(
            eq(routingRules.organizationId, organizationId),
            afterPosition === undefined ? undefined : gt(routingRules.position, afterPosition)
          )
        )
        .orderBy(asc(routingRules.position), asc(routingRules.id))
        .limit(limit)
      return rows.map(toRecord)
    },

    findRoutingRule: async (id) => {
      const row = (await tx.select().from(routingRules).where(own(id)).limit(1))[0]
      return row ? toRecord(row) : null
    },

    insertRoutingRule: async (input) => {
      await tx.insert(routingRules).values({
        id: input.id,
        organizationId,
        position: input.position,
        name: input.name,
        conditions: input.conditions,
        ...targetColumns(input.target, input.name),
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      return input
    },

    updateRoutingRule: async (id, fields, now) => {
      const rows = await tx
        .update(routingRules)
        .set({
          name: fields.name,
          conditions: fields.conditions,
          ...targetColumns(fields.target, fields.name),
          updatedAt: now,
        })
        .where(own(id))
        .returning()
      const row = rows[0]
      return row ? toRecord(row) : null
    },

    deleteRoutingRule: async (id) =>
      (await tx.delete(routingRules).where(own(id)).returning({ id: routingRules.id })).length > 0,

    setRoutingRulePositions: async (ids, now) => {
      // shortcut: one update per rule (at most 200), one statement with a CASE when this is hot.
      for (const [index, id] of ids.entries()) {
        await tx
          .update(routingRules)
          .set({ position: index + 1, updatedAt: now })
          .where(own(id))
      }
    },

    lockRoutingState: async (targetKey, now) => {
      await tx
        .insert(routingState)
        .values({ organizationId, targetKey, updatedAt: now })
        .onConflictDoNothing()
      const row = (await tx.select().from(routingState).where(stateRow(targetKey)).for('update'))[0]
      return lastOf(row?.lastMembershipId)
    },

    readRoutingState: async (targetKey) => {
      const row = (await tx.select().from(routingState).where(stateRow(targetKey)).limit(1))[0]
      return lastOf(row?.lastMembershipId)
    },

    saveRoutingState: async (targetKey, lastMembershipId, now) => {
      await tx
        .update(routingState)
        .set({ lastMembershipId, cursor: sql`${routingState.cursor} + 1`, updatedAt: now })
        .where(stateRow(targetKey))
    },

    insertRoutingDecision: async (input) => {
      await tx.insert(routingDecisions).values({
        id: input.id,
        organizationId,
        purpose: input.purpose,
        prospectId: input.prospectId,
        bookingTypeId: input.bookingTypeId,
        ruleId: input.ruleId,
        chosenMembershipId: input.chosenMembershipId,
        candidates: input.candidates,
        skipped: input.skipped,
        reason: input.reason,
        createdAt: input.now,
      })
    },

    listRoutingDecisions: async ({ limit }) => {
      const rows = await tx
        .select()
        .from(routingDecisions)
        .where(eq(routingDecisions.organizationId, organizationId))
        .orderBy(desc(routingDecisions.createdAt), desc(routingDecisions.id))
        .limit(limit)
      return rows.map((row) => ({
        id: routingDecisionIdSchema.parse(row.id),
        purpose: row.purpose,
        prospectId: row.prospectId === null ? null : prospectIdSchema.parse(row.prospectId),
        bookingTypeId:
          row.bookingTypeId === null ? null : bookingTypeIdSchema.parse(row.bookingTypeId),
        ruleId: row.ruleId === null ? null : routingRuleIdSchema.parse(row.ruleId),
        chosenMembershipId:
          row.chosenMembershipId === null ? null : membershipIdSchema.parse(row.chosenMembershipId),
        candidates: routingResultSchema.shape.candidates.parse(row.candidates),
        skipped: routingResultSchema.shape.skipped.parse(row.skipped),
        reason: row.reason,
        now: row.createdAt,
      }))
    },

    countActiveBookings: async (membershipId, from, to) => {
      const rows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.organizationId, organizationId),
            eq(bookings.membershipId, membershipId),
            ne(bookings.status, 'cancelled'),
            gte(bookings.startsAt, from),
            lt(bookings.startsAt, to)
          )
        )
      return rows[0]?.count ?? 0
    },

    isTeamMember: async (teamId, membershipId) =>
      (
        await tx
          .select({ id: teamMembers.membershipId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.organizationId, organizationId),
              eq(teamMembers.teamId, teamId),
              eq(teamMembers.membershipId, membershipId)
            )
          )
          .limit(1)
      ).length > 0,
  }
}

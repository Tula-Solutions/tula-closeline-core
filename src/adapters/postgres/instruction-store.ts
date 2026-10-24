import { and, desc, eq, lt } from 'drizzle-orm'
import {
  agentInstructionVersionIdSchema,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { agentInstructionPointers, agentInstructionVersions } from 'tula-closeline-db/schema'
import type {
  InstructionPointerRecord,
  InstructionScope,
  InstructionVersionRecord,
} from '~/ports/instruction-store'

const toVersion = (
  row: typeof agentInstructionVersions.$inferSelect
): InstructionVersionRecord => ({
  id: agentInstructionVersionIdSchema.parse(row.id),
  agentKind: row.agentKind,
  number: row.number,
  text: row.text,
  authorMembershipId:
    row.authorMembershipId === null ? null : membershipIdSchema.parse(row.authorMembershipId),
  createdAt: row.createdAt,
})

const toPointer = (
  row: typeof agentInstructionPointers.$inferSelect
): InstructionPointerRecord => ({
  agentKind: row.agentKind,
  versionNumber: row.versionNumber,
  publishedByMembershipId:
    row.publishedByMembershipId === null
      ? null
      : membershipIdSchema.parse(row.publishedByMembershipId),
  publishedAt: row.publishedAt,
})

/** The Postgres instruction methods of one Organization's transaction. */
export function createInstructionStore(
  tx: Transaction,
  organizationId: OrganizationId
): InstructionScope {
  const versionsOf = (agentKind: InstructionVersionRecord['agentKind']) =>
    and(
      eq(agentInstructionVersions.organizationId, organizationId),
      eq(agentInstructionVersions.agentKind, agentKind)
    )

  return {
    insertInstructionVersion: async (input) => {
      const [last] = await tx
        .select({ number: agentInstructionVersions.number })
        .from(agentInstructionVersions)
        .where(versionsOf(input.agentKind))
        .orderBy(desc(agentInstructionVersions.number))
        .limit(1)
      const [row] = await tx
        .insert(agentInstructionVersions)
        .values({
          id: input.id,
          organizationId,
          agentKind: input.agentKind,
          number: (last?.number ?? 0) + 1,
          text: input.text,
          authorMembershipId: input.authorMembershipId,
          createdAt: input.now,
        })
        .returning()
      if (!row) {
        throw new Error('agent_instruction_versions: insert returned no row')
      }
      return toVersion(row)
    },

    findInstructionVersion: async (agentKind, number) => {
      const [row] = await tx
        .select()
        .from(agentInstructionVersions)
        .where(and(versionsOf(agentKind), eq(agentInstructionVersions.number, number)))
        .limit(1)
      return row ? toVersion(row) : null
    },

    listInstructionVersions: async ({ agentKind, before, limit }) => {
      const rows = await tx
        .select()
        .from(agentInstructionVersions)
        .where(
          and(
            versionsOf(agentKind),
            before === undefined ? undefined : lt(agentInstructionVersions.number, before)
          )
        )
        .orderBy(desc(agentInstructionVersions.number))
        .limit(limit)
      return rows.map(toVersion)
    },

    getInstructionPointer: async (agentKind) => {
      const [row] = await tx
        .select()
        .from(agentInstructionPointers)
        .where(
          and(
            eq(agentInstructionPointers.organizationId, organizationId),
            eq(agentInstructionPointers.agentKind, agentKind)
          )
        )
        .limit(1)
      return row ? toPointer(row) : null
    },

    setInstructionPointer: async (input) => {
      const [row] = await tx
        .insert(agentInstructionPointers)
        .values({
          organizationId,
          agentKind: input.agentKind,
          versionNumber: input.versionNumber,
          publishedByMembershipId: input.publishedByMembershipId,
          publishedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [agentInstructionPointers.organizationId, agentInstructionPointers.agentKind],
          set: {
            versionNumber: input.versionNumber,
            publishedByMembershipId: input.publishedByMembershipId,
            publishedAt: input.now,
          },
        })
        .returning()
      if (!row) {
        throw new Error('agent_instruction_pointers: upsert returned no row')
      }
      return toPointer(row)
    },
  }
}

import { and, asc, eq, gt, inArray, or } from 'drizzle-orm'
import {
  AGENT_CALLING_WINDOW,
  AGENT_KINDS,
  agentSendWindowSchema,
  escalationRulesSchema,
  membershipIdSchema,
  type OrganizationId,
} from 'tula-closeline-contract'
import type { Transaction } from 'tula-closeline-db'
import { agentSettings, ORGANIZATION_AGENT_KIND } from 'tula-closeline-db/schema'
import type {
  AgentSettingRecord,
  AgentSettingsScope,
  AgentsPausedRecord,
} from '~/ports/agent-settings-store'

const CAP_START = `${String(AGENT_CALLING_WINDOW.startHour).padStart(2, '0')}:00`
const CAP_END = `${String(AGENT_CALLING_WINDOW.endHour).padStart(2, '0')}:00`

type StoredWindow = { start: string; end: string }

/** Cuts a stored send window to the fixed calling window, so a row saved before the cap still reads. */
const clampSendWindow = (stored: unknown): unknown => {
  const days = (stored as { days?: { windows?: StoredWindow[] }[] } | null)?.days
  if (!Array.isArray(days)) {
    return stored
  }
  return {
    ...(stored as object),
    days: days
      .map((day) => ({
        ...day,
        windows: (day.windows ?? [])
          .map((w) => ({
            ...w,
            start: w.start < CAP_START ? CAP_START : w.start,
            end: w.end > CAP_END ? CAP_END : w.end,
          }))
          .filter((w) => w.start < w.end),
      }))
      .filter((day) => day.windows.length > 0),
  }
}

const toSetting = (row: typeof agentSettings.$inferSelect): AgentSettingRecord => {
  if (row.agentKind === ORGANIZATION_AGENT_KIND || row.level === null) {
    throw new Error('agent_settings: an Organization row is not an Agent setting')
  }
  return {
    agentKind: row.agentKind,
    channel: row.channel,
    level: row.level,
    sendWindow: agentSendWindowSchema.parse(clampSendWindow(row.sendWindow)),
    escalationRules: escalationRulesSchema.parse(row.escalationRules),
    updatedByMembershipId:
      row.updatedByMembershipId === null
        ? null
        : membershipIdSchema.parse(row.updatedByMembershipId),
    updatedAt: row.updatedAt,
  }
}

const toPaused = (row: typeof agentSettings.$inferSelect): AgentsPausedRecord => ({
  paused: row.agentsPaused === true,
  updatedByMembershipId:
    row.updatedByMembershipId === null ? null : membershipIdSchema.parse(row.updatedByMembershipId),
  updatedAt: row.updatedAt,
})

/** The Postgres Agent control methods of one Organization's transaction. */
export function createAgentSettingsStore(
  tx: Transaction,
  organizationId: OrganizationId
): AgentSettingsScope {
  const mine = eq(agentSettings.organizationId, organizationId)

  return {
    getAgentSetting: async (agentKind, channel) => {
      const [row] = await tx
        .select()
        .from(agentSettings)
        .where(
          and(mine, eq(agentSettings.agentKind, agentKind), eq(agentSettings.channel, channel))
        )
        .limit(1)
      return row ? toSetting(row) : null
    },

    listAgentSettings: async ({ agentKind, after, limit }) => {
      const rows = await tx
        .select()
        .from(agentSettings)
        .where(
          and(
            mine,
            agentKind === undefined
              ? inArray(agentSettings.agentKind, [...AGENT_KINDS])
              : eq(agentSettings.agentKind, agentKind),
            after === undefined
              ? undefined
              : or(
                  gt(agentSettings.agentKind, after.agentKind),
                  and(
                    eq(agentSettings.agentKind, after.agentKind),
                    gt(agentSettings.channel, after.channel)
                  )
                )
          )
        )
        .orderBy(asc(agentSettings.agentKind), asc(agentSettings.channel))
        .limit(limit)
      return rows.map(toSetting)
    },

    upsertAgentSetting: async (input) => {
      const values = {
        level: input.level,
        sendWindow: input.sendWindow,
        escalationRules: input.escalationRules,
        agentsPaused: null,
        updatedByMembershipId: input.membershipId,
        updatedAt: input.now,
      }
      const [row] = await tx
        .insert(agentSettings)
        .values({ organizationId, agentKind: input.agentKind, channel: input.channel, ...values })
        .onConflictDoUpdate({
          target: [agentSettings.organizationId, agentSettings.agentKind, agentSettings.channel],
          set: values,
        })
        .returning()
      if (!row) {
        throw new Error('agent_settings: upsert returned no row')
      }
      return toSetting(row)
    },

    getAgentsPaused: async () => {
      const [row] = await tx
        .select()
        .from(agentSettings)
        .where(and(mine, eq(agentSettings.agentKind, ORGANIZATION_AGENT_KIND)))
        .limit(1)
      return row ? toPaused(row) : null
    },

    setAgentsPaused: async (input) => {
      const values = {
        agentsPaused: input.paused,
        updatedByMembershipId: input.membershipId,
        updatedAt: input.now,
      }
      const [row] = await tx
        .insert(agentSettings)
        .values({
          organizationId,
          agentKind: ORGANIZATION_AGENT_KIND,
          channel: 'default',
          ...values,
        })
        .onConflictDoUpdate({
          target: [agentSettings.organizationId, agentSettings.agentKind, agentSettings.channel],
          set: values,
        })
        .returning()
      if (!row) {
        throw new Error('agent_settings: pause upsert returned no row')
      }
      return toPaused(row)
    },
  }
}

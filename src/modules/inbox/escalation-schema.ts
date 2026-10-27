import { teamIdSchema } from 'tula-closeline-contract'
import { z } from 'zod'
import type { EscalationRuleRecord } from '~/ports/inbox-store'

/** The most escalation rules a page lists; there are only a handful of triggers, so one page holds all. */
export const ESCALATION_RULE_MAX_PAGE = 100

/** What fires an escalation rule. */
export const escalationTriggerSchema = z.enum([
  'asks_for_person',
  'pricing_or_legal',
  'negative_tone',
  'low_confidence',
  'writer_failure',
])

/** Where an escalation goes. */
export const escalationTargetSchema = z.enum(['prospect_owner', 'team_round_robin', 'admin_queue'])

/** The `{trigger}` path parameter of the rule routes. */
export const escalationTriggerParamsSchema = z.object({ trigger: escalationTriggerSchema })

/**
 * The body of a rule: its target, the Team for a Team round-robin, the threshold for
 * `low_confidence`, and whether it is on. Which of these a trigger needs is checked by the service.
 */
export const setEscalationRuleRequestSchema = z.object({
  target: escalationTargetSchema,
  teamId: teamIdSchema.optional(),
  threshold: z.number().gt(0).lte(1).optional(),
  enabled: z.boolean().default(true),
})

/** The query of the rule list: a page size up to the maximum and the cursor of the page before. */
export const listEscalationRulesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ESCALATION_RULE_MAX_PAGE).default(50),
  cursor: z.string().min(1).max(512).optional(),
})

/** An escalation rule as the routes answer it. */
export const escalationRuleSchema = z.object({
  id: z.string(),
  trigger: escalationTriggerSchema,
  target: escalationTargetSchema,
  teamId: teamIdSchema.nullable(),
  threshold: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One page of escalation rules. */
export const escalationRulePageSchema = z.object({
  items: z.array(escalationRuleSchema),
  nextCursor: z.string().nullable(),
})

/** The cursor of a rule list: the trigger of the last rule on the page. */
export const escalationRuleCursorSchema = z.object({ trigger: escalationTriggerSchema })

/** The error code of a rule that does not exist. */
export const ESCALATION_RULE_NOT_FOUND = {
  code: 'escalation_rule.not_found',
  status: 404,
  message: 'No escalation rule is set for that trigger.',
} as const

/** A stored rule as the routes answer it. */
export function toEscalationRuleResponse(
  record: EscalationRuleRecord
): z.infer<typeof escalationRuleSchema> {
  return {
    id: record.id,
    trigger: record.trigger,
    target: record.target,
    teamId: record.teamId,
    threshold: record.threshold,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

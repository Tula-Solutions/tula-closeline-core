import {
  BOOKING_ERRORS,
  type BookingTypeId,
  type CreateRoutingRuleRequest,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listRoutingRulesQuerySchema,
  MAX_ROUTING_RULES,
  type MembershipId,
  type Page,
  type RouteRequest,
  type RoutingResult,
  type RoutingRule,
  type RoutingRuleId,
  type RoutingTarget,
  routingRuleSchema,
  type TestRoutingRequest,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { prospectNotFound, visibilityOf } from '~/modules/prospect/service'
import type { OrganizationScope } from '~/ports/core-store'
import type { RoutingRuleRecord } from '~/ports/routing-store'
import { bandOf, isDefaultRule } from './match'
import { pick } from './pick'

/** What the routing service needs from the container. */
export type RoutingDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'env'>

/** What a write call is given besides its request: the validated `Idempotency-Key`, if sent. */
export type RoutingCallOptions = { idempotencyKey?: string | undefined }

const ruleCursor = z.strictObject({ position: z.number().int().min(0) })

/** The API shape of a rule. */
function toResponse(record: RoutingRuleRecord): RoutingRule {
  return routingRuleSchema.parse({
    id: record.id,
    name: record.name,
    conditions: record.conditions,
    target: record.target,
    isDefault: isDefaultRule(record.conditions),
    position: record.position,
    createdAt: record.createdAt.toISOString(),
  })
}

const invalid = (field: string) => domainError(BOOKING_ERRORS['routing.rule_invalid'], { field })
const notFound = () => domainError(BOOKING_ERRORS['routing.rule_not_found'])

/** All rules in order; an Organization has at most {@link MAX_ROUTING_RULES}. */
const allRules = (scope: OrganizationScope) => scope.listRoutingRules({ limit: MAX_ROUTING_RULES })

/**
 * Whether a Manager may point a rule at the target: a Rep on one of their Teams, their own Team,
 * or a pool of such Reps. Owner and Admin may point at anything.
 */
async function mayTarget(
  scope: OrganizationScope,
  role: Caller['role'],
  membershipId: MembershipId,
  target: RoutingTarget
): Promise<boolean> {
  if (role !== 'manager') {
    return true
  }
  if (target.kind === 'team') {
    return scope.isTeamMember(target.teamId, membershipId)
  }
  // shortcut: a Manager's first 1000 Reps; a Manager over more needs a per-Rep Team query.
  const managed = new Set(await scope.listManagedReps(membershipId, 1000))
  const named = target.kind === 'rep' ? [target.membershipId] : target.membershipIds
  return named.every((id) => managed.has(id))
}

/** Refuses a rule that names a Team, Rep or Booking Type this Organization does not have. */
async function requireValid(scope: OrganizationScope, request: CreateRoutingRuleRequest) {
  const { target, conditions } = request
  if (target.kind === 'team' && !(await scope.getTeam(target.teamId))) {
    throw invalid('target')
  }
  if (target.kind !== 'team') {
    const named = target.kind === 'rep' ? [target.membershipId] : target.membershipIds
    const found = await Promise.all(named.map((id) => scope.getMembership(id)))
    if (found.some((member) => member?.role !== 'rep')) {
      throw invalid('target')
    }
  }
  const types = await Promise.all(
    (conditions.bookingTypeIds ?? []).map((id) => scope.findBookingType(id))
  )
  if (types.some((type) => type === null)) {
    throw invalid('conditions.bookingTypeIds')
  }
  const owners = await Promise.all(
    (conditions.accountOwnerMembershipIds ?? []).map((id) => scope.getMembership(id))
  )
  if (owners.some((owner) => owner === null)) {
    throw invalid('conditions.accountOwnerMembershipIds')
  }
}

/** A rule the caller may change, or `routing.rule_not_found`. */
async function requireChangeable(
  scope: OrganizationScope,
  access: { role: Caller['role']; membershipId: MembershipId },
  id: RoutingRuleId
) {
  const rule = await scope.findRoutingRule(id)
  if (!rule || !(await mayTarget(scope, access.role, access.membershipId, rule.target))) {
    throw notFound()
  }
  return rule
}

/** Lists the rules in the order they are tried, one page at a time (at most 100). */
export async function list(
  deps: Pick<RoutingDeps, 'store'>,
  caller: Caller,
  query: z.infer<typeof listRoutingRulesQuerySchema>
): Promise<Page<RoutingRule>> {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, ruleCursor)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'routing_rule.read')
    const rows = await scope.listRoutingRules({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { afterPosition: after.position }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toResponse),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ position: last.position }) : null,
    }
  })
}

/** Reads one rule. */
export async function get(
  deps: Pick<RoutingDeps, 'store'>,
  caller: Caller,
  id: RoutingRuleId
): Promise<RoutingRule> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'routing_rule.read')
    const rule = await scope.findRoutingRule(id)
    if (!rule) {
      throw notFound()
    }
    return toResponse(rule)
  })
}

/**
 * Creates a rule before the default rule (or last). Owner and Admin anywhere, a Manager only
 * for their own Team's Reps (otherwise `routing.rule_not_found`). With an `Idempotency-Key` the
 * same request again returns the first one (200).
 */
export async function create(
  deps: RoutingDeps,
  caller: Caller,
  request: CreateRoutingRuleRequest,
  options: RoutingCallOptions
): Promise<IdempotentAnswer<200 | 201, RoutingRule>> {
  const now = deps.clock.now()
  const answer = await deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'routing_rules.create',
        request: { body: request },
        status: 201,
        response: routingRuleSchema,
      },
      async () => {
        const access = await openOrganizationForWrite(scope, caller, 'routing_rule.write')
        if (!(await mayTarget(scope, access.role, access.membershipId, request.target))) {
          throw notFound()
        }
        await requireValid(scope, request)
        const rules = await allRules(scope)
        if (rules.length >= MAX_ROUTING_RULES) {
          throw invalid('rules')
        }
        const makesDefault = isDefaultRule(request.conditions)
        if (makesDefault && rules.some((rule) => isDefaultRule(rule.conditions))) {
          throw invalid('conditions')
        }
        const id = formatId('rrl', crypto.randomUUID())
        await scope.insertRoutingRule({
          id,
          name: request.name,
          conditions: request.conditions,
          target: request.target,
          position: 0,
          createdAt: now,
        })
        const ordinary = rules.filter((rule) => !isDefaultRule(rule.conditions))
        const defaults = rules.filter((rule) => isDefaultRule(rule.conditions))
        const order = makesDefault ? [...ordinary, { id }] : [...ordinary, { id }, ...defaults]
        await scope.setRoutingRulePositions(
          order.map((rule) => rule.id),
          now
        )
        const stored = await scope.findRoutingRule(id)
        if (!stored) {
          throw new Error('The Routing Rule was not stored')
        }
        return toResponse(stored)
      }
    )
  )
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/** Replaces a rule's name, conditions and target; its place stays, except a rule that becomes the default goes last. */
export async function update(
  deps: RoutingDeps,
  caller: Caller,
  id: RoutingRuleId,
  request: CreateRoutingRuleRequest
): Promise<RoutingRule> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'routing_rule.write')
    await requireChangeable(scope, access, id)
    if (!(await mayTarget(scope, access.role, access.membershipId, request.target))) {
      throw notFound()
    }
    await requireValid(scope, request)
    const rules = await allRules(scope)
    const becomesDefault = isDefaultRule(request.conditions)
    if (becomesDefault && rules.some((rule) => rule.id !== id && isDefaultRule(rule.conditions))) {
      throw invalid('conditions')
    }
    await scope.updateRoutingRule(
      id,
      { name: request.name, conditions: request.conditions, target: request.target },
      now
    )
    if (becomesDefault) {
      await scope.setRoutingRulePositions(
        [...rules.filter((rule) => rule.id !== id).map((rule) => rule.id), id],
        now
      )
    }
    const stored = await scope.findRoutingRule(id)
    if (!stored) {
      throw notFound()
    }
    return toResponse(stored)
  })
}

/** Deletes a rule the caller may change; a rule already gone is a success. */
export async function remove(deps: RoutingDeps, caller: Caller, id: RoutingRuleId): Promise<void> {
  const now = deps.clock.now()
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'routing_rule.write')
    if (!(await scope.findRoutingRule(id))) {
      return
    }
    await requireChangeable(scope, access, id)
    await scope.deleteRoutingRule(id)
    const rest = (await allRules(scope)).map((rule) => rule.id)
    await scope.setRoutingRulePositions(rest, now)
  })
}

/** Sets the order of every rule from a list of all their ids; the default rule must be last. Owner and Admin only. */
export async function reorder(
  deps: RoutingDeps,
  caller: Caller,
  ruleIds: RoutingRuleId[]
): Promise<Page<RoutingRule>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganizationForWrite(scope, caller, 'routing_rule.reorder')
    const rules = await allRules(scope)
    const known = new Set(rules.map((rule) => rule.id))
    if (ruleIds.length !== rules.length || ruleIds.some((id) => !known.has(id))) {
      throw invalid('ruleIds')
    }
    const defaultRule = rules.find((rule) => isDefaultRule(rule.conditions))
    if (defaultRule && ruleIds.at(-1) !== defaultRule.id) {
      throw invalid('ruleIds')
    }
    await scope.setRoutingRulePositions(ruleIds, now)
    const rows = await scope.listRoutingRules({ limit: DEFAULT_PAGE_SIZE + 1 })
    const page = rows.slice(0, DEFAULT_PAGE_SIZE)
    const last = page.at(-1)
    return {
      items: page.map(toResponse),
      nextCursor:
        rows.length > DEFAULT_PAGE_SIZE && last ? encodeCursor({ position: last.position }) : null,
    }
  })
}

/** Refuses a Booking Type id that is not one of this Organization's. */
async function requireBookingType(scope: OrganizationScope, id: BookingTypeId | undefined) {
  if (id && !(await scope.findBookingType(id))) {
    throw domainError(BOOKING_ERRORS['booking.type_not_found'])
  }
}

/** Tests the rules with sample attributes: nothing is stored and no round-robin state moves. */
export async function test(
  deps: Pick<RoutingDeps, 'store' | 'clock'>,
  caller: Caller,
  request: TestRoutingRequest
): Promise<RoutingResult> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'routing.test')
    await requireBookingType(scope, request.bookingTypeId)
    return pick(scope, {
      attributes: request.attributes,
      bookingTypeId: request.bookingTypeId,
      now,
      mode: { store: null },
    })
  })
}

/** Routes a Prospect the caller may see: stores the decision and advances the round-robin. */
export async function route(
  deps: Pick<RoutingDeps, 'store' | 'clock'>,
  caller: Caller,
  request: RouteRequest
): Promise<RoutingResult> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'routing.route')
    await requireBookingType(scope, request.bookingTypeId)
    const { visibility } = await visibilityOf(scope, caller)
    const prospect = await scope.getProspect(request.prospectId, visibility)
    if (!prospect) {
      throw prospectNotFound()
    }
    const fields = prospect.companyId
      ? ((await scope.listCurrentFields('company', [prospect.companyId])).get(prospect.companyId) ??
        [])
      : []
    const field = (name: string) => fields.find((row) => row.field === name)?.value ?? null
    const size = Number(field('employeeCount'))
    return pick(scope, {
      attributes: {
        // Prospects carry no country yet; only the test route exercises a countries condition.
        country: null,
        region: field('region'),
        companySizeBand: field('employeeCount') === null ? null : bandOf(size),
        accountOwnerMembershipId: prospect.ownerMembershipId,
        source: prospect.source,
      },
      bookingTypeId: request.bookingTypeId,
      now,
      mode: { store: { prospectId: prospect.id } },
    })
  })
}

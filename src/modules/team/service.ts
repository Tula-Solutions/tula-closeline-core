import {
  CORE_ERRORS,
  type CreateTeamRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type ListTeamMembersQuery,
  type ListTeamMembersResponse,
  type ListTeamsQuery,
  type ListTeamsResponse,
  type MembershipId,
  type RenameTeamRequest,
  type Team,
  type TeamId,
  type TeamMember,
  teamMemberSchema,
  teamSchema,
} from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { memberCursorSchema, toMemberResponse } from '~/modules/member/schema'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { type OrganizationScope, TeamNameTakenError, type TeamRecord } from '~/ports/core-store'
import { teamCursorSchema, toTeamMemberResponse, toTeamResponse } from './schema'

/** What the Team service needs from the container. */
export type TeamDeps = Pick<Container, 'store' | 'clock' | 'logger'>

/** What a route that can be retried is given besides its request: the validated `Idempotency-Key` header, if sent. */
export type TeamCallOptions = { idempotencyKey?: string | undefined }

/** Maps the store's rule errors to the contract's codes; any other error passes unchanged. */
function asDomainError(error: unknown): unknown {
  if (error instanceof TeamNameTakenError) {
    return domainError(CORE_ERRORS['team.name_taken'])
  }
  return error
}

/** Reads a Team under a row lock; one in another Organization is not found, like one that does not exist. */
async function lockTeam(scope: OrganizationScope, teamId: TeamId): Promise<TeamRecord> {
  const team = await scope.lockTeam(teamId)
  if (!team) {
    throw domainError(CORE_ERRORS['team.not_found'])
  }
  return team
}

/** Reads a member under a row lock; one in another Organization is not found. */
async function lockMember(scope: OrganizationScope, membershipId: MembershipId): Promise<void> {
  if (!(await scope.lockMembership(membershipId))) {
    throw domainError(CORE_ERRORS['member.not_found'])
  }
}

/**
 * Lists the members of a Team, one page at a time, in Membership id order. Owner, Admin and
 * Manager (the roles that list the Organization's members, because each item carries an address).
 * A Team that does not exist and one of another Organization are both `team.not_found`.
 */
export async function listMembers(
  deps: Pick<TeamDeps, 'store'>,
  caller: Caller,
  teamId: TeamId,
  query: ListTeamMembersQuery
): Promise<ListTeamMembersResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, memberCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'team.list_members')
    if (!(await scope.getTeam(teamId))) {
      throw domainError(CORE_ERRORS['team.not_found'])
    }
    // One extra row says whether another page follows without a count.
    const rows = await scope.listTeamMembers({
      teamId,
      ...(after === undefined ? {} : { after: after.after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toMemberResponse),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ after: last.id }) : null,
    }
  })
}

/** Lists the Organization's Teams, one page at a time, in Team id order. Any role. */
export async function list(
  deps: Pick<TeamDeps, 'store'>,
  caller: Caller,
  query: ListTeamsQuery
): Promise<ListTeamsResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, teamCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'team.list')
    // One extra row says whether another page follows without a count.
    const rows = await scope.listTeams({
      ...(after === undefined ? {} : { after: after.after }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toTeamResponse),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ after: last.id }) : null,
    }
  })
}

/**
 * Creates a Team. Owner and Admin. A name already in use, ignoring ASCII case, is
 * `team.name_taken`. With an `Idempotency-Key` the same request again returns the first Team and
 * creates nothing (route `teams.create`).
 */
export async function create(
  deps: TeamDeps,
  caller: Caller,
  request: CreateTeamRequest,
  options: TeamCallOptions = {}
): Promise<IdempotentAnswer<201, Team>> {
  const now = deps.clock.now()
  try {
    return await deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'teams.create',
          request: { body: request },
          status: 201,
          response: teamSchema,
        },
        async () => {
          const { membershipId: actorId } = await openOrganizationForWrite(
            scope,
            caller,
            'team.create'
          )
          const team = await scope.insertTeam({
            id: formatId('team', crypto.randomUUID()),
            name: request.name,
            now,
          })
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: actorId },
            action: 'team.created',
            subject: { type: 'team', id: team.id },
          })
          return toTeamResponse(team)
        }
      )
    )
  } catch (error) {
    throw asDomainError(error)
  }
}

/** Renames a Team. Owner and Admin. Renaming it to its own name, in any case, is allowed. */
export async function rename(
  deps: TeamDeps,
  caller: Caller,
  teamId: TeamId,
  request: RenameTeamRequest
): Promise<Team> {
  const now = deps.clock.now()
  try {
    return await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const { membershipId: actorId } = await openOrganizationForWrite(scope, caller, 'team.rename')
      await lockTeam(scope, teamId)
      const renamed = await scope.renameTeam(teamId, request.name, now)
      if (!renamed) {
        throw domainError(CORE_ERRORS['team.not_found'])
      }
      await Audit.recordIn(scope, caller.organizationId, {
        occurredAt: now,
        actor: { kind: 'member', membershipId: actorId },
        action: 'team.renamed',
        subject: { type: 'team', id: teamId },
      })
      return toTeamResponse(renamed)
    })
  } catch (error) {
    throw asDomainError(error)
  }
}

/**
 * Deletes a Team. Owner and Admin. The database removes its places and clears it from pending
 * Invitations in the same statement, so no member is loaded into the process. The cascade still costs time proportional to the Team's
 * size, with the Organization lock held.
 */
export async function remove(deps: TeamDeps, caller: Caller, teamId: TeamId): Promise<void> {
  const now = deps.clock.now()
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const { membershipId: actorId } = await openOrganizationForWrite(scope, caller, 'team.delete')
    await lockTeam(scope, teamId)
    if (!(await scope.deleteTeam(teamId))) {
      throw domainError(CORE_ERRORS['team.not_found'])
    }
    await Audit.recordIn(scope, caller.organizationId, {
      occurredAt: now,
      actor: { kind: 'member', membershipId: actorId },
      action: 'team.deleted',
      subject: { type: 'team', id: teamId },
    })
  })
}

/**
 * Adds a member to a Team. Owner and Admin. Adding one who is already in it succeeds and changes
 * nothing. With an `Idempotency-Key` the same request again returns the first answer (route
 * `teams.add_member`; the Team is part of the request, so the same key on another Team is another request).
 */
export async function addMember(
  deps: TeamDeps,
  caller: Caller,
  teamId: TeamId,
  membershipId: MembershipId,
  options: TeamCallOptions = {}
): Promise<IdempotentAnswer<200, TeamMember>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'teams.add_member',
        request: { params: { teamId }, body: { membershipId } },
        status: 200,
        response: teamMemberSchema,
      },
      async () => {
        const { membershipId: actorId } = await openOrganizationForWrite(
          scope,
          caller,
          'team.add_member'
        )
        await lockTeam(scope, teamId)
        await lockMember(scope, membershipId)
        const place = await scope.addTeamMember(teamId, membershipId, now)
        // An existing place comes back with its first createdAt: only a new one is an event.
        if (place.createdAt.getTime() === now.getTime()) {
          await Audit.recordIn(scope, caller.organizationId, {
            occurredAt: now,
            actor: { kind: 'member', membershipId: actorId },
            action: 'team.member_added',
            subject: { type: 'team', id: teamId },
            metadata: { membershipId },
          })
        }
        return toTeamMemberResponse(place)
      }
    )
  )
}

/** What a stored Team-member removal holds: nothing, since the route answers 204 with no body. */
const removedSchema = z.object({})

/**
 * Removes a member from a Team. Owner and Admin. One who is not in the Team is `member.not_found`
 * (the contract has no code for a missing place), so no removal is ever reported that did not
 * happen. With an `Idempotency-Key` the same request again replays the stored 204 (route
 * `teams.remove_member`); a request with no key or a new key on a non-member is still not found.
 */
export async function removeMember(
  deps: TeamDeps,
  caller: Caller,
  teamId: TeamId,
  membershipId: MembershipId,
  options: TeamCallOptions = {}
): Promise<IdempotentAnswer<204, Record<string, never>>> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, (scope) =>
    idempotent(
      deps,
      scope,
      caller,
      {
        key: options.idempotencyKey,
        route: 'teams.remove_member',
        request: { params: { teamId, membershipId } },
        status: 204,
        response: removedSchema as z.ZodType<Record<string, never>>,
      },
      async () => {
        const { membershipId: actorId } = await openOrganizationForWrite(
          scope,
          caller,
          'team.remove_member'
        )
        await lockTeam(scope, teamId)
        await lockMember(scope, membershipId)
        if (!(await scope.removeTeamMember(teamId, membershipId))) {
          throw domainError(CORE_ERRORS['member.not_found'])
        }
        await Audit.recordIn(scope, caller.organizationId, {
          occurredAt: now,
          actor: { kind: 'member', membershipId: actorId },
          action: 'team.member_removed',
          subject: { type: 'team', id: teamId },
          metadata: { membershipId },
        })
        return {}
      }
    )
  )
}

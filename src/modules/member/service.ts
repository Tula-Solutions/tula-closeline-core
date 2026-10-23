import {
  CORE_ERRORS,
  decodeCursor,
  ERRORS,
  encodeCursor,
  type ListMembersQuery,
  type ListMembersResponse,
  type Member,
  type MembershipId,
  type Role,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import * as Audit from '~/modules/audit/service'
import type { Caller } from '~/modules/caller'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import {
  AlreadyMemberError,
  LastOwnerError,
  type MembershipRecord,
  type OrganizationScope,
} from '~/ports/core-store'
import { isAllowed } from './permission'
import { memberCursorSchema, toMemberResponse } from './schema'

/** What the member service needs from the container. */
export type MemberDeps = Pick<Container, 'store' | 'clock'>

/** Lists the Organization's members, one page at a time, in Membership id order. Owner, Admin, Manager. */
export async function list(
  deps: MemberDeps,
  caller: Caller,
  query: ListMembersQuery
): Promise<ListMembersResponse> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, memberCursorSchema)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'member.list')
    // One extra row says whether another page follows without a count.
    const rows = await scope.listMembers({
      ...(after === undefined ? {} : { after: after.after }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.ids === undefined ? {} : { ids: query.ids }),
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

/**
 * Reads the member a change is about under a row lock, after the caller has been allowed to
 * attempt it, so the permission check and the write see the same row. A member of another
 * Organization is not found, exactly as one that does not exist; and nobody changes themselves
 * through these routes: the only Owner doing so is told why (`member.last_owner`), anyone else is
 * forbidden.
 */
async function lockTarget(
  scope: OrganizationScope,
  caller: Caller,
  membershipId: MembershipId
): Promise<MembershipRecord> {
  const target = await scope.lockMembership(membershipId)
  if (!target) {
    throw domainError(CORE_ERRORS['member.not_found'])
  }
  if (target.userId === caller.userId) {
    if (target.role === 'owner' && !(await scope.hasOtherOwner(target.id))) {
      throw domainError(CORE_ERRORS['member.last_owner'])
    }
    throw domainError(ERRORS['auth.forbidden'])
  }
  return target
}

/** Maps the store's rule errors to the contract's codes; any other error passes unchanged. */
function asDomainError(error: unknown): unknown {
  if (error instanceof LastOwnerError) {
    return domainError(CORE_ERRORS['member.last_owner'])
  }
  if (error instanceof AlreadyMemberError) {
    return domainError(CORE_ERRORS['membership.already_member'])
  }
  return error
}

/**
 * Changes a member's role. Owner: any member to any role. Admin: a Manager or Rep, to Manager or
 * Rep. Nobody changes their own role, and the last Owner cannot be demoted (`member.last_owner`).
 * The caller's role is read again under the Organization's lock, not taken from the token.
 */
export async function changeRole(
  deps: MemberDeps,
  caller: Caller,
  membershipId: MembershipId,
  role: Role
): Promise<Member> {
  const now = deps.clock.now()
  try {
    return await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const { role: actor, membershipId: actorId } = await openOrganizationForWrite(
        scope,
        caller,
        'member.change_role'
      )
      const target = await lockTarget(scope, caller, membershipId)
      if (
        !isAllowed({
          actor,
          action: 'member.change_role',
          targetRole: target.role,
          newRole: role,
        })
      ) {
        throw domainError(ERRORS['auth.forbidden'])
      }
      if (target.role === role) {
        return toMemberResponse(target)
      }
      const changed = await scope.setRole(target.id, role, now)
      if (!changed) {
        throw domainError(CORE_ERRORS['member.not_found'])
      }
      await Audit.recordIn(scope, caller.organizationId, {
        occurredAt: now,
        actor: { kind: 'member', membershipId: actorId },
        action: 'member.role_changed',
        subject: { type: 'membership', id: target.id },
        metadata: { fromRole: target.role, toRole: role },
      })
      return toMemberResponse(changed)
    })
  } catch (error) {
    throw asDomainError(error)
  }
}

/**
 * Removes a member. Owner: any member. Admin: a Manager or Rep. Nobody removes themselves, and
 * the last Owner cannot be removed (`member.last_owner`). Removing an absent member is not found.
 */
export async function remove(
  deps: MemberDeps,
  caller: Caller,
  membershipId: MembershipId
): Promise<void> {
  const now = deps.clock.now()
  try {
    await deps.store.withOrganization(caller.organizationId, async (scope) => {
      const { role: actor, membershipId: actorId } = await openOrganizationForWrite(
        scope,
        caller,
        'member.remove'
      )
      const target = await lockTarget(scope, caller, membershipId)
      if (!isAllowed({ actor, action: 'member.remove', targetRole: target.role })) {
        throw domainError(ERRORS['auth.forbidden'])
      }
      if (!(await scope.deleteMembership(target.id))) {
        throw domainError(CORE_ERRORS['member.not_found'])
      }
      await Audit.recordIn(scope, caller.organizationId, {
        occurredAt: now,
        actor: { kind: 'member', membershipId: actorId },
        action: 'member.removed',
        subject: { type: 'membership', id: target.id },
        metadata: { role: target.role },
      })
    })
  } catch (error) {
    throw asDomainError(error)
  }
}

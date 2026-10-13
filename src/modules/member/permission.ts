import type { Role } from 'tula-closeline-contract'

/** Every action a caller can ask of the Organization and member routes. */
export const ACTIONS = [
  'organization.read',
  'organization.rename',
  'member.list',
  'member.change_role',
  'member.remove',
] as const

/** An action on the Organization or its members. */
export type Action = (typeof ACTIONS)[number]

/** The actions that change something; a suspended Organization refuses these and allows the rest. */
export const WRITE_ACTIONS: readonly Action[] = [
  'organization.rename',
  'member.change_role',
  'member.remove',
]

/** The roles an Admin may manage and hand out; only an Owner touches Owners and Admins. */
const ADMIN_MANAGEABLE: readonly Role[] = ['manager', 'rep']

/** For each action, the roles that may attempt it at all. */
const MAY_ATTEMPT: Readonly<Record<Action, readonly Role[]>> = {
  'organization.read': ['owner', 'admin', 'manager', 'rep'],
  'organization.rename': ['owner', 'admin'],
  'member.list': ['owner', 'admin', 'manager'],
  'member.change_role': ['owner', 'admin'],
  'member.remove': ['owner', 'admin'],
}

/** What a caller asks to do, with the target's role where the action has a target. */
export type PermissionRequest =
  | { actor: Role; action: 'organization.read' | 'organization.rename' | 'member.list' }
  | { actor: Role; action: 'member.change_role'; targetRole: Role; newRole: Role }
  | { actor: Role; action: 'member.remove'; targetRole: Role }

/** Whether `action` changes something, so a suspended Organization refuses it. */
export function isWrite(action: Action): boolean {
  return WRITE_ACTIONS.includes(action)
}

/**
 * Whether a role may attempt the action at all, whoever the target is. The service asks this
 * before it looks a member up, so a caller who may never do it learns nothing about members.
 */
export function mayAttempt(actor: Role, action: Action): boolean {
  return MAY_ATTEMPT[action].includes(actor)
}

/**
 * Who may do what (the one place the rules live). An Owner may change any member to any role and
 * remove any member; an Admin may change or remove only a Manager or Rep, and only to Manager or
 * Rep; a Manager may read the Organization and list members; a Rep may read the Organization.
 * Self-targeting and the last Owner are not roles' business and are checked by the service.
 */
export function isAllowed(request: PermissionRequest): boolean {
  if (!mayAttempt(request.actor, request.action)) {
    return false
  }
  switch (request.action) {
    case 'member.change_role':
      return (
        request.actor === 'owner' ||
        (ADMIN_MANAGEABLE.includes(request.targetRole) &&
          ADMIN_MANAGEABLE.includes(request.newRole))
      )
    case 'member.remove':
      return request.actor === 'owner' || ADMIN_MANAGEABLE.includes(request.targetRole)
    default:
      return true
  }
}

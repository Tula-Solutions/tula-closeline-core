import type { InvitableRole, Role } from 'tula-closeline-contract'

/** Every action a caller can ask of the Organization, member, invitation, Team, Prospect and Prospect Company routes. */
export const ACTIONS = [
  'organization.read',
  'organization.rename',
  'member.list',
  'member.change_role',
  'member.remove',
  'invitation.create',
  'invitation.list',
  'invitation.revoke',
  'team.list',
  'team.list_members',
  'team.create',
  'team.rename',
  'team.delete',
  'team.add_member',
  'team.remove_member',
  'prospect.create',
  'prospect.update',
  'prospect.read',
  'prospect.list',
  'prospect.assign',
  'prospect_company.create',
  'prospect_company.update',
  'prospect_company.read',
  'prospect_company.list',
] as const

/** An action on the Organization, its members, its Invitations or its Teams. */
export type Action = (typeof ACTIONS)[number]

/** The actions that change something; a suspended Organization refuses these and allows the rest. */
export const WRITE_ACTIONS: readonly Action[] = [
  'organization.rename',
  'member.change_role',
  'member.remove',
  'invitation.create',
  'invitation.revoke',
  'team.create',
  'team.rename',
  'team.delete',
  'team.add_member',
  'team.remove_member',
  'prospect.create',
  'prospect.update',
  'prospect.assign',
  'prospect_company.create',
  'prospect_company.update',
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
  'invitation.create': ['owner', 'admin'],
  'invitation.list': ['owner', 'admin'],
  'invitation.revoke': ['owner', 'admin'],
  'team.list': ['owner', 'admin', 'manager', 'rep'],
  'team.list_members': ['owner', 'admin', 'manager'],
  'team.create': ['owner', 'admin'],
  'team.rename': ['owner', 'admin'],
  'team.delete': ['owner', 'admin'],
  'team.add_member': ['owner', 'admin'],
  'team.remove_member': ['owner', 'admin'],
  'prospect.create': ['owner', 'admin', 'manager', 'rep'],
  'prospect.update': ['owner', 'admin', 'manager', 'rep'],
  'prospect.read': ['owner', 'admin', 'manager', 'rep'],
  'prospect.list': ['owner', 'admin', 'manager', 'rep'],
  'prospect.assign': ['owner', 'admin'],
  'prospect_company.create': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.update': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.read': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.list': ['owner', 'admin', 'manager', 'rep'],
}

/** What a caller asks to do, with the target's role where the action has a target. */
export type PermissionRequest =
  | {
      actor: Role
      action:
        | 'organization.read'
        | 'organization.rename'
        | 'member.list'
        | 'invitation.list'
        | 'team.list'
        | 'team.list_members'
        | 'team.create'
        | 'team.rename'
        | 'team.delete'
        | 'team.add_member'
        | 'team.remove_member'
        | 'prospect.create'
        | 'prospect.update'
        | 'prospect.read'
        | 'prospect.list'
        | 'prospect.assign'
        | 'prospect_company.create'
        | 'prospect_company.update'
        | 'prospect_company.read'
        | 'prospect_company.list'
    }
  | { actor: Role; action: 'invitation.create'; offeredRole: InvitableRole }
  | { actor: Role; action: 'invitation.revoke'; targetRole: InvitableRole }
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
 * An Owner may invite for any invitable role and revoke any Invitation; an Admin only for (and
 * only those offering) Manager or Rep; Owner and Admin list Invitations. Every role lists Teams;
 * Owner, Admin and Manager list a Team's members (each item carries an address, as the members list does);
 * Owner and Admin create, rename and delete them and add or remove their members.
 * Every role may create, edit, read and list Prospects and Prospect Companies; which Prospects a
 * role sees is decided by the Prospect service. Owner and Admin assign Prospect owners, one or many. Self-targeting and the last Owner are not roles' business and are checked by the service.
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
    case 'invitation.revoke':
      return request.actor === 'owner' || ADMIN_MANAGEABLE.includes(request.targetRole)
    case 'invitation.create':
      return request.actor === 'owner' || ADMIN_MANAGEABLE.includes(request.offeredRole)
    default:
      return true
  }
}

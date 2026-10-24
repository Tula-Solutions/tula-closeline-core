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
  'prospect.erase',
  'export.create',
  'export.read',
  'export.download',
  'inbox.correct',
  'prospect_import.create',
  'prospect_import.read',
  'prospect_company.create',
  'prospect_company.update',
  'prospect_company.read',
  'prospect_company.list',
  'suppression.add',
  'suppression.remove',
  'suppression.read',
  'suppression.list',
  'suppression.lookup',
  'contact_check.list',
  'audit.list',
  'audit.read',
  'audit.verify',
  'audit.csv',
  'consent.record',
  'consent.withdraw',
  'consent.read',
  'consent.evidence',
  'consent_wording.create',
  'consent_wording.update',
  'consent_wording.read',
  'consent_form.create',
  'consent_form.publish',
  'consent_form.close',
  'consent_form.read',
  'crm.read',
  'crm.connect',
  'crm.disconnect',
  'api_key.create',
  'api_key.list',
  'api_key.revoke',
  'agent_instructions.read',
  'agent_instructions.write',
  'inbox.list',
  'inbox.read',
  'inbox.approve',
  'inbox.reply',
  'inbox.decisions',
  'inbox.policy_read',
  'inbox.policy_write',
  'analytics.read',
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
  'prospect.erase',
  'export.create',
  'export.download',
  'inbox.correct',
  'inbox.approve',
  'inbox.reply',
  'inbox.policy_write',
  'prospect_import.create',
  'prospect_company.create',
  'prospect_company.update',
  'suppression.add',
  'suppression.remove',
  'audit.csv',
  'consent.record',
  'consent_wording.create',
  'consent_wording.update',
  'consent_form.create',
  'consent_form.publish',
  'consent_form.close',
  'crm.connect',
  'crm.disconnect',
  'api_key.create',
  'api_key.revoke',
  'agent_instructions.write',
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
  'prospect.erase': ['owner', 'admin'],
  'export.create': ['owner', 'admin'],
  'export.read': ['owner', 'admin'],
  'export.download': ['owner', 'admin'],
  'inbox.correct': ['owner', 'admin', 'manager', 'rep'],
  'prospect_import.create': ['owner', 'admin'],
  'prospect_import.read': ['owner', 'admin'],
  'prospect_company.create': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.update': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.read': ['owner', 'admin', 'manager', 'rep'],
  'prospect_company.list': ['owner', 'admin', 'manager', 'rep'],
  'suppression.add': ['owner', 'admin'],
  'suppression.remove': ['owner', 'admin'],
  'suppression.read': ['owner', 'admin'],
  'suppression.list': ['owner', 'admin'],
  'suppression.lookup': ['owner', 'admin'],
  'contact_check.list': ['owner', 'admin'],
  'audit.list': ['owner', 'admin', 'manager'],
  'audit.read': ['owner', 'admin', 'manager'],
  'audit.verify': ['owner', 'admin'],
  'audit.csv': ['owner', 'admin'],
  'consent.record': ['owner', 'admin', 'manager', 'rep'],
  'consent.withdraw': ['owner', 'admin', 'manager', 'rep'],
  'consent.read': ['owner', 'admin', 'manager', 'rep'],
  'consent.evidence': ['owner', 'admin'],
  'consent_wording.create': ['owner', 'admin'],
  'consent_wording.update': ['owner', 'admin'],
  'consent_wording.read': ['owner', 'admin', 'manager', 'rep'],
  'consent_form.create': ['owner', 'admin'],
  'consent_form.publish': ['owner', 'admin'],
  'consent_form.close': ['owner', 'admin'],
  'consent_form.read': ['owner', 'admin', 'manager', 'rep'],
  'crm.read': ['owner', 'admin', 'manager'],
  'crm.connect': ['owner', 'admin'],
  'crm.disconnect': ['owner', 'admin'],
  'api_key.create': ['owner', 'admin'],
  'api_key.list': ['owner', 'admin'],
  'api_key.revoke': ['owner', 'admin'],
  'agent_instructions.read': ['owner', 'admin', 'manager'],
  'agent_instructions.write': ['owner', 'admin'],
  'inbox.list': ['owner', 'admin', 'manager', 'rep'],
  'inbox.read': ['owner', 'admin', 'manager', 'rep'],
  'inbox.approve': ['owner', 'admin', 'manager', 'rep'],
  'inbox.reply': ['owner', 'admin', 'manager', 'rep'],
  'inbox.decisions': ['owner', 'admin', 'manager'],
  'inbox.policy_read': ['owner', 'admin'],
  'inbox.policy_write': ['owner', 'admin'],
  'analytics.read': ['owner', 'admin'],
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
        | 'prospect.erase'
        | 'export.create'
        | 'export.read'
        | 'export.download'
        | 'inbox.correct'
        | 'prospect_import.create'
        | 'prospect_import.read'
        | 'prospect_company.create'
        | 'prospect_company.update'
        | 'prospect_company.read'
        | 'prospect_company.list'
        | 'suppression.add'
        | 'suppression.remove'
        | 'suppression.read'
        | 'suppression.list'
        | 'suppression.lookup'
        | 'contact_check.list'
        | 'audit.list'
        | 'audit.read'
        | 'audit.verify'
        | 'audit.csv'
        | 'consent.record'
        | 'consent.withdraw'
        | 'consent.read'
        | 'consent.evidence'
        | 'consent_wording.create'
        | 'consent_wording.update'
        | 'consent_wording.read'
        | 'consent_form.create'
        | 'consent_form.publish'
        | 'consent_form.close'
        | 'consent_form.read'
        | 'crm.read'
        | 'crm.connect'
        | 'crm.disconnect'
        | 'api_key.create'
        | 'api_key.list'
        | 'api_key.revoke'
        | 'agent_instructions.read'
        | 'agent_instructions.write'
        | 'inbox.list'
        | 'inbox.read'
        | 'inbox.approve'
        | 'inbox.reply'
        | 'inbox.decisions'
        | 'inbox.policy_read'
        | 'inbox.policy_write'
        | 'analytics.read'
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
 * role sees is decided by the Prospect service. Owner and Admin assign Prospect owners, one or many, and alone manage the suppression list and read the Contact Check log, and connect and disconnect a CRM (a Manager may read its status). Self-targeting and the last Owner are not roles' business and are checked by the service.
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

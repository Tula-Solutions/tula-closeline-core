import { describe, expect, test } from 'bun:test'
import { INVITABLE_ROLES, ROLES, type Role } from 'tula-closeline-contract'
import { ACTIONS, isAllowed, isWrite, mayAttempt, WRITE_ACTIONS } from './permission'

// The table of who may do what, written out by hand, not derived from the code under test.
const SIMPLE = {
  'organization.read': ['owner', 'admin', 'manager', 'rep'],
  'organization.rename': ['owner', 'admin'],
  'member.list': ['owner', 'admin', 'manager'],
  'invitation.list': ['owner', 'admin'],
  'team.list': ['owner', 'admin', 'manager', 'rep'],
  'team.create': ['owner', 'admin'],
  'team.rename': ['owner', 'admin'],
  'team.delete': ['owner', 'admin'],
  'team.add_member': ['owner', 'admin'],
  'team.remove_member': ['owner', 'admin'],
  'prospect.assign': ['owner', 'admin'],
  'prospect.create': ['owner', 'admin', 'manager', 'rep'],
  'prospect.update': ['owner', 'admin', 'manager', 'rep'],
  'prospect.read': ['owner', 'admin', 'manager', 'rep'],
  'prospect.list': ['owner', 'admin', 'manager', 'rep'],
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
} as const satisfies Record<string, readonly Role[]>

describe('actions without a target', () => {
  const cases = ROLES.flatMap((actor) =>
    (Object.keys(SIMPLE) as (keyof typeof SIMPLE)[]).map(
      (action) => [actor, action, (SIMPLE[action] as readonly Role[]).includes(actor)] as const
    )
  )

  test.each(cases)('%s asking to %s is allowed: %p', (actor, action, expected) => {
    expect(isAllowed({ actor, action })).toBe(expected)
    expect(mayAttempt(actor, action)).toBe(expected)
  })
})

describe('creating an Invitation', () => {
  const rows = ROLES.flatMap((actor) =>
    INVITABLE_ROLES.map((offeredRole) => {
      const expected =
        actor === 'owner' ||
        (actor === 'admin' && (offeredRole === 'manager' || offeredRole === 'rep'))
      return [actor, offeredRole, expected] as const
    })
  )

  test.each(rows)('%s inviting for %s is allowed: %p', (actor, offeredRole, expected) => {
    expect(isAllowed({ actor, action: 'invitation.create', offeredRole })).toBe(expected)
  })
})

describe('revoking an Invitation', () => {
  const rows = ROLES.flatMap((actor) =>
    INVITABLE_ROLES.map((targetRole) => {
      const expected =
        actor === 'owner' ||
        (actor === 'admin' && (targetRole === 'manager' || targetRole === 'rep'))
      return [actor, targetRole, expected] as const
    })
  )

  test.each(rows)('%s revoking one for %s is allowed: %p', (actor, targetRole, expected) => {
    expect(isAllowed({ actor, action: 'invitation.revoke', targetRole })).toBe(expected)
  })
})

describe('changing a role', () => {
  const rows = ROLES.flatMap((actor) =>
    ROLES.flatMap((targetRole) =>
      ROLES.map((newRole) => {
        const expected =
          actor === 'owner' ||
          (actor === 'admin' &&
            (targetRole === 'manager' || targetRole === 'rep') &&
            (newRole === 'manager' || newRole === 'rep'))
        return [actor, targetRole, newRole, expected] as const
      })
    )
  )

  test.each(rows)(
    '%s changing a %s to %s is allowed: %p',
    (actor, targetRole, newRole, expected) => {
      expect(isAllowed({ actor, action: 'member.change_role', targetRole, newRole })).toBe(expected)
    }
  )

  test('only the Owner may promote to Owner or Admin, or touch an Owner or Admin', () => {
    expect(
      isAllowed({
        actor: 'admin',
        action: 'member.change_role',
        targetRole: 'rep',
        newRole: 'admin',
      })
    ).toBe(false)
    expect(
      isAllowed({
        actor: 'admin',
        action: 'member.change_role',
        targetRole: 'rep',
        newRole: 'owner',
      })
    ).toBe(false)
    expect(
      isAllowed({
        actor: 'admin',
        action: 'member.change_role',
        targetRole: 'admin',
        newRole: 'rep',
      })
    ).toBe(false)
    expect(
      isAllowed({
        actor: 'owner',
        action: 'member.change_role',
        targetRole: 'rep',
        newRole: 'owner',
      })
    ).toBe(true)
  })
})

describe('removing a member', () => {
  const rows = ROLES.flatMap((actor) =>
    ROLES.map((targetRole) => {
      const expected =
        actor === 'owner' ||
        (actor === 'admin' && (targetRole === 'manager' || targetRole === 'rep'))
      return [actor, targetRole, expected] as const
    })
  )

  test.each(rows)('%s removing a %s is allowed: %p', (actor, targetRole, expected) => {
    expect(isAllowed({ actor, action: 'member.remove', targetRole })).toBe(expected)
  })
})

test('a Manager and a Rep may never attempt a change, whoever the target', () => {
  for (const actor of ['manager', 'rep'] as const) {
    expect(mayAttempt(actor, 'member.change_role')).toBe(false)
    expect(mayAttempt(actor, 'member.remove')).toBe(false)
  }
})

test('exactly the changes are writes, and every read is not', () => {
  expect(ACTIONS.filter(isWrite).sort()).toEqual([...WRITE_ACTIONS].sort())
  expect([...WRITE_ACTIONS].sort()).toEqual([
    'invitation.create',
    'invitation.revoke',
    'member.change_role',
    'member.remove',
    'organization.rename',
    'prospect.assign',
    'prospect.create',
    'prospect.update',
    'prospect_company.create',
    'prospect_company.update',
    'suppression.add',
    'suppression.remove',
    'team.add_member',
    'team.create',
    'team.delete',
    'team.remove_member',
    'team.rename',
  ])
  for (const read of [
    'organization.read',
    'member.list',
    'invitation.list',
    'team.list',
  ] as const) {
    expect(isWrite(read)).toBe(false)
  }
})

test('a role outside the four is never allowed anything', () => {
  const stranger = 'superuser' as Role
  for (const action of ACTIONS) {
    expect(mayAttempt(stranger, action)).toBe(false)
  }
})

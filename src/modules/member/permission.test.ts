import { describe, expect, test } from 'bun:test'
import { ROLES, type Role } from 'tula-closeline-contract'
import { ACTIONS, isAllowed, isWrite, mayAttempt, WRITE_ACTIONS } from './permission'

// The table of who may do what, written out by hand, not derived from the code under test.
const SIMPLE: Record<'organization.read' | 'organization.rename' | 'member.list', Role[]> = {
  'organization.read': ['owner', 'admin', 'manager', 'rep'],
  'organization.rename': ['owner', 'admin'],
  'member.list': ['owner', 'admin', 'manager'],
}

describe('actions without a target', () => {
  const cases = ROLES.flatMap((actor) =>
    (Object.keys(SIMPLE) as (keyof typeof SIMPLE)[]).map(
      (action) => [actor, action, SIMPLE[action].includes(actor)] as const
    )
  )

  test.each(cases)('%s asking to %s is allowed: %p', (actor, action, expected) => {
    expect(isAllowed({ actor, action })).toBe(expected)
    expect(mayAttempt(actor, action)).toBe(expected)
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

test('exactly the renaming and member changes are writes', () => {
  expect(ACTIONS.filter(isWrite).sort()).toEqual([...WRITE_ACTIONS].sort())
  expect([...WRITE_ACTIONS].sort()).toEqual([
    'member.change_role',
    'member.remove',
    'organization.rename',
  ])
})

test('a role outside the four is never allowed anything', () => {
  const stranger = 'superuser' as Role
  for (const action of ACTIONS) {
    expect(mayAttempt(stranger, action)).toBe(false)
  }
})

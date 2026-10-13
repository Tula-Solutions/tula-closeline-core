import { expect, test } from 'bun:test'
import { INVITABLE_ROLES, ROLES } from 'tula-closeline-contract'
import { isAllowed, type PermissionRequest } from '../src/modules/member/permission'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The permission function runs once or twice on every public request. Complexity: O(1), a lookup
// in a four-element list and a switch. Input: every combination of actor, target and new role
// (64 role changes, 16 removals, 12 member and Organization actions, 12 Team and Invitation
// listings and renames, 24 Invitation creations and revocations), cycled. Each "request" is one call.
// Typical best batch: under 0.1 ms for 500 calls. Budget: 1 ms, ten times that and above the
// timer's resolution, so only a loop or an allocation per call would fail it.
const BUDGET_MS = 1

function requests(): PermissionRequest[] {
  const list: PermissionRequest[] = []
  for (const actor of ROLES) {
    for (const targetRole of ROLES) {
      list.push({ actor, action: 'member.remove', targetRole })
      for (const newRole of ROLES) {
        list.push({ actor, action: 'member.change_role', targetRole, newRole })
      }
    }
    list.push({ actor, action: 'organization.read' })
    list.push({ actor, action: 'organization.rename' })
    list.push({ actor, action: 'member.list' })
    list.push({ actor, action: 'invitation.list' })
    list.push({ actor, action: 'team.list' })
    list.push({ actor, action: 'team.rename' })
    for (const role of INVITABLE_ROLES) {
      list.push({ actor, action: 'invitation.create', offeredRole: role })
      list.push({ actor, action: 'invitation.revoke', targetRole: role })
    }
  }
  return list
}

test(`permission: the best of ${BATCHES} batches of ${BATCH_REQUESTS} calls is within ${BUDGET_MS} ms`, async () => {
  const all = requests()

  const result = await measure((index) => isAllowed(all[index % all.length] as PermissionRequest))

  console.log(summary('permission', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})

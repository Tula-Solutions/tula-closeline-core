import { describe, expect, test } from 'bun:test'
import type { OrganizationId, OrganizationStatus } from 'tula-closeline-contract'
import { newMembershipId, newOrganizationId, newUserId } from '~/testing'
import { AlreadyMemberError, type CoreStore, LastOwnerError } from './core-store'

/** What a {@link describeCoreStore} run needs from the adapter under test. */
export type CoreStoreHarness = {
  store: CoreStore
  /** Sets an Organization's status the way an operator would, outside the store's port. */
  setStatus(organizationId: OrganizationId, status: OrganizationStatus): Promise<void>
}

const NOW = new Date('2026-01-01T00:00:00.000Z')
const LATER = new Date('2026-01-02T00:00:00.000Z')

/**
 * The behaviour every {@link CoreStore} adapter must show, run against the memory adapter and
 * the Postgres one alike: tenant scoping, one Organization per user, the last-Owner rule and the
 * rollback of a failed transaction.
 */
export function describeCoreStore(label: string, make: () => Promise<CoreStoreHarness>): void {
  describe(`CoreStore: ${label}`, () => {
    async function seed(harness: CoreStoreHarness, extraOwners = 0) {
      const organizationId = newOrganizationId()
      const ownerUserId = newUserId()
      const ownerMembershipId = newMembershipId()
      const otherOwners = Array.from({ length: extraOwners }, () => ({
        id: newMembershipId(),
        userId: newUserId(),
      }))
      await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.insertOrganization({ name: 'Acme', region: 'us', now: NOW })
        await scope.insertMembership({
          id: ownerMembershipId,
          userId: ownerUserId,
          role: 'owner',
          now: NOW,
        })
        for (const owner of otherOwners) {
          await scope.insertMembership({ ...owner, role: 'owner', now: NOW })
        }
      })
      return { organizationId, ownerUserId, ownerMembershipId, otherOwners }
    }

    test('an Organization is created with its Owner and read back', async () => {
      const harness = await make()
      const { organizationId, ownerUserId, ownerMembershipId } = await seed(harness)

      const read = await harness.store.withOrganization(organizationId, async (scope) => ({
        organization: await scope.getOrganization(),
        byUser: await scope.getMembershipByUser(ownerUserId),
        byId: await scope.getMembership(ownerMembershipId),
      }))

      expect(read.organization).toMatchObject({
        id: organizationId,
        name: 'Acme',
        status: 'active',
      })
      expect(read.organization?.region).toBe('us')
      expect(read.byUser).toMatchObject({ id: ownerMembershipId, role: 'owner' })
      expect(read.byId?.userId).toBe(ownerUserId)
    })

    test('an Organization with no Owner does not commit', async () => {
      const { store } = await make()
      const organizationId = newOrganizationId()

      await expect(
        store.withOrganization(organizationId, async (scope) => {
          await scope.insertOrganization({ name: 'Orphan', region: 'us', now: NOW })
        })
      ).rejects.toThrow()

      const found = await store.withOrganization(organizationId, (scope) => scope.getOrganization())
      expect(found).toBeNull()
    })

    test('a transaction that fails leaves nothing behind', async () => {
      const { store } = await make()
      const organizationId = newOrganizationId()
      const userId = newUserId()

      await expect(
        store.withOrganization(organizationId, async (scope) => {
          await scope.insertOrganization({ name: 'Doomed', region: 'us', now: NOW })
          await scope.insertMembership({ id: newMembershipId(), userId, role: 'owner', now: NOW })
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')

      expect(await store.organizationOfUser(userId)).toBeNull()
      expect(await store.withOrganization(organizationId, (s) => s.getOrganization())).toBeNull()
    })

    test('a scope sees and changes nothing of another Organization', async () => {
      const harness = await make()
      const mine = await seed(harness, 1)
      const theirs = await seed(harness)

      const view = await harness.store.withOrganization(theirs.organizationId, async (scope) => ({
        organization: await scope.getOrganization(),
        listed: await scope.listMembers({ limit: 10 }),
        mine: await scope.getMembership(mine.ownerMembershipId),
        mineByUser: await scope.getMembershipByUser(mine.ownerUserId),
        changed: await scope.setRole(mine.ownerMembershipId, 'rep', LATER),
        removed: await scope.deleteMembership(mine.ownerMembershipId),
      }))

      expect(view.organization?.id).toBe(theirs.organizationId)
      expect(view.listed.map((m) => m.id)).toEqual([theirs.ownerMembershipId])
      expect(view.mine).toBeNull()
      expect(view.mineByUser).toBeNull()
      expect(view.changed).toBeNull()
      expect(view.removed).toBe(false)
      const stillThere = await harness.store.withOrganization(mine.organizationId, (scope) =>
        scope.getMembership(mine.ownerMembershipId)
      )
      expect(stillThere?.role).toBe('owner')
    })

    test('a scope for an Organization that does not exist finds nothing', async () => {
      const { store } = await make()

      const view = await store.withOrganization(newOrganizationId(), async (scope) => ({
        organization: await scope.getOrganization(),
        renamed: await scope.renameOrganization('X', NOW),
        listed: await scope.listMembers({ limit: 5 }),
      }))

      expect(view).toEqual({ organization: null, renamed: null, listed: [] })
    })

    test('a user belongs to one Organization: a second Membership is refused and rolls back', async () => {
      const harness = await make()
      const first = await seed(harness)
      const secondOrganizationId = newOrganizationId()

      await expect(
        harness.store.withOrganization(secondOrganizationId, async (scope) => {
          await scope.insertOrganization({ name: 'Second', region: 'us', now: NOW })
          await scope.insertMembership({
            id: newMembershipId(),
            userId: first.ownerUserId,
            role: 'owner',
            now: NOW,
          })
        })
      ).rejects.toBeInstanceOf(AlreadyMemberError)

      expect((await harness.store.organizationOfUser(first.ownerUserId))?.organizationId).toBe(
        first.organizationId
      )
      expect(
        await harness.store.withOrganization(secondOrganizationId, (s) => s.getOrganization())
      ).toBeNull()
    })

    test('two racing creations for one user leave one Organization and one loser', async () => {
      const { store } = await make()
      const userId = newUserId()
      const create = () =>
        store.withOrganization(newOrganizationId(), async (scope) => {
          await scope.insertOrganization({ name: 'Race', region: 'us', now: NOW })
          await scope.insertMembership({ id: newMembershipId(), userId, role: 'owner', now: NOW })
        })

      const results = await Promise.allSettled([create(), create()])

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const loser = results.find((r) => r.status === 'rejected')
      expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(AlreadyMemberError)
    })

    test('the directory lookup knows no stranger and follows the Organization status', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)

      expect(await harness.store.organizationOfUser(newUserId())).toBeNull()
      expect(await harness.store.organizationOfUser(ownerUserId)).toEqual({
        organizationId,
        status: 'active',
      })
      await harness.setStatus(organizationId, 'suspended')
      expect((await harness.store.organizationOfUser(ownerUserId))?.status).toBe('suspended')
    })

    test('the last Owner cannot be demoted or removed, and nothing changes', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId } = await seed(harness)

      await expect(
        harness.store.withOrganization(organizationId, (s) =>
          s.setRole(ownerMembershipId, 'admin', LATER)
        )
      ).rejects.toBeInstanceOf(LastOwnerError)
      await expect(
        harness.store.withOrganization(organizationId, (s) => s.deleteMembership(ownerMembershipId))
      ).rejects.toBeInstanceOf(LastOwnerError)

      const after = await harness.store.withOrganization(organizationId, (s) =>
        s.getMembership(ownerMembershipId)
      )
      expect(after?.role).toBe('owner')
    })

    test('with a second Owner, either can be demoted or removed in turn, but not both', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId, otherOwners } = await seed(harness, 1)
      const second = otherOwners[0]
      if (!second) {
        throw new Error('seed made no second Owner')
      }

      const demoted = await harness.store.withOrganization(organizationId, (s) =>
        s.setRole(second.id, 'admin', LATER)
      )
      expect(demoted).toMatchObject({ role: 'admin', updatedAt: LATER })
      await expect(
        harness.store.withOrganization(organizationId, (s) => s.deleteMembership(ownerMembershipId))
      ).rejects.toBeInstanceOf(LastOwnerError)
    })

    test('a deleted Organization may be emptied, its last Owner included', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId, ownerUserId } = await seed(harness)
      await harness.setStatus(organizationId, 'deleted')

      const removed = await harness.store.withOrganization(organizationId, (s) =>
        s.deleteMembership(ownerMembershipId)
      )

      expect(removed).toBe(true)
      expect(await harness.store.organizationOfUser(ownerUserId)).toBeNull()
    })

    test('members come in id order, a page at a time, from the id after the cursor', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId } = await seed(harness)
      const extra = Array.from({ length: 4 }, () => newMembershipId())
      await harness.store.withOrganization(organizationId, async (scope) => {
        for (const id of extra) {
          await scope.insertMembership({ id, userId: newUserId(), role: 'rep', now: NOW })
        }
      })
      const expected = [ownerMembershipId, ...extra].sort()

      const seen: string[] = []
      let after: (typeof expected)[number] | undefined
      for (let page = 0; page < 5; page++) {
        const rows = await harness.store.withOrganization(organizationId, (scope) =>
          scope.listMembers({ ...(after === undefined ? {} : { after }), limit: 2 })
        )
        seen.push(...rows.map((row) => row.id))
        after = rows.at(-1)?.id
        if (rows.length < 2) {
          break
        }
      }

      expect(seen).toEqual(expected)
    })

    test('renaming changes the name and the update time only', async () => {
      const harness = await make()
      const { organizationId } = await seed(harness)

      const renamed = await harness.store.withOrganization(organizationId, (s) =>
        s.renameOrganization('Acme Corp', LATER)
      )

      expect(renamed).toMatchObject({ name: 'Acme Corp', status: 'active', region: 'us' })
      expect(renamed?.createdAt).toEqual(NOW)
      expect(renamed?.updatedAt).toEqual(LATER)
    })
  })
}

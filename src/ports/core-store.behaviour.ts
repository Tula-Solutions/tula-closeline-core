import { describe, expect, test } from 'bun:test'
import {
  formatId,
  type OrganizationId,
  type OrganizationStatus,
  type UserId,
} from 'tula-closeline-contract'
import {
  newMembershipId,
  newOrganizationId,
  newUserId,
  seedOrganization,
  TEST_PROFILE,
} from '~/testing'
import {
  AlreadyMemberError,
  type CoreStore,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  LastOwnerError,
  MissingOrganizationError,
  TeamNameTakenError,
} from './core-store'

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
          ...TEST_PROFILE,
          now: NOW,
        })
        for (const owner of otherOwners) {
          await scope.insertMembership({ ...owner, role: 'owner', ...TEST_PROFILE, now: NOW })
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
          await scope.insertMembership({
            id: newMembershipId(),
            userId,
            role: 'owner',
            ...TEST_PROFILE,
            now: NOW,
          })
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
        organization: await scope.lockOrganization(),
        listed: await scope.listMembers({ limit: 10 }),
        mine: await scope.getMembership(mine.ownerMembershipId),
        lockedMine: await scope.lockMembership(mine.ownerMembershipId),
        mineByUser: await scope.getMembershipByUser(mine.ownerUserId),
        changed: await scope.setRole(mine.ownerMembershipId, 'rep', LATER),
        removed: await scope.deleteMembership(mine.ownerMembershipId),
      }))

      expect(view.organization?.id).toBe(theirs.organizationId)
      expect(view.listed.map((m) => m.id)).toEqual([theirs.ownerMembershipId])
      expect(view.mine).toBeNull()
      expect(view.lockedMine).toBeNull()
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
        organization: await scope.lockOrganization(),
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
            ...TEST_PROFILE,
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
          await scope.insertMembership({
            id: newMembershipId(),
            userId,
            role: 'owner',
            ...TEST_PROFILE,
            now: NOW,
          })
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
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.setRole(ownerMembershipId, 'admin', LATER)
        })
      ).rejects.toBeInstanceOf(LastOwnerError)
      await expect(
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.deleteMembership(ownerMembershipId)
        })
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

      const demoted = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return s.setRole(second.id, 'admin', LATER)
      })
      expect(demoted).toMatchObject({ role: 'admin', updatedAt: LATER })
      await expect(
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.deleteMembership(ownerMembershipId)
        })
      ).rejects.toBeInstanceOf(LastOwnerError)
    })

    test('a deleted Organization may be emptied, its last Owner included', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId, ownerUserId } = await seed(harness)
      await harness.setStatus(organizationId, 'deleted')

      const removed = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return s.deleteMembership(ownerMembershipId)
      })

      expect(removed).toBe(true)
      expect(await harness.store.organizationOfUser(ownerUserId)).toBeNull()
    })

    test('members come in id order, a page at a time, from the id after the cursor', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId } = await seed(harness)
      const extra = Array.from({ length: 4 }, () => newMembershipId())
      await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.lockOrganization()
        for (const id of extra) {
          await scope.insertMembership({
            id,
            userId: newUserId(),
            role: 'rep',
            ...TEST_PROFILE,
            now: NOW,
          })
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

    test('the locking reads return what the plain reads do', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId } = await seed(harness)

      const read = await harness.store.withOrganization(organizationId, async (scope) => ({
        locked: await scope.lockOrganization(),
        plain: await scope.getOrganization(),
        lockedMember: await scope.lockMembership(ownerMembershipId),
        plainMember: await scope.getMembership(ownerMembershipId),
        absent: await scope.lockMembership(newMembershipId()),
      }))

      expect(read.locked).toEqual(read.plain)
      expect(read.locked?.id).toBe(organizationId)
      expect(read.lockedMember).toEqual(read.plainMember)
      expect(read.lockedMember?.role).toBe('owner')
      expect(read.absent).toBeNull()
    })

    test('renaming changes the name and the update time only', async () => {
      const harness = await make()
      const { organizationId } = await seed(harness)

      const renamed = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return s.renameOrganization('Acme Corp', LATER)
      })

      expect(renamed).toMatchObject({ name: 'Acme Corp', status: 'active', region: 'us' })
      expect(renamed?.createdAt).toEqual(NOW)
      expect(renamed?.updatedAt).toEqual(LATER)
    })
  })
}

const HOUR_MS = 3_600_000

/** A fingerprint that looks like a SHA-256, distinct per call: 64 lowercase hex characters. */
function newTokenHash(): string {
  return `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`
}

/**
 * The behaviour every {@link CoreStore} adapter must show for Invitations and Teams, run against
 * the memory adapter and the Postgres one alike: the rules the database holds (one pending
 * Invitation per email, final states, expiry, an active Organization, unique folded Team names,
 * cascades) and the scoping to one Organization.
 */
export function describeInvitationsAndTeams(
  label: string,
  make: () => Promise<CoreStoreHarness>
): void {
  describe(`CoreStore invitations and Teams: ${label}`, () => {
    async function seed(harness: CoreStoreHarness) {
      const organizationId = newOrganizationId()
      const ownerUserId = newUserId()
      const ownerMembershipId = newMembershipId()
      await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.insertOrganization({ name: 'Acme', region: 'us', now: NOW })
        await scope.insertMembership({
          id: ownerMembershipId,
          userId: ownerUserId,
          role: 'owner',
          ...TEST_PROFILE,
          now: NOW,
        })
      })
      return { organizationId, ownerUserId, ownerMembershipId }
    }

    /** Adds a pending Invitation expiring `ttlMs` from `created`, in a transaction of its own. */
    async function invite(
      harness: CoreStoreHarness,
      organizationId: OrganizationId,
      ownerUserId: UserId,
      options: { email?: string; ttlMs?: number; created?: Date; tokenHash?: string } = {}
    ) {
      const created = options.created ?? new Date()
      const id = formatId('inv', crypto.randomUUID())
      const tokenHash = options.tokenHash ?? newTokenHash()
      const record = await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.lockOrganization()
        return scope.insertInvitation({
          id,
          email: options.email ?? `${crypto.randomUUID()}@example.com`,
          role: 'rep',
          teamId: null,
          invitedByUserId: ownerUserId,
          tokenHash,
          expiresAt: new Date(created.getTime() + (options.ttlMs ?? 24 * HOUR_MS)),
          now: created,
        })
      })
      return { record, tokenHash }
    }

    test('an Invitation is stored pending, found by its token hash, and never shows the hash', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)

      const { record, tokenHash } = await invite(harness, organizationId, ownerUserId, {
        email: 'new@example.com',
      })

      expect(record).toMatchObject({
        organizationId,
        email: 'new@example.com',
        role: 'rep',
        state: 'pending',
        teamId: null,
        acceptedAt: null,
        revokedAt: null,
      })
      expect(JSON.stringify(record)).not.toContain(tokenHash)
      const found = await harness.store.withOrganization(organizationId, (s) =>
        s.getInvitationByTokenHash(tokenHash)
      )
      expect(found?.id).toBe(record.id)
      expect(await harness.store.invitationForToken(tokenHash)).toEqual({
        organizationId,
        invitationId: record.id,
      })
    })

    test('a second pending Invitation for one email is refused; after a revoke a new one is fine', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const first = await invite(harness, organizationId, ownerUserId, { email: 'a@example.com' })

      await expect(
        invite(harness, organizationId, ownerUserId, { email: 'a@example.com' })
      ).rejects.toBeInstanceOf(InvitationAlreadyPendingError)
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.revokeInvitation(first.record.id, new Date())
      })

      await invite(harness, organizationId, ownerUserId, { email: 'a@example.com' })
    })

    test('the same email may be pending in two Organizations', async () => {
      const harness = await make()
      const a = await seed(harness)
      const b = await seed(harness)

      await invite(harness, a.organizationId, a.ownerUserId, { email: 'x@example.com' })
      await invite(harness, b.organizationId, b.ownerUserId, { email: 'x@example.com' })
    })

    test('revoked and accepted are final: nothing is pending again, and a used token opens nothing', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const revoked = await invite(harness, organizationId, ownerUserId)
      const accepted = await invite(harness, organizationId, ownerUserId)

      const outcome = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return {
          revoked: await s.revokeInvitation(revoked.record.id, new Date()),
          revokedAgain: await s.revokeInvitation(revoked.record.id, new Date()),
          accepted: await s.acceptInvitation(accepted.record.id, new Date()),
          acceptedAgain: await s.acceptInvitation(accepted.record.id, new Date()),
          revokeAccepted: await s.revokeInvitation(accepted.record.id, new Date()),
        }
      })

      expect(outcome.revoked?.state).toBe('revoked')
      expect(outcome.revokedAgain).toBeNull()
      expect(outcome.accepted?.state).toBe('accepted')
      expect(outcome.acceptedAgain).toBeNull()
      expect(outcome.revokeAccepted).toBeNull()
      expect(await harness.store.invitationForToken(revoked.tokenHash)).toBeNull()
      expect(await harness.store.invitationForToken(accepted.tokenHash)).toBeNull()
    })

    test('an expired Invitation opens nothing and cannot be accepted, but can be revoked', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const past = new Date(Date.now() - 48 * HOUR_MS)
      const expired = await invite(harness, organizationId, ownerUserId, {
        created: past,
        ttlMs: 24 * HOUR_MS,
      })

      expect(await harness.store.invitationForToken(expired.tokenHash)).toBeNull()
      await expect(
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.acceptInvitation(expired.record.id, new Date())
        })
      ).rejects.toBeInstanceOf(InvitationNotAcceptableError)
      const revoked = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return s.revokeInvitation(expired.record.id, new Date())
      })
      expect(revoked?.state).toBe('revoked')
    })

    test('expired pending Invitations are revoked oldest first, at most the limit at a time, and only in their own Organization', async () => {
      const harness = await make()
      const mine = await seed(harness)
      const theirs = await seed(harness)
      const base = Date.now() - 10 * 24 * HOUR_MS
      const expired = []
      for (let index = 0; index < 3; index++) {
        expired.push(
          await invite(harness, mine.organizationId, mine.ownerUserId, {
            created: new Date(base + index * 1000),
            ttlMs: 24 * HOUR_MS,
          })
        )
      }
      const live = await invite(harness, mine.organizationId, mine.ownerUserId)
      const foreign = await invite(harness, theirs.organizationId, theirs.ownerUserId, {
        created: new Date(base),
        ttlMs: 24 * HOUR_MS,
      })
      const sweep = (organizationId: OrganizationId, limit: number) =>
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.revokeExpiredInvitations(
            new Date(),
            limit,
            new Date(Date.now() - 7 * 24 * HOUR_MS)
          )
        })

      const first = await sweep(mine.organizationId, 2)
      const afterFirst = await harness.store.withOrganization(mine.organizationId, async (s) => ({
        revoked: (await s.listInvitations({ state: 'revoked', limit: 10 })).map((r) => r.id),
        pending: await s.countPendingInvitations(10),
      }))
      const second = await sweep(mine.organizationId, 100)
      const third = await sweep(mine.organizationId, 100)

      expect([first, second, third]).toEqual([2, 1, 0])
      expect(afterFirst).toEqual({
        revoked: [expired[1]?.record.id as never, expired[0]?.record.id as never],
        pending: 2,
      })
      const left = await harness.store.withOrganization(mine.organizationId, (s) =>
        s.listInvitations({ state: 'pending', limit: 10 })
      )
      expect(left.map((r) => r.id)).toEqual([live.record.id])
      expect(await harness.store.invitationForToken(foreign.tokenHash)).toBeNull()
      const theirPending = await harness.store.withOrganization(theirs.organizationId, (s) =>
        s.countPendingInvitations(10)
      )
      expect(theirPending).toBe(1)
    })

    test('the sweep looks only at Invitations created at or before the bound it is given', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const now = new Date()
      const young = await invite(harness, organizationId, ownerUserId, {
        created: new Date(now.getTime() - 2 * HOUR_MS),
        ttlMs: HOUR_MS,
      })
      const sweep = (createdAtOrBefore: Date) =>
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.revokeExpiredInvitations(now, 10, createdAtOrBefore)
        })

      const tooEarly = await sweep(new Date(now.getTime() - 3 * HOUR_MS))
      const stillPending = await harness.store.withOrganization(organizationId, (s) =>
        s.countPendingInvitations(10)
      )
      const inRange = await sweep(new Date(now.getTime() - HOUR_MS))

      expect({ tooEarly, stillPending, inRange }).toEqual({
        tooEarly: 0,
        stillPending: 1,
        inRange: 1,
      })
      expect(young.record.state).toBe('pending')
    })

    test('an Invitation of a suspended or deleted Organization opens nothing and cannot be accepted', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const pending = await invite(harness, organizationId, ownerUserId)

      await harness.setStatus(organizationId, 'suspended')

      expect(await harness.store.invitationForToken(pending.tokenHash)).toBeNull()
      await expect(
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.acceptInvitation(pending.record.id, new Date())
        })
      ).rejects.toBeInstanceOf(InvitationNotAcceptableError)
    })

    test('an Invitation is read and changed only inside its own Organization', async () => {
      const harness = await make()
      const mine = await seed(harness)
      const theirs = await seed(harness)
      const own = await invite(harness, mine.organizationId, mine.ownerUserId)

      const view = await harness.store.withOrganization(theirs.organizationId, async (s) => {
        await s.lockOrganization()
        return {
          locked: await s.lockInvitation(own.record.id),
          byHash: await s.getInvitationByTokenHash(own.tokenHash),
          listed: await s.listInvitations({ state: 'pending', limit: 10 }),
          revoked: await s.revokeInvitation(own.record.id, new Date()),
          count: await s.countPendingInvitations(10),
        }
      })

      expect(view).toEqual({ locked: null, byHash: null, listed: [], revoked: null, count: 0 })
      expect(await harness.store.invitationForToken(own.tokenHash)).not.toBeNull()
    })

    test('Invitations list newest first by state, a page at a time, and the count stops at its limit', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const base = Date.now()
      const made: Awaited<ReturnType<typeof invite>>[] = []
      for (let index = 0; index < 5; index++) {
        made.push(
          await invite(harness, organizationId, ownerUserId, { created: new Date(base + index) })
        )
      }
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.revokeInvitation(made[0]?.record.id as never, new Date())
      })

      const seen: string[] = []
      let after: { createdAt: Date; id: (typeof made)[number]['record']['id'] } | undefined
      for (let page = 0; page < 5; page++) {
        const rows = await harness.store.withOrganization(organizationId, (s) =>
          s.listInvitations({ state: 'pending', ...(after ? { after } : {}), limit: 3 })
        )
        seen.push(...rows.map((row) => row.id))
        const last = rows.at(-1)
        after = last ? { createdAt: last.createdAt, id: last.id } : undefined
        if (rows.length < 3) {
          break
        }
      }
      const revokedList = await harness.store.withOrganization(organizationId, (s) =>
        s.listInvitations({ state: 'revoked', limit: 10 })
      )
      const counts = await harness.store.withOrganization(organizationId, async (s) => ({
        capped: await s.countPendingInvitations(3),
        all: await s.countPendingInvitations(100),
      }))

      expect(seen).toEqual(
        made
          .slice(1)
          .map((m) => m.record.id)
          .reverse()
      )
      expect(revokedList.map((row) => row.id)).toEqual([made[0]?.record.id as never])
      expect(counts).toEqual({ capped: 3, all: 4 })
    })

    test('Invitations created at one instant list by id, the greater id first, a page at a time', async () => {
      const harness = await make()
      const { organizationId, ownerUserId } = await seed(harness)
      const instant = new Date(Date.now() - HOUR_MS)
      const made: Awaited<ReturnType<typeof invite>>[] = []
      for (let index = 0; index < 5; index++) {
        made.push(await invite(harness, organizationId, ownerUserId, { created: instant }))
      }

      const seen: string[] = []
      let after: { createdAt: Date; id: (typeof made)[number]['record']['id'] } | undefined
      for (let page = 0; page < 5; page++) {
        const rows = await harness.store.withOrganization(organizationId, (s) =>
          s.listInvitations({ state: 'pending', ...(after ? { after } : {}), limit: 2 })
        )
        seen.push(...rows.map((row) => row.id))
        const last = rows.at(-1)
        after = last ? { createdAt: last.createdAt, id: last.id } : undefined
        if (rows.length < 2) {
          break
        }
      }

      expect(seen).toEqual(
        made
          .map((m) => m.record.id)
          .sort()
          .reverse()
      )
    })

    test('Invitations created since a time are counted in every state and no further than the limit, with the oldest of them', async () => {
      const harness = await make()
      const mine = await seed(harness)
      const theirs = await seed(harness)
      const base = Date.now() - 10 * HOUR_MS
      const made: Awaited<ReturnType<typeof invite>>[] = []
      for (let index = 0; index < 6; index++) {
        made.push(
          await invite(harness, mine.organizationId, mine.ownerUserId, {
            created: new Date(base + index * 1000),
          })
        )
      }
      await invite(harness, theirs.organizationId, theirs.ownerUserId, {
        created: new Date(base + 3000),
      })
      await harness.store.withOrganization(mine.organizationId, async (s) => {
        await s.lockOrganization()
        await s.revokeInvitation(made[3]?.record.id as never, new Date())
      })
      const since = new Date(base + 1500)
      const count = (at: Date, limit: number) =>
        harness.store.withOrganization(mine.organizationId, (s) =>
          s.countInvitationsSince(at, limit)
        )

      expect(await count(since, 100)).toEqual({ count: 4, oldest: new Date(base + 2000) })
      expect(await count(since, 3)).toEqual({ count: 3, oldest: expect.any(Date) as never })
      // The window opens after the time given, never at it.
      expect(await count(new Date(base + 2000), 100)).toEqual({
        count: 3,
        oldest: new Date(base + 3000),
      })
      expect(await count(new Date(base + 10_000), 100)).toEqual({ count: 0, oldest: null })
    })

    test('a Team name is unique per Organization ignoring ASCII case, but not accents, and not across Organizations', async () => {
      const harness = await make()
      const a = await seed(harness)
      const b = await seed(harness)
      const add = (organizationId: OrganizationId, name: string) =>
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.insertTeam({ id: formatId('team', crypto.randomUUID()), name, now: NOW })
        })

      await add(a.organizationId, 'Sales')
      await expect(add(a.organizationId, 'sALES')).rejects.toBeInstanceOf(TeamNameTakenError)
      await add(a.organizationId, 'Éclair')
      await add(a.organizationId, 'éclair')
      await add(b.organizationId, 'Sales')
    })

    test('renaming a Team to a name another has is refused, to its own name in another case is fine', async () => {
      const harness = await make()
      const { organizationId } = await seed(harness)
      const [sales, support] = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        const one = await s.insertTeam({
          id: formatId('team', crypto.randomUUID()),
          name: 'Sales',
          now: NOW,
        })
        const two = await s.insertTeam({
          id: formatId('team', crypto.randomUUID()),
          name: 'Support',
          now: NOW,
        })
        return [one, two]
      })

      await expect(
        harness.store.withOrganization(organizationId, async (s) => {
          await s.lockOrganization()
          return s.renameTeam(sales?.id as never, 'SUPPORT', LATER)
        })
      ).rejects.toBeInstanceOf(TeamNameTakenError)
      const renamed = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return s.renameTeam(support?.id as never, 'support', LATER)
      })
      expect(renamed).toMatchObject({ name: 'support', updatedAt: LATER })
    })

    test('adding a member to a Team twice keeps the first place, removing is idempotent, and a removed membership leaves its Teams', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId } = await seed(harness)
      const teamId = formatId('team', crypto.randomUUID())
      const rep = newMembershipId()
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.insertTeam({ id: teamId, name: 'Sales', now: NOW })
        await s.insertMembership({
          id: rep,
          userId: newUserId(),
          role: 'rep',
          ...TEST_PROFILE,
          now: NOW,
        })
      })

      const result = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        return {
          first: await s.addTeamMember(teamId, rep, NOW),
          again: await s.addTeamMember(teamId, rep, LATER),
          removed: await s.removeTeamMember(teamId, rep),
          removedAgain: await s.removeTeamMember(teamId, rep),
          owner: await s.addTeamMember(teamId, ownerMembershipId, NOW),
        }
      })
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.addTeamMember(teamId, rep, NOW)
        await s.deleteMembership(rep)
      })
      const afterRemoval = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.insertMembership({
          id: rep,
          userId: newUserId(),
          role: 'rep',
          ...TEST_PROFILE,
          now: NOW,
        })
        return s.removeTeamMember(teamId, rep)
      })

      expect(result.first.createdAt).toEqual(NOW)
      expect(result.again.createdAt).toEqual(NOW)
      expect(result.removed).toBe(true)
      expect(result.removedAgain).toBe(false)
      expect(result.owner.membershipId).toBe(ownerMembershipId)
      expect(afterRemoval).toBe(false)
    })

    test('deleting a Team removes its places and clears it from Invitations, leaving the members', async () => {
      const harness = await make()
      const { organizationId, ownerMembershipId, ownerUserId } = await seed(harness)
      const teamId = formatId('team', crypto.randomUUID())
      const invitationId = formatId('inv', crypto.randomUUID())
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        await s.insertTeam({ id: teamId, name: 'Sales', now: NOW })
        await s.addTeamMember(teamId, ownerMembershipId, NOW)
        await s.insertInvitation({
          id: invitationId,
          email: 'in@example.com',
          role: 'rep',
          teamId,
          invitedByUserId: ownerUserId,
          tokenHash: newTokenHash(),
          expiresAt: new Date(Date.now() + HOUR_MS),
          now: new Date(),
        })
      })

      const outcome = await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        const deleted = await s.deleteTeam(teamId)
        return {
          deleted,
          again: await s.deleteTeam(teamId),
          team: await s.lockTeam(teamId),
          member: await s.getMembership(ownerMembershipId),
          invitation: await s.lockInvitation(invitationId),
        }
      })

      expect(outcome.deleted).toBe(true)
      expect(outcome.again).toBe(false)
      expect(outcome.team).toBeNull()
      expect(outcome.member?.id).toBe(ownerMembershipId)
      expect(outcome.invitation).toMatchObject({ state: 'pending', teamId: null })
    })

    test('a scope sees and changes nothing of another Organization’s Teams', async () => {
      const harness = await make()
      const mine = await seed(harness)
      const theirs = await seed(harness)
      const teamId = formatId('team', crypto.randomUUID())
      await harness.store.withOrganization(mine.organizationId, async (s) => {
        await s.lockOrganization()
        await s.insertTeam({ id: teamId, name: 'Sales', now: NOW })
      })

      const view = await harness.store.withOrganization(theirs.organizationId, async (s) => {
        await s.lockOrganization()
        return {
          locked: await s.lockTeam(teamId),
          listed: await s.listTeams({ limit: 10 }),
          renamed: await s.renameTeam(teamId, 'Mine now', LATER),
          deleted: await s.deleteTeam(teamId),
          removed: await s.removeTeamMember(teamId, theirs.ownerMembershipId),
        }
      })

      expect(view).toEqual({
        locked: null,
        listed: [],
        renamed: null,
        deleted: false,
        removed: false,
      })
      const still = await harness.store.withOrganization(mine.organizationId, (s) =>
        s.listTeams({ limit: 10 })
      )
      expect(still.map((t) => t.name)).toEqual(['Sales'])
    })

    test('Teams list in id order, a page at a time', async () => {
      const harness = await make()
      const { organizationId } = await seed(harness)
      const ids = Array.from({ length: 5 }, () => formatId('team', crypto.randomUUID()))
      await harness.store.withOrganization(organizationId, async (s) => {
        await s.lockOrganization()
        for (const [index, id] of ids.entries()) {
          await s.insertTeam({ id, name: `Team ${index}`, now: NOW })
        }
      })

      const seen: string[] = []
      let after: (typeof ids)[number] | undefined
      for (let page = 0; page < 5; page++) {
        const rows = await harness.store.withOrganization(organizationId, (s) =>
          s.listTeams({ ...(after ? { after } : {}), limit: 2 })
        )
        seen.push(...rows.map((row) => row.id))
        after = rows.at(-1)?.id
        if (rows.length < 2) {
          break
        }
      }

      expect(seen).toEqual([...ids].sort())
    })
  })
}

/**
 * The behaviour of the idempotency keys of every {@link CoreStore} adapter: the row is claimed in
 * the transaction of the write and never outlives a failure, an answer is replayed only to the
 * same Organization, user, route and request, an expired answer counts as absent, and the purge
 * removes one bounded batch of one Organization's expired keys.
 */
export function describeIdempotencyKeys(
  label: string,
  make: () => Promise<CoreStoreHarness>
): void {
  describe(`CoreStore idempotency keys: ${label}`, () => {
    const HASH_A = 'a'.repeat(64)
    const HASH_B = 'b'.repeat(64)
    const expiredBefore = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)

    async function seed() {
      const harness = await make()
      const seeded = await seedOrganization(harness.store)
      const ref = (
        key = 'key-0123456789abcdef',
        route = 'things.create',
        userId = seeded.owner.userId
      ) => ({
        userId,
        route,
        key,
      })
      const claim = (
        organizationId: OrganizationId,
        reference: ReturnType<typeof ref>,
        requestHash = HASH_A,
        now = NOW,
        before = expiredBefore
      ) =>
        harness.store.withOrganization(organizationId, (s) =>
          s.reserveIdempotencyKey({ ...reference, requestHash, now, expiredBefore: before })
        )
      /** Claims, completes and commits an answer. */
      const answer = (
        organizationId: OrganizationId,
        reference: ReturnType<typeof ref>,
        response: unknown = { id: 'thing_1' },
        requestHash = HASH_A,
        now = NOW
      ) =>
        harness.store.withOrganization(organizationId, async (s) => {
          const reserved = await s.reserveIdempotencyKey({
            ...reference,
            requestHash,
            now,
            expiredBefore: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          })
          if (reserved.outcome !== 'reserved') {
            return reserved
          }
          await s.lockOrganization()
          await s.completeIdempotencyKey(reference, 201, response)
          return reserved
        })
      return { harness, seeded, ref, claim, answer }
    }

    test('a free key is reserved, and the same request after the commit is replayed with the stored status and body', async () => {
      const { seeded, ref, claim, answer } = await seed()

      const first = await answer(seeded.organizationId, ref(), {
        id: 'thing_1',
        nested: { a: [1, 2] },
      })
      const again = await claim(seeded.organizationId, ref())

      expect(first).toEqual({ outcome: 'reserved' })
      expect(again).toEqual({
        outcome: 'replay',
        status: 201,
        response: { id: 'thing_1', nested: { a: [1, 2] } },
      })
    })

    test('the same key with a different request hash is reused, and the stored answer stays', async () => {
      const { seeded, ref, claim, answer } = await seed()
      await answer(seeded.organizationId, ref())

      const other = await claim(seeded.organizationId, ref(), HASH_B)
      const same = await claim(seeded.organizationId, ref())

      expect(other).toEqual({ outcome: 'reused' })
      expect(same).toMatchObject({ outcome: 'replay', status: 201 })
    })

    test('a reservation that is not committed leaves the key free', async () => {
      const { harness, seeded, ref, claim } = await seed()

      await expect(
        harness.store.withOrganization(seeded.organizationId, async (s) => {
          await s.reserveIdempotencyKey({
            ...ref(),
            requestHash: HASH_A,
            now: NOW,
            expiredBefore,
          })
          throw new Error('the write failed')
        })
      ).rejects.toThrow('the write failed')

      expect(await claim(seeded.organizationId, ref(), HASH_B)).toEqual({ outcome: 'reserved' })
    })

    test('a key is per Organization, user and route', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      const other = await seedOrganization(harness.store)
      await answer(seeded.organizationId, ref())

      expect(
        await claim(
          other.organizationId,
          ref('key-0123456789abcdef', 'things.create', other.owner.userId),
          HASH_A
        )
      ).toEqual({ outcome: 'reserved' })
      expect(
        await claim(
          seeded.organizationId,
          ref('key-0123456789abcdef', 'things.create', newUserId())
        )
      ).toEqual({ outcome: 'reserved' })
      expect(
        await claim(seeded.organizationId, ref('key-0123456789abcdef', 'things.rename'))
      ).toEqual({ outcome: 'reserved' })
    })

    test('another Organization cannot read or replay a key, even naming the same user', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      const other = await seedOrganization(harness.store)
      await answer(seeded.organizationId, ref())

      const theirs = await claim(other.organizationId, ref())

      expect(theirs).toEqual({ outcome: 'reserved' })
    })

    test('an answer created before the expiry bound counts as absent and is replaced by the new one', async () => {
      const { seeded, ref, claim, answer } = await seed()
      await answer(seeded.organizationId, ref(), { id: 'old' }, HASH_A, NOW)
      const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)

      const replaced = await answer(seeded.organizationId, ref(), { id: 'new' }, HASH_B, later)
      const replay = await claim(
        seeded.organizationId,
        ref(),
        HASH_B,
        later,
        new Date(later.getTime() - 24 * 60 * 60 * 1000)
      )

      expect(replaced).toEqual({ outcome: 'reserved' })
      expect(replay).toEqual({ outcome: 'replay', status: 201, response: { id: 'new' } })
    })

    test('an answer exactly at the expiry bound is still live', async () => {
      const { seeded, ref, claim, answer } = await seed()
      await answer(seeded.organizationId, ref())

      const at = await claim(seeded.organizationId, ref(), HASH_A, NOW, NOW)
      const after = await claim(
        seeded.organizationId,
        ref(),
        HASH_B,
        NOW,
        new Date(NOW.getTime() + 1)
      )

      expect(at).toMatchObject({ outcome: 'replay' })
      expect(after).toEqual({ outcome: 'reserved' })
    })

    test('a key is completed once', async () => {
      const { harness, seeded, ref } = await seed()

      await expect(
        harness.store.withOrganization(seeded.organizationId, async (s) => {
          await s.reserveIdempotencyKey({ ...ref(), requestHash: HASH_A, now: NOW, expiredBefore })
          await s.completeIdempotencyKey(ref(), 201, { id: 'one' })
          await s.completeIdempotencyKey(ref(), 201, { id: 'two' })
        })
      ).rejects.toThrow('not in flight')
    })

    test('a key that was never reserved cannot be completed', async () => {
      const { harness, seeded, ref } = await seed()

      await expect(
        harness.store.withOrganization(seeded.organizationId, (s) =>
          s.completeIdempotencyKey(ref(), 201, { id: 'x' })
        )
      ).rejects.toThrow('not in flight')
    })

    test('a deleted key, in flight or completed, is free again', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      await answer(seeded.organizationId, ref('completed-key-0123456'))

      const removedCompleted = await harness.store.withOrganization(seeded.organizationId, (s) =>
        s.deleteIdempotencyKey(ref('completed-key-0123456'))
      )
      const inFlight = await harness.store.withOrganization(seeded.organizationId, async (s) => {
        await s.reserveIdempotencyKey({
          ...ref('in-flight-key-012345'),
          requestHash: HASH_A,
          now: NOW,
          expiredBefore,
        })
        const removed = await s.deleteIdempotencyKey(ref('in-flight-key-012345'))
        const missing = await s.deleteIdempotencyKey(ref('no-such-key-0123456'))
        return { removed, missing }
      })

      expect(removedCompleted).toBe(true)
      expect(inFlight).toEqual({ removed: true, missing: false })
      expect(await claim(seeded.organizationId, ref('completed-key-0123456'))).toEqual({
        outcome: 'reserved',
      })
      expect(await claim(seeded.organizationId, ref('in-flight-key-012345'))).toEqual({
        outcome: 'reserved',
      })
    })

    test('an Organization that does not exist cannot hold a key', async () => {
      const { harness, ref } = await seed()

      await expect(
        harness.store.withOrganization(newOrganizationId(), (s) =>
          s.reserveIdempotencyKey({ ...ref(), requestHash: HASH_A, now: NOW, expiredBefore })
        )
      ).rejects.toBeInstanceOf(MissingOrganizationError)
    })

    test('two requests with one key at once: one reserves and completes, the other waits and is replayed', async () => {
      const { harness, seeded, ref } = await seed()
      const attempt = () =>
        harness.store.withOrganization(seeded.organizationId, async (s) => {
          const reserved = await s.reserveIdempotencyKey({
            ...ref(),
            requestHash: HASH_A,
            now: NOW,
            expiredBefore,
          })
          if (reserved.outcome === 'reserved') {
            await s.lockOrganization()
            await s.completeIdempotencyKey(ref(), 201, { id: 'the-one' })
          }
          return reserved
        })

      const results = await Promise.all([attempt(), attempt(), attempt()])

      expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1)
      expect(results.filter((r) => r.outcome === 'replay')).toEqual([
        { outcome: 'replay', status: 201, response: { id: 'the-one' } },
        { outcome: 'replay', status: 201, response: { id: 'the-one' } },
      ])
    })

    test('the purge removes the oldest expired keys of this Organization up to the limit, and nothing else', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      const other = await seedOrganization(harness.store)
      const at = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000)
      for (const [n, hours] of [30, 29, 28, 27].entries()) {
        await answer(seeded.organizationId, ref(`expired-key-000000${n}`), { n }, HASH_A, at(hours))
      }
      await answer(
        seeded.organizationId,
        ref('fresh-key-0000000001'),
        { fresh: true },
        HASH_A,
        at(1)
      )
      await answer(
        other.organizationId,
        ref('expired-key-0000000', 'things.create', other.owner.userId),
        { other: true },
        HASH_A,
        at(40)
      )

      const removed = await harness.store.withOrganization(seeded.organizationId, async (s) => {
        await s.lockOrganization()
        return s.purgeIdempotencyKeys(at(24), 3)
      })
      const rest = await harness.store.withOrganization(seeded.organizationId, async (s) => {
        await s.lockOrganization()
        return s.purgeIdempotencyKeys(at(24), 10)
      })

      expect(removed).toBe(3)
      expect(rest).toBe(1)
      expect(
        await claim(seeded.organizationId, ref('fresh-key-0000000001'), HASH_A, NOW, at(24))
      ).toMatchObject({ outcome: 'replay' })
      expect(
        await claim(
          other.organizationId,
          ref('expired-key-0000000', 'things.create', other.owner.userId),
          HASH_A,
          NOW,
          at(24 * 3)
        )
      ).toMatchObject({ outcome: 'replay' })
    })

    test('looking at a key claims nothing: free before, the stored answer after the commit, reused for another request', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      const look = (requestHash: string, before = expiredBefore, reference = ref()) =>
        harness.store.withOrganization(seeded.organizationId, (s) =>
          s.findIdempotencyKey({ ...reference, requestHash, expiredBefore: before })
        )

      const before = await look(HASH_A, expiredBefore, ref('other-key-0123456789'))
      // Looking claimed nothing, so the key is still free to reserve.
      const stillFree = await claim(seeded.organizationId, ref('free-key-0123456789'), HASH_A)

      expect(before).toEqual({ outcome: 'free' })
      expect(stillFree).toEqual({ outcome: 'reserved' })
      expect(await look(HASH_A, expiredBefore, ref('free-key-0123456789'))).toEqual({
        outcome: 'free',
      })
      await answer(seeded.organizationId, ref('other-key-0123456789'), { id: 'thing_2' })
      expect(await look(HASH_A, expiredBefore, ref('other-key-0123456789'))).toEqual({
        outcome: 'replay',
        status: 201,
        response: { id: 'thing_2' },
      })
      expect(await look(HASH_B, expiredBefore, ref('other-key-0123456789'))).toEqual({
        outcome: 'reused',
      })
    })

    test('looking at a key finds nothing for an expired answer, another user, another route or another Organization', async () => {
      const { harness, seeded, ref, answer } = await seed()
      const other = await seedOrganization(harness.store)
      await answer(seeded.organizationId, ref())
      const look = (
        organizationId: OrganizationId,
        reference: ReturnType<typeof ref>,
        before = expiredBefore
      ) =>
        harness.store.withOrganization(organizationId, (s) =>
          s.findIdempotencyKey({ ...reference, requestHash: HASH_A, expiredBefore: before })
        )

      expect(await look(seeded.organizationId, ref(), new Date(NOW.getTime() + 1))).toEqual({
        outcome: 'free',
      })
      expect(
        await look(seeded.organizationId, ref('key-0123456789abcdef', 'things.create', newUserId()))
      ).toEqual({ outcome: 'free' })
      expect(
        await look(seeded.organizationId, ref('key-0123456789abcdef', 'things.rename'))
      ).toEqual({ outcome: 'free' })
      expect(await look(other.organizationId, ref())).toEqual({ outcome: 'free' })
      expect(await look(seeded.organizationId, ref())).toMatchObject({ outcome: 'replay' })
    })

    test('two users with one route and key: one completes, deletes and replays without touching the other’s row', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      const second = newUserId()
      const mine = ref()
      const theirs = ref('key-0123456789abcdef', 'things.create', second)
      await answer(seeded.organizationId, mine, { id: 'mine' })
      await answer(seeded.organizationId, theirs, { id: 'theirs' }, HASH_B)

      const removed = await harness.store.withOrganization(seeded.organizationId, (s) =>
        s.deleteIdempotencyKey(mine)
      )

      expect(removed).toBe(true)
      expect(await claim(seeded.organizationId, theirs, HASH_B)).toEqual({
        outcome: 'replay',
        status: 201,
        response: { id: 'theirs' },
      })
      expect(await claim(seeded.organizationId, mine)).toEqual({ outcome: 'reserved' })
    })

    test('a user replays only their own answer when another user holds the same route and key', async () => {
      const { seeded, ref, claim, answer } = await seed()
      const second = newUserId()
      await answer(seeded.organizationId, ref(), { id: 'mine' })
      await answer(seeded.organizationId, ref('key-0123456789abcdef', 'things.create', second), {
        id: 'theirs',
      })

      expect(await claim(seeded.organizationId, ref())).toMatchObject({ response: { id: 'mine' } })
      expect(
        await claim(seeded.organizationId, ref('key-0123456789abcdef', 'things.create', second))
      ).toMatchObject({ response: { id: 'theirs' } })
    })

    test('a purge that is not committed removes nothing', async () => {
      const { harness, seeded, ref, claim, answer } = await seed()
      await answer(
        seeded.organizationId,
        ref(),
        { id: 'old' },
        HASH_A,
        new Date(NOW.getTime() - 48 * 60 * 60 * 1000)
      )

      await expect(
        harness.store.withOrganization(seeded.organizationId, async (s) => {
          await s.lockOrganization()
          await s.purgeIdempotencyKeys(NOW, 10)
          throw new Error('rolled back')
        })
      ).rejects.toThrow('rolled back')

      expect(
        await claim(
          seeded.organizationId,
          ref(),
          HASH_A,
          NOW,
          new Date(NOW.getTime() - 72 * 60 * 60 * 1000)
        )
      ).toMatchObject({ outcome: 'replay' })
    })
  })
}

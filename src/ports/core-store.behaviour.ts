import { describe, expect, test } from 'bun:test'
import {
  type ConsentChannel,
  type ConsentEventId,
  type ConsentWordingId,
  type ContactCheckId,
  type CrmConnectionId,
  formatId,
  type MembershipId,
  type OrganizationId,
  type OrganizationStatus,
  type ProspectCompanyId,
  type ProspectId,
  type ProspectImportId,
  type Role,
  type SuppressionEntryId,
  type UserId,
} from 'tula-closeline-contract'
import {
  newMembershipId,
  newOrganizationId,
  newUserId,
  type SeededMember,
  seedOrganization,
  TEST_PROFILE,
} from '~/testing'
import {
  AlreadyMemberError,
  CompanyDomainTakenError,
  type ConsentEventInput,
  type ConsentEventKind,
  type ContactCheckRecord,
  type CoreStore,
  CrmAccountTakenError,
  InvitationAlreadyPendingError,
  InvitationNotAcceptableError,
  LastOwnerError,
  MissingOrganizationError,
  MissingReferenceError,
  type NewCrmConnection,
  type NewSuppressionEntry,
  type OrganizationScope,
  ProspectIdentityTakenError,
  type ProspectPageRequest,
  type ProspectVisibility,
  REASSIGN_MAX_IDS,
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

/**
 * `abandonOrganization`: the guard and the change as one step, the same in every adapter. An
 * Organization's creation time is whatever `insertOrganization` is given, so age is set up without
 * waiting; the adapter judges it against its own clock (the database's, for Postgres).
 */
export function describeAbandon(label: string, make: () => Promise<CoreStoreHarness>): void {
  describe(`CoreStore (${label}): abandonOrganization`, () => {
    const HOUR = 60 * 60 * 1000

    /** An Organization created `ageMs` ago whose members are the Owner and one per extra role. */
    async function seedAged(harness: CoreStoreHarness, ageMs: number, extra: readonly Role[] = []) {
      const organizationId = newOrganizationId()
      const created = new Date(Date.now() - ageMs)
      const members = ['owner' as Role, ...extra].map((role) => ({
        id: newMembershipId(),
        userId: newUserId(),
        role,
      }))
      await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.insertOrganization({ name: 'Acme', region: 'us', now: created })
        for (const member of members) {
          await scope.insertMembership({ ...member, ...TEST_PROFILE, now: created })
        }
      })
      return { organizationId, members }
    }

    const abandon = (harness: CoreStoreHarness, organizationId: OrganizationId, userId: UserId) =>
      harness.store.withOrganization(organizationId, async (scope) => {
        await scope.lockOrganization()
        return scope.abandonOrganization(userId, 24, new Date())
      })

    const state = (harness: CoreStoreHarness, organizationId: OrganizationId) =>
      harness.store.withOrganization(organizationId, async (scope) => ({
        organization: await scope.getOrganization(),
        members: await scope.listMembers({ limit: 10 }),
      }))

    test('marks a young one-member Organization deleted, removes the member and frees the user', async () => {
      const harness = await make()
      const { organizationId, members } = await seedAged(harness, HOUR)
      const owner = members[0]?.userId as UserId

      expect(await abandon(harness, organizationId, owner)).toBe(true)

      const after = await state(harness, organizationId)
      expect(after.organization?.status).toBe('deleted')
      expect(after.members).toEqual([])
      expect(await harness.store.organizationOfUser(owner)).toBeNull()
    })

    test('removes the member from the Teams it was in, and leaves the Teams', async () => {
      const harness = await make()
      const { organizationId, members } = await seedAged(harness, HOUR)
      const owner = members[0]
      const teamId = formatId('team', crypto.randomUUID())
      await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.lockOrganization()
        await scope.insertTeam({ id: teamId, name: 'Sales', now: new Date() })
        await scope.addTeamMember(teamId, owner?.id as never, new Date())
      })

      expect(await abandon(harness, organizationId, owner?.userId as UserId)).toBe(true)

      const after = await harness.store.withOrganization(organizationId, async (scope) => {
        await scope.lockOrganization()
        return {
          teams: await scope.listTeams({ limit: 10 }),
          stillPlaced: await scope.removeTeamMember(teamId, owner?.id as never),
        }
      })
      expect(after.teams.map((team) => team.id)).toEqual([teamId])
      expect(after.stillPlaced).toBe(false)
    })

    test('does nothing for a second member, another user, or a day-old Organization', async () => {
      const harness = await make()
      const two = await seedAged(harness, HOUR, ['rep'])
      const one = await seedAged(harness, HOUR)
      const old = await seedAged(harness, 25 * HOUR)

      expect(await abandon(harness, two.organizationId, two.members[0]?.userId as UserId)).toBe(
        false
      )
      expect(await abandon(harness, one.organizationId, newUserId())).toBe(false)
      expect(await abandon(harness, old.organizationId, old.members[0]?.userId as UserId)).toBe(
        false
      )

      for (const seeded of [two, one, old]) {
        const after = await state(harness, seeded.organizationId)
        expect(after.organization?.status).toBe('active')
        expect(after.members).toHaveLength(seeded.members.length)
      }
    })

    test('does nothing for a deleted Organization, or one that does not exist', async () => {
      const harness = await make()
      const { organizationId, members } = await seedAged(harness, HOUR)
      await harness.setStatus(organizationId, 'deleted')

      expect(await abandon(harness, organizationId, members[0]?.userId as UserId)).toBe(false)
      expect(await abandon(harness, newOrganizationId(), newUserId())).toBe(false)

      expect((await state(harness, organizationId)).members).toHaveLength(1)
    })

    test('a suspended one-member Organization under a day old is not abandoned', async () => {
      const harness = await make()
      const { organizationId, members } = await seedAged(harness, HOUR)
      await harness.setStatus(organizationId, 'suspended')

      expect(await abandon(harness, organizationId, members[0]?.userId as UserId)).toBe(false)

      const after = await state(harness, organizationId)
      expect(after.organization?.status).toBe('suspended')
      expect(after.members).toHaveLength(1)
    })

    test('a change that is rolled back leaves the Organization as it was', async () => {
      const harness = await make()
      const { organizationId, members } = await seedAged(harness, HOUR)

      await expect(
        harness.store.withOrganization(organizationId, async (scope) => {
          await scope.lockOrganization()
          await scope.abandonOrganization(members[0]?.userId as UserId, 24, new Date())
          throw new Error('rolled back')
        })
      ).rejects.toThrow('rolled back')

      const after = await state(harness, organizationId)
      expect(after.organization?.status).toBe('active')
      expect(after.members).toHaveLength(1)
    })

    describe('Prospects', () => {
      const prospectId = () => formatId('prs', crypto.randomUUID()) as ProspectId
      const companyId = () => formatId('pco', crypto.randomUUID()) as ProspectCompanyId
      const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

      async function world() {
        const harness = await make()
        const seeded = await seedOrganization(harness.store, ['manager', 'rep', 'rep'])
        const manager = seeded.members[1] as SeededMember
        const rep = seeded.members[2] as SeededMember
        const outsider = seeded.members[3] as SeededMember
        const run = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
          harness.store.withOrganization(seeded.organizationId, async (scope) => {
            await scope.lockOrganization()
            return fn(scope)
          })
        await run(async (scope) => {
          const team = await scope.insertTeam({
            id: formatId('team', crypto.randomUUID()),
            name: 'East',
            now: NOW,
          })
          await scope.addTeamMember(team.id, manager.id, NOW)
          await scope.addTeamMember(team.id, rep.id, NOW)
        })
        const add = (
          owner: SeededMember | null,
          minutes: number,
          companyRef: ProspectCompanyId | null = null
        ) =>
          run((scope) =>
            scope.insertProspect({
              id: prospectId(),
              companyId: companyRef,
              ownerMembershipId: owner?.id ?? null,
              source: 'manual',
              tags: [],
              notes: null,
              now: at(minutes),
            })
          )
        return { harness, seeded, manager, rep, outsider, run, add }
      }

      test('a Prospect is read back by id and a missing or foreign id is null', async () => {
        const { harness, seeded, run, add, rep } = await world()
        const made = await add(rep, 0)

        const read = await run((scope) => scope.getProspect(made.id, { kind: 'all' }))
        const missing = await run((scope) => scope.getProspect(prospectId(), { kind: 'all' }))
        const other = await seedOrganization(harness.store)
        const foreign = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.getProspect(made.id, { kind: 'all' })
        )

        expect(read).toMatchObject({ id: made.id, ownerMembershipId: rep.id, status: 'active' })
        expect(missing).toBeNull()
        expect(foreign).toBeNull()
        expect(seeded.organizationId).not.toBe(other.organizationId)
      })

      test('a page is newest first by creation time then id, and a cursor loses and repeats none', async () => {
        const { run, add, rep } = await world()
        const made = []
        for (const minutes of [0, 1, 2, 2, 2, 3]) {
          made.push(await add(rep, minutes))
        }

        const walk = async () => {
          const ids: string[] = []
          let after: { createdAt: Date; id: ProspectId } | undefined
          for (;;) {
            const page = await run((scope) =>
              scope.listProspects({
                visibility: { kind: 'all' },
                limit: 2,
                ...(after ? { after } : {}),
              })
            )
            ids.push(...page.map((p) => p.id))
            const last = page[page.length - 1]
            if (page.length < 2 || !last) {
              return ids
            }
            after = { createdAt: last.createdAt, id: last.id }
          }
        }
        const expected = [...made]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .map((p) => p.id)

        expect(await walk()).toEqual(expected)
      })

      test('visibility: all, owner and team', async () => {
        const { run, add, manager, rep, outsider } = await world()
        const mine = await add(manager, 0)
        const mates = await add(rep, 1)
        const far = await add(outsider, 2)
        const unowned = await add(null, 3)
        const ids = (visibility: ProspectVisibility) =>
          run((scope) => scope.listProspects({ visibility, limit: 100 })).then((r) =>
            r.map((p) => p.id).sort()
          )

        expect(await ids({ kind: 'all' })).toEqual([mine.id, mates.id, far.id, unowned.id].sort())
        expect(await ids({ kind: 'owner', membershipId: rep.id })).toEqual([mates.id])
        expect(await ids({ kind: 'team', managerMembershipId: manager.id })).toEqual(
          [mine.id, mates.id].sort()
        )
        expect(
          await run((scope) =>
            scope.getProspect(far.id, { kind: 'team', managerMembershipId: manager.id })
          )
        ).toBeNull()
      })

      test('filters by owner, status, company and Source', async () => {
        const { run, add, rep, manager } = await world()
        const company = await run((scope) =>
          scope.insertProspectCompany({ id: companyId(), name: 'Acme', domain: null, now: NOW })
        )
        const a = await add(rep, 0, company.id)
        const b = await add(manager, 1)
        await run((scope) => scope.updateProspect(b.id, { status: 'archived' }, at(5)))
        const ids = (extra: Partial<ProspectPageRequest>) =>
          run((scope) =>
            scope.listProspects({ visibility: { kind: 'all' }, limit: 100, ...extra })
          ).then((r) => r.map((p) => p.id))

        expect(await ids({ ownerMembershipId: rep.id })).toEqual([a.id])
        expect(await ids({ status: 'archived' })).toEqual([b.id])
        expect(await ids({ companyId: company.id })).toEqual([a.id])
        expect(await ids({ source: 'manual' })).toHaveLength(2)
        expect(await ids({ source: 'import' })).toEqual([])
      })

      test('q matches the current name, email and company name, ignoring case', async () => {
        const { run, add, rep } = await world()
        const company = await run((scope) =>
          scope.insertProspectCompany({
            id: companyId(),
            name: 'Globex Corp',
            domain: null,
            now: NOW,
          })
        )
        const a = await add(rep, 0, company.id)
        const b = await add(rep, 1)
        const stamp = { source: 'manual', sourceRef: null, setByUserId: null, at: NOW }
        await run(async (scope) => {
          await scope.applyFieldChanges('prospect', a.id, [
            { action: 'set', field: 'firstName', value: 'Ada', ...stamp },
          ])
          await scope.applyFieldChanges('prospect', b.id, [
            { action: 'set', field: 'email', value: 'bea@example.test', ...stamp },
          ])
        })
        const ids = (q: string) =>
          run((scope) => scope.listProspects({ visibility: { kind: 'all' }, limit: 100, q })).then(
            (r) => r.map((p) => p.id)
          )

        expect(await ids('ADA')).toEqual([a.id])
        expect(await ids('BEA@EX')).toEqual([b.id])
        expect(await ids('globex')).toEqual([a.id])
        expect(await ids('zzz')).toEqual([])
      })

      test('q matches %, _ and \\ literally, in any current field value', async () => {
        const { run, add, rep } = await world()
        const stamp = { source: 'manual', sourceRef: null, setByUserId: null, at: NOW }
        const named = async (minutes: number, value: string) => {
          const made = await add(rep, minutes)
          await run((scope) =>
            scope.applyFieldChanges('prospect', made.id, [
              { action: 'set', field: 'jobTitle', value, ...stamp },
            ])
          )
          return made.id
        }
        const percent = await named(0, '100% sure')
        const underscore = await named(1, 'a_b')
        const plain = await named(2, 'axb sure')
        const slash = await named(3, 'c\\d')
        const ids = (q: string) =>
          run((scope) => scope.listProspects({ visibility: { kind: 'all' }, limit: 100, q })).then(
            (r) => r.map((p) => p.id).sort()
          )

        expect(await ids('%')).toEqual([percent])
        expect(await ids('_')).toEqual([underscore])
        expect(await ids('a_b')).toEqual([underscore])
        expect(await ids('\\')).toEqual([slash])
        expect(await ids('sure')).toEqual([percent, plain].sort())
      })

      test("q never matches another Organization's Prospects or Companies", async () => {
        const { harness, run, add, rep } = await world()
        const stamp = { source: 'manual', sourceRef: null, setByUserId: null, at: NOW }
        const mine = await add(rep, 0)
        await run((scope) =>
          scope.applyFieldChanges('prospect', mine.id, [
            { action: 'set', field: 'firstName', value: 'Zelda', ...stamp },
          ])
        )
        const other = await seedOrganization(harness.store, ['rep'])
        const theirs = await harness.store.withOrganization(other.organizationId, async (scope) => {
          await scope.lockOrganization()
          const made = await scope.insertProspect({
            id: prospectId(),
            companyId: null,
            ownerMembershipId: null,
            source: 'manual',
            tags: [],
            notes: null,
            now: at(0),
          })
          await scope.applyFieldChanges('prospect', made.id, [
            { action: 'set', field: 'firstName', value: 'Zelda', ...stamp },
          ])
          await scope.insertProspectCompany({
            id: companyId(),
            name: 'Zelda Works',
            domain: null,
            now: NOW,
          })
          return made
        })

        const found = await run((scope) =>
          scope.listProspects({ visibility: { kind: 'all' }, limit: 100, q: 'zelda' })
        )
        const companies = await run((scope) =>
          scope.listProspectCompanies({ limit: 100, q: 'zelda' })
        )

        expect(found.map((p) => p.id)).toEqual([mine.id])
        expect(found.map((p) => p.id)).not.toContain(theirs.id)
        expect(companies).toEqual([])
      })

      test('a q list pages by id and finds one owner Prospects beyond the first search window', async () => {
        const { run, add, rep, manager } = await world()
        const stamp = { source: 'manual', sourceRef: null, setByUserId: null, at: NOW }
        const made: ProspectId[] = []
        // Ids are random, so id order is too: the rep owns every third Prospect, which leaves some of
        // them past the first 101 ids except with a chance of about one in 100,000.
        const repIndexes: number[] = []
        for (let index = 0; index < 130; index++) {
          const owner = index % 3 === 0 ? rep : manager
          if (index % 3 === 0) {
            repIndexes.push(index)
          }
          const one = await add(owner, index)
          made.push(one.id)
          await run((scope) =>
            scope.applyFieldChanges('prospect', one.id, [
              { action: 'set', field: 'firstName', value: `Zed${index}`, ...stamp },
            ])
          )
        }
        const owned = repIndexes.map((index) => made[index] as ProspectId).sort()
        expect(owned.some((id) => [...made].sort().indexOf(id) >= 101)).toBe(true)

        const rare = await run((scope) =>
          scope.listProspects({
            visibility: { kind: 'all' },
            ownerMembershipId: rep.id,
            q: 'zed',
            limit: 100,
          })
        )
        const seen: ProspectId[] = []
        let after: { createdAt: Date; id: ProspectId } | undefined
        for (;;) {
          const page = await run((scope) =>
            scope.listProspects({
              visibility: { kind: 'all' },
              q: 'zed',
              limit: 41,
              ...(after ? { after } : {}),
            })
          )
          seen.push(...page.slice(0, 40).map((p) => p.id))
          const last = page[39]
          if (page.length < 41 || !last) {
            break
          }
          after = { createdAt: last.createdAt, id: last.id }
        }

        expect(rare.map((p) => p.id)).toEqual(owned)
        expect(seen).toEqual([...made].sort())
      })

      test('a q search with a rare owner filter reaches every match by following resumeAfter', async () => {
        const { run, add, rep, manager } = await world()
        const stamp = { source: 'manual', sourceRef: null, setByUserId: null, at: NOW }
        const made: ProspectId[] = []
        const owned: ProspectId[] = []
        // 620 matches is more than the five windows of 101 ids a single call reads. Ids are random,
        // so the rep owns nine of them, fewer than a page: the first call scans five windows, finds fewer
        // than a page and must say where to resume.
        for (let index = 0; index < 620; index++) {
          const mine = index % 70 === 0
          const one = await add(mine ? rep : manager, index)
          made.push(one.id)
          if (mine) {
            owned.push(one.id)
          }
          await run((scope) =>
            scope.applyFieldChanges('prospect', one.id, [
              { action: 'set', field: 'firstName', value: `Yarrow${index}`, ...stamp },
            ])
          )
        }
        const sorted = [...made].sort()
        expect(sorted).toHaveLength(620)

        // Page the way the service does: ask for one more than the page, follow the extra row's
        // predecessor when it comes back, else `resumeAfter` when the search stopped early.
        const seen: ProspectId[] = []
        let after: { createdAt: Date; id: ProspectId } | undefined
        let calls = 0
        let stoppedOnTheCap = false
        for (;;) {
          const result = await run((scope) =>
            scope.searchProspects({
              visibility: { kind: 'all' },
              ownerMembershipId: rep.id,
              q: 'yarrow',
              limit: 11,
              ...(after ? { after } : {}),
            })
          )
          calls += 1
          if (result.rows.length < 11 && result.resumeAfter !== null) {
            stoppedOnTheCap = true
          }
          const page = result.rows.slice(0, 10)
          seen.push(...page.map((row) => row.id))
          const next = result.rows.length > 10 ? page.at(-1)?.id : result.resumeAfter
          if (!next) {
            break
          }
          after = { createdAt: new Date(0), id: next }
        }

        expect(seen).toEqual([...owned].sort())
        expect(stoppedOnTheCap).toBe(true)
        expect(calls).toBeGreaterThan(1)
      }, 120_000)

      test('an identity is held by one Prospect, found by value, freed by null', async () => {
        const { run, add, rep } = await world()
        const a = await add(rep, 0)
        const b = await add(rep, 1)
        await run((scope) => scope.setProspectIdentity(a.id, 'email', 'a@example.test', NOW))

        expect(await run((scope) => scope.findProspectByIdentity('email', 'a@example.test'))).toBe(
          a.id
        )
        await expect(
          run((scope) => scope.setProspectIdentity(b.id, 'email', 'a@example.test', NOW))
        ).rejects.toBeInstanceOf(ProspectIdentityTakenError)
        await run((scope) => scope.setProspectIdentity(a.id, 'email', null, NOW))
        expect(
          await run((scope) => scope.findProspectByIdentity('email', 'a@example.test'))
        ).toBeNull()
        await run((scope) => scope.setProspectIdentity(b.id, 'email', 'a@example.test', NOW))
        expect(await run((scope) => scope.findProspectByIdentity('email', 'a@example.test'))).toBe(
          b.id
        )
      })

      test('the same identity value in another Organization is not a clash', async () => {
        const { harness, run, add, rep } = await world()
        const a = await add(rep, 0)
        await run((scope) => scope.setProspectIdentity(a.id, 'email', 'a@example.test', NOW))
        const other = await seedOrganization(harness.store)

        const found = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.findProspectByIdentity('email', 'a@example.test')
        )

        expect(found).toBeNull()
      })

      test('a Prospect Company with a taken domain, or an unknown company or owner, is refused', async () => {
        const { run, add, rep } = await world()
        await run((scope) =>
          scope.insertProspectCompany({ id: companyId(), name: 'A', domain: 'a.test', now: NOW })
        )

        await expect(
          run((scope) =>
            scope.insertProspectCompany({ id: companyId(), name: 'B', domain: 'a.test', now: NOW })
          )
        ).rejects.toBeInstanceOf(CompanyDomainTakenError)
        await expect(add(rep, 0, companyId())).rejects.toBeInstanceOf(MissingReferenceError)
        await expect(
          run((scope) =>
            scope.insertProspect({
              id: prospectId(),
              companyId: null,
              ownerMembershipId: newMembershipId(),
              source: 'manual',
              tags: [],
              notes: null,
              now: NOW,
            })
          )
        ).rejects.toBeInstanceOf(MissingReferenceError)
      })

      test('q on Companies matches name or domain, % and _ literally, and pages by id', async () => {
        const { run } = await world()
        const make = (name: string, domain: string | null): Promise<ProspectCompanyId> =>
          run((scope) =>
            scope.insertProspectCompany({ id: companyId(), name, domain, now: NOW })
          ).then((c) => c.id)
        const percent = await make('Half % Off', null)
        const under = await make('Under_score', null)
        await make('Underscore', 'underscore.test')
        const many: ProspectCompanyId[] = []
        for (let index = 0; index < 5; index++) {
          many.push(await make(`Pager ${index}`, null))
        }
        const find = (q: string) =>
          run((scope) => scope.listProspectCompanies({ limit: 100, q })).then((r) =>
            r.map((c) => c.id)
          )

        expect(await find('%')).toEqual([percent])
        expect(await find('_')).toEqual([under])
        expect(await find('R_S')).toEqual([under])
        const first = await run((scope) => scope.listProspectCompanies({ limit: 3, q: 'pager' }))
        const last = first.at(-1)
        const rest = await run((scope) =>
          scope.listProspectCompanies({
            limit: 3,
            q: 'pager',
            after: { createdAt: last?.createdAt ?? NOW, id: last?.id ?? companyId() },
          })
        )
        expect([...first, ...rest].map((c) => c.id)).toEqual([...many].sort())
      })

      test('a Prospect Company keeps its enrichment columns and field values', async () => {
        const { run } = await world()
        const id = companyId()

        const created = await run((scope) =>
          scope.insertProspectCompany({
            id,
            name: 'Acme',
            domain: null,
            industry: 'Software',
            region: 'EMEA',
            employeeCount: 0,
            technologies: ['Bun'],
            now: NOW,
          })
        )
        const patched = await run((scope) =>
          scope.updateProspectCompany(
            id,
            { industry: null, employeeCount: 40, technologies: [] },
            at(1)
          )
        )
        await run((scope) =>
          scope.applyFieldChanges('company', id, [
            {
              action: 'set',
              field: 'employeeCount',
              value: '40',
              source: 'manual',
              sourceRef: null,
              setByUserId: null,
              at: at(1),
            },
            {
              action: 'set',
              field: 'technologies',
              value: '[]',
              source: 'manual',
              sourceRef: null,
              setByUserId: null,
              at: at(1),
            },
          ])
        )
        const read = await run((scope) => scope.getProspectCompany(id))
        const fields = (await run((scope) => scope.listCurrentFields('company', [id]))).get(id)

        expect(created).toMatchObject({
          industry: 'Software',
          region: 'EMEA',
          employeeCount: 0,
          technologies: ['Bun'],
        })
        expect(patched).toMatchObject({
          industry: null,
          region: 'EMEA',
          employeeCount: 40,
          technologies: [],
        })
        expect(read).toMatchObject({ industry: null, employeeCount: 40, technologies: [] })
        expect(fields?.map((f) => [f.field, f.value]).sort()).toEqual([
          ['employeeCount', '40'],
          ['technologies', '[]'],
        ])
      })

      test('field values: set replaces the current, clear removes it, record keeps it out of view', async () => {
        const { run, add, rep } = await world()
        const p = await add(rep, 0)
        const stamp = (source: string, minutes: number) => ({
          source,
          sourceRef: source === 'manual' ? null : 'ref',
          setByUserId: null,
          at: at(minutes),
        })
        const current = async () =>
          (await run((scope) => scope.listCurrentFields('prospect', [p.id]))).get(p.id) ?? []

        await run((scope) =>
          scope.applyFieldChanges('prospect', p.id, [
            { action: 'set', field: 'jobTitle', value: 'Eng', ...stamp('import', 1) },
          ])
        )
        await run((scope) =>
          scope.applyFieldChanges('prospect', p.id, [
            { action: 'set', field: 'jobTitle', value: 'CTO', ...stamp('manual', 2) },
            {
              action: 'record',
              field: 'jobTitle',
              value: 'Dev',
              state: 'superseded',
              ...stamp('import', 3),
            },
          ])
        )

        expect(await current()).toMatchObject([
          { field: 'jobTitle', value: 'CTO', source: 'manual' },
        ])
        await run((scope) =>
          scope.applyFieldChanges('prospect', p.id, [
            { action: 'clear', field: 'jobTitle', at: at(4) },
          ])
        )
        expect(await current()).toEqual([])
      })

      test('a field set many times still reads its latest value (history is trimmed)', async () => {
        const { run, add, rep } = await world()
        const p = await add(rep, 0)

        for (let i = 0; i < 60; i++) {
          await run((scope) =>
            scope.applyFieldChanges('prospect', p.id, [
              {
                action: 'set',
                field: 'jobTitle',
                value: `v${i}`,
                source: 'import',
                sourceRef: 'ref',
                setByUserId: null,
                at: at(i),
              },
            ])
          )
        }

        const read = (await run((scope) => scope.listCurrentFields('prospect', [p.id]))).get(p.id)
        expect(read).toMatchObject([{ field: 'jobTitle', value: 'v59' }])
      })

      test('a rolled-back transaction leaves no Prospect', async () => {
        const { harness, seeded, rep } = await world()
        const id = prospectId()

        await expect(
          harness.store.withOrganization(seeded.organizationId, async (scope) => {
            await scope.lockOrganization()
            await scope.insertProspect({
              id,
              companyId: null,
              ownerMembershipId: rep.id,
              source: 'manual',
              tags: [],
              notes: null,
              now: NOW,
            })
            throw new Error('rolled back')
          })
        ).rejects.toThrow('rolled back')

        const after = await harness.store.withOrganization(seeded.organizationId, (scope) =>
          scope.getProspect(id, { kind: 'all' })
        )
        expect(after).toBeNull()
      })

      test('reassigning reports what exists and what changed, and ignores foreign and missing ids', async () => {
        const { harness, run, add, rep, manager } = await world()
        const mine = await add(rep, 0)
        const already = await add(manager, 1)
        const other = await seedOrganization(harness.store, ['rep'])
        const foreign = await harness.store.withOrganization(
          other.organizationId,
          async (scope) => {
            await scope.lockOrganization()
            return scope.insertProspect({
              id: prospectId(),
              companyId: null,
              ownerMembershipId: other.members[1]?.id ?? null,
              source: 'manual',
              tags: [],
              notes: null,
              now: NOW,
            })
          }
        )

        const result = await run((scope) =>
          scope.reassignProspects(
            [mine.id, already.id, foreign.id, prospectId()],
            manager.id,
            at(5)
          )
        )

        expect(result.found).toBe(2)
        expect(result.changed).toEqual([mine.id])
        const read = await run((scope) => scope.getProspect(mine.id, { kind: 'all' }))
        expect(read?.ownerMembershipId).toBe(manager.id)
        const untouched = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.getProspect(foreign.id, { kind: 'all' })
        )
        expect(untouched?.ownerMembershipId).toBe(other.members[1]?.id)
      })

      test('reassigning to a Membership that is not here throws MissingReferenceError', async () => {
        const { harness, run, add, rep } = await world()
        const made = await add(rep, 0)
        const other = await seedOrganization(harness.store, ['rep'])

        await expect(
          run((scope) =>
            scope.reassignProspects([made.id], other.members[1]?.id as MembershipId, at(1))
          )
        ).rejects.toBeInstanceOf(MissingReferenceError)
      })

      test('reassigning more than the maximum ids is refused', async () => {
        const { run, rep } = await world()
        const ids = Array.from({ length: REASSIGN_MAX_IDS + 1 }, () => prospectId())

        await expect(run((scope) => scope.reassignProspects(ids, rep.id, at(1)))).rejects.toThrow()
      })

      describe('erasing', () => {
        const stamp = (minutes: number) => ({
          source: 'manual',
          sourceRef: null,
          setByUserId: null,
          at: at(minutes),
        })

        async function withHistory() {
          const w = await world()
          const made = await w.add(w.rep, 0)
          await w.run(async (scope) => {
            await scope.applyFieldChanges('prospect', made.id, [
              { action: 'set', field: 'email', value: 'old@example.test', ...stamp(1) },
              { action: 'set', field: 'phone', value: '+14155550100', ...stamp(1) },
            ])
            await scope.applyFieldChanges('prospect', made.id, [
              { action: 'set', field: 'email', value: 'new@example.test', ...stamp(2) },
              { action: 'set', field: 'firstName', value: 'Pat', ...stamp(2) },
            ])
            await scope.setProspectIdentity(made.id, 'email', 'new@example.test', at(2))
            await scope.setProspectIdentity(made.id, 'phone', '+14155550100', at(2))
          })
          return { ...w, made }
        }

        test('lists every address ever held, current or superseded, once each', async () => {
          const { run, made } = await withHistory()

          const found = await run((scope) => scope.listProspectAddresses(made.id))

          const key = (a: { kind: string; value: string }) => `${a.kind}:${a.value}`
          expect(found.map(key).sort()).toEqual([
            'email:new@example.test',
            'email:old@example.test',
            'phone:+14155550100',
          ])
        })

        test('removes at most the limit of rows per call and reports how many it removed', async () => {
          const { run, made } = await withHistory()

          const first = await run((scope) => scope.eraseProspectFields(made.id, 2))
          const second = await run((scope) => scope.eraseProspectFields(made.id, 2))
          const third = await run((scope) => scope.eraseProspectFields(made.id, 2))
          const last = await run((scope) => scope.eraseProspectFields(made.id, 2))

          expect([first, second, third, last]).toEqual([2, 2, 0, 0])
          // The identities stay until the Prospect row goes, so the live addresses are still known.
          expect(await run((scope) => scope.listProspectAddresses(made.id))).toHaveLength(2)
          expect(
            (await run((scope) => scope.listCurrentFields('prospect', [made.id]))).get(made.id)
          ).toBeUndefined()
        })

        test('the Prospect row goes with its identities, which are then free', async () => {
          const { run, made, add, rep } = await withHistory()
          await run((scope) => scope.eraseProspectFields(made.id, 100))

          const erased = await run((scope) => scope.eraseProspectRow(made.id))
          const again = await run((scope) => scope.eraseProspectRow(made.id))

          expect([erased, again]).toEqual([true, false])
          expect(await run((scope) => scope.getProspect(made.id, { kind: 'all' }))).toBeNull()
          expect(
            await run((scope) => scope.findProspectByIdentity('email', 'new@example.test'))
          ).toBe(null)
          const next = await add(rep, 5)
          await run((scope) =>
            scope.setProspectIdentity(next.id, 'email', 'new@example.test', at(5))
          )
          expect(
            await run((scope) => scope.findProspectByIdentity('email', 'new@example.test'))
          ).toBe(next.id)
        })

        test('another Organization is left alone, even for the same id', async () => {
          const { harness, made, run } = await withHistory()
          const other = await seedOrganization(harness.store)
          const theirs = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
            harness.store.withOrganization(other.organizationId, async (scope) => {
              await scope.lockOrganization()
              return fn(scope)
            })

          const removed = await theirs((scope) => scope.eraseProspectFields(made.id, 100))
          const row = await theirs((scope) => scope.eraseProspectRow(made.id))

          expect(removed).toBe(0)
          expect(row).toBe(false)
          expect(await run((scope) => scope.getProspect(made.id, { kind: 'all' }))).not.toBeNull()
          expect(await run((scope) => scope.listProspectAddresses(made.id))).toHaveLength(3)
        })
      })
    })

    describe('Prospect imports', () => {
      const importId = () => formatId('pimp', crypto.randomUUID()) as ProspectImportId
      const prospectId = () => formatId('prs', crypto.randomUUID()) as ProspectId
      const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

      async function world() {
        const harness = await make()
        const seeded = await seedOrganization(harness.store)
        const run = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
          harness.store.withOrganization(seeded.organizationId, async (scope) => {
            await scope.lockOrganization()
            return fn(scope)
          })
        const add = (minutes: number) => {
          const id = importId()
          return run((scope) =>
            scope.insertProspectImport({
              id,
              sizeBytes: 120,
              contentHash: new Uint8Array(32).fill(7),
              objectKey: `prospect-imports/${id}/original.csv`,
              uploadedByUserId: seeded.owner.userId,
              now: at(minutes),
            })
          )
        }
        return { harness, seeded, run, add }
      }

      test('an import starts uploaded with no counts and is read back by id; a foreign id is null', async () => {
        const { harness, seeded, run, add } = await world()
        const made = await add(0)

        const read = await run((scope) => scope.getProspectImport(made.id))
        const locked = await run((scope) => scope.lockProspectImport(made.id))
        const missing = await run((scope) => scope.getProspectImport(importId()))
        const other = await seedOrganization(harness.store)
        const foreign = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.getProspectImport(made.id)
        )

        expect(read).toMatchObject({
          id: made.id,
          state: 'uploaded',
          failureReason: null,
          sizeBytes: 120,
          processedRows: 0,
          rowCount: null,
          createdCount: null,
          updatedCount: null,
          skippedCount: null,
          rejectedCount: null,
          uploadedByUserId: seeded.owner.userId,
        })
        expect([...(read?.contentHash ?? [])]).toEqual(new Array(32).fill(7))
        expect(locked?.id).toBe(made.id)
        expect(missing).toBeNull()
        expect(foreign).toBeNull()
      })

      test('a page is newest first and a cursor loses and repeats none', async () => {
        const { run, add } = await world()
        const made = []
        for (const minutes of [0, 1, 2, 2, 3]) {
          made.push(await add(minutes))
        }
        const expected = [...made]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
          .map((item) => item.id)

        const first = await run((scope) => scope.listProspectImports({ limit: 2 }))
        const last = first[1]
        const rest = await run((scope) =>
          scope.listProspectImports({
            limit: 10,
            after: last ? { createdAt: last.createdAt, id: last.id } : undefined,
          })
        )

        expect([...first, ...rest].map((item) => item.id)).toEqual(expected)
      })

      test('progress, a failure and the final counts are stored', async () => {
        const { run, add } = await world()
        const made = await add(0)

        const processing = await run((scope) =>
          scope.updateProspectImport(made.id, { state: 'processing', processedRows: 40 }, at(1))
        )
        const done = await run((scope) =>
          scope.updateProspectImport(
            made.id,
            {
              state: 'completed',
              processedRows: 50,
              counts: { rowCount: 50, created: 30, updated: 10, skipped: 4, rejected: 6 },
            },
            at(2)
          )
        )
        const failed = await add(3)
        const failedRead = await run((scope) =>
          scope.updateProspectImport(
            failed.id,
            { state: 'failed', failureReason: 'too_many_rows' },
            at(4)
          )
        )
        const missing = await run((scope) =>
          scope.updateProspectImport(importId(), { state: 'processing' }, at(5))
        )

        expect(processing).toMatchObject({ state: 'processing', processedRows: 40, rowCount: null })
        expect(done).toMatchObject({
          state: 'completed',
          processedRows: 50,
          rowCount: 50,
          createdCount: 30,
          updatedCount: 10,
          skippedCount: 4,
          rejectedCount: 6,
        })
        expect(done?.updatedAt.getTime()).toBe(at(2).getTime())
        expect(failedRead).toMatchObject({ state: 'failed', failureReason: 'too_many_rows' })
        expect(missing).toBeNull()
      })

      test('rows keep their first result, page by row number and count by result', async () => {
        const { run, add } = await world()
        const made = await add(0)
        const created = prospectId()
        await run((scope) =>
          scope.insertProspectImportRows(made.id, [
            { rowNumber: 2, result: 'created', reason: null, prospectId: created },
            { rowNumber: 3, result: 'rejected', reason: 'invalid_email', prospectId: null },
            { rowNumber: 4, result: 'skipped', reason: 'manual_values_kept', prospectId: created },
          ])
        )
        await run((scope) =>
          scope.insertProspectImportRows(made.id, [
            { rowNumber: 3, result: 'rejected', reason: 'blank_row', prospectId: null },
            { rowNumber: 5, result: 'rejected', reason: 'missing_identity', prospectId: null },
          ])
        )

        const all = await run((scope) =>
          scope.listProspectImportRows({ importId: made.id, limit: 10 })
        )
        const page = await run((scope) =>
          scope.listProspectImportRows({ importId: made.id, limit: 2, afterRow: 2 })
        )
        const rejected = await run((scope) =>
          scope.listProspectImportRows({ importId: made.id, result: 'rejected', limit: 10 })
        )
        const counts = await run((scope) => scope.countProspectImportRows(made.id))

        expect(all.map((row) => [row.rowNumber, row.result, row.reason])).toEqual([
          [2, 'created', null],
          [3, 'rejected', 'invalid_email'],
          [4, 'skipped', 'manual_values_kept'],
          [5, 'rejected', 'missing_identity'],
        ])
        expect(all[0]?.prospectId).toBe(created)
        expect(page.map((row) => row.rowNumber)).toEqual([3, 4])
        expect(rejected.map((row) => row.rowNumber)).toEqual([3, 5])
        expect(counts).toEqual({ created: 1, updated: 0, skipped: 1, rejected: 2 })
      })

      test('another Organization sees none of the rows, and deleting an import removes its rows', async () => {
        const { harness, run, add } = await world()
        const made = await add(0)
        await run((scope) =>
          scope.insertProspectImportRows(made.id, [
            { rowNumber: 2, result: 'rejected', reason: 'blank_row', prospectId: null },
          ])
        )
        const other = await seedOrganization(harness.store)

        const foreignRows = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.listProspectImportRows({ importId: made.id, limit: 10 })
        )
        const foreignDelete = await harness.store.withOrganization(
          other.organizationId,
          async (scope) => {
            await scope.lockOrganization()
            return scope.deleteProspectImport(made.id)
          }
        )
        const deleted = await run(async (scope) => {
          await scope.lockOrganization()
          return scope.deleteProspectImport(made.id)
        })
        const again = await run(async (scope) => {
          await scope.lockOrganization()
          return scope.deleteProspectImport(made.id)
        })
        const after = await run((scope) =>
          scope.listProspectImportRows({ importId: made.id, limit: 10 })
        )

        expect(foreignRows).toEqual([])
        expect(foreignDelete).toBe(false)
        expect(deleted).toBe(true)
        expect(again).toBe(false)
        expect(after).toEqual([])
        expect(await run((scope) => scope.getProspectImport(made.id))).toBeNull()
      })

      test('a Prospect Company is found by domain, or by name ignoring case, oldest first', async () => {
        const { harness, run } = await world()
        const newId = () => formatId('pco', crypto.randomUUID()) as ProspectCompanyId
        const first = newId()
        const second = newId()
        await run(async (scope) => {
          await scope.insertProspectCompany({
            id: first,
            name: 'Globex',
            domain: 'globex.com',
            now: at(0),
          })
          await scope.insertProspectCompany({
            id: second,
            name: 'GLOBEX',
            domain: null,
            now: at(1),
          })
        })
        const other = await seedOrganization(harness.store)

        const byDomain = await run((scope) => scope.findProspectCompany({ domain: 'globex.com' }))
        const byName = await run((scope) => scope.findProspectCompany({ name: 'globex' }))
        const none = await run((scope) => scope.findProspectCompany({ name: 'Initech' }))
        const noDomain = await run((scope) => scope.findProspectCompany({ domain: 'initech.com' }))
        const foreign = await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.findProspectCompany({ domain: 'globex.com' })
        )

        expect(byDomain?.id).toBe(first)
        expect(byName?.id).toBe(first)
        expect(none).toBeNull()
        expect(noDomain).toBeNull()
        expect(foreign).toBeNull()
      })
    })
  })
}

/** What a {@link describeConsentLedger} run needs on top of the harness: a way to plant ledger events. */
export type ConsentLedgerHarness = CoreStoreHarness & {
  /** Appends a consent event of that kind for the Prospect on the channel, as the ledger's writer would. */
  seedConsent(
    organizationId: OrganizationId,
    prospectId: ProspectId,
    channel: ConsentChannel,
    kind: ConsentEventKind
  ): Promise<void>
  /** Creates a consent wording of the Organization that covers those channels. */
  seedWording(organizationId: OrganizationId, channels: ConsentChannel[]): Promise<ConsentWordingId>
}

/**
 * Suppression entries, the consent read the Contact Check makes and the Contact Check log, the same
 * in every adapter: tenant scoping, the one live entry per address, which entries can be removed,
 * keyset paging and the retention purge.
 */
export function describeConsentLedger(
  label: string,
  make: () => Promise<ConsentLedgerHarness>
): void {
  describe(`CoreStore consent ledger: ${label}`, () => {
    const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n)
    const entryId = () => formatId('sup', crypto.randomUUID()) as SuppressionEntryId
    const checkId = () => formatId('chk', crypto.randomUUID()) as ContactCheckId
    const prospectId = () => formatId('prs', crypto.randomUUID()) as ProspectId
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

    async function world() {
      const harness = await make()
      const seeded = await seedOrganization(harness.store, [])
      const run = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
        harness.store.withOrganization(seeded.organizationId, async (scope) => {
          await scope.lockOrganization()
          return fn(scope)
        })
      const entry = (
        n: number,
        minutes: number,
        overrides: Partial<NewSuppressionEntry> = {}
      ): NewSuppressionEntry => ({
        id: entryId(),
        addressKind: 'email',
        addressHash: hash(n),
        maskedAddress: 'a***@example.com',
        reason: 'manual',
        channel: null,
        sourceRef: null,
        addedByUserId: seeded.owner.userId,
        now: at(minutes),
        ...overrides,
      })
      return { harness, seeded, run, entry }
    }

    test('an entry is written once per live address and read back by hash and id', async () => {
      const { run, entry } = await world()
      const first = await run((scope) => scope.insertSuppressionEntry(entry(1, 0)))
      const again = await run((scope) => scope.insertSuppressionEntry(entry(1, 1)))

      expect(first.created).toBe(true)
      expect(again.created).toBe(false)
      expect(again.entry.id).toBe(first.entry.id)
      const found = await run((scope) => scope.findLiveSuppression('email', [hash(1), hash(2)]))
      expect(found.map((row) => row.id)).toEqual([first.entry.id])
      expect(await run((scope) => scope.findLiveSuppression('phone', [hash(1)]))).toEqual([])
      const read = await run((scope) => scope.getSuppressionEntry(first.entry.id))
      expect(read).toMatchObject({
        reason: 'manual',
        removable: true,
        maskedAddress: 'a***@example.com',
        removedAt: null,
      })
    })

    test('an entry of another Organization is neither found nor listed nor removed', async () => {
      const { harness, run, entry } = await world()
      const made = await run((scope) => scope.insertSuppressionEntry(entry(1, 0)))
      const other = await seedOrganization(harness.store, [])
      const inOther = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
        harness.store.withOrganization(other.organizationId, async (scope) => {
          await scope.lockOrganization()
          return fn(scope)
        })

      expect(await inOther((scope) => scope.findLiveSuppression('email', [hash(1)]))).toEqual([])
      expect(await inOther((scope) => scope.getSuppressionEntry(made.entry.id))).toBeNull()
      expect(
        await inOther((scope) => scope.listSuppressionEntries({ limit: 10, state: 'active' }))
      ).toEqual([])
      expect(
        await inOther((scope) =>
          scope.removeSuppressionEntry(made.entry.id, {
            userId: other.owner.userId,
            reason: 'no',
            now: at(2),
          })
        )
      ).toBeNull()
      expect(await run((scope) => scope.getSuppressionEntry(made.entry.id))).toMatchObject({
        removedAt: null,
      })
    })

    test('only a manual entry is removed, once, and its address can then be added again', async () => {
      const { seeded, run, entry } = await world()
      const manual = await run((scope) => scope.insertSuppressionEntry(entry(1, 0)))
      const stop = await run((scope) =>
        scope.insertSuppressionEntry(entry(2, 1, { reason: 'stop', channel: 'sms' }))
      )
      const removal = { userId: seeded.owner.userId, reason: 'Mistake', now: at(5) }

      expect(await run((scope) => scope.removeSuppressionEntry(stop.entry.id, removal))).toBeNull()
      const removed = await run((scope) => scope.removeSuppressionEntry(manual.entry.id, removal))
      expect(removed).toMatchObject({
        removedAt: at(5),
        removedByUserId: seeded.owner.userId,
        removalReason: 'Mistake',
      })
      expect(
        await run((scope) => scope.removeSuppressionEntry(manual.entry.id, removal))
      ).toBeNull()
      expect(await run((scope) => scope.findLiveSuppression('email', [hash(1)]))).toEqual([])

      const readded = await run((scope) => scope.insertSuppressionEntry(entry(1, 6)))
      expect(readded.created).toBe(true)
      expect(readded.entry.id).not.toBe(manual.entry.id)
      expect(
        (await run((scope) => scope.listSuppressionEntries({ limit: 10, state: 'removed' }))).map(
          (row) => row.id
        )
      ).toEqual([manual.entry.id])
    })

    test('entries list newest first by keyset and narrow by reason and kind', async () => {
      const { run, entry } = await world()
      const ids: SuppressionEntryId[] = []
      for (let n = 0; n < 5; n += 1) {
        const made = await run((scope) =>
          scope.insertSuppressionEntry(
            entry(n + 10, n, n === 3 ? { reason: 'bounce', addressKind: 'phone' } : {})
          )
        )
        ids.push(made.entry.id)
      }
      const newest = [...ids].reverse()

      const first = await run((scope) =>
        scope.listSuppressionEntries({ limit: 2, state: 'active' })
      )
      expect(first.map((row) => row.id)).toEqual(newest.slice(0, 2))
      const last = first[1]
      const second = await run((scope) =>
        scope.listSuppressionEntries({
          limit: 10,
          state: 'active',
          after: { at: last?.createdAt as Date, id: last?.id as SuppressionEntryId },
        })
      )
      expect(second.map((row) => row.id)).toEqual(newest.slice(2))
      expect(
        (
          await run((scope) =>
            scope.listSuppressionEntries({ limit: 10, state: 'active', reason: 'bounce' })
          )
        ).map((row) => row.id)
      ).toEqual([ids[3] as SuppressionEntryId])
      expect(
        await run((scope) =>
          scope.listSuppressionEntries({ limit: 10, state: 'active', addressKind: 'linkedin' })
        )
      ).toEqual([])
    })

    test('a Prospect identity is read back and a missing one is null', async () => {
      const { run } = await world()
      const id = prospectId()
      await run(async (scope) => {
        await scope.insertProspect({
          id,
          companyId: null,
          ownerMembershipId: null,
          source: 'manual',
          tags: [],
          notes: null,
          now: NOW,
        })
        await scope.setProspectIdentity(id, 'email', 'a@example.com', NOW)
      })

      expect(await run((scope) => scope.getProspectIdentity(id, 'email'))).toBe('a@example.com')
      expect(await run((scope) => scope.getProspectIdentity(id, 'phone'))).toBeNull()
      expect(await run((scope) => scope.getProspectIdentity(prospectId(), 'email'))).toBeNull()
    })

    test('the newest consent event of a Prospect on a channel decides, and others are apart', async () => {
      const { harness, seeded, run } = await world()
      const id = prospectId()
      await run((scope) =>
        scope.insertProspect({
          id,
          companyId: null,
          ownerMembershipId: null,
          source: 'manual',
          tags: [],
          notes: null,
          now: NOW,
        })
      )
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBeNull()

      await harness.seedConsent(seeded.organizationId, id, 'phone', 'granted')
      await harness.seedConsent(seeded.organizationId, id, 'sms', 'granted')
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBe('granted')
      await harness.seedConsent(seeded.organizationId, id, 'phone', 'withdrawn')
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBe('withdrawn')
      expect(await run((scope) => scope.latestConsentKind(id, 'sms'))).toBe('granted')
      expect(await run((scope) => scope.latestConsentKind(id, 'whatsapp'))).toBeNull()
      await harness.seedConsent(seeded.organizationId, id, 'phone', 'granted')
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBe('granted')

      const other = await seedOrganization(harness.store, [])
      expect(
        await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.latestConsentKind(id, 'phone')
        )
      ).toBeNull()
    })

    test('consent events page newest first by cursor, filter by channel, and are apart per Organization', async () => {
      const { harness, seeded, run } = await world()
      const id = prospectId()
      await run((scope) =>
        scope.insertProspect({
          id,
          companyId: null,
          ownerMembershipId: null,
          source: 'manual',
          tags: [],
          notes: null,
          now: NOW,
        })
      )
      const kinds = ['granted', 'withdrawn', 'granted', 'withdrawn', 'granted'] as const
      for (const [n, kind] of kinds.entries()) {
        await harness.seedConsent(seeded.organizationId, id, n % 2 === 0 ? 'sms' : 'phone', kind)
      }
      const first = await run((scope) => scope.listConsentEvents({ prospectId: id, limit: 3 }))
      expect(first.map((r) => r.event.channel)).toEqual(['sms', 'phone', 'sms'])
      const last = first.at(-1)
      const rest = await run((scope) =>
        scope.listConsentEvents({ prospectId: id, limit: 3, after: { seq: last?.seq ?? 0 } })
      )
      expect(rest).toHaveLength(2)
      expect(rest[0]?.seq).toBeLessThan(last?.seq ?? 0)
      const sms = await run((scope) =>
        scope.listConsentEvents({ prospectId: id, channel: 'sms', limit: 10 })
      )
      expect(sms.map((r) => r.event.kind)).toEqual(['granted', 'granted', 'granted'])
      const evidence = await run((scope) =>
        scope.listConsentEvidence({ prospectId: id, limit: 10 })
      )
      expect(evidence).toHaveLength(5)
      expect(evidence.every((r) => r.submission === null)).toBe(true)

      const other = await seedOrganization(harness.store, [])
      const strangerRead = await harness.store.withOrganization(other.organizationId, (scope) =>
        scope.listConsentEvents({ prospectId: id, limit: 10 })
      )
      expect(strangerRead).toEqual([])
    })

    test('appended consent events are stored in order, the newest per channel decides, and others are apart', async () => {
      const { harness, seeded, run } = await world()
      const id = prospectId()
      await run((scope) =>
        scope.insertProspect({
          id,
          companyId: null,
          ownerMembershipId: null,
          source: 'manual',
          tags: [],
          notes: null,
          now: NOW,
        })
      )
      const wordingId = await harness.seedWording(seeded.organizationId, ['phone', 'sms'])
      const input = (
        channel: ConsentChannel,
        kind: ConsentEventKind,
        minutes: number
      ): ConsentEventInput => ({
        id: formatId('cev', crypto.randomUUID()) as ConsentEventId,
        prospectId: id,
        channel,
        kind,
        source: 'manual',
        wordingId: kind === 'granted' ? wordingId : null,
        evidenceRef: kind === 'granted' ? 'ticket-1' : null,
        callId: null,
        formId: null,
        ipAddress: null,
        userAgent: null,
        stopAll: false,
        recordedByUserId: seeded.owner.userId,
        occurredAt: at(minutes),
      })

      expect(await run((scope) => scope.latestConsentEvents(id))).toEqual([])
      const stored = await run((scope) =>
        scope.appendConsentEvents([
          input('phone', 'granted', 0),
          input('sms', 'granted', 0),
          input('phone', 'withdrawn', 1),
        ])
      )
      expect(stored.map((e) => [e.channel, e.kind])).toEqual([
        ['phone', 'granted'],
        ['sms', 'granted'],
        ['phone', 'withdrawn'],
      ])

      const latest = await run((scope) => scope.latestConsentEvents(id))
      const byChannel = Object.fromEntries(latest.map((e) => [e.channel, e.kind]))
      expect(byChannel).toEqual({ phone: 'withdrawn', sms: 'granted' })
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBe('withdrawn')

      await run((scope) => scope.appendConsentEvents([input('phone', 'granted', 2)]))
      expect(await run((scope) => scope.latestConsentKind(id, 'phone'))).toBe('granted')
      expect(await run((scope) => scope.latestConsentEvents(id))).toHaveLength(2)
    })

    test('a consent wording and the events of one Organization are invisible to another', async () => {
      const { harness, seeded, run } = await world()
      const wordingId = await harness.seedWording(seeded.organizationId, ['phone'])
      expect(await run((scope) => scope.getConsentWording(wordingId))).toEqual({
        id: wordingId,
        version: 1,
        channels: ['phone'],
      })
      expect(await run((scope) => scope.getConsentWording(wordingId))).not.toBeNull()
      const other = await seedOrganization(harness.store, [])
      expect(
        await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.getConsentWording(wordingId)
        )
      ).toBeNull()
      expect(
        await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.latestConsentEvents(prospectId())
        )
      ).toEqual([])
    })

    test('checks are logged without a lock, listed newest first and narrowed by filter', async () => {
      const { harness, seeded, run } = await world()
      const id = prospectId()
      const record = (
        minutes: number,
        overrides: Partial<ContactCheckRecord> = {}
      ): ContactCheckRecord => ({
        id: checkId(),
        prospectId: id,
        channel: 'phone',
        purpose: 'agent_initiated',
        caller: 'voice',
        allowed: false,
        code: 'consent.missing',
        basis: null,
        checkedAt: at(minutes),
        ...overrides,
      })
      const rows = [
        record(0),
        record(1, { allowed: true, code: null, basis: 'consent_granted' }),
        record(2, { channel: 'email', prospectId: null, code: 'consent.suppressed' }),
      ]
      for (const row of rows) {
        // No lockOrganization: a check never waits for one.
        await harness.store.withOrganization(seeded.organizationId, (scope) =>
          scope.insertContactCheck(row)
        )
      }

      const all = await run((scope) => scope.listContactChecks({ limit: 10 }))
      expect(all.map((row) => row.id)).toEqual([...rows].reverse().map((row) => row.id))
      expect(all[0]).toMatchObject({ prospectId: null, code: 'consent.suppressed', basis: null })
      const page = await run((scope) => scope.listContactChecks({ limit: 1 }))
      const cursor = page[0]
      const next = await run((scope) =>
        scope.listContactChecks({
          limit: 10,
          after: { at: cursor?.checkedAt as Date, id: cursor?.id as ContactCheckId },
        })
      )
      expect(next.map((row) => row.id)).toEqual(
        [rows[1], rows[0]].map((r) => r?.id as ContactCheckId)
      )
      const byProspect = await run((scope) =>
        scope.listContactChecks({ limit: 10, prospectId: id })
      )
      expect(byProspect).toHaveLength(2)
      expect(
        await run((scope) => scope.listContactChecks({ limit: 10, allowed: true }))
      ).toHaveLength(1)
      expect(
        await run((scope) => scope.listContactChecks({ limit: 10, code: 'consent.suppressed' }))
      ).toHaveLength(1)
      expect(
        await run((scope) => scope.listContactChecks({ limit: 10, channel: 'email' }))
      ).toHaveLength(1)

      const other = await seedOrganization(harness.store, [])
      expect(
        await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.listContactChecks({ limit: 10 })
        )
      ).toEqual([])
    })

    test('the purge removes the old log rows of this Organization only, in bounded batches', async () => {
      const { harness, seeded, run } = await world()
      const row = (minutes: number): ContactCheckRecord => ({
        id: checkId(),
        prospectId: null,
        channel: 'email',
        purpose: 'rep_initiated',
        caller: 'portal',
        allowed: true,
        code: null,
        basis: 'rep_initiated',
        checkedAt: at(minutes),
      })
      const other = await seedOrganization(harness.store, [])
      await harness.store.withOrganization(other.organizationId, (scope) =>
        scope.insertContactCheck(row(0))
      )
      for (const minutes of [0, 1, 2, 10]) {
        await harness.store.withOrganization(seeded.organizationId, (scope) =>
          scope.insertContactCheck(row(minutes))
        )
      }

      expect(await run((scope) => scope.purgeContactChecks(at(5), 2))).toBe(2)
      expect(await run((scope) => scope.purgeContactChecks(at(5), 2))).toBe(1)
      expect(await run((scope) => scope.purgeContactChecks(at(5), 2))).toBe(0)
      expect(await run((scope) => scope.listContactChecks({ limit: 10 }))).toHaveLength(1)
      expect(
        await harness.store.withOrganization(other.organizationId, (scope) =>
          scope.listContactChecks({ limit: 10 })
        )
      ).toHaveLength(1)
    })
  })
}

/**
 * CRM connections, the same in every adapter: one per provider and Organization that keeps its id
 * when replaced, tokens held only as the bytes given, one CRM account in one Organization, delete
 * with the tokens, keyset paging and tenant scoping.
 */
export function describeCrmConnections(label: string, make: () => Promise<CoreStoreHarness>): void {
  describe(`CoreStore CRM connections: ${label}`, () => {
    const connectionId = () => formatId('crn', crypto.randomUUID()) as CrmConnectionId
    const bytes = (n: number) => new Uint8Array([n, n, n, n])

    async function world() {
      const harness = await make()
      const seeded = await seedOrganization(harness.store, [])
      const inOrg = <T>(
        organizationId: OrganizationId,
        fn: (scope: OrganizationScope) => Promise<T>
      ) =>
        harness.store.withOrganization(organizationId, async (scope) => {
          await scope.lockOrganization()
          return fn(scope)
        })
      const run = <T>(fn: (scope: OrganizationScope) => Promise<T>) =>
        inOrg(seeded.organizationId, fn)
      const connection = (
        membershipId: MembershipId,
        overrides: Partial<NewCrmConnection> = {}
      ): NewCrmConnection => ({
        id: connectionId(),
        provider: 'hubspot',
        externalAccountId: `acct-${crypto.randomUUID()}`,
        accountLabel: 'Acme Sales',
        scopeLevel: 'read',
        connectedByMembershipId: membershipId,
        accessTokenSealed: bytes(1),
        refreshTokenSealed: bytes(2),
        tokenKeyId: 'key-1',
        accessTokenExpiresAt: new Date(NOW.getTime() + 3_600_000),
        now: NOW,
        ...overrides,
      })
      return { harness, seeded, run, inOrg, connection }
    }

    test('there is none until one is stored', async () => {
      const { run } = await world()
      expect(await run((scope) => scope.getCrmConnection('hubspot'))).toBeNull()
      expect(await run((scope) => scope.getCrmSealedTokens('hubspot'))).toBeNull()
      expect(await run((scope) => scope.listCrmConnections({ limit: 10 }))).toEqual([])
    })

    test('stores a connection and its sealed bytes, and returns only metadata', async () => {
      const { run, seeded, connection } = await world()
      const input = connection(seeded.owner.id)
      const stored = await run((scope) => scope.upsertCrmConnection(input))

      expect(stored).toMatchObject({
        id: input.id,
        provider: 'hubspot',
        state: 'connected',
        accountLabel: 'Acme Sales',
        scopeLevel: 'read',
        connectedByMembershipId: seeded.owner.id,
        needsReconnectSince: null,
        lastSyncedAt: null,
      })
      expect(Object.keys(stored)).not.toContain('accessTokenSealed')
      const tokens = await run((scope) => scope.getCrmSealedTokens('hubspot'))
      expect(tokens?.connectionId).toBe(input.id)
      expect(Array.from(tokens?.accessTokenSealed ?? [])).toEqual([1, 1, 1, 1])
      expect(Array.from(tokens?.refreshTokenSealed ?? [])).toEqual([2, 2, 2, 2])
      expect(tokens?.tokenKeyId).toBe('key-1')
    })

    test('connecting again replaces the grant and keeps the connection id', async () => {
      const { run, seeded, connection } = await world()
      const first = await run((scope) => scope.upsertCrmConnection(connection(seeded.owner.id)))
      const again = await run((scope) =>
        scope.upsertCrmConnection(
          connection(seeded.owner.id, {
            externalAccountId: first.externalAccountId,
            scopeLevel: 'read_write',
            accessTokenSealed: bytes(7),
            refreshTokenSealed: null,
            now: new Date(NOW.getTime() + 60_000),
          })
        )
      )

      expect(again.id).toBe(first.id)
      expect(again.scopeLevel).toBe('read_write')
      expect(await run((scope) => scope.listCrmConnections({ limit: 10 }))).toHaveLength(1)
      const tokens = await run((scope) => scope.getCrmSealedTokens('hubspot'))
      expect(Array.from(tokens?.accessTokenSealed ?? [])).toEqual([7, 7, 7, 7])
      expect(tokens?.refreshTokenSealed).toBeNull()
    })

    test('a CRM account held by another Organization is refused', async () => {
      const { harness, run, inOrg, seeded, connection } = await world()
      const account = `shared-${crypto.randomUUID()}`
      const mine = connection(seeded.owner.id, { externalAccountId: account })
      await run((scope) => scope.upsertCrmConnection(mine))
      const other = await seedOrganization(harness.store, [])

      await expect(
        inOrg(other.organizationId, (scope) =>
          scope.upsertCrmConnection(connection(other.owner.id, { externalAccountId: account }))
        )
      ).rejects.toBeInstanceOf(CrmAccountTakenError)
      expect(
        await inOrg(other.organizationId, (scope) => scope.getCrmConnection('hubspot'))
      ).toBeNull()
    })

    test('delete removes the connection and its tokens, and answers the deleted record', async () => {
      const { run, seeded, connection } = await world()
      const input = connection(seeded.owner.id)
      await run((scope) => scope.upsertCrmConnection(input))

      const deleted = await run((scope) => scope.deleteCrmConnection('hubspot'))
      expect(deleted?.id).toBe(input.id)
      expect(await run((scope) => scope.getCrmConnection('hubspot'))).toBeNull()
      expect(await run((scope) => scope.getCrmSealedTokens('hubspot'))).toBeNull()
      expect(await run((scope) => scope.deleteCrmConnection('hubspot'))).toBeNull()
    })

    test('a connection of another Organization is neither read, listed nor deleted', async () => {
      const { harness, run, inOrg, seeded, connection } = await world()
      await run((scope) => scope.upsertCrmConnection(connection(seeded.owner.id)))
      const other = await seedOrganization(harness.store, [])

      expect(await inOrg(other.organizationId, (s) => s.getCrmConnection('hubspot'))).toBeNull()
      expect(await inOrg(other.organizationId, (s) => s.getCrmSealedTokens('hubspot'))).toBeNull()
      expect(await inOrg(other.organizationId, (s) => s.listCrmConnections({ limit: 10 }))).toEqual(
        []
      )
      expect(await inOrg(other.organizationId, (s) => s.deleteCrmConnection('hubspot'))).toBeNull()
      expect(await run((scope) => scope.getCrmConnection('hubspot'))).not.toBeNull()
    })

    test('a page is cut by limit and continues after an id', async () => {
      const { run, seeded, connection } = await world()
      await run((scope) => scope.upsertCrmConnection(connection(seeded.owner.id)))

      const page = await run((scope) => scope.listCrmConnections({ limit: 1 }))
      expect(page).toHaveLength(1)
      const first = page[0]
      expect(
        await run((scope) =>
          scope.listCrmConnections({ afterId: first?.id as CrmConnectionId, limit: 10 })
        )
      ).toEqual([])
    })
  })
}

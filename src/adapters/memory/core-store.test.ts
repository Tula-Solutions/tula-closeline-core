import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import type { OrganizationScope } from '~/ports/core-store'
import {
  describeAbandon,
  describeCoreStore,
  describeIdempotencyKeys,
  describeInvitationsAndTeams,
} from '~/ports/core-store.behaviour'
import { newMembershipId, newUserId, seedOrganization, TEST_PROFILE } from '~/testing'
import { createMemoryCoreStore } from './core-store'

describeCoreStore('memory', async () => {
  const store = createMemoryCoreStore()
  return { store, setStatus: async (id, status) => store.setOrganizationStatus(id, status) }
})

const newInvitationId = () => formatId('inv', crypto.randomUUID())
const newTeamId = () => formatId('team', crypto.randomUUID())

describeInvitationsAndTeams('memory', async () => {
  const store = createMemoryCoreStore()
  return { store, setStatus: async (id, status) => store.setOrganizationStatus(id, status) }
})

describeAbandon('memory', async () => {
  const store = createMemoryCoreStore()
  return { store, setStatus: async (id, status) => store.setOrganizationStatus(id, status) }
})

describeIdempotencyKeys('memory', async () => {
  const store = createMemoryCoreStore()
  return { store, setStatus: async (id, status) => store.setOrganizationStatus(id, status) }
})

describe('CoreStore: memory, the lock order', () => {
  test('a write or a member lock before the Organization is locked is refused', async () => {
    const store = createMemoryCoreStore()
    const seeded = await seedOrganization(store, ['rep'])
    const rep = seeded.members[1]
    const now = new Date()

    const attempts = [
      (s: OrganizationScope) => s.renameOrganization('X', now),
      (s: OrganizationScope) => s.setRole(rep?.id as never, 'admin', now),
      (s: OrganizationScope) => s.deleteMembership(rep?.id as never),
      (s: OrganizationScope) => s.lockMembership(rep?.id as never),
      (s: OrganizationScope) =>
        s.insertMembership({
          id: newMembershipId(),
          userId: newUserId(),
          role: 'rep',
          ...TEST_PROFILE,
          now,
        }),
      (s: OrganizationScope) => s.lockInvitation(newInvitationId()),
      (s: OrganizationScope) => s.lockPendingInvitationByEmail('a@example.com'),
      (s: OrganizationScope) => s.revokeInvitation(newInvitationId(), now),
      (s: OrganizationScope) => s.acceptInvitation(newInvitationId(), now),
      (s: OrganizationScope) =>
        s.insertInvitation({
          id: newInvitationId(),
          email: 'a@example.com',
          role: 'rep',
          teamId: null,
          invitedByUserId: newUserId(),
          tokenHash: 'a'.repeat(64),
          expiresAt: now,
          now,
        }),
      (s: OrganizationScope) => s.insertTeam({ id: newTeamId(), name: 'X', now }),
      (s: OrganizationScope) => s.lockTeam(newTeamId()),
      (s: OrganizationScope) => s.renameTeam(newTeamId(), 'Y', now),
      (s: OrganizationScope) => s.deleteTeam(newTeamId()),
      (s: OrganizationScope) => s.addTeamMember(newTeamId(), rep?.id as never, now),
      (s: OrganizationScope) => s.removeTeamMember(newTeamId(), rep?.id as never),
    ]
    for (const attempt of attempts) {
      await expect(
        store.withOrganization(seeded.organizationId, async (s) => attempt(s))
      ).rejects.toThrow('lock order')
    }
  })

  test('after lockOrganization the same writes go through', async () => {
    const store = createMemoryCoreStore()
    const seeded = await seedOrganization(store, ['rep'])

    const renamed = await store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      return s.renameOrganization('X', new Date())
    })

    expect(renamed?.name).toBe('X')
  })
})

describe('CoreStore: memory, the idempotency lock order', () => {
  test('a key is reserved before the Organization is locked, and a reservation after the lock is refused', async () => {
    const store = createMemoryCoreStore()
    const seeded = await seedOrganization(store)
    const request = {
      userId: seeded.owner.userId,
      route: 'things.create',
      key: 'key-0123456789abcdef',
      requestHash: 'a'.repeat(64),
      now: new Date(),
      expiredBefore: new Date(0),
    }

    const reserved = await store.withOrganization(seeded.organizationId, (s) =>
      s.reserveIdempotencyKey(request)
    )
    const late = store.withOrganization(seeded.organizationId, async (s) => {
      await s.lockOrganization()
      return s.reserveIdempotencyKey({ ...request, key: 'other-key-0123456789' })
    })

    expect(reserved).toEqual({ outcome: 'reserved' })
    await expect(late).rejects.toThrow('lock order')
  })
})

import { describe, expect, test } from 'bun:test'
import type { OrganizationScope } from '~/ports/core-store'
import { describeCoreStore } from '~/ports/core-store.behaviour'
import { seedOrganization } from '~/testing'
import { createMemoryCoreStore } from './core-store'

describeCoreStore('memory', async () => {
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

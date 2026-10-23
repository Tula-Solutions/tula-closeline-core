import { afterAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { type ConsentWordingId, formatId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { consentWordings, contactConsentEvents, organizations } from 'tula-closeline-db/schema'
import { integrationUrls } from '~/integration-support'
import { LastOwnerError } from '~/ports/core-store'
import {
  describeAbandon,
  describeConsentForms,
  describeConsentLedger,
  describeCoreStore,
  describeCrmConnections,
  describeIdempotencyKeys,
  describeInvitationsAndTeams,
} from '~/ports/core-store.behaviour'
import { seedOrganization } from '~/testing'
import { createPostgresCoreStore } from './core-store'
import { postgresErrorOf } from './retry'

const { db, close } = createDb(integrationUrls().service)
const store = createPostgresCoreStore(db)
// A second connection pool, so a test can ask for a lock while the first holds one.
const other = createDb(integrationUrls().service)

afterAll(async () => {
  await close()
  await other.close()
})

describeCoreStore('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeCrmConnections('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeConsentLedger('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
  seedConsent: (organizationId, prospectId, channel, kind) =>
    withOrganization(db, organizationId, async (tx) => {
      const wordingId = formatId('cwd', crypto.randomUUID())
      await tx.insert(consentWordings).values({
        id: wordingId,
        organizationId,
        version: 1,
        text: `I agree ${wordingId}`,
        channels: ['phone', 'sms', 'whatsapp', 'email', 'linkedin'],
        supersedesId: null,
        createdByUserId: formatId('usr', crypto.randomUUID()),
      })
      await tx.insert(contactConsentEvents).values({
        id: formatId('cev', crypto.randomUUID()),
        organizationId,
        prospectId,
        channel,
        kind,
        source: 'manual',
        wordingId: kind === 'granted' ? wordingId : null,
        evidenceRef: kind === 'granted' ? 'test' : null,
        occurredAt: new Date(),
      })
    }),
  seedWording: (organizationId, channels) =>
    withOrganization(db, organizationId, async (tx) => {
      const id = formatId('cwd', crypto.randomUUID()) as ConsentWordingId
      await tx.insert(consentWordings).values({
        id,
        organizationId,
        version: 1,
        text: `I agree ${id}`,
        channels,
        supersedesId: null,
        createdByUserId: formatId('usr', crypto.randomUUID()),
      })
      return id
    }),
}))

describeConsentForms('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeInvitationsAndTeams('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeAbandon('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describeIdempotencyKeys('postgres', async () => ({
  store,
  setStatus: (organizationId, status) =>
    withOrganization(db, organizationId, async (tx) => {
      await tx
        .update(organizations)
        .set({ status })
        .where(eq(organizations.organizationId, organizationId))
    }),
}))

describe('CoreStore: postgres, the consent wording lock trigger', () => {
  test('an update that skips the store pre-check is refused by the database with 23001', async () => {
    const seeded = await seedOrganization(store)
    const wordingId = formatId('cwd', crypto.randomUUID())
    const formId = formatId('cfm', crypto.randomUUID())
    const now = new Date()
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertConsentWording({
        id: wordingId,
        version: 1,
        text: 'I agree.',
        channels: ['email'],
        supersedesId: null,
        createdByUserId: seeded.owner.userId,
        now,
      })
      await scope.insertConsentForm({
        id: formId,
        wordingId,
        name: 'Form',
        channels: ['email'],
        createdByUserId: seeded.owner.userId,
        now,
      })
      await scope.publishConsentForm(formId, {
        token: crypto.randomUUID().replaceAll('-', '').padEnd(43, 'Z'),
        now,
      })
    })

    const code = await failureCode(
      withOrganization(db, seeded.organizationId, (tx) =>
        tx.update(consentWordings).set({ text: 'Sneaky' }).where(eq(consentWordings.id, wordingId))
      )
    )
    expect(code).toBe('23001')
  })
})

describe('CoreStore: postgres, under concurrency', () => {
  test('two Owners demoting each other at once leave one Owner and one refusal', async () => {
    const seeded = await seedOrganization(store, ['owner'])
    const [first, second] = seeded.members
    if (!first || !second) {
      throw new Error('seed made no pair of Owners')
    }
    const now = new Date()

    const results = await Promise.allSettled([
      store.withOrganization(seeded.organizationId, (s) => s.setRole(first.id, 'rep', now)),
      store.withOrganization(seeded.organizationId, (s) => s.setRole(second.id, 'rep', now)),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(LastOwnerError)
    const owners = await store.withOrganization(seeded.organizationId, (s) =>
      s.listMembers({ limit: 10 })
    )
    expect(owners.filter((m) => m.role === 'owner')).toHaveLength(1)
  })

  test('a failure other than a rule is thrown as it came, not as a rule error', async () => {
    const seeded = await seedOrganization(store)

    await expect(
      store.withOrganization(seeded.organizationId, (s) =>
        s.insertOrganization({ name: 'Again', region: 'us', now: new Date() })
      )
    ).rejects.not.toBeInstanceOf(LastOwnerError)
  })
})

/** The SQLSTATE of the failure of `attempt`, or `undefined` when it succeeded. */
async function failureCode(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt
    return undefined
  } catch (error) {
    return postgresErrorOf(error)?.code
  }
}

describe('CoreStore: postgres, the lock modes', () => {
  /** Asks, from another connection and without waiting, for a row lock of `mode` on one row. */
  const ask = (organizationId: string, table: string, key: string, id: string, mode: string) =>
    failureCode(
      withOrganization(other.db, organizationId as never, (tx) =>
        tx.execute(sql.raw(`select 1 from core.${table} where ${key} = '${id}' for ${mode} nowait`))
      )
    )

  test('lockOrganization holds the row FOR NO KEY UPDATE: it excludes writers and sharers, not the key-share check of a member write', async () => {
    const seeded = await seedOrganization(store, ['rep'])
    const org = seeded.organizationId
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      locked()
      await released
    })
    await holding

    try {
      const noKeyUpdate = await ask(org, 'organizations', 'organization_id', org, 'no key update')
      const share = await ask(org, 'organizations', 'organization_id', org, 'share')
      const keyShare = await ask(org, 'organizations', 'organization_id', org, 'key share')

      expect(noKeyUpdate).toBe('55P03')
      expect(share).toBe('55P03')
      expect(keyShare).toBeUndefined()
    } finally {
      release()
      await holder
    }
  })

  test('hasOtherOwner counts only this Organization’s other Owners', async () => {
    const seeded = await seedOrganization(store, ['admin'])
    const other = await seedOrganization(store, ['admin'])
    const admin = seeded.members[1]
    if (!admin) {
      throw new Error('seed made no member')
    }

    const alone = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.hasOtherOwner(seeded.owner.id)
    )
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.setRole(admin.id, 'owner', new Date())
    })
    const withSecond = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.hasOtherOwner(seeded.owner.id)
    )
    const otherAlone = await store.withOrganization(other.organizationId, (scope) =>
      scope.hasOtherOwner(other.owner.id)
    )

    expect([alone, withSecond, otherAlone]).toEqual([false, true, false])
  })

  test('lockMembership holds the row FOR UPDATE: even a key-share check waits', async () => {
    const seeded = await seedOrganization(store, ['rep'])
    const org = seeded.organizationId
    const rep = seeded.members[1]
    if (!rep) {
      throw new Error('seed made no member')
    }
    let locked: () => void = () => undefined
    const holding = new Promise<void>((resolve) => {
      locked = resolve
    })
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = store.withOrganization(org, async (scope) => {
      await scope.lockOrganization()
      await scope.lockMembership(rep.id)
      locked()
      await released
    })
    await holding

    try {
      const keyShare = await ask(org, 'memberships', 'id', rep.id, 'key share')
      const otherMember = await ask(org, 'memberships', 'id', seeded.owner.id, 'update')

      expect(keyShare).toBe('55P03')
      expect(otherMember).toBeUndefined()
    } finally {
      release()
      await holder
    }
  })
})

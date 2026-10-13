/** Shared setup of the internal-call integration suites: pools, the app over Postgres and small database probes. */
import { expect } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { OrganizationId, UserId } from 'tula-closeline-contract'
import { createDb, withOrganization } from 'tula-closeline-db'
import { organizations } from 'tula-closeline-db/schema'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { integrationUrls } from '~/integration-support'
import { type ApiBody, createTestApp, newUserId, publicCaller } from '~/testing'

export const urls = integrationUrls()
export const service = createDb(urls.service)
export const owner = createDb(urls.owner)
/** A second pool */
// A second pool, so one transaction can hold the Organization lock while another asks for it.
export const holderPool = createDb(urls.service)
export const store = createPostgresCoreStore(service.db)
const WAIT_MS = 300
/** A store whose writes give up waiting for the Organization lock after a moment. */
export const impatient = createPostgresCoreStore(service.db, {}, { writeLockTimeoutMs: WAIT_MS })

// The pools are not closed here: this module is shared by several suites in one `bun test` process,
// so an `afterAll` would close them under the suites that run after the first.

/** The app over Postgres, its clock at the real time so Invitation expiry agrees with the database. */
export async function harness(over: { impatient?: boolean; clockStart?: string } = {}) {
  const app = await createTestApp({
    store: over.impatient ? impatient : store,
    env: { DATABASE_URL: urls.service },
    clockStart: over.clockStart ?? new Date().toISOString(),
  })
  const post = async (path: string, body: unknown) => {
    const response = await app.app.request(path, {
      method: 'POST',
      headers: app.internal(),
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      body: (await response.json()) as ApiBody,
      retryAfter: response.headers.get('retry-after'),
    }
  }
  const signUp = async (extra: Record<string, unknown> = {}) => {
    const userId = newUserId()
    const made = await post('/internal/organizations', {
      userId,
      organizationName: 'Acme',
      email: `${userId}@example.test`,
      name: 'Olive Owner',
      ...extra,
    })
    expect(made.status).toBe(200)
    return { userId, organizationId: made.body.organizationId as OrganizationId }
  }
  const abandon = (organizationId: string, userId: string) =>
    post(`/internal/organizations/${organizationId}/abandon`, { userId })
  const members = async (organizationId: OrganizationId, as: { userId: UserId }) => {
    const page = await publicCaller(app)(
      { userId: as.userId, role: 'owner' },
      organizationId,
      'GET',
      '/members?limit=100'
    )
    return page.body.items as Record<string, unknown>[]
  }
  return { ...app, post, signUp, abandon, members }
}

/** The status the owner-only status table holds for an Organization, or null when it has none. */
export async function statusOf(organizationId: OrganizationId): Promise<string | null> {
  const { rows } = await owner.db.execute<{ status: string }>(
    sql`select status from core.organization_state where organization_id = ${organizationId}`
  )
  return rows[0]?.status ?? null
}

export async function directoryRows(userId: UserId): Promise<number> {
  const { rows } = await owner.db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.membership_directory where user_id = ${userId}`
  )
  return rows[0]?.n ?? 0
}

export async function organizationCount(): Promise<number> {
  const { rows } = await owner.db.execute<{ n: number }>(
    sql`select count(*)::int as n from core.organization_state`
  )
  return rows[0]?.n ?? 0
}

/** Sets an Organization's creation time to the database's clock plus `offset` (a Postgres interval), as the owner. */
export function createdAt(organizationId: OrganizationId, offset: string) {
  return withOrganization(owner.db, organizationId, (tx) =>
    tx.execute(sql`
      update core.organizations
      set created_at = clock_timestamp() + ${offset}::interval
      where organization_id = ${organizationId}
    `)
  )
}

/** Holds the Organization's row lock in another connection until `release` is called. */
export function holdOrganizationLock(organizationId: OrganizationId) {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let locked: () => void = () => undefined
  const hasLock = new Promise<void>((resolve) => {
    locked = resolve
  })
  const done = withOrganization(holderPool.db, organizationId, async (tx) => {
    await tx
      .select()
      .from(organizations)
      .where(eq(organizations.organizationId, organizationId))
      .for('no key update')
    locked()
    await released
  })
  return { hasLock, release, done }
}

/** Waits, by looking at the lock table and not at the clock, until some transaction waits for another. */
export async function untilSomeoneWaits(): Promise<void> {
  for (let look = 0; look < 1000; look += 1) {
    const result = await owner.db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_locks where not granted and locktype in ('transactionid', 'tuple')`
    )
    if ((result.rows[0]?.waiting ?? 0) > 0) {
      return
    }
    await Bun.sleep(5)
  }
  throw new Error('no transaction ever waited')
}

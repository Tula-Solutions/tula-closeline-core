import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { OrganizationId } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, service } from '~/integration-harness'
import * as Crm from '~/modules/crm/service'
import { publicCaller } from '~/testing'

const ACCESS = 'pat-access-token-SECRET-VALUE-1'
const REFRESH = 'pat-refresh-token-SECRET-VALUE-2'

/** How many connection rows the Organization sees through the service login, under its own scope. */
const visibleRows = (organizationId: OrganizationId) =>
  withOrganization(service.db, organizationId, async (tx) => {
    const { rows } = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from core.crm_connection`
    )
    return Number(rows[0]?.n)
  })

describe('CRM connections, over Postgres with row-level security', () => {
  test('a second Organization cannot read or disconnect the first one connection', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const theirs = await h.signUp()
    h.deps.hubspot.acceptCode('code-1', {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      externalAccountId: `acct-${crypto.randomUUID()}`,
      accountLabel: 'Acme Sales',
      scopeLevel: 'read',
    })
    const connected = await Crm.connect(
      h.deps,
      { organizationId: mine.organizationId, userId: mine.userId, role: 'owner' },
      { provider: 'hubspot', code: 'code-1', redirectUri: 'https://core.test/cb' },
      { traceId: 'trace-1' }
    )
    expect(connected.state).toBe('connected')

    const api = publicCaller(h)
    const me = { userId: mine.userId, role: 'owner' as const }
    const them = { userId: theirs.userId, role: 'owner' as const }
    const key = () => ({ 'idempotency-key': crypto.randomUUID() })

    const mineRead = await api(me, mine.organizationId, 'GET', '/crm/connections/hubspot')
    expect(mineRead.body.state).toBe('connected')

    const theirRead = await api(them, theirs.organizationId, 'GET', '/crm/connections/hubspot')
    expect(theirRead.body).toEqual({
      provider: 'hubspot',
      state: 'not_connected',
      connection: null,
    })
    const theirList = await api(them, theirs.organizationId, 'GET', '/crm/connections')
    expect(theirList.body).toEqual({ items: [], nextCursor: null })
    const theirDelete = await api(
      them,
      theirs.organizationId,
      'DELETE',
      '/crm/connections/hubspot',
      undefined,
      key()
    )
    expect(theirDelete.status).toBe(404)
    expect(await visibleRows(theirs.organizationId)).toBe(0)
    expect(await visibleRows(mine.organizationId)).toBe(1)

    // Their token reaching my Organization's id is refused too: the first Organization is unharmed.
    const stillThere = await api(me, mine.organizationId, 'GET', '/crm/connections/hubspot')
    expect(stillThere.body.state).toBe('connected')
  })

  test('the tokens are stored sealed, and disconnect deletes them', async () => {
    const h = await harness()
    const mine = await h.signUp()
    h.deps.hubspot.acceptCode('code-1', {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: null,
      externalAccountId: `acct-${crypto.randomUUID()}`,
      accountLabel: null,
      scopeLevel: 'read_write',
    })
    await Crm.connect(
      h.deps,
      { organizationId: mine.organizationId, userId: mine.userId, role: 'owner' },
      { provider: 'hubspot', code: 'code-1', redirectUri: 'https://core.test/cb' },
      { traceId: 'trace-1' }
    )
    const stored = await withOrganization(service.db, mine.organizationId, (tx) =>
      tx.execute<{ access: string; refresh: string }>(
        sql`select encode(access_token_sealed, 'escape') as access,
                   encode(refresh_token_sealed, 'escape') as refresh
            from core.crm_connection`
      )
    )
    expect(stored.rows).toHaveLength(1)
    for (const row of stored.rows) {
      expect(row.access).not.toContain(ACCESS)
      expect(row.refresh).not.toContain(REFRESH)
    }

    const api = publicCaller(h)
    const removed = await api(
      { userId: mine.userId, role: 'owner' },
      mine.organizationId,
      'DELETE',
      '/crm/connections/hubspot',
      undefined,
      { 'idempotency-key': crypto.randomUUID() }
    )
    expect(removed.status).toBe(204)
    expect(await visibleRows(mine.organizationId)).toBe(0)
    expect(h.deps.logLines.join('\n')).not.toContain('SECRET-VALUE')
  })

  test('a CRM account another Organization holds cannot be connected', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const theirs = await h.signUp()
    const account = `acct-${crypto.randomUUID()}`
    const grant = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: null,
      externalAccountId: account,
      accountLabel: null,
      scopeLevel: 'read' as const,
    }
    const connect = (user: typeof mine, code: string) => {
      h.deps.hubspot.acceptCode(code, grant)
      return Crm.connect(
        h.deps,
        { organizationId: user.organizationId, userId: user.userId, role: 'owner' },
        { provider: 'hubspot', code, redirectUri: 'https://core.test/cb' },
        { traceId: 'trace-1' }
      )
    }
    await connect(mine, 'code-1')
    await expect(connect(theirs, 'code-2')).rejects.toMatchObject({ status: 400 })
    expect(await visibleRows(theirs.organizationId)).toBe(0)
  })
})

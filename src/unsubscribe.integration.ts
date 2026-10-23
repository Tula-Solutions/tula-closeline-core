import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { OrganizationId } from 'tula-closeline-contract'
import { withOrganization } from 'tula-closeline-db'
import { harness, owner } from '~/integration-harness'
import { mintUnsubscribeToken, UNSUBSCRIBE_CHANNEL } from '~/modules/unsubscribe/token'
import { publicCaller, TEST_UNSUBSCRIBE_TOKEN_KEY } from '~/testing'

/** How many Suppression entries an Organization holds, read as the owner inside its scope. */
async function entriesOf(organizationId: OrganizationId): Promise<number> {
  const { rows } = await withOrganization(owner.db, organizationId, (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from core.suppression_entry`)
  )
  return rows[0]?.n ?? 0
}

describe('Unsubscribe and STOP, over Postgres', () => {
  test('a link unsubscribes once, a replay changes nothing, and another Organization is untouched', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const theirs = await h.signUp()
    const api = publicCaller(h)
    const me = { userId: mine.userId, role: 'owner' as const }
    const made = await api(me, mine.organizationId, 'POST', '/prospects', {
      firstName: 'Ada',
      email: 'ada@example.test',
    })
    expect(made.status).toBe(201)
    const prospectId = made.body.id as string
    const check = async () =>
      (
        await h.post('/internal/v1/contact-checks', {
          organizationId: mine.organizationId,
          prospectId,
          channel: 'email',
          purpose: 'agent_initiated',
          caller: 'outbound-agent',
        })
      ).body
    expect(await check()).toMatchObject({ allowed: true })

    const token = mintUnsubscribeToken(TEST_UNSUBSCRIBE_TOKEN_KEY, {
      organizationId: mine.organizationId,
      prospectId: prospectId as never,
      channel: UNSUBSCRIBE_CHANNEL,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const click = (value: string) =>
      h.app.request(`/v1/public/unsubscribe/${value}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      })
    const preview = await h.app.request(`/v1/public/unsubscribe/${token}`)
    expect(preview.status).toBe(200)
    expect(await preview.json()).toEqual({ organizationName: 'Acme', channel: 'email' })
    expect(await check()).toMatchObject({ allowed: true })

    const first = await click(token)
    expect(first.status).toBe(200)
    const receipt = await first.json()
    expect(receipt).toMatchObject({ unsubscribed: true })
    expect(await check()).toMatchObject({ allowed: false, code: 'consent.suppressed' })
    const again = await click(token)
    expect(await again.json()).toEqual(receipt)
    expect(await entriesOf(mine.organizationId)).toBe(1)
    expect(await entriesOf(theirs.organizationId)).toBe(0)
    const bad = await click(`${token.slice(0, -2)}AA`)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: { code: 'consent.invalid_token' } })
  })

  test('an inbound STOP suppresses the number over Postgres and a repeat answers the same entry', async () => {
    const h = await harness()
    const mine = await h.signUp()
    const body = {
      organizationId: mine.organizationId,
      channel: 'sms',
      phone: '+14155550177',
      sourceRef: 'twilio:SM1',
    }
    const first = await h.post('/internal/v1/consent-withdrawals', body)
    expect(first.status).toBe(200)
    expect(first.body.prospectId).toBeNull()
    const again = await h.post('/internal/v1/consent-withdrawals', body)
    expect(again.body).toEqual(first.body)
  })
})

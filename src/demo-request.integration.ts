import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb } from 'tula-closeline-db'
import { createPostgresDemoRateLimiter } from '~/adapters/postgres/demo-rate-limiter'
import { createPostgresDemoRequestStore } from '~/adapters/postgres/demo-request-store'
import { integrationUrls } from '~/integration-support'
import { RATE_LIMIT } from '~/modules/demo-request/service'
import {
  NOTICE_BACKOFF_SECONDS,
  NOTICE_MAX_ATTEMPTS,
  purgeExpired,
  sendPendingNotices,
} from '~/modules/demo-request/worker'
import { createTestApp, newOrganizationId, newUserId } from '~/testing'

const urls = integrationUrls()
const service = createDb(urls.service)
const owner = createDb(urls.owner)

afterAll(async () => {
  await service.close()
  await owner.close()
})

const PATH = '/v1/marketing/demo-requests'
const NEVER = new AbortController().signal
const VALID = {
  name: 'Ada Visitor',
  workEmail: 'Ada@Example.test',
  companyName: 'Visitor-Co-marker',
  message: 'message-marker',
  sourcePage: '/pricing',
}

beforeEach(async () => {
  await owner.db.execute(sql`truncate core.demo_request, core.demo_rate_counter`)
})

/** The app over the real Demo Request tables, with in-memory mail and rate counting. */
async function setup() {
  const harness = await createTestApp({
    demoRequests: createPostgresDemoRequestStore(service.db),
    demoRateLimiter: createPostgresDemoRateLimiter(service.db),
    clockStart: new Date().toISOString(),
  })
  const post = (body: unknown, key: string = crypto.randomUUID()) =>
    harness.app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    })
  return { ...harness, post }
}

type Row = { work_email: string; notification_status: string; notification_attempts: number }
async function rows(): Promise<Row[]> {
  const { rows } = await owner.db.execute<Row>(
    sql`select work_email, notification_status, notification_attempts from core.demo_request order by submitted_at`
  )
  return rows
}

describe('Demo Requests against Postgres', () => {
  test('a valid request stores one row and queues one notice', async () => {
    const { post } = await setup()
    const response = await post(VALID)
    expect(response.status).toBe(201)
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.work_email).toBe('ada@example.test')
    expect(stored[0]?.notification_status).toBe('pending')
  })

  test('the same key twice stores one row and returns the first id', async () => {
    const { post } = await setup()
    const key = crypto.randomUUID()
    const first = await post(VALID, key)
    const second = await post(VALID, key)
    expect(second.status).toBe(200)
    expect(((await second.json()) as { id: string }).id).toBe(
      ((await first.json()) as { id: string }).id
    )
    expect(await rows()).toHaveLength(1)
    const other = await post({ ...VALID, companyName: 'Other' }, key)
    expect(other.status).toBe(422)
  })

  test('an invalid body is marketing.invalid_request and stores nothing', async () => {
    const { post } = await setup()
    const response = await post({ ...VALID, workEmail: 'nope' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'marketing.invalid_request'
    )
    expect(await rows()).toHaveLength(0)
  })

  test('a filled honeypot stores nothing', async () => {
    const { post } = await setup()
    const response = await post({ ...VALID, website: 'https://spam.test' })
    expect(response.status).toBe(201)
    expect(await rows()).toHaveLength(0)
  })

  test('the request after the limit is marketing.rate_limited', async () => {
    const { post } = await setup()
    for (let n = 0; n < RATE_LIMIT; n += 1) {
      expect((await post(VALID)).status).toBe(201)
    }
    const response = await post(VALID)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3600')
    expect(await rows()).toHaveLength(RATE_LIMIT)
  })

  test('a throwing mail adapter still succeeds, the notice stays pending, a retry sends it once', async () => {
    const { post, deps } = await setup()
    deps.teamMail.failing = true
    expect((await post(VALID)).status).toBe(201)
    await sendPendingNotices(deps, NEVER)
    expect((await rows())[0]?.notification_status).toBe('pending')
    deps.teamMail.failing = false
    // The database judges the backoff by its own clock.
    await owner.db.execute(
      sql`update core.demo_request set notification_last_attempt_at = now() - make_interval(secs => ${NOTICE_BACKOFF_SECONDS + 1})`
    )
    await sendPendingNotices(deps, NEVER)
    expect(deps.teamMail.outbox).toHaveLength(1)
    expect((await rows())[0]?.notification_status).toBe('sent')
    await sendPendingNotices(deps, NEVER)
    expect(deps.teamMail.outbox).toHaveLength(1)
  })

  test('a notice past the attempt cap settles failed', async () => {
    const { post, deps } = await setup()
    await post(VALID)
    await owner.db.execute(
      sql`update core.demo_request set notification_attempts = ${NOTICE_MAX_ATTEMPTS}, notification_last_attempt_at = now() - interval '1 hour'`
    )
    deps.teamMail.failing = true
    await sendPendingNotices(deps, NEVER)
    const [row] = await rows()
    expect(row?.notification_status).toBe('failed')
    expect(row?.notification_attempts).toBe(NOTICE_MAX_ATTEMPTS + 1)
  })

  test('the purge deletes requests older than twelve months only', async () => {
    const { post, deps } = await setup()
    await post(VALID)
    await post({ ...VALID, workEmail: 'old@example.test' })
    await owner.db.execute(
      sql`update core.demo_request set submitted_at = now() - interval '13 months' where work_email = 'old@example.test'`
    )
    expect(await purgeExpired(deps)).toBe(1)
    expect((await rows()).map((row) => row.work_email)).toEqual(['ada@example.test'])
  })

  test('a member token from any Organization cannot read Demo Requests', async () => {
    const { app, bearer, post } = await setup()
    await post(VALID)
    const token = await bearer({
      userId: newUserId(),
      organizationId: newOrganizationId(),
      role: 'owner',
    })
    for (const path of [PATH, '/v1/demo-requests', '/v1/organization']) {
      const response = await app.request(path, { headers: token })
      expect(await response.text()).not.toContain('Visitor-Co-marker')
    }
  })

  test('the service login cannot touch the table directly', async () => {
    const read = async () => {
      await service.db.execute(sql`select * from core.demo_request`)
    }
    await expect(read()).rejects.toThrow()
  })

  test('no log line holds a Visitor field', async () => {
    const { post, deps } = await setup()
    await post(VALID)
    await post({ ...VALID, workEmail: 'bad' })
    deps.teamMail.failing = true
    await sendPendingNotices(deps, NEVER)
    const everything = JSON.stringify([deps.logLines, deps.reported])
    for (const secret of ['Ada', 'ada@example', 'Visitor-Co', 'message-marker', '/pricing']) {
      expect(everything).not.toContain(secret)
    }
  })
})

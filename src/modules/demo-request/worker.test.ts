import { describe, expect, test } from 'bun:test'
import { createTestDeps, type TestDeps } from '~/testing'
import {
  NOTICE_BACKOFF_SECONDS,
  NOTICE_BATCH,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_SEND_TIMEOUT_MS,
  purgeExpired,
  sendPendingNotices,
  startDemoBackground,
} from './worker'

const NEVER = new AbortController().signal

async function submit(deps: TestDeps, n = 0) {
  return deps.demoRequests.submit({
    id: `dreq_${crypto.randomUUID()}`,
    name: `Ada-marker-${n}`,
    workEmail: `ada${n}@example.test`,
    companyName: 'Visitor-Co-marker',
    message: 'message-marker <b>x</b>',
    sourcePage: '/pricing',
    idempotencyKey: crypto.randomUUID(),
  })
}

const rest = (deps: TestDeps) => deps.clock.advance(`${NOTICE_BACKOFF_SECONDS}s`)

describe('sendPendingNotices', () => {
  test('sends one team notice to the configured recipient and settles it sent', async () => {
    const deps = createTestDeps()
    await submit(deps)
    expect(await sendPendingNotices(deps, NEVER)).toBe(1)
    expect(deps.teamMail.outbox).toHaveLength(1)
    expect(deps.teamMail.outbox[0]?.to).toBe(deps.env.DEMO_NOTICE_TO)
    expect(deps.demos.rows()[0]?.status).toBe('sent')
    // Settled notices are never sent again.
    rest(deps)
    expect(await sendPendingNotices(deps, NEVER)).toBe(0)
    expect(deps.teamMail.outbox).toHaveLength(1)
  })

  test('a failing mail adapter leaves the notice pending and a retry sends it once', async () => {
    const deps = createTestDeps()
    await submit(deps)
    deps.teamMail.failing = true
    await sendPendingNotices(deps, NEVER)
    expect(deps.demos.rows()[0]?.status).toBe('pending')
    expect(deps.teamMail.outbox).toHaveLength(0)
    // Within the backoff it is not tried again.
    expect(await sendPendingNotices(deps, NEVER)).toBe(0)
    deps.teamMail.failing = false
    rest(deps)
    await sendPendingNotices(deps, NEVER)
    expect(deps.teamMail.outbox).toHaveLength(1)
    expect(deps.demos.rows()[0]?.status).toBe('sent')
  })

  test('a notice that fails its last allowed attempt settles failed', async () => {
    const deps = createTestDeps()
    await submit(deps)
    deps.teamMail.failing = true
    for (let attempt = 1; attempt < NOTICE_MAX_ATTEMPTS; attempt += 1) {
      await sendPendingNotices(deps, NEVER)
      expect(deps.demos.rows()[0]?.status).toBe('pending')
      rest(deps)
    }
    await sendPendingNotices(deps, NEVER)
    expect(deps.demos.rows()[0]?.status).toBe('failed')
    rest(deps)
    deps.teamMail.failing = false
    expect(await sendPendingNotices(deps, NEVER)).toBe(0)
    expect(deps.teamMail.outbox).toHaveLength(0)
  })

  test('giving up on a notice is logged as an error, so the team can see it was lost', async () => {
    const deps = createTestDeps()
    await submit(deps)
    deps.teamMail.failing = true
    for (let attempt = 1; attempt <= NOTICE_MAX_ATTEMPTS; attempt += 1) {
      await sendPendingNotices(deps, NEVER)
      rest(deps)
    }
    const lines = deps.logLines.map((line) => JSON.parse(line) as { level: number; msg: string })
    const gaveUp = lines.filter((line) => line.msg === 'demo notice given up')
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.level).toBeGreaterThanOrEqual(50)
  })

  test('a notice already past the cap settles failed without being sent', async () => {
    const deps = createTestDeps()
    await submit(deps)
    for (let attempt = 0; attempt < NOTICE_MAX_ATTEMPTS; attempt += 1) {
      // A worker that died after claiming: claimed but never settled.
      await deps.demoRequests.claimNotices(10, 0)
    }
    rest(deps)
    await sendPendingNotices(deps, NEVER)
    expect(deps.demos.rows()[0]?.status).toBe('failed')
    expect(deps.teamMail.outbox).toHaveLength(0)
  })

  test('stops at an aborted signal', async () => {
    const deps = createTestDeps()
    await submit(deps)
    const controller = new AbortController()
    controller.abort()
    await sendPendingNotices(deps, controller.signal)
    expect(deps.teamMail.outbox).toHaveLength(0)
  })

  test('logs no Visitor field, whether the send worked or not', async () => {
    const deps = createTestDeps()
    await submit(deps, 1)
    deps.teamMail.failing = true
    await sendPendingNotices(deps, NEVER)
    for (let attempt = 1; attempt < NOTICE_MAX_ATTEMPTS; attempt += 1) {
      rest(deps)
      await sendPendingNotices(deps, NEVER)
    }
    expect(deps.logLines.length).toBeGreaterThan(0)
    const everything = JSON.stringify([deps.logLines, deps.reported])
    for (const secret of ['Ada', 'ada1@', 'Visitor-Co', 'message-marker', '/pricing']) {
      expect(everything).not.toContain(secret)
    }
  })
})

describe('purgeExpired', () => {
  test('deletes Demo Requests older than twelve months and keeps newer ones', async () => {
    const deps = createTestDeps()
    await submit(deps, 1)
    deps.clock.advance('300d')
    await submit(deps, 2)
    expect(await purgeExpired(deps)).toBe(0)
    deps.clock.advance('100d')
    expect(await purgeExpired(deps)).toBe(1)
    expect(deps.demos.rows()).toHaveLength(1)
    expect(deps.demos.rows()[0]?.name).toBe('Ada-marker-2')
  })

  test('runs batches while they come back full', async () => {
    const deps = createTestDeps()
    for (let n = 0; n < 1_001; n += 1) {
      await submit(deps, n)
    }
    deps.clock.advance('400d')
    expect(await purgeExpired(deps)).toBe(1_001)
    expect(deps.demos.rows()).toHaveLength(0)
  })
})

describe('startDemoBackground', () => {
  test('sends a pending notice and ends when the signal aborts', async () => {
    const deps = createTestDeps()
    await submit(deps)
    const controller = new AbortController()
    const done = startDemoBackground(deps, controller.signal)
    const deadline = Date.now() + 2_000
    while (deps.teamMail.outbox.length === 0 && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    controller.abort()
    await done
    expect(deps.teamMail.outbox).toHaveLength(1)
  })
})

describe('a pass is shorter than the claim lease', () => {
  test('a whole batch of slow sends fits inside the backoff, so no second pass re-claims it', () => {
    expect((NOTICE_BATCH * NOTICE_SEND_TIMEOUT_MS) / 1000).toBeLessThanOrEqual(
      NOTICE_BACKOFF_SECONDS
    )
  })

  test('a settle that throws does not drop the notices after it', async () => {
    const deps = createTestDeps()
    await submit(deps, 1)
    await submit(deps, 2)
    await submit(deps, 3)
    const settle = deps.demoRequests.settleNotice.bind(deps.demoRequests)
    let calls = 0
    deps.demoRequests.settleNotice = async (id, outcome) => {
      calls += 1
      if (calls === 1) {
        throw new Error('settle failed')
      }
      return settle(id, outcome)
    }
    await sendPendingNotices(deps, NEVER)
    expect(deps.teamMail.outbox).toHaveLength(3)
    expect(deps.demos.rows().filter((row) => row.status === 'sent')).toHaveLength(2)
  })
})

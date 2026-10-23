import { describe, expect, test } from 'bun:test'
import {
  CONSENT_REQUIRED_CHANNELS,
  type ConsentChannel,
  type ContactCheckRequest,
  contactCheckResultSchema,
  ERRORS,
  formatId,
  type OrganizationId,
  type ProspectId,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import type { CoreStore } from '~/ports/core-store'
import {
  createTestApp,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { CONTACT_CHECK_PURGE_BATCH, purgeDue, purgeExpired } from './service'

const CHANNELS: readonly ConsentChannel[] = ['email', 'phone', 'sms', 'whatsapp', 'linkedin']
const PURPOSES = ['agent_initiated', 'rep_initiated', 'reply'] as const
const CONSENT_STATES = ['none', 'granted', 'withdrawn'] as const

async function setup(wrap?: (store: CoreStore) => CoreStore) {
  const memory = createMemoryCoreStore()
  const store = wrap ? wrap(memory) : memory
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body)
  const check = async (
    body: Record<string, unknown>,
    headers: Record<string, string> = harness.internal()
  ) => {
    const response = await harness.app.request('/internal/v1/contact-checks', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  /** Creates a Prospect with an email and a phone, the way a Rep would. */
  const prospect = async (organizationId = seeded.organizationId, actor = seeded.owner) => {
    const made = await call(
      actor,
      'POST',
      '/prospects',
      { firstName: 'Ada', email: 'ada@example.test', phone: '+14155550123' },
      organizationId
    )
    return made.body.id as ProspectId
  }
  const suppress = (body: Record<string, unknown>, organizationId = seeded.organizationId) =>
    call(seeded.owner, 'POST', '/suppression-entries', body, organizationId)
  const log = async (query = '') =>
    (await call(seeded.owner, 'GET', `/contact-checks${query}`)).body as {
      items: Record<string, unknown>[]
      nextCursor: string | null
    }
  return {
    ...harness,
    memory,
    call,
    check,
    prospect,
    suppress,
    log,
    seeded,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

function request(
  organizationId: OrganizationId,
  prospectId: ProspectId,
  channel: ConsentChannel,
  purpose: ContactCheckRequest['purpose']
) {
  return { organizationId, prospectId, channel, purpose, caller: 'inbound-agent' }
}

describe('the Contact Check rules', () => {
  test.each(
    CHANNELS.flatMap((channel) =>
      PURPOSES.flatMap((purpose) =>
        CONSENT_STATES.flatMap((consent) =>
          [false, true].map((suppressed) => ({ channel, purpose, consent, suppressed }))
        )
      )
    )
  )('$channel / $purpose / consent $consent / suppressed $suppressed', async (c) => {
    const { check, prospect, memory, suppress, seeded } = await setup()
    const prospectId = await prospect()
    if (c.consent !== 'none') {
      memory.seedConsentEvent(seeded.organizationId, prospectId, c.channel, 'granted')
    }
    if (c.consent === 'withdrawn') {
      memory.seedConsentEvent(seeded.organizationId, prospectId, c.channel, 'withdrawn')
    }
    if (c.suppressed) {
      const body =
        c.channel === 'email'
          ? { email: 'ada@example.test' }
          : c.channel === 'linkedin'
            ? { linkedinUrl: 'https://www.linkedin.com/in/ada' }
            : { phone: '+14155550123' }
      if (c.channel === 'linkedin') {
        // The Prospect has no LinkedIn identity, so there is nothing of theirs to suppress.
        await suppress(body)
      } else {
        expect((await suppress(body)).status).toBe(201)
      }
    }

    const { status, body } = await check(
      request(seeded.organizationId, prospectId, c.channel, c.purpose)
    )

    expect(status).toBe(200)
    const result = contactCheckResultSchema.parse(body)
    const addressSuppressed = c.suppressed && c.channel !== 'linkedin'
    if (addressSuppressed) {
      expect(result).toMatchObject({
        allowed: false,
        code: 'consent.suppressed',
        suppressionReason: 'manual',
      })
      return
    }
    if (c.purpose !== 'agent_initiated') {
      expect(result).toMatchObject({ allowed: true, basis: c.purpose })
    } else if (c.channel === 'email') {
      expect(result).toMatchObject({ allowed: true, basis: 'email_no_suppression' })
    } else if (c.channel === 'linkedin') {
      expect(result).toMatchObject({ allowed: false, code: 'consent.missing' })
    } else if (c.consent === 'granted') {
      expect(result).toMatchObject({ allowed: true, basis: 'consent_granted' })
    } else {
      expect(result).toMatchObject({
        allowed: false,
        code: c.consent === 'withdrawn' ? 'consent.withdrawn' : 'consent.missing',
        suppressionReason: null,
      })
    }
    // Every channel that needs consent is in the list the rules read from.
    expect(CONSENT_REQUIRED_CHANNELS).toContain('phone')
  })

  test('a Prospect check tests the address of the channel, so a suppressed phone does not stop email', async () => {
    const { check, prospect, suppress, seeded } = await setup()
    const prospectId = await prospect()
    await suppress({ phone: '+14155550123' })

    const email = await check(
      request(seeded.organizationId, prospectId, 'email', 'agent_initiated')
    )
    const sms = await check(request(seeded.organizationId, prospectId, 'sms', 'rep_initiated'))

    expect(email.body.allowed).toBe(true)
    expect(sms.body).toMatchObject({ allowed: false, code: 'consent.suppressed' })
  })

  test('the reason of the suppression entry is passed back', async () => {
    const { check, prospect, memory, seeded } = await setup()
    const prospectId = await prospect()
    await memory.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      const { hashAddress } = await import('~/modules/suppression/address')
      const { formatId } = await import('tula-closeline-contract')
      const { TEST_CONSENT_HASH_KEY } = await import('~/testing')
      return scope.insertSuppressionEntry({
        id: formatId('sup', crypto.randomUUID()),
        addressKind: 'email',
        addressHash: hashAddress(
          TEST_CONSENT_HASH_KEY,
          seeded.organizationId,
          'email',
          'ada@example.test'
        ),
        maskedAddress: 'a***@example.test',
        reason: 'complaint',
        channel: null,
        sourceRef: null,
        addedByUserId: null,
        now: new Date('2026-01-01T00:00:00Z'),
      })
    })

    const { body } = await check(
      request(seeded.organizationId, prospectId, 'email', 'rep_initiated')
    )

    expect(body).toMatchObject({
      allowed: false,
      code: 'consent.suppressed',
      suppressionReason: 'complaint',
    })
  })

  test('a removed suppression entry no longer blocks', async () => {
    const { check, prospect, suppress, call, owner, seeded } = await setup()
    const prospectId = await prospect()
    const entry = await suppress({ email: 'ada@example.test' })
    await call(owner, 'POST', `/suppression-entries/${entry.body.id}/removal`, {
      reason: 'mistake',
    })

    const { body } = await check(
      request(seeded.organizationId, prospectId, 'email', 'agent_initiated')
    )

    expect(body.allowed).toBe(true)
  })

  test('a check by address finds a suppressed address in any spelling, and allows only what needs no consent', async () => {
    const { check, suppress, seeded } = await setup()
    await suppress({ email: 'ada@example.test' })
    const by = (address: Record<string, string>, channel: ConsentChannel, purpose: string) =>
      check({ organizationId: seeded.organizationId, channel, purpose, caller: 'x', ...address })

    expect((await by({ email: 'ADA@Example.test' }, 'email', 'reply')).body).toMatchObject({
      allowed: false,
      code: 'consent.suppressed',
    })
    expect(
      (await by({ email: 'bob@example.test' }, 'email', 'agent_initiated')).body
    ).toMatchObject({
      allowed: true,
      basis: 'email_no_suppression',
    })
    expect((await by({ phone: '+14155550199' }, 'sms', 'reply')).body).toMatchObject({
      allowed: true,
      basis: 'reply',
    })
    // No Prospect, so no consent ledger to read: an Agent cannot text an address alone.
    expect((await by({ phone: '+14155550199' }, 'sms', 'agent_initiated')).body).toMatchObject({
      allowed: false,
      code: 'consent.missing',
    })
  })

  test('an unknown Prospect, or one of another Organization, is consent.missing and logged', async () => {
    const { check, prospect, log, seeded, memory } = await setup()
    const other = await seedOrganization(memory, [])
    const theirs = await prospect(other.organizationId, other.owner)

    const unknown = await check(
      request(seeded.organizationId, formatId('prs', crypto.randomUUID()), 'email', 'reply')
    )
    const foreign = await check(request(seeded.organizationId, theirs, 'email', 'reply'))

    for (const answer of [unknown, foreign]) {
      expect(answer.body).toMatchObject({ allowed: false, code: 'consent.missing' })
      expect(answer.body.checkId).not.toBeNull()
    }
    expect((await log()).items).toHaveLength(2)
  })

  test('an Organization that does not exist is consent.missing with no check id', async () => {
    const { check } = await setup()

    const { status, body } = await check({
      organizationId: newOrganizationId(),
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'reply',
      caller: 'x',
    })

    expect(status).toBe(200)
    expect(body).toMatchObject({ allowed: false, code: 'consent.missing', checkId: null })
  })

  test('a deleted Organization is refused without a log row, and a suspended one is refused with one', async () => {
    const { check, seeded, memory } = await setup()
    const body = {
      organizationId: seeded.organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    }

    memory.setOrganizationStatus(seeded.organizationId, 'suspended')
    const suspended = await check(body)
    memory.setOrganizationStatus(seeded.organizationId, 'deleted')
    const deleted = await check(body)

    expect(suspended.body).toMatchObject({ allowed: false, code: 'consent.missing' })
    expect(typeof suspended.body.checkId).toBe('string')
    expect(deleted.body).toMatchObject({ allowed: false, code: 'consent.missing', checkId: null })
  })

  test('a body with no address and no Prospect, or with two, is request.invalid', async () => {
    const { check, seeded } = await setup()
    const base = {
      organizationId: seeded.organizationId,
      channel: 'email',
      purpose: 'reply',
      caller: 'x',
    }

    for (const extra of [{}, { email: 'a@example.test', phone: '+14155550123' }]) {
      const { status, body } = await check({ ...base, ...extra })
      expect(status).toBe(400)
      expect((body.error as { code: string }).code).toBe(ERRORS['request.invalid'].code)
    }
  })

  test('only the internal secret is accepted', async () => {
    const { check, bearer, owner, seeded, app } = await setup()
    const body = {
      organizationId: seeded.organizationId,
      email: 'a@example.test',
      channel: 'email',
      purpose: 'reply',
      caller: 'x',
    }

    const none = await check(body, { 'content-type': 'application/json' })
    const user = await app.request('/internal/v1/contact-checks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await bearer({
          userId: owner.userId,
          organizationId: seeded.organizationId,
          role: 'owner',
        })),
      },
      body: JSON.stringify(body),
    })

    expect(none.status).toBe(401)
    expect(user.status).toBe(401)
  })
})

describe('the Contact Check log', () => {
  test('every check about an Organization is logged, without an address', async () => {
    const { check, prospect, log, suppress, deps, seeded } = await setup()
    const prospectId = await prospect()
    await suppress({ email: 'blocked@example.test' })
    await check(request(seeded.organizationId, prospectId, 'email', 'agent_initiated'))
    deps.clock.advance('1s')
    await check({
      organizationId: seeded.organizationId,
      email: 'BLOCKED@example.test',
      channel: 'email',
      purpose: 'reply',
      caller: 'outbound',
    })

    const page = await log()

    expect(page.items.map((i) => [i.allowed, i.code, i.basis, i.caller])).toEqual([
      [false, 'consent.suppressed', null, 'outbound'],
      [true, null, 'email_no_suppression', 'inbound-agent'],
    ])
    expect(page.items[0]?.prospectId).toBeNull()
    expect(page.items[1]?.prospectId).toBe(prospectId)
    const text = JSON.stringify(page)
    expect(text).not.toContain('example.test')
    expect(text).not.toContain('4155550123')
  })

  test('filters, pages with a cursor, and refuses a bad one', async () => {
    const { check, prospect, log, deps, seeded } = await setup()
    const prospectId = await prospect()
    for (const channel of ['email', 'sms', 'phone'] as const) {
      deps.clock.advance('1s')
      await check(request(seeded.organizationId, prospectId, channel, 'agent_initiated'))
    }

    const first = await log('?limit=2')
    const second = await log(`?limit=2&cursor=${first.nextCursor}`)
    const denied = await log('?allowed=false')
    const sms = await log('?channel=sms')
    const missing = await log('?code=consent.missing')
    const unavailable = await log('?code=consent.unavailable')

    expect(first.items.map((i) => i.channel)).toEqual(['phone', 'sms'])
    expect(second.items.map((i) => i.channel)).toEqual(['email'])
    expect(second.nextCursor).toBeNull()
    expect(denied.items).toHaveLength(2)
    expect(sms.items).toHaveLength(1)
    expect(missing.items).toHaveLength(2)
    expect(unavailable.items).toEqual([])
  })

  test('a bad cursor is request.invalid', async () => {
    const { call, owner } = await setup()

    const response = await call(owner, 'GET', '/contact-checks?cursor=nope')

    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe(ERRORS['request.invalid'].code)
  })

  test.each([
    ['owner', true],
    ['admin', true],
    ['manager', false],
    ['rep', false],
  ] as const)('%s may read it: %p', async (role, allowed) => {
    const { call, owner, ...actors } = await setup()
    const actor = role === 'owner' ? owner : actors[role]

    const response = await call(actor, 'GET', '/contact-checks')

    expect(response.status).toBe(allowed ? 200 : 403)
  })

  test('another Organization sees none of it, and its own checks stay its own', async () => {
    const { check, call, prospect, memory, seeded } = await setup()
    const other = await seedOrganization(memory, [])
    const prospectId = await prospect()
    await check(request(seeded.organizationId, prospectId, 'email', 'reply'))

    const theirs = await call(
      other.owner,
      'GET',
      '/contact-checks',
      undefined,
      other.organizationId
    )

    expect(theirs.body).toEqual({ items: [], nextCursor: null })
  })

  test('the Suppression list of another Organization does not block this one', async () => {
    const { check, suppress, memory, seeded } = await setup()
    const other = await seedOrganization(memory, [])
    await suppress({ email: 'ada@example.test' }, other.organizationId)

    const { body } = await check({
      organizationId: seeded.organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    })

    expect(body.allowed).toBe(true)
  })
})

describe('when the log cannot be written', () => {
  test('the call fails and nothing is allowed', async () => {
    const { check, seeded } = await setup((inner) => ({
      ...inner,
      withOrganization: (id, fn) =>
        inner.withOrganization(id, (scope) =>
          fn({
            ...scope,
            insertContactCheck: async () => {
              throw new Error('the database is down')
            },
          })
        ),
    }))

    const { status, body } = await check({
      organizationId: seeded.organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    })

    expect(status).toBe(500)
    expect(body.allowed).toBeUndefined()
  })
})

describe('the retention of the log', () => {
  const OLD = new Date('2025-01-01T00:00:00Z')
  const oldRow = (n: number) => ({
    id: formatId('chk', crypto.randomUUID()),
    prospectId: null,
    channel: 'email' as const,
    purpose: 'reply' as const,
    caller: 'x',
    allowed: true,
    code: null,
    basis: 'reply' as const,
    checkedAt: new Date(OLD.getTime() + n),
  })

  test('purgeDue picks about one id in sixteen', () => {
    const ids = Array.from({ length: 1600 }, () => formatId('chk', crypto.randomUUID()))

    const due = ids.filter(purgeDue).length

    expect(due).toBeGreaterThan(40)
    expect(due).toBeLessThan(200)
  })

  test('purgeExpired removes only rows older than 90 days, one bounded batch at a time', async () => {
    const { memory, seeded, log, deps } = await setup()
    await memory.withOrganization(seeded.organizationId, async (scope) => {
      for (let n = 0; n < CONTACT_CHECK_PURGE_BATCH + 5; n++) {
        await scope.insertContactCheck(oldRow(n))
      }
      await scope.insertContactCheck({
        ...oldRow(0),
        checkedAt: new Date(deps.clock.now().getTime() - 89 * 24 * 60 * 60 * 1000),
      })
    })

    const gone = await memory.withOrganization(seeded.organizationId, (scope) =>
      purgeExpired(scope, deps.clock.now())
    )

    expect(gone).toBe(CONTACT_CHECK_PURGE_BATCH)
    expect((await log('?limit=100')).items).toHaveLength(6)
    const rest = await memory.withOrganization(seeded.organizationId, (scope) =>
      purgeExpired(scope, deps.clock.now())
    )
    expect(rest).toBe(5)
    expect((await log('?limit=100')).items).toHaveLength(1)
  })

  test('checks clear the expired rows of their own Organization as they go, and only theirs', async () => {
    const { memory, seeded, check, log } = await setup()
    const other = await seedOrganization(memory, [])
    for (const org of [seeded.organizationId, other.organizationId]) {
      await memory.withOrganization(org, (scope) => scope.insertContactCheck(oldRow(1)))
    }
    const body = {
      organizationId: seeded.organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    }

    for (let n = 0; n < 400; n++) {
      await check(body)
    }

    const mine = (await log('?limit=100')).items
    expect(mine.every((row) => new Date(row.checkedAt as string) > OLD)).toBe(true)
    const theirs = await memory.withOrganization(other.organizationId, (scope) =>
      scope.listContactChecks({ limit: 10 })
    )
    expect(theirs).toHaveLength(1)
  })

  test('a failing purge does not fail the check, and warns with the error name only', async () => {
    const { check, seeded, deps } = await setup((inner) => ({
      ...inner,
      withOrganization: (id, fn) =>
        inner.withOrganization(id, (scope) =>
          fn({
            ...scope,
            purgeContactChecks: async () => {
              throw new Error('secret row detail')
            },
          })
        ),
    }))
    const body = {
      organizationId: seeded.organizationId,
      email: 'ada@example.test',
      channel: 'email',
      purpose: 'agent_initiated',
      caller: 'x',
    }

    const statuses = new Set<number>()
    for (let n = 0; n < 200; n++) {
      statuses.add((await check(body)).status)
    }

    expect([...statuses]).toEqual([200])
    const warnings = deps.logLines.filter((line) => line.includes('purge'))
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.join('')).toContain('Error')
    expect(warnings.join('')).not.toContain('secret row detail')
    expect(warnings.join('')).not.toContain('ada@example.test')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  CONSENT_ERRORS,
  CORE_ERRORS,
  ERRORS,
  formatId,
  type Role,
  type SuppressionEntryId,
  suppressionEntryPageSchema,
  suppressionEntrySchema,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createTestApp,
  newOrganizationId,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'
import { hashAddress } from './address'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: { userId: SeededMember['userId']; role: Role },
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)
  const queued = async () => {
    const out: { type: string; payload: Record<string, unknown> }[] = []
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        return out
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          out.push({
            type: delivery.envelope.type,
            payload: delivery.envelope.payload as Record<string, unknown>,
          })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  /** Adds an entry the way a stop or a bounce would, which no route here can. */
  const addSystemEntry = (reason: 'stop' | 'bounce', email: string) =>
    store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return scope.insertSuppressionEntry({
        id: formatId('sup', crypto.randomUUID()),
        addressKind: 'email',
        addressHash: hashAddress(
          harness.deps.env.CONSENT_HASH_KEY,
          seeded.organizationId,
          'email',
          email
        ),
        maskedAddress: 'a***@example.test',
        reason,
        channel: null,
        sourceRef: 'msg-1',
        addedByUserId: null,
        now: harness.deps.clock.now(),
      })
    })
  return {
    ...harness,
    store,
    call,
    queued,
    addSystemEntry,
    seeded,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

describe('adding an address', () => {
  test('adds a manual entry with a mask, never the address, and publishes suppression.added', async () => {
    const { call, owner, queued } = await setup()

    const response = await call(owner, 'POST', '/suppression-entries', {
      email: 'Ada@Example.TEST',
      note: 'asked on the phone',
    })

    expect(response.status).toBe(201)
    const entry = suppressionEntrySchema.parse(response.body)
    expect(entry).toMatchObject({
      addressKind: 'email',
      reason: 'manual',
      channel: null,
      sourceRef: 'asked on the phone',
      addedByUserId: owner.userId,
      removable: true,
      removedAt: null,
    })
    expect(entry.maskedAddress).toBe('a***@example.test')
    expect(JSON.stringify(response.body)).not.toContain('ada@example.test')
    const events = await queued()
    expect(events).toEqual([
      {
        type: 'suppression.added',
        payload: {
          suppressionEntryId: entry.id,
          addressKind: 'email',
          reason: 'manual',
          prospectId: null,
        },
      },
    ])
  })

  test('names the Prospect that holds the address in the event', async () => {
    const { call, owner, queued } = await setup()
    const prospect = await call(owner, 'POST', '/prospects', {
      firstName: 'Ada',
      email: 'ada@example.test',
    })
    const prospectId = (prospect.body as { id: string }).id
    await queued()

    await call(owner, 'POST', '/suppression-entries', { email: 'ADA@example.test' })

    const [event] = await queued()
    expect(event?.payload.prospectId).toBe(prospectId)
  })

  test.each([
    ['phone', { phone: '+14155550123' }, '+*******0123'],
    ['linkedin', { linkedinUrl: 'https://www.linkedin.com/in/ada-l/' }, 'linkedin.com/in/a***'],
  ] as const)('adds a %s address', async (kind, body, masked) => {
    const { call, owner } = await setup()

    const response = await call(owner, 'POST', '/suppression-entries', body)

    expect(response.status).toBe(201)
    expect(suppressionEntrySchema.parse(response.body)).toMatchObject({
      addressKind: kind,
      maskedAddress: masked,
    })
  })

  test('an address already suppressed answers its entry (200) and publishes nothing', async () => {
    const { call, owner, admin, queued } = await setup()
    const first = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    await queued()

    const again = await call(admin, 'POST', '/suppression-entries', { email: 'ADA@example.test' })

    expect(again.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
    expect(await queued()).toEqual([])
    const listed = await call(owner, 'GET', '/suppression-entries')
    expect(suppressionEntryPageSchema.parse(listed.body).items).toHaveLength(1)
  })

  test('a repeat with the same Idempotency-Key answers the first entry and publishes once', async () => {
    const { call, owner, queued } = await setup()
    const headers = { 'idempotency-key': 'add-key-0001-abcdef' }

    const first = await call(
      owner,
      'POST',
      '/suppression-entries',
      { phone: '+14155550123' },
      headers
    )
    const second = await call(
      owner,
      'POST',
      '/suppression-entries',
      { phone: '+14155550123' },
      headers
    )

    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.body).toEqual(first.body)
    expect(await queued()).toHaveLength(1)
  })

  test('the same Idempotency-Key for another address is request.idempotency_key_reused', async () => {
    const { call, owner } = await setup()
    const headers = { 'idempotency-key': 'add-key-0002-abcdef' }
    await call(owner, 'POST', '/suppression-entries', { phone: '+14155550123' }, headers)

    const other = await call(
      owner,
      'POST',
      '/suppression-entries',
      { phone: '+14155550124' },
      headers
    )

    expect(other.status).toBe(422)
    expect(other.body.error?.code).toBe('request.idempotency_key_reused')
  })

  test.each([
    ['no address', {}],
    ['two addresses', { email: 'a@example.test', phone: '+14155550123' }],
    ['an email that is not one', { email: 'not an email' }],
    ['a phone without a country code', { phone: '4155550123' }],
    ['a LinkedIn address that is not one', { linkedinUrl: 'https://example.test/in/ada' }],
    ['an unknown field', { email: 'a@example.test', reason: 'stop' }],
    ['a note over 500 characters', { email: 'a@example.test', note: 'x'.repeat(501) }],
  ])('refuses %s as request.invalid', async (_name, body) => {
    const { call, owner } = await setup()

    const response = await call(owner, 'POST', '/suppression-entries', body)

    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe(ERRORS['request.invalid'].code)
  })

  test('a long note is kept to 200 characters in the source reference', async () => {
    const { call, owner } = await setup()

    const response = await call(owner, 'POST', '/suppression-entries', {
      email: 'a@example.test',
      note: 'n'.repeat(300),
    })

    expect(response.body.sourceRef).toBe('n'.repeat(200))
  })

  test('an entry has no source reference when there is no note, and a blank note is refused', async () => {
    const { call, owner } = await setup()

    const none = await call(owner, 'POST', '/suppression-entries', { email: 'a@example.test' })
    const blank = await call(owner, 'POST', '/suppression-entries', {
      email: 'b@example.test',
      note: '   ',
    })

    expect(none.body.sourceRef).toBeNull()
    expect(blank.status).toBe(400)
  })

  test('a suspended Organization refuses it', async () => {
    const { call, owner, store, seeded } = await setup()
    store.setOrganizationStatus(seeded.organizationId, 'suspended')

    const response = await call(owner, 'POST', '/suppression-entries', { email: 'a@example.test' })

    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe(CORE_ERRORS['organization.suspended'].code)
  })
})

describe('who may manage the list', () => {
  test.each([
    ['owner', true],
    ['admin', true],
    ['manager', false],
    ['rep', false],
  ] as const)('%s may use every route: %p', async (role, allowed) => {
    const { call, owner, ...actors } = await setup()
    const actor = role === 'owner' ? owner : actors[role]
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    const id = entry.body.id as string
    const attempts = [
      call(actor, 'POST', '/suppression-entries', { email: 'bob@example.test' }),
      call(actor, 'GET', '/suppression-entries'),
      call(actor, 'POST', '/suppression-entries/lookups', { email: 'ada@example.test' }),
      call(actor, 'GET', `/suppression-entries/${id}`),
      call(actor, 'POST', `/suppression-entries/${id}/removal`, { reason: 'asked again' }),
    ]

    for (const response of await Promise.all(attempts)) {
      if (allowed) {
        expect(response.status).toBeLessThan(300)
      } else {
        expect(response.status).toBe(403)
        expect(response.body.error?.code).toBe(ERRORS['auth.forbidden'].code)
      }
    }
  })
})

describe('listing and looking up', () => {
  test('lists live entries newest first in pages, with a cursor that continues', async () => {
    const { call, owner, deps } = await setup()
    const ids: SuppressionEntryId[] = []
    for (const phone of ['+14155550101', '+14155550102', '+14155550103']) {
      deps.clock.advance('1s')
      ids.push(
        (await call(owner, 'POST', '/suppression-entries', { phone })).body.id as SuppressionEntryId
      )
    }

    const first = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries?limit=2')).body
    )
    const second = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', `/suppression-entries?limit=2&cursor=${first.nextCursor}`)).body
    )

    expect(first.items.map((e) => e.id)).toEqual([
      ids[2] as SuppressionEntryId,
      ids[1] as SuppressionEntryId,
    ])
    expect(first.nextCursor).not.toBeNull()
    expect(second.items.map((e) => e.id)).toEqual([ids[0] as SuppressionEntryId])
    expect(second.nextCursor).toBeNull()
  })

  test('filters on the reason and the address kind', async () => {
    const { call, owner, addSystemEntry } = await setup()
    await call(owner, 'POST', '/suppression-entries', { phone: '+14155550101' })
    await addSystemEntry('bounce', 'b@example.test')

    const bounces = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries?reason=bounce')).body
    )
    const phones = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries?addressKind=phone')).body
    )

    expect(bounces.items.map((e) => e.reason)).toEqual(['bounce'])
    expect(phones.items.map((e) => e.addressKind)).toEqual(['phone'])
  })

  test('a removed entry leaves the default list and shows under state=removed', async () => {
    const { call, owner } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { phone: '+14155550101' })
    await call(owner, 'POST', `/suppression-entries/${entry.body.id}/removal`, {
      reason: 'mistake',
    })

    const active = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries')).body
    )
    const removed = suppressionEntryPageSchema.parse(
      (await call(owner, 'GET', '/suppression-entries?state=removed')).body
    )

    expect(active.items).toEqual([])
    expect(removed.items.map((e) => e.id)).toEqual([entry.body.id as SuppressionEntryId])
  })

  test.each(['not-a-cursor', 'e30', '%%%'])('cursor %p is request.invalid', async (cursor) => {
    const { call, owner } = await setup()

    const response = await call(owner, 'GET', `/suppression-entries?cursor=${cursor}`)

    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe(ERRORS['request.invalid'].code)
  })

  test('looks an address up by any spelling of it, and finds nothing for another', async () => {
    const { call, owner } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })

    const found = await call(owner, 'POST', '/suppression-entries/lookups', {
      email: 'ADA@example.test',
    })
    const missing = await call(owner, 'POST', '/suppression-entries/lookups', {
      email: 'bob@example.test',
    })

    expect(suppressionEntryPageSchema.parse(found.body)).toEqual({
      items: [entry.body as never],
      nextCursor: null,
    })
    expect(missing.body).toEqual({ items: [], nextCursor: null })
  })

  test('a removed address is no longer found', async () => {
    const { call, owner } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    await call(owner, 'POST', `/suppression-entries/${entry.body.id}/removal`, {
      reason: 'mistake',
    })

    const found = await call(owner, 'POST', '/suppression-entries/lookups', {
      email: 'ada@example.test',
    })

    expect(found.body).toEqual({ items: [], nextCursor: null })
  })

  test('an address that cannot be normalised is request.invalid', async () => {
    const { call, owner } = await setup()

    const response = await call(owner, 'POST', '/suppression-entries/lookups', { phone: 'abc' })

    expect(response.status).toBe(400)
  })
})

describe('getting an entry', () => {
  test('answers a live and a removed entry', async () => {
    const { call, owner } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    const path = `/suppression-entries/${entry.body.id}`

    const live = await call(owner, 'GET', path)
    await call(owner, 'POST', `${path}/removal`, { reason: 'mistake' })
    const removed = await call(owner, 'GET', path)

    expect(live.body).toEqual(entry.body)
    expect(suppressionEntrySchema.parse(removed.body)).toMatchObject({
      removedByUserId: owner.userId,
      removalReason: 'mistake',
    })
  })

  test('an unknown id is consent.not_found', async () => {
    const { call, owner } = await setup()

    const response = await call(
      owner,
      'GET',
      `/suppression-entries/${formatId('sup', crypto.randomUUID())}`
    )

    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe(CONSENT_ERRORS['consent.not_found'].code)
  })

  test('a malformed id is request.invalid', async () => {
    const { call, owner } = await setup()

    expect((await call(owner, 'GET', '/suppression-entries/nope')).status).toBe(400)
  })
})

describe('removing an entry', () => {
  test('removes a manual entry with a reason and publishes suppression.removed once', async () => {
    const { call, owner, admin, queued } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    await queued()
    const path = `/suppression-entries/${entry.body.id}/removal`

    const removed = await call(admin, 'POST', path, { reason: 'added by mistake' })
    const again = await call(admin, 'POST', path, { reason: 'something else' })

    expect(removed.status).toBe(200)
    expect(suppressionEntrySchema.parse(removed.body)).toMatchObject({
      removedByUserId: admin.userId,
      removalReason: 'added by mistake',
    })
    expect(again.status).toBe(200)
    expect(again.body).toEqual(removed.body)
    expect(await queued()).toEqual([
      {
        type: 'suppression.removed',
        payload: { suppressionEntryId: entry.body.id, addressKind: 'email' },
      },
    ])
  })

  test('the address can be added again once removed', async () => {
    const { call, owner } = await setup()
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    await call(owner, 'POST', `/suppression-entries/${entry.body.id}/removal`, {
      reason: 'mistake',
    })

    const again = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })

    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(entry.body.id)
  })

  test.each(['stop', 'bounce'] as const)(
    'an entry with the reason %s is consent.entry_not_removable and stays',
    async (reason) => {
      const { call, owner, addSystemEntry } = await setup()
      const { entry } = await addSystemEntry(reason, 'ada@example.test')

      const response = await call(owner, 'POST', `/suppression-entries/${entry.id}/removal`, {
        reason: 'please',
      })

      expect(response.status).toBe(409)
      expect(response.body.error?.code).toBe(CONSENT_ERRORS['consent.entry_not_removable'].code)
      const still = await call(owner, 'POST', '/suppression-entries/lookups', {
        email: 'ada@example.test',
      })
      expect((still.body.items as unknown[]).length).toBe(1)
    }
  )

  test('an unknown id is consent.not_found, and a missing reason is request.invalid', async () => {
    const { call, owner } = await setup()
    const unknown = `/suppression-entries/${formatId('sup', crypto.randomUUID())}/removal`

    expect((await call(owner, 'POST', unknown, { reason: 'x' })).body.error?.code).toBe(
      CONSENT_ERRORS['consent.not_found'].code
    )
    expect((await call(owner, 'POST', unknown, {})).status).toBe(400)
  })
})

describe('another Organization', () => {
  test('cannot see, get, look up or remove an entry, and the same address is a separate entry', async () => {
    const { call, owner, store, seeded } = await setup()
    const other = await seedOrganization(store, [])
    const entry = await call(owner, 'POST', '/suppression-entries', { email: 'ada@example.test' })
    const id = entry.body.id as string
    const theirs = (method: string, path: string, body?: unknown) =>
      call(other.owner, method, path, body, undefined, other.organizationId)

    expect((await theirs('GET', '/suppression-entries')).body).toEqual({
      items: [],
      nextCursor: null,
    })
    expect((await theirs('GET', `/suppression-entries/${id}`)).status).toBe(404)
    expect(
      (await theirs('POST', `/suppression-entries/${id}/removal`, { reason: 'x' })).status
    ).toBe(404)
    expect(
      (await theirs('POST', '/suppression-entries/lookups', { email: 'ada@example.test' })).body
    ).toEqual({ items: [], nextCursor: null })
    const add = await theirs('POST', '/suppression-entries', { email: 'ada@example.test' })
    expect(add.status).toBe(201)
    expect(add.body.id).not.toBe(id)
    const mine = await call(owner, 'GET', `/suppression-entries/${id}`)
    expect(mine.body.removedAt).toBeNull()
    expect(seeded.organizationId).not.toBe(other.organizationId)
  })

  test('an Organization that does not exist is organization.not_found', async () => {
    const { call, owner } = await setup()

    const response = await call(
      owner,
      'GET',
      '/suppression-entries',
      undefined,
      undefined,
      newOrganizationId()
    )

    expect(response.status).toBe(404)
    expect(response.body.error?.code).toBe(CORE_ERRORS['organization.not_found'].code)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  consentEventPageSchema,
  consentFormPageSchema,
  consentFormSchema,
  consentWordingSchema,
  evidencePageSchema,
  hostedConsentFormViewSchema,
  hostedConsentReceiptSchema,
  prospectSchema,
  type Role,
} from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { ConsentWordingSupersededError, type CoreStore } from '~/ports/core-store'
import {
  type ApiResponse,
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
} from '~/testing'

type Actor = { userId: SeededMember['userId']; role: Role }

const IP = '203.0.113.9'
const AGENT = 'TestBrowser/1.0'

async function setup() {
  const memory = createMemoryCoreStore()
  const harness = await createTestApp({ store: memory })
  const seeded = await seedOrganization(memory, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (
    actor: Actor,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    organizationId = seeded.organizationId
  ) => api(actor, organizationId, method, path, body, headers)

  /** A call to a public route: no token, the client address and user agent as the server would see them. */
  const pub = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    address = IP
  ): Promise<ApiResponse> => {
    const response = await harness.app.request(
      `/v1/public/consent-forms${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'user-agent': AGENT, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { requestIP: () => ({ address }) }
    )
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) : {},
      retryAfter: response.headers.get('retry-after'),
    }
  }

  const wording = async (channels = ['email', 'sms'], text = 'We may email and text you.') => {
    const made = await call(seeded.owner, 'POST', '/consent-wordings', { text, channels })
    expect(made.status).toBe(201)
    return consentWordingSchema.parse(made.body)
  }
  const form = async (wordingId: string, channels = ['email', 'sms'], name = 'Newsletter') => {
    const made = await call(seeded.owner, 'POST', '/consent-forms', { wordingId, name, channels })
    expect(made.status).toBe(201)
    return consentFormSchema.parse(made.body)
  }
  const published = async (channels = ['email', 'sms']) => {
    const w = await wording(channels)
    const f = await form(w.id, channels)
    const response = await call(seeded.owner, 'POST', `/consent-forms/${f.id}/publication`)
    expect(response.status).toBe(200)
    const live = consentFormSchema.parse(response.body)
    return { wording: w, form: live, token: live.token as string }
  }
  const submission = (wordingId: string, overrides: Record<string, unknown> = {}) => ({
    wordingId,
    firstName: 'Ada',
    email: 'Ada@Example.test',
    phone: '+14155551234',
    choices: [
      { channel: 'email', agreed: true },
      { channel: 'sms', agreed: false },
    ],
    ...overrides,
  })
  const prospects = async () => {
    const response = await call(seeded.owner, 'GET', '/prospects?limit=100')
    return (response.body.items as { id: string }[]).map((item) => item.id)
  }
  return {
    memory,
    harness,
    seeded,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
    call,
    pub,
    wording,
    form,
    published,
    submission,
    prospects,
  }
}

describe('consent form administration', () => {
  test('a form is a draft with no token until it is published, then it is closed', async () => {
    const { owner, manager, call, wording, form } = await setup()
    const w = await wording()
    const draft = await form(w.id)
    expect(draft).toMatchObject({ state: 'draft', token: null, publishedAt: null, closedAt: null })

    const live = consentFormSchema.parse(
      (await call(owner, 'POST', `/consent-forms/${draft.id}/publication`)).body
    )
    expect(live.state).toBe('published')
    expect(live.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(live.publishedAt).not.toBeNull()

    // A Manager can read the form but never the secret link.
    const seen = consentFormSchema.parse(
      (await call(manager, 'GET', `/consent-forms/${draft.id}`)).body
    )
    expect(seen).toMatchObject({ state: 'published', token: null })

    const again = await call(owner, 'POST', `/consent-forms/${draft.id}/publication`)
    expect(again.status).toBe(409)
    expect(again.body.error?.code).toBe('request.conflict')

    const closed = consentFormSchema.parse(
      (await call(owner, 'POST', `/consent-forms/${draft.id}/closure`)).body
    )
    expect(closed.state).toBe('closed')
    expect(closed.closedAt).not.toBeNull()
    const twice = await call(owner, 'POST', `/consent-forms/${draft.id}/closure`)
    expect(twice.status).toBe(409)
    expect(twice.body.error?.code).toBe('request.conflict')
  })

  test('a draft cannot be closed', async () => {
    const { owner, call, wording, form } = await setup()
    const draft = await form((await wording()).id)
    const response = await call(owner, 'POST', `/consent-forms/${draft.id}/closure`)
    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('request.conflict')
  })

  test('only an Owner or Admin writes; every role reads', async () => {
    const { owner, admin, manager, rep, call, wording, form } = await setup()
    const w = await wording()
    for (const actor of [manager, rep]) {
      const create = await call(actor, 'POST', '/consent-forms', {
        wordingId: w.id,
        name: 'x',
        channels: ['email'],
      })
      expect(create.status).toBe(403)
      expect(create.body.error?.code).toBe('auth.forbidden')
      expect(
        (await call(actor, 'POST', '/consent-wordings', { text: 'x', channels: ['sms'] })).status
      ).toBe(403)
    }
    const f = await form(w.id)
    for (const actor of [manager, rep]) {
      expect((await call(actor, 'POST', `/consent-forms/${f.id}/publication`)).status).toBe(403)
      expect((await call(actor, 'GET', `/consent-forms/${f.id}`)).status).toBe(200)
      expect((await call(actor, 'GET', '/consent-forms')).status).toBe(200)
      expect((await call(actor, 'GET', `/consent-wordings/${w.id}`)).status).toBe(200)
    }
    const byAdmin = await call(admin, 'POST', `/consent-forms/${f.id}/publication`)
    expect(byAdmin.status).toBe(200)
    expect(consentFormSchema.parse(byAdmin.body).token).not.toBeNull()
    expect(owner.role).toBe('owner')
  })

  test('a form cannot offer a channel its wording does not cover, or use a missing wording', async () => {
    const { owner, call, wording } = await setup()
    const w = await wording(['email'])
    const wide = await call(owner, 'POST', '/consent-forms', {
      wordingId: w.id,
      name: 'x',
      channels: ['email', 'sms'],
    })
    expect(wide.status).toBe(400)
    expect(wide.body.error?.code).toBe('request.invalid')
    const missing = await call(owner, 'POST', '/consent-forms', {
      wordingId: 'cwd_00000000000000000000000000000000',
      name: 'x',
      channels: ['email'],
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('consent.not_found')
  })

  test('creating a form is idempotent on the key', async () => {
    const { owner, call, wording } = await setup()
    const w = await wording()
    const body = { wordingId: w.id, name: 'Once', channels: ['email'] }
    const headers = { 'idempotency-key': 'form-create-key-0001' }
    const first = await call(owner, 'POST', '/consent-forms', body, headers)
    const second = await call(owner, 'POST', '/consent-forms', body, headers)
    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.body.id).toBe(first.body.id)
    const reused = await call(owner, 'POST', '/consent-forms', { ...body, name: 'Other' }, headers)
    expect(reused.status).toBe(422)
    expect(reused.body.error?.code).toBe('request.idempotency_key_reused')
    const listed = consentFormPageSchema.parse((await call(owner, 'GET', '/consent-forms')).body)
    expect(listed.items).toHaveLength(1)
  })

  test('lists are cursor paged with a maximum page size and a state filter', async () => {
    const { owner, call, wording, form } = await setup()
    const w = await wording()
    const made = [await form(w.id), await form(w.id), await form(w.id)]
    await call(owner, 'POST', `/consent-forms/${made[0]?.id}/publication`)

    const first = consentFormPageSchema.parse(
      (await call(owner, 'GET', '/consent-forms?limit=2')).body
    )
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = consentFormPageSchema.parse(
      (await call(owner, 'GET', `/consent-forms?limit=2&cursor=${first.nextCursor}`)).body
    )
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((f) => f.id)).size).toBe(3)

    const drafts = consentFormPageSchema.parse(
      (await call(owner, 'GET', '/consent-forms?state=draft')).body
    )
    expect(drafts.items).toHaveLength(2)
    for (const query of ['limit=101', 'limit=0', 'cursor=not-a-cursor', 'state=bogus']) {
      const response = await call(owner, 'GET', `/consent-forms?${query}`)
      expect(response.status).toBe(400)
      expect(response.body.error?.code).toBe('request.invalid')
    }
  })
})

describe('consent wording lock', () => {
  test('a wording can be edited until a published form uses it, then it is consent.wording_locked', async () => {
    const { owner, call, wording, form } = await setup()
    const w = await wording()
    const edited = await call(owner, 'PATCH', `/consent-wordings/${w.id}`, { text: 'Edited text.' })
    expect(edited.status).toBe(200)
    expect(consentWordingSchema.parse(edited.body)).toMatchObject({
      text: 'Edited text.',
      locked: false,
    })

    // A draft form does not lock it; publishing does.
    const f = await form(w.id)
    expect(
      (await call(owner, 'PATCH', `/consent-wordings/${w.id}`, { text: 'Again.' })).status
    ).toBe(200)
    await call(owner, 'POST', `/consent-forms/${f.id}/publication`)

    const locked = await call(owner, 'PATCH', `/consent-wordings/${w.id}`, { text: 'Too late.' })
    expect(locked.status).toBe(409)
    expect(locked.body.error?.code).toBe('consent.wording_locked')
    const read = consentWordingSchema.parse(
      (await call(owner, 'GET', `/consent-wordings/${w.id}`)).body
    )
    expect(read).toMatchObject({ text: 'Again.', locked: true })

    // The change is a new version, which names the one it replaces and is open to edit.
    const next = await call(owner, 'POST', `/consent-wordings/${w.id}/versions`, {
      text: 'Version two.',
      channels: ['email', 'sms'],
    })
    expect(next.status).toBe(201)
    expect(consentWordingSchema.parse(next.body)).toMatchObject({
      version: 2,
      supersedesId: w.id,
      locked: false,
    })
  })

  test('two versions of one wording at once answer 201 and 409 request.conflict, never 500', async () => {
    const { owner, call, wording } = await setup()
    const w = await wording()
    const body = { text: 'Version two.', channels: ['email', 'sms'] }
    const results = await Promise.all([
      call(owner, 'POST', `/consent-wordings/${w.id}/versions`, body),
      call(owner, 'POST', `/consent-wordings/${w.id}/versions`, { ...body, text: 'Other two.' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    const refused = results.find((r) => r.status === 409)
    expect(refused?.body.error?.code).toBe('request.conflict')
  })

  test('a unique violation on the version number, past the superseded check, is request.conflict', async () => {
    const memory = createMemoryCoreStore()
    // The store refuses every new version, as the database does when another one won the race.
    const racing: CoreStore = {
      ...memory,
      withOrganization: (organizationId, fn) =>
        memory.withOrganization(organizationId, (scope) =>
          fn({
            ...scope,
            insertConsentWording: async (input) => {
              if (input.supersedesId !== null) {
                throw new ConsentWordingSupersededError()
              }
              return scope.insertConsentWording(input)
            },
          })
        ),
    }
    const harness = await createTestApp({ store: racing })
    const seeded = await seedOrganization(memory, [])
    const call = publicCaller(harness)
    const made = await call(seeded.owner, seeded.organizationId, 'POST', '/consent-wordings', {
      text: 'We may email you.',
      channels: ['email'],
    })
    expect(made.status).toBe(201)
    const next = await call(
      seeded.owner,
      seeded.organizationId,
      'POST',
      `/consent-wordings/${consentWordingSchema.parse(made.body).id}/versions`,
      { text: 'Version two.', channels: ['email'] }
    )
    expect(next.status).toBe(409)
    expect(next.body.error?.code).toBe('request.conflict')
  })

  test('closing the form keeps the wording locked', async () => {
    const { owner, call, published } = await setup()
    const { wording, form } = await published()
    await call(owner, 'POST', `/consent-forms/${form.id}/closure`)
    const response = await call(owner, 'PATCH', `/consent-wordings/${wording.id}`, { text: 'No.' })
    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('consent.wording_locked')
  })

  test('the wording a form shows cannot be edited after a grant either', async () => {
    const { owner, call, pub, published, submission } = await setup()
    const { wording, token } = await published()
    expect((await pub('POST', `/${token}/submissions`, submission(wording.id))).status).toBe(201)
    const response = await call(owner, 'PATCH', `/consent-wordings/${wording.id}`, { text: 'No.' })
    expect(response.status).toBe(409)
    expect(response.body.error?.code).toBe('consent.wording_locked')
  })
})

describe('hosted consent form (public)', () => {
  test('the page shows the Organization, the exact wording version and the channels', async () => {
    const { pub, published } = await setup()
    const { wording, token } = await published()
    const response = await pub('GET', `/${token}`)
    expect(response.status).toBe(200)
    expect(hostedConsentFormViewSchema.parse(response.body)).toMatchObject({
      wordingId: wording.id,
      wordingVersion: 1,
      wordingText: 'We may email and text you.',
      channels: ['email', 'sms'],
    })
  })

  test('a submission grants only the ticked channels, tied to the wording version, with evidence', async () => {
    const { owner, call, pub, published, submission, prospects } = await setup()
    const { wording, form, token } = await published()
    const response = await pub('POST', `/${token}/submissions`, submission(wording.id))
    expect(response.status).toBe(201)
    const receipt = hostedConsentReceiptSchema.parse(response.body)
    expect(receipt.channels).toEqual(['email'])
    expect(JSON.stringify(response.body)).not.toContain(IP)

    const [id] = await prospects()
    const consent = (await call(owner, 'GET', `/prospects/${id}/consent`)).body.channels as {
      channel: string
      state: string
      wordingId: string | null
    }[]
    expect(consent.find((c) => c.channel === 'email')).toMatchObject({
      state: 'granted',
      wordingId: wording.id,
    })
    // The unticked channel was never granted.
    expect(consent.find((c) => c.channel === 'sms')?.state).toBe('none')

    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent-events`)).body
    )
    expect(events.items).toHaveLength(1)
    expect(events.items[0]).toMatchObject({
      channel: 'email',
      kind: 'granted',
      source: 'hosted_form',
      formId: form.id,
      wordingId: wording.id,
    })

    const evidence = evidencePageSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent-evidence`)).body
    )
    expect(evidence.items[0]).toMatchObject({
      wording: { id: wording.id, version: 1, text: 'We may email and text you.' },
      submission: { ipAddress: IP, userAgent: AGENT },
    })
  })

  test('every ticked channel gets its own grant and consent.granted is published for each', async () => {
    const { harness, call, owner, pub, published, submission, prospects } = await setup()
    const { wording, token } = await published()
    const response = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, {
        choices: [
          { channel: 'email', agreed: true },
          { channel: 'sms', agreed: true },
        ],
      })
    )
    expect(hostedConsentReceiptSchema.parse(response.body).channels).toEqual(['email', 'sms'])
    const [id] = await prospects()
    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent-events`)).body
    )
    expect(events.items.map((e) => e.channel).sort()).toEqual(['email', 'sms'])

    const types: string[] = []
    await drainTestOutbox(harness.deps)
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        break
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          types.push(delivery.envelope.type)
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
    expect(types.filter((t) => t === 'consent.granted')).toHaveLength(2)
    expect(types.filter((t) => t === 'prospect.created')).toHaveLength(1)
  })

  test('a submission that ticks nothing is refused and grants nothing', async () => {
    const { pub, published, submission, prospects } = await setup()
    const { wording, token } = await published()
    const response = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, {
        choices: [
          { channel: 'email', agreed: false },
          { channel: 'sms', agreed: false },
        ],
      })
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('request.invalid')
    expect(await prospects()).toHaveLength(0)
  })

  test('an existing Prospect keeps its data; the grant lands on it and no second one is made', async () => {
    const { owner, call, pub, published, submission, prospects } = await setup()
    const made = await call(owner, 'POST', '/prospects', {
      firstName: 'Original',
      email: 'ada@example.test',
    })
    const { wording, token } = await published()
    const response = await pub('POST', `/${token}/submissions`, submission(wording.id))
    expect(response.status).toBe(201)
    expect(await prospects()).toEqual([made.body.id as string])
    const read = await call(owner, 'GET', `/prospects/${made.body.id}`)
    expect(prospectSchema.parse(read.body).fields.firstName?.value).toBe('Original')
  })

  test('a phone of one Prospect and an email of another answers like any submission and reveals nothing', async () => {
    const { owner, call, pub, published, submission, prospects } = await setup()
    const a = await call(owner, 'POST', '/prospects', { firstName: 'A', phone: '+14155551234' })
    await call(owner, 'POST', '/prospects', { firstName: 'B', email: 'ada@example.test' })
    const { wording, token } = await published()
    const response = await pub('POST', `/${token}/submissions`, submission(wording.id))
    expect(response.status).toBe(201)
    expect(await prospects()).toHaveLength(2)
    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${a.body.id}/consent-events`)).body
    )
    // The email is not on A, so it grants nothing to A (or to B); the answer is still a receipt.
    expect(events.items).toHaveLength(0)
    expect(hostedConsentReceiptSchema.parse(response.body).channels).toEqual(['email'])
  })

  test('a typed address the matched Prospect does not hold grants nothing, but the receipt is the same', async () => {
    const { owner, call, pub, published, submission } = await setup()
    const p = await call(owner, 'POST', '/prospects', {
      firstName: 'P',
      phone: '+14155551234',
      email: 'a@example.test',
    })
    const { wording, token } = await published()
    const response = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, {
        email: 'b@example.test',
        choices: [
          { channel: 'email', agreed: true },
          { channel: 'sms', agreed: true },
        ],
      })
    )
    expect(response.status).toBe(201)
    expect(hostedConsentReceiptSchema.parse(response.body).channels).toEqual(['email', 'sms'])
    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${p.body.id}/consent-events`)).body
    )
    // The phone is held by P, so sms is granted; the email b@ is not, so email is not.
    expect(events.items.map((e) => e.channel)).toEqual(['sms'])
  })

  test('a ticked channel with no address typed is refused by the contract and grants nothing', async () => {
    const { pub, published, submission, prospects } = await setup()
    const { wording, token } = await published()
    const response = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, { phone: undefined, choices: [{ channel: 'sms', agreed: true }] })
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('request.invalid')
    expect(await prospects()).toHaveLength(0)
  })

  test('a new Prospect made from the submission is granted both channels', async () => {
    const { owner, call, pub, published, submission, prospects } = await setup()
    const { wording, token } = await published()
    await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, {
        choices: [
          { channel: 'email', agreed: true },
          { channel: 'sms', agreed: true },
        ],
      })
    )
    const [id] = await prospects()
    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${id}/consent-events`)).body
    )
    expect(events.items.map((e) => e.channel).sort()).toEqual(['email', 'sms'])
  })

  test('a wording other than the form, or a channel it does not offer, is refused', async () => {
    const { pub, published, submission, wording, prospects } = await setup()
    const { wording: shown, token } = await published(['email'])
    const other = await wording()
    const wrong = await pub('POST', `/${token}/submissions`, submission(other.id))
    expect(wrong.status).toBe(400)
    expect(wrong.body.error?.code).toBe('request.invalid')
    const unoffered = await pub(
      'POST',
      `/${token}/submissions`,
      submission(shown.id, { choices: [{ channel: 'sms', agreed: true }] })
    )
    expect(unoffered.status).toBe(400)
    expect(unoffered.body.error?.code).toBe('request.invalid')
    expect(await prospects()).toHaveLength(0)
  })

  test('the contract refuses a body that is missing the address a ticked channel needs', async () => {
    const { pub, published, submission } = await setup()
    const { wording, token } = await published()
    const response = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, { email: undefined })
    )
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('request.invalid')
  })

  test('a hosted-form grant is audited as the system, once per channel, and not on a replay', async () => {
    const { owner, call, pub, published, submission } = await setup()
    const { wording, token } = await published()
    const headers = { 'idempotency-key': 'hosted-submit-key-0002' }
    const body = submission(wording.id)
    await pub('POST', `/${token}/submissions`, body, headers)
    await pub('POST', `/${token}/submissions`, body, headers)
    const log = (await call(owner, 'GET', '/audit-events')).body.items as {
      action: string
      actor: { kind: string }
      metadata: Record<string, unknown>
    }[]
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((e) => e.action === 'consent.granted' && e.actor.kind === 'system')).toBe(true)
    expect(log.every((e) => e.metadata.source === 'hosted_form')).toBe(true)
  })

  test('the same Idempotency-Key returns the first receipt and grants nothing twice', async () => {
    const { owner, call, pub, published, submission, prospects, harness } = await setup()
    const { wording, token } = await published()
    const headers = { 'idempotency-key': 'hosted-submit-key-0001' }
    const body = submission(wording.id)
    const first = await pub('POST', `/${token}/submissions`, body, headers)
    const second = await pub('POST', `/${token}/submissions`, body, headers)
    expect([first.status, second.status]).toEqual([201, 200])
    expect(second.body).toEqual(first.body)
    const ids = await prospects()
    expect(ids).toHaveLength(1)
    const events = consentEventPageSchema.parse(
      (await call(owner, 'GET', `/prospects/${ids[0]}/consent-events`)).body
    )
    expect(events.items).toHaveLength(1)

    const reused = await pub(
      'POST',
      `/${token}/submissions`,
      submission(wording.id, { firstName: 'Grace' }),
      headers
    )
    expect(reused.status).toBe(422)
    expect(reused.body.error?.code).toBe('request.idempotency_key_reused')

    // The replay published nothing new.
    let granted = 0
    await drainTestOutbox(harness.deps)
    for (;;) {
      const batch = await harness.deps.events.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 60,
        waitSeconds: 0,
      })
      if (batch.length === 0) {
        break
      }
      for (const delivery of batch) {
        if (delivery.kind === 'message') {
          granted += delivery.envelope.type === 'consent.granted' ? 1 : 0
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
    expect(granted).toBe(1)
  })

  test('a draft, a closed form, an unknown and a malformed link are all consent.invalid_token', async () => {
    const { owner, call, pub, wording, form, published, submission } = await setup()
    const w = await wording()
    const draft = await form(w.id)
    const live = await published()
    await call(owner, 'POST', `/consent-forms/${live.form.id}/closure`)
    const tokens = [
      'A'.repeat(43), // unknown
      'short', // malformed
      live.token, // closed
      draft.id, // a form id is not a token
    ]
    for (const token of tokens) {
      const read = await pub('GET', `/${token}`)
      expect(read.status).toBe(400)
      expect(read.body.error?.code).toBe('consent.invalid_token')
      const sent = await pub('POST', `/${token}/submissions`, submission(w.id))
      expect(sent.status).toBe(400)
      expect(sent.body.error?.code).toBe('consent.invalid_token')
    }
  })

  test('a link of an Organization that is not active is consent.invalid_token, like any other', async () => {
    const { memory, seeded, pub, published, submission } = await setup()
    const live = await published()
    const unknown = await pub('GET', `/${'A'.repeat(43)}`)
    for (const status of ['suspended', 'deleted'] as const) {
      memory.setOrganizationStatus(seeded.organizationId, status)
      const read = await pub('GET', `/${live.token}`)
      expect(read.status).toBe(unknown.status)
      expect(read.body).toEqual(unknown.body)
      const sent = await pub('POST', `/${live.token}/submissions`, submission(live.wording.id))
      expect(sent.status).toBe(400)
      expect(sent.body.error?.code).toBe('consent.invalid_token')
      expect(sent.body).toEqual(unknown.body)
    }
    memory.setOrganizationStatus(seeded.organizationId, 'active')
    expect((await pub('GET', `/${live.token}`)).status).toBe(200)
  })

  test('the public routes log nothing of the body, address, user agent, email or phone', async () => {
    const { harness, pub, published, submission } = await setup()
    const live = await published()
    const address = '198.51.100.77'
    const agent = 'SecretAgent/9.9 (probe)'
    const body = submission(live.wording.id, {
      firstName: 'Zebulon',
      lastName: 'Quixote',
      email: 'zebulon.quixote@leaky.test',
      phone: '+14155550177',
      choices: [
        { channel: 'email', agreed: true },
        { channel: 'sms', agreed: true },
      ],
    })
    const headers = { 'user-agent': agent }
    harness.deps.logLines.length = 0
    expect((await pub('GET', `/${live.token}`, undefined, headers, address)).status).toBe(200)
    expect((await pub('POST', `/${live.token}/submissions`, body, headers, address)).status).toBe(
      201
    )
    // Failures log too: a bad link, a bad body and the replay of a key.
    await pub('POST', `/${'B'.repeat(43)}/submissions`, body, headers, address)
    await pub('POST', `/${live.token}/submissions`, { ...body, choices: [] }, headers, address)
    const lines = harness.deps.logLines.join('\n')
    for (const secret of [
      address,
      agent,
      'Zebulon',
      'Quixote',
      'zebulon.quixote@leaky.test',
      'Zebulon.Quixote@leaky.test',
      '4155550177',
      live.token,
    ]) {
      expect(lines).not.toContain(secret)
    }
  })

  test('the public route is rate limited per client address', async () => {
    const { pub, published } = await setup()
    const { token } = await published()
    for (let i = 0; i < 60; i += 1) {
      expect((await pub('GET', `/${token}`)).status).toBe(200)
    }
    const limited = await pub('GET', `/${token}`)
    expect(limited.status).toBe(429)
    expect(limited.body.error?.code).toBe('rate.limited')
    expect(Number(limited.retryAfter)).toBeGreaterThan(0)
    // Another address has its own budget.
    expect((await pub('GET', `/${token}`, undefined, {}, '198.51.100.7')).status).toBe(200)
  })

  test('only the portal origin gets CORS headers', async () => {
    const { harness, published } = await setup()
    const { token } = await published()
    const portal = new URL(harness.deps.env.PORTAL_BASE_URL).origin
    const ok = await harness.app.request(`/v1/public/consent-forms/${token}`, {
      headers: { origin: portal },
    })
    expect(ok.headers.get('access-control-allow-origin')).toBe(portal)
    const other = await harness.app.request(`/v1/public/consent-forms/${token}`, {
      headers: { origin: 'https://evil.example' },
    })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('second Organization', () => {
  test("cannot read, publish or close the first Organization's form, and sees none of its grants", async () => {
    const { owner, memory, call, wording, form, pub, published, submission } = await setup()
    const other = await seedOrganization(memory, [])
    const w = await wording()
    const draft = await form(w.id)
    const live = await published()
    await pub('POST', `/${live.token}/submissions`, submission(live.wording.id))

    const asOther = (method: string, path: string, body?: unknown) =>
      call(other.owner, method, path, body, undefined, other.organizationId)
    for (const [method, path] of [
      ['GET', `/consent-forms/${draft.id}`],
      ['POST', `/consent-forms/${draft.id}/publication`],
      ['POST', `/consent-forms/${live.form.id}/closure`],
      ['GET', `/consent-wordings/${w.id}`],
    ] as const) {
      const response = await asOther(method, path)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('consent.not_found')
    }
    const edit = await asOther('PATCH', `/consent-wordings/${w.id}`, { text: 'Mine now.' })
    expect(edit.status).toBe(404)
    expect(edit.body.error?.code).toBe('consent.not_found')
    const borrowed = await asOther('POST', '/consent-forms', {
      wordingId: w.id,
      name: 'x',
      channels: ['email'],
    })
    expect(borrowed.status).toBe(404)
    expect(borrowed.body.error?.code).toBe('consent.not_found')

    const forms = consentFormPageSchema.parse((await asOther('GET', '/consent-forms')).body)
    expect(forms.items).toHaveLength(0)
    const theirProspects = await asOther('GET', '/prospects?limit=100')
    expect(theirProspects.body.items).toEqual([])
    const mine = await call(owner, 'GET', '/prospects?limit=100')
    expect((mine.body.items as unknown[]).length).toBe(1)

    // The first Organization's form is untouched by all of it.
    const still = consentFormSchema.parse(
      (await call(owner, 'GET', `/consent-forms/${live.form.id}`)).body
    )
    expect(still.state).toBe('published')
  })

  test("a submission through the first Organization's link lands only in the first Organization", async () => {
    const { memory, pub, published, submission, prospects, call } = await setup()
    const other = await seedOrganization(memory, [])
    const { wording, token } = await published()
    expect((await pub('POST', `/${token}/submissions`, submission(wording.id))).status).toBe(201)
    expect(await prospects()).toHaveLength(1)
    const theirs = await call(
      other.owner,
      'GET',
      '/prospects?limit=100',
      undefined,
      undefined,
      other.organizationId
    )
    expect(theirs.body.items).toEqual([])
  })
})

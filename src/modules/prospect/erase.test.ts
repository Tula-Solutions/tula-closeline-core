import { describe, expect, test } from 'bun:test'
import {
  type eraseProspectResponseSchema,
  formatId,
  type ProspectId,
  prospectSchema,
  type Role,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { hashAddress } from '~/modules/suppression/address'
import {
  createTestApp,
  drainTestOutbox,
  publicCaller,
  type SeededMember,
  seedOrganization,
  TEST_CONSENT_HASH_KEY,
} from '~/testing'
import { processAssignJobs } from './assign-worker'
import { processErase } from './erase'

type Actor = { userId: SeededMember['userId']; role: Role }
type Erased = z.infer<typeof eraseProspectResponseSchema>

const EMAIL = 'Pat.Doe@Example.test'
const NEW_EMAIL = 'pat.new@example.test'
const PHONE = '+14155550100'

async function setup() {
  const store = createMemoryCoreStore()
  const harness = await createTestApp({ store })
  const seeded = await seedOrganization(store, ['admin', 'manager', 'rep'])
  const byRole = (role: Role) => seeded.members.find((m) => m.role === role) as SeededMember
  const api = publicCaller(harness)
  const call = (actor: Actor, method: string, path: string, body?: unknown) =>
    api(actor, seeded.organizationId, method, path, body)
  const create = async (actor: Actor, body: Record<string, unknown>) => {
    const response = await call(actor, 'POST', '/prospects', body)
    expect([200, 201]).toContain(response.status)
    return prospectSchema.parse(response.body)
  }
  const drain = async () => {
    const signal = new AbortController().signal
    let total = 0
    for (;;) {
      const n = await processAssignJobs(harness.deps, signal)
      if (n === 0) {
        return total
      }
      total += n
    }
  }
  const events = async () => {
    const out: { type: string; payload: unknown }[] = []
    await drainTestOutbox(harness.deps)
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
          out.push({ type: delivery.envelope.type, payload: delivery.envelope.payload })
          await harness.deps.events.acknowledge(delivery.receipt)
        }
      }
    }
  }
  const suppressionOf = (kind: 'email' | 'phone', normalised: string) =>
    store.withOrganization(seeded.organizationId, (scope) =>
      scope.findLiveSuppression(kind, [
        hashAddress(TEST_CONSENT_HASH_KEY, seeded.organizationId, kind, normalised),
      ])
    )
  const job = (prospectId: ProspectId) => ({
    organizationId: seeded.organizationId,
    prospectId,
    actorUserId: seeded.owner.userId,
    traceId: 'trace-erase',
  })
  return {
    ...harness,
    store,
    seeded,
    call,
    create,
    drain,
    events,
    suppressionOf,
    job,
    owner: seeded.owner,
    admin: byRole('admin'),
    manager: byRole('manager'),
    rep: byRole('rep'),
  }
}

const full = (s: Awaited<ReturnType<typeof setup>>, email = EMAIL, phone = PHONE) =>
  s.create(s.rep, {
    firstName: 'Pat',
    lastName: 'Doe',
    email,
    phone,
    notes: 'Called twice about the renewal',
  })

describe('asking to erase a Prospect', () => {
  test('Owner and Admin get 202 queued at once; the work happens in the job', async () => {
    const s = await setup()
    for (const [n, actor] of [s.owner, s.admin].entries()) {
      const prospect = await full(s, `pat${n}@example.test`, `+1415555020${n}`)
      const response = await s.call(actor, 'DELETE', `/prospects/${prospect.id}`)

      expect(response.status).toBe(202)
      expect(response.body as Erased).toEqual({ prospectId: prospect.id, state: 'queued' })
      expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(200)
    }
    expect(await s.drain()).toBe(2)
  })

  test('a Rep and a Manager get auth.forbidden and nothing is queued', async () => {
    const s = await setup()
    const prospect = await full(s)
    for (const actor of [s.rep, s.manager]) {
      const response = await s.call(actor, 'DELETE', `/prospects/${prospect.id}`)
      expect(response.status).toBe(403)
      expect(response.body.error?.code).toBe('auth.forbidden')
    }
    expect(await s.drain()).toBe(0)
    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(200)
  })

  test('an unknown Prospect and one of another Organization are prospect.not_found', async () => {
    const s = await setup()
    const other = await seedOrganization(s.store, [])
    const theirs = await publicCaller(s)(other.owner, other.organizationId, 'POST', '/prospects', {
      firstName: 'Theirs',
    })
    const theirId = prospectSchema.parse(theirs.body).id

    for (const id of [formatId('prs', crypto.randomUUID()), theirId]) {
      const response = await s.call(s.owner, 'DELETE', `/prospects/${id}`)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('prospect.not_found')
    }
    expect(await s.drain()).toBe(0)
    const still = await publicCaller(s)(
      other.owner,
      other.organizationId,
      'GET',
      `/prospects/${theirId}`
    )
    expect(still.status).toBe(200)
  })

  test('a queue that refuses the job is 503 and the Prospect stays', async () => {
    const s = await setup()
    const prospect = await full(s)
    Object.assign(s.deps.jobs, {
      publishBatch: async () => {
        throw new Error('queue down')
      },
    })

    const response = await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)

    expect(response.status).toBe(503)
    expect(response.body.error?.code).toBe('server.unavailable')
    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(200)
  })

  test('a suspended Organization refuses', async () => {
    const s = await setup()
    const prospect = await full(s)
    s.store.setOrganizationStatus(s.seeded.organizationId, 'suspended')

    const response = await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)

    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('organization.suspended')
  })
})

describe('the erase job', () => {
  test('removes the Prospect: it is prospect.not_found, even for a repeat request', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)
    expect(await s.drain()).toBe(1)

    for (const actor of [s.owner, s.rep]) {
      const response = await s.call(actor, 'GET', `/prospects/${prospect.id}`)
      expect(response.status).toBe(404)
      expect(response.body.error?.code).toBe('prospect.not_found')
    }
    const again = await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)
    expect(again.status).toBe(404)
    const listed = await s.call(s.owner, 'GET', '/prospects')
    expect((listed.body as { items: unknown[] }).items).toEqual([])
  })

  test('deletes fields, history, identities and notes, so no address is left to read', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.call(s.rep, 'PATCH', `/prospects/${prospect.id}`, { email: NEW_EMAIL })
    await processErase(s.deps, s.job(prospect.id))

    await s.store.withOrganization(s.seeded.organizationId, async (scope) => {
      expect(await scope.getProspect(prospect.id, { kind: 'all' })).toBeNull()
      expect(await scope.listProspectAddresses(prospect.id)).toEqual([])
      expect((await scope.listCurrentFields('prospect', [prospect.id])).get(prospect.id)).toBe(
        undefined
      )
      expect(await scope.findProspectByIdentity('email', NEW_EMAIL)).toBeNull()
      expect(await scope.findProspectByIdentity('phone', PHONE)).toBeNull()
    })
  })

  test('keeps a salted-hash suppression entry for every old email and phone, with no mask', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.call(s.rep, 'PATCH', `/prospects/${prospect.id}`, { email: NEW_EMAIL })
    await processErase(s.deps, s.job(prospect.id))

    for (const [kind, address] of [
      ['email', 'pat.doe@example.test'],
      ['email', NEW_EMAIL],
      ['phone', PHONE],
    ] as const) {
      const [entry] = await s.suppressionOf(kind, address)
      expect(entry?.reason).toBe('erased')
      expect(entry?.maskedAddress).toBeNull()
      expect(entry?.removable).toBe(false)
    }
  })

  test('frees the identities for a new Prospect', async () => {
    const s = await setup()
    const prospect = await full(s)
    await processErase(s.deps, s.job(prospect.id))

    const again = await s.call(s.rep, 'POST', '/prospects', { email: EMAIL })

    expect([200, 201]).toContain(again.status)
    expect(prospectSchema.parse(again.body).id).not.toBe(prospect.id)
  })

  test('publishes prospect.erased with the id alone, and no event carries personal data', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.events()

    await processErase(s.deps, s.job(prospect.id))

    const published = await s.events()
    expect(published.filter((e) => e.type === 'prospect.erased')).toEqual([
      { type: 'prospect.erased', payload: { prospectId: prospect.id } },
    ])
    const text = JSON.stringify(published).toLowerCase()
    for (const secret of ['pat', 'doe', 'example.test', '4155550100', 'renewal']) {
      expect(text).not.toContain(secret)
    }
    expect(published.filter((e) => e.type === 'suppression.added')).toHaveLength(2)
  })

  test('a redelivery changes and publishes nothing more', async () => {
    const s = await setup()
    const prospect = await full(s)
    await processErase(s.deps, s.job(prospect.id))
    await s.events()

    await processErase(s.deps, s.job(prospect.id))

    expect(await s.events()).toEqual([])
    expect(await s.suppressionOf('email', 'pat.doe@example.test')).toHaveLength(1)
  })

  test('resumes after a crash between the suppression and the delete', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.store.withOrganization(s.seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.eraseProspectFields(prospect.id, 1)
    })

    await processErase(s.deps, s.job(prospect.id))

    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(404)
    expect((await s.events()).filter((e) => e.type === 'prospect.erased')).toHaveLength(1)
  })

  test('an address added while the job runs is still suppressed', async () => {
    const s = await setup()
    const prospect = await full(s)
    const real = s.deps.store
    let calls = 0
    const store = Object.assign(Object.create(real), {
      withOrganization: async (...args: Parameters<typeof real.withOrganization>) => {
        const result = await real.withOrganization(...args)
        calls += 1
        if (calls === 2) {
          await s.call(s.rep, 'PATCH', `/prospects/${prospect.id}`, { email: 'late@example.test' })
        }
        return result
      },
    })

    await processErase({ ...s.deps, store }, s.job(prospect.id))

    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(404)
    expect(await s.suppressionOf('email', 'late@example.test')).toHaveLength(1)
  })

  test('deletes the history in bounded batches', async () => {
    const s = await setup()
    const prospect = await full(s)
    for (const n of [1, 2, 3, 4, 5]) {
      await s.call(s.rep, 'PATCH', `/prospects/${prospect.id}`, { email: `old${n}@example.test` })
    }

    await processErase(s.deps, s.job(prospect.id), { batchRows: 2 })

    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(404)
    for (const n of [1, 2, 3, 4, 5]) {
      expect(await s.suppressionOf('email', `old${n}@example.test`)).toHaveLength(1)
    }
  })

  test('leaves a Prospect of another Organization with the same email untouched', async () => {
    const s = await setup()
    const other = await seedOrganization(s.store, [])
    const api = publicCaller(s)
    const theirs = prospectSchema.parse(
      (await api(other.owner, other.organizationId, 'POST', '/prospects', { email: EMAIL })).body
    )
    const prospect = await full(s)

    await processErase(s.deps, s.job(prospect.id))

    const get = await api(other.owner, other.organizationId, 'GET', `/prospects/${theirs.id}`)
    expect(get.status).toBe(200)
    const found = await s.store.withOrganization(other.organizationId, (scope) =>
      scope.findLiveSuppression('email', [
        hashAddress(TEST_CONSENT_HASH_KEY, other.organizationId, 'email', 'pat.doe@example.test'),
      ])
    )
    expect(found).toEqual([])
  })

  test('a Prospect already gone ends the job; a deleted Organization ends it; a suspended one retries', async () => {
    const s = await setup()
    const gone = formatId('prs', crypto.randomUUID())
    await processErase(s.deps, s.job(gone))
    expect(await s.events()).toEqual([])

    const prospect = await full(s)
    s.store.setOrganizationStatus(s.seeded.organizationId, 'suspended')
    await expect(processErase(s.deps, s.job(prospect.id))).rejects.toThrow()
    s.store.setOrganizationStatus(s.seeded.organizationId, 'deleted')
    await processErase(s.deps, s.job(prospect.id))
    s.store.setOrganizationStatus(s.seeded.organizationId, 'active')
    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(200)
  })

  test('logs no field value, address or note', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)
    await s.drain()

    const logs = s.deps.logLines.join('\n').toLowerCase()
    for (const secret of ['pat', 'doe', 'example.test', '4155550100', 'renewal']) {
      expect(logs).not.toContain(secret)
    }
  })

  test('the worker takes the job off the queue and does not drop it', async () => {
    const s = await setup()
    const prospect = await full(s)
    await s.call(s.owner, 'DELETE', `/prospects/${prospect.id}`)

    expect(await s.drain()).toBe(1)
    expect(await s.drain()).toBe(0)
    expect((await s.call(s.owner, 'GET', `/prospects/${prospect.id}`)).status).toBe(404)
  })
})

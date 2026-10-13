import { describe, expect, test } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm'
import type { Database } from 'tula-closeline-db'
import { describeError } from '~/describe-error'
import { hashToken } from '~/modules/invitation/token'
import { InvitationAlreadyPendingError, TeamNameTakenError } from '~/ports/core-store'
import { createTestApp, newOrganizationId, newUserId, seedOrganization } from '~/testing'
import { createPostgresCoreStore } from './core-store'

const TOKEN = 'k'.repeat(43)
const HASH = hashToken(TOKEN)
const EMAIL = 'private.person@example.com'

/** The failure drizzle raises: its message carries the query text and every bound parameter. */
function driverFailure(code = '57P01'): DrizzleQueryError {
  return new DrizzleQueryError(
    'select organization_id, invitation_id from core.invitation_for_token($1)',
    [HASH, EMAIL],
    Object.assign(new Error(`terminating connection for ${EMAIL}`), { code })
  )
}

/** A database whose every query and transaction fails the way a dropped connection does. */
function failingDatabase(failure: () => Error = () => driverFailure()): Database {
  return {
    execute: async () => {
      throw failure()
    },
    transaction: async () => {
      throw failure()
    },
  } as unknown as Database
}

/** What an operator could read of a failure: every field of its description and its message. */
function visibleOf(error: unknown): string {
  return JSON.stringify([describeError(error), error instanceof Error ? error.message : ''])
}

describe('a driver failure names neither the query nor its parameters', () => {
  test('the token lookup throws a plain error: no cause, no query text, no hash, no address', async () => {
    const store = createPostgresCoreStore(failingDatabase())

    const error = await store.invitationForToken(HASH).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).cause).toBeUndefined()
    expect(visibleOf(error)).not.toContain(HASH)
    expect(visibleOf(error)).not.toContain(EMAIL)
    expect(visibleOf(error)).not.toContain('invitation_for_token')
    expect(Object.keys(error as object)).not.toContain('params')
    expect(Object.keys(error as object)).not.toContain('query')
  })

  test('so do the directory lookup of a user and a transaction (which binds hashes and addresses)', async () => {
    const store = createPostgresCoreStore(failingDatabase())

    const lookup = await store.organizationOfUser(newUserId()).catch((caught: unknown) => caught)
    const transaction = await store
      .withOrganization(newOrganizationId(), async (scope) => scope.getInvitationByTokenHash(HASH))
      .catch((caught: unknown) => caught)

    for (const error of [lookup, transaction]) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).cause).toBeUndefined()
      expect(visibleOf(error)).not.toContain(HASH)
      expect(visibleOf(error)).not.toContain(EMAIL)
    }
  })

  test('the SQLSTATE stays, so an operator can tell a dropped connection from a bad statement', async () => {
    const store = createPostgresCoreStore(failingDatabase(() => driverFailure('57P01')))

    const error = await store.invitationForToken(HASH).catch((caught: unknown) => caught)

    expect((error as { code?: string }).code).toBe('57P01')
  })

  test('a failure that is not a query failure passes unchanged', async () => {
    const own = new Error('the service function threw')
    const store = createPostgresCoreStore(failingDatabase(() => own))

    const error = await store.invitationForToken(HASH).catch((caught: unknown) => caught)

    expect(error).toBe(own)
  })

  test('through the accept route: nothing the log or the report holds names the hash or the address', async () => {
    const store = createPostgresCoreStore(failingDatabase())
    const harness = await createTestApp({ store })

    const response = await harness.app.request('/internal/invitations/accept', {
      method: 'POST',
      headers: harness.internal(),
      body: JSON.stringify({ userId: newUserId(), email: EMAIL, invitationToken: TOKEN }),
    })

    expect(response.status).toBe(500)
    expect(harness.deps.reported).toHaveLength(1)
    const everything = [
      harness.deps.logLines.join('\n'),
      ...harness.deps.reported.map((entry) => visibleOf(entry.error)),
      await response.text(),
    ].join('\n')
    expect(everything).not.toContain(HASH)
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(EMAIL)
    expect(everything).not.toContain('invitation_for_token')
  })

  test('through create Invitation: nothing the log or the report holds names the address', async () => {
    const memory = await createTestApp()
    const seeded = await seedOrganization(memory.deps.store)
    const store = createPostgresCoreStore(failingDatabase())
    const harness = await createTestApp({ store })

    const response = await harness.app.request('/v1/invitations', {
      method: 'POST',
      headers: {
        ...(await harness.bearer({ ...seeded.owner, organizationId: seeded.organizationId })),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: EMAIL, role: 'rep' }),
    })

    expect(response.status).toBe(500)
    const everything = [
      harness.deps.logLines.join('\n'),
      ...harness.deps.reported.map((entry) => visibleOf(entry.error)),
    ].join('\n')
    expect(everything).not.toContain(EMAIL)
    expect(everything).not.toContain(HASH)
  })
})

/** The failure drizzle raises for a statement the server refused: the Postgres error is its `cause`. */
function refused(code: string, constraint?: string): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into core.invitations (email, token_hash) values ($1, $2)',
    [EMAIL, HASH],
    Object.assign(new Error(`refused for ${EMAIL}`), {
      code,
      ...(constraint === undefined ? {} : { constraint }),
    })
  )
}

/** A database whose transactions run `fn` against a tx that answers every statement with no rows. */
function workingDatabase(): Database {
  const tx = { execute: async () => ({ rows: [] }) }
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Database
}

const NO_WAIT = { sleep: async () => undefined, random: () => 0 }

describe('a constraint violation reaches the service as its own error, through the wrapper', () => {
  test.each([
    ['invitations_pending_email_key', InvitationAlreadyPendingError],
    ['teams_organization_name_key', TeamNameTakenError],
  ])(
    '23505 on %s is %p, with no query text or parameter left on it',
    async (constraint, expected) => {
      const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)

      const error = await store
        .withOrganization(newOrganizationId(), async () => {
          throw refused('23505', constraint)
        })
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(expected)
      expect((error as Error).cause).toBeUndefined()
      expect(visibleOf(error)).not.toContain(EMAIL)
      expect(visibleOf(error)).not.toContain(HASH)
    }
  )

  test('23505 on a constraint the store does not know stays a plain error that keeps only the SQLSTATE', async () => {
    const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)

    const error = await store
      .withOrganization(newOrganizationId(), async () => {
        throw refused('23505', 'some_other_key')
      })
      .catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(InvitationAlreadyPendingError)
    expect(error).not.toBeInstanceOf(TeamNameTakenError)
    expect((error as { code?: string }).code).toBe('23505')
    expect(visibleOf(error)).not.toContain(EMAIL)
  })
})

describe('a serialization failure inside the wrapper is retried', () => {
  test('40001 once: the transaction runs again and its result is returned', async () => {
    const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)
    let runs = 0

    const result = await store.withOrganization(newOrganizationId(), async () => {
      runs += 1
      if (runs === 1) {
        throw refused('40001')
      }
      return 'done'
    })

    expect([result, runs]).toEqual(['done', 2])
  })

  test('a deadlock is retried the same way', async () => {
    const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)
    let runs = 0

    const result = await store.withOrganization(newOrganizationId(), async () => {
      runs += 1
      if (runs === 1) {
        throw refused('40P01')
      }
      return 'done'
    })

    expect([result, runs]).toEqual(['done', 2])
  })

  test('40001 every time: three runs, then the failure leaves with its SQLSTATE and nothing else', async () => {
    const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)
    let runs = 0

    const error = await store
      .withOrganization(newOrganizationId(), async () => {
        runs += 1
        throw refused('40001')
      })
      .catch((caught: unknown) => caught)

    expect(runs).toBe(3)
    expect((error as { code?: string }).code).toBe('40001')
    expect((error as Error).cause).toBeUndefined()
    expect(visibleOf(error)).not.toContain(EMAIL)
  })

  test('a constraint violation is not retried', async () => {
    const store = createPostgresCoreStore(workingDatabase(), NO_WAIT)
    let runs = 0

    await store
      .withOrganization(newOrganizationId(), async () => {
        runs += 1
        throw refused('23505', 'teams_organization_name_key')
      })
      .catch(() => undefined)

    expect(runs).toBe(1)
  })
})

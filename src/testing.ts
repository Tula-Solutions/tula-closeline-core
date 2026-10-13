import type { OpenAPIHono } from '@hono/zod-openapi'
import {
  formatId,
  type MembershipId,
  type OrganizationId,
  type Role,
  type UserId,
} from 'tula-closeline-contract'
import {
  createFixedClock,
  createLogger,
  createStaticKeySet,
  createTokenVerifier,
  type FixedClock,
  TokenVerificationError,
  type TokenVerifier,
} from 'tula-closeline-kit'
import { createTestJwks, createTestKeyPair, mintTestToken } from 'tula-closeline-kit/testing'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import {
  createMemoryInvitationMailer,
  type MemoryInvitationMailer,
} from '~/adapters/memory/invitation-mailer'
import { createApp } from '~/app'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import type { AppEnv } from '~/http/types'
import { SERVICE } from '~/info'
import type { CoreStore, OrganizationScope } from '~/ports/core-store'
import type { InvitationMailer } from '~/ports/invitation-mailer'

/** The internal secret the test environment accepts, and the one a second secret rotates in. */
export const TEST_INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef-A'

/** A second accepted secret, so a test can show that rotation works. */
export const TEST_INTERNAL_SECRET_NEXT = 'test-internal-secret-0123456789abcdef-B'

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
  /** The in-memory invitation mailer, whatever `invitationMailer` was overridden with. */
  mail: MemoryInvitationMailer
}

/** What a test may replace in {@link createTestDeps}. */
export type TestDepsOverrides = {
  readinessChecks?: readonly ReadinessCheck[]
  env?: Record<string, string>
  /** The store; defaults to a fresh in-memory one. */
  store?: CoreStore
  /** The invitation mailer; defaults to the in-memory one, which is `mail` on the deps. */
  invitationMailer?: InvitationMailer
  /** Where the app's fixed clock starts; defaults to 2026-01-01. Set it near now for a real database, which judges expiry by its own clock. */
  clockStart?: string
  /** The access-token verifier; defaults to one that rejects every token. */
  tokenVerifier?: TokenVerifier
}

const REJECTING_VERIFIER: TokenVerifier = {
  verify: async () => {
    throw new TokenVerificationError('invalid')
  },
}

/** Builds a container of in-memory doubles and a fixed clock; `overrides` replace any field. */
export function createTestDeps(overrides: TestDepsOverrides = {}): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []
  const mail = createMemoryInvitationMailer()
  // A memory store judges expiry by the deps' clock, which `createTestApp` replaces later, so it
  // reads the clock through the object and not through a copy.
  const holder: { deps?: TestDeps } = {}
  const store = overrides.store ?? createMemoryCoreStore()
  if ('useClock' in store && typeof store.useClock === 'function') {
    store.useClock(() => holder.deps?.clock.now() ?? new Date())
  }

  const deps: TestDeps = {
    env: loadEnv({
      ENVIRONMENT: 'local',
      LOG_LEVEL: 'debug',
      // Every key that is required outside local, so a test may set any ENVIRONMENT.
      REGION: 'us',
      DATABASE_URL: 'postgres://closeline_core:closeline_core_local@127.0.0.1:5432/closeline',
      AUTH_JWKS_URL: 'https://auth.test/.well-known/jwks.json',
      AUTH_ISSUER: 'https://auth.test',
      AUTH_AUDIENCE: 'closeline',
      INTERNAL_API_TOKENS: TEST_INTERNAL_SECRET,
      PORTAL_BASE_URL: 'https://app.test',
      ...overrides.env,
    }),
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    store,
    invitationMailer: overrides.invitationMailer ?? mail,
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    close: async () => undefined,
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
    mail,
  }
  holder.deps = deps
  return deps
}

/** Who a minted access token names. */
export type TestIdentity = { userId: UserId; organizationId: OrganizationId; role: Role }

/** A fresh user id, for a test that needs one nobody else has. */
export function newUserId(): UserId {
  return formatId('usr', crypto.randomUUID())
}

/** A fresh Organization id. */
export function newOrganizationId(): OrganizationId {
  return formatId('org', crypto.randomUUID())
}

/** A fresh Membership id. */
export function newMembershipId(): MembershipId {
  return formatId('mem', crypto.randomUUID())
}

/** The app, its container, and what a test needs to call it as someone. */
export type TestApp = {
  app: OpenAPIHono<AppEnv>
  deps: TestDeps
  /** The `Authorization` header of a valid access token for `identity`. */
  bearer(identity: TestIdentity): Promise<{ authorization: string }>
  /** The headers of a valid internal call; a different `key` makes a different request. */
  internal(
    key?: string,
    secret?: string
  ): { authorization: string; 'idempotency-key': string; 'content-type': string }
}

/**
 * The whole app over a fresh container, with a verifier that accepts the tokens `bearer` signs
 * (a real Ed25519 key pair, verified the way production verifies) and nothing else.
 */
export async function createTestApp(overrides: TestDepsOverrides = {}): Promise<TestApp> {
  const keyPair = await createTestKeyPair()
  const clock = createFixedClock(overrides.clockStart ?? '2026-01-01T00:00:00Z')
  const verifier = createTokenVerifier({
    issuer: 'https://auth.test',
    audience: 'closeline',
    keys: await createStaticKeySet(createTestJwks(keyPair)),
    clock,
  })
  const deps = createTestDeps({ tokenVerifier: verifier, ...overrides })
  // Tokens are minted and verified at the same instant, whatever the test advances the clock to.
  deps.clock = clock

  return {
    app: createApp(deps),
    deps,
    bearer: async (identity) => ({
      authorization: `Bearer ${await mintTestToken({
        keyPair,
        clock,
        claims: { sub: identity.userId, org: identity.organizationId, role: identity.role },
      })}`,
    }),
    internal: (key = crypto.randomUUID(), secret = TEST_INTERNAL_SECRET) => ({
      authorization: `Bearer ${secret}`,
      'idempotency-key': key,
      'content-type': 'application/json',
    }),
  }
}

/** A person's address and name as a test gives them to a Membership that does not care which. */
export const TEST_PROFILE = { email: 'member@example.test', name: null } as const

/** One member of a seeded Organization. */
export type SeededMember = {
  id: MembershipId
  userId: UserId
  email: string
  name: string | null
  role: Role
}

/** An Organization made by {@link seedOrganization}. */
export type SeededOrganization = {
  organizationId: OrganizationId
  /** The Owner, always first. */
  owner: SeededMember
  /** Every member, the Owner first, then one per extra role in the order given. */
  members: SeededMember[]
}

/**
 * Creates an Organization in the store with an Owner and one more member per role in `extra`,
 * through the store's own port, so it works against any adapter.
 */
export async function seedOrganization(
  store: CoreStore,
  extra: readonly Role[] = [],
  name = 'Acme'
): Promise<SeededOrganization> {
  const organizationId = newOrganizationId()
  const now = new Date('2026-01-01T00:00:00Z')
  const members: SeededMember[] = ['owner' as Role, ...extra].map((role) => ({
    id: newMembershipId(),
    userId: newUserId(),
    email: `${crypto.randomUUID()}@example.test`,
    name: role === 'owner' ? 'Olive Owner' : null,
    role,
  }))
  await store.withOrganization(organizationId, async (scope) => {
    await scope.insertOrganization({ name, region: 'us', now })
    for (const member of members) {
      await scope.insertMembership({ ...member, now })
    }
  })
  const owner = members[0]
  if (!owner) {
    throw new Error('seedOrganization made no Owner')
  }
  return { organizationId, owner, members }
}

/** A store that forwards to another and notes each scope method a transaction calls. */
export type RecordingStore = {
  store: CoreStore
  /** The scope methods called so far, in order. */
  calls: (keyof OrganizationScope)[]
  /** The store methods called so far, in order: the two directory lookups and each transaction. */
  storeCalls: (keyof CoreStore)[]
  /** How many transactions were opened. */
  transactions: () => number
  /** The arguments of each call to one scope method so far, in order. */
  argsOf: (name: keyof OrganizationScope) => unknown[][]
}

/** What {@link recordStore} may change about the store it wraps. */
export type RecordStoreOverrides = Partial<Pick<CoreStore, 'organizationOfUser'>> & {
  /**
   * Runs once the token lookup has answered and before its answer is returned, so a test can change
   * state in the window between the lookup and the transaction that follows it (an Invitation
   * revoked, an Organization suspended, the clock moved past an expiry).
   */
  afterInvitationLookup?: () => void | Promise<void>
}

/**
 * Wraps `inner` so a test can see which store and scope methods ran, in order, and how many
 * transactions opened. Behaviour is unchanged. `override` may replace the user lookup and may add
 * a hook that runs between the token lookup and the transaction.
 */
export function recordStore(inner: CoreStore, override: RecordStoreOverrides = {}): RecordingStore {
  const calls: (keyof OrganizationScope)[] = []
  const storeCalls: (keyof CoreStore)[] = []
  const argsByName = new Map<keyof OrganizationScope, unknown[][]>()
  let transactions = 0
  const store: CoreStore = {
    organizationOfUser: (userId) => {
      storeCalls.push('organizationOfUser')
      return (override.organizationOfUser ?? ((id) => inner.organizationOfUser(id)))(userId)
    },
    invitationForToken: async (tokenHash) => {
      storeCalls.push('invitationForToken')
      const found = await inner.invitationForToken(tokenHash)
      await override.afterInvitationLookup?.()
      return found
    },
    withOrganization: (organizationId, fn) => {
      storeCalls.push('withOrganization')
      transactions += 1
      return inner.withOrganization(organizationId, (scope) => {
        const recorded = Object.fromEntries(
          (Object.keys(scope) as (keyof OrganizationScope)[]).map((name) => [
            name,
            (...args: never[]) => {
              calls.push(name)
              argsByName.set(name, [...(argsByName.get(name) ?? []), args])
              return (scope[name] as (...a: never[]) => unknown)(...args)
            },
          ])
        ) as unknown as OrganizationScope
        return fn(recorded)
      })
    },
  }
  return {
    store,
    calls,
    storeCalls,
    transactions: () => transactions,
    argsOf: (name) => argsByName.get(name) ?? [],
  }
}

/** The JSON a route answered with; `error` is set on a failure. */
export type ApiBody = Record<string, unknown> & { error?: { code: string; message: string } }

/** What a call to a route came back with. */
export type ApiResponse = { status: number; body: ApiBody; retryAfter: string | null }

/**
 * Returns a function that calls a public (`/v1`) route as `actor`, who holds `actor.role` in
 * their token, in the Organization `organizationId` names.
 */
export function publicCaller(harness: Pick<TestApp, 'app' | 'bearer'>) {
  return async (
    actor: { userId: UserId; role: Role },
    organizationId: OrganizationId,
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse> => {
    const token = await harness.bearer({ userId: actor.userId, organizationId, role: actor.role })
    const response = await harness.app.request(`/v1${path}`, {
      method,
      headers: { ...token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : {}) as ApiBody,
      retryAfter: response.headers.get('retry-after'),
    }
  }
}

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
import { createApp } from '~/app'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import type { AppEnv } from '~/http/types'
import { SERVICE } from '~/info'
import type { CoreStore } from '~/ports/core-store'

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
}

/** What a test may replace in {@link createTestDeps}. */
export type TestDepsOverrides = {
  readinessChecks?: readonly ReadinessCheck[]
  env?: Record<string, string>
  /** The store; defaults to a fresh in-memory one. */
  store?: CoreStore
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

  return {
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
      ...overrides.env,
    }),
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    store: overrides.store ?? createMemoryCoreStore(),
    tokenVerifier: overrides.tokenVerifier ?? REJECTING_VERIFIER,
    close: async () => undefined,
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
  }
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
  const clock = createFixedClock('2026-01-01T00:00:00Z')
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

/** One member of a seeded Organization. */
export type SeededMember = { id: MembershipId; userId: UserId; role: Role }

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

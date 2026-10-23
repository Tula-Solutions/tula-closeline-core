import { sql } from 'drizzle-orm'
import type { RequestId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import {
  type Clock,
  createLogger,
  createRemoteKeySet,
  createTokenVerifier,
  type LogDestination,
  type Logger,
  type Queue,
  systemClock,
  type TokenVerifier,
} from 'tula-closeline-kit'
import { createSqsQueue } from 'tula-closeline-kit/queue'
import { createMemoryQueue } from 'tula-closeline-kit/testing'
import {
  attemptTimeoutFor,
  createMailpitInvitationMailer,
  DEFAULT_LOCAL_MAIL_FROM,
} from '~/adapters/mailpit/invitation-mailer'
import { createMailpitTeamNoticeMailer } from '~/adapters/mailpit/team-notice-mailer'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { createPostgresDemoRateLimiter } from '~/adapters/postgres/demo-rate-limiter'
import { createPostgresDemoRequestStore } from '~/adapters/postgres/demo-request-store'
import { createUnconfiguredInvitationMailer } from '~/adapters/unconfigured/invitation-mailer'
import { createUnconfiguredTeamNoticeMailer } from '~/adapters/unconfigured/team-notice-mailer'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import { type CoreEnvelope, registry } from '~/messages'
import type { CoreStore } from '~/ports/core-store'
import type { DemoRateLimiter } from '~/ports/demo-rate-limiter'
import type { DemoRequestStore } from '~/ports/demo-request-store'
import type { InvitationMailer } from '~/ports/invitation-mailer'
import type { TeamNoticeMailer } from '~/ports/team-notice-mailer'

/** One dependency probe for `/readyz`: resolve when healthy, reject or stall when not. */
export type ReadinessCheck = {
  /** A short stable name, reported to the caller, never an address or credential. */
  name: string
  /** Probes the dependency; `signal` aborts when the check has run out of time. */
  run: (signal: AbortSignal) => Promise<void>
}

/** What `reportError` is told about the request that failed. */
export type ErrorContext = {
  requestId: RequestId
  method: string
  /** The path only, never the query string, which can carry secrets. */
  path: string
  /** The HTTP status of the response sent to the client, which can differ from the error's own. */
  status: number
}

/** Everything a request needs from outside the process, built once in {@link createContainer}. */
export type Container = {
  env: Env
  logger: Logger
  clock: Clock
  /** Organizations and Memberships; the only way any module reaches the database. */
  store: CoreStore
  /**
   * Hands invitation emails to the mail system. Called after the Invitation commits; when it fails
   * the Invitation is revoked. This becomes an outbox row and a queue job when the queue port
   * exists.
   */
  invitationMailer: InvitationMailer
  /** Demo Requests from the marketing site and their team-notice outbox. */
  demoRequests: DemoRequestStore
  /** Counts public Demo Request submissions per hashed client address. */
  demoRateLimiter: DemoRateLimiter
  /** Mails the team a notice for each Demo Request; called by the outbox worker. */
  teamNoticeMailer: TeamNoticeMailer
  /**
   * Core's domain events (`prospect.created`, `prospect.updated`). Published after the change
   * commits; delivery is at least once. There is no outbox yet, so a publish that fails is logged
   * and the change stands.
   */
  events: Queue<CoreEnvelope>
  /** Verifies the access tokens of the public routes against the auth service's published keys. */
  tokenVerifier: TokenVerifier
  /** Releases the database connections; safe to call more than once. */
  close: () => Promise<void>
  /** Probes run by `/readyz`: the database. */
  readinessChecks: readonly ReadinessCheck[]
  /**
   * The one place unexpected errors go. It logs through the kit logger today; the error tracker is
   * wired in here and nowhere else. It must not throw and must not return anything to a client.
   */
  reportError: (error: unknown, context: ErrorContext) => void
  /**
   * Set once shutdown begins: `/readyz` answers 503 from then on, before the server stops.
   * `drainingSince` is when the first signal arrived (epoch ms from `clock`), for shutdown only.
   */
  lifecycle: { draining: boolean; drainingSince?: number }
}

/**
 * Calls `reportError` so that it can neither throw nor leave a rejected promise behind, even if
 * an implementation wrongly went async.
 */
export function reportSafely(container: Container, error: unknown, context: ErrorContext): void {
  try {
    const result: unknown = container.reportError(error, context)
    if (result instanceof Promise) {
      result.catch(() => {})
    }
  } catch {
    // A failing reporter must never turn a handled error into a dropped response.
  }
}

/** Options for {@link createContainer}. */
export type ContainerOptions = {
  /** Where log lines go; defaults to stdout. */
  logDestination?: LogDestination
}

/**
 * Chooses the Invitation mailer: the local mailbox adapter when `MAIL_LOCAL_URL` is set, otherwise
 * the unconfigured one, which fails every delivery. The local adapter is built only when
 * `ENVIRONMENT` is `local`: with the URL set anywhere else this throws, as {@link loadEnv} does,
 * instead of trusting that it ran or falling back. Each attempt's bound is derived from
 * `INVITATION_DELIVERY_TIMEOUT_MS`, so all attempts and pauses fit inside the route's own bound.
 * The production provider is still undecided (hub issue #35).
 */
export function createInvitationMailer(env: Env, logger: Pick<Logger, 'warn'>): InvitationMailer {
  if (env.MAIL_LOCAL_URL === undefined) {
    return createUnconfiguredInvitationMailer()
  }
  if (env.ENVIRONMENT !== 'local') {
    throw new Error('MAIL_LOCAL_URL is accepted only when ENVIRONMENT is local')
  }
  return createMailpitInvitationMailer({
    baseUrl: env.MAIL_LOCAL_URL,
    from: env.MAIL_LOCAL_FROM ?? DEFAULT_LOCAL_MAIL_FROM,
    logger,
    timeoutMs: attemptTimeoutFor(env.INVITATION_DELIVERY_TIMEOUT_MS),
  })
}

/**
 * Chooses the team-notice mailer on the same rules as {@link createInvitationMailer}: Mailpit when
 * `MAIL_LOCAL_URL` is set (local only), otherwise the unconfigured one, which fails every
 * delivery so the notice stays pending.
 */
export function createTeamNoticeMailer(env: Env, logger: Pick<Logger, 'warn'>): TeamNoticeMailer {
  if (env.MAIL_LOCAL_URL === undefined) {
    return createUnconfiguredTeamNoticeMailer()
  }
  if (env.ENVIRONMENT !== 'local') {
    throw new Error('MAIL_LOCAL_URL is accepted only when ENVIRONMENT is local')
  }
  return createMailpitTeamNoticeMailer({
    baseUrl: env.MAIL_LOCAL_URL,
    from: env.MAIL_LOCAL_FROM ?? DEFAULT_LOCAL_MAIL_FROM,
    logger,
    timeoutMs: attemptTimeoutFor(env.INVITATION_DELIVERY_TIMEOUT_MS),
  })
}

/** The SQS queue when `QUEUE_URL` is set, otherwise the kit's memory queue (local only). */
function createEvents(env: Env): Queue<CoreEnvelope> {
  if (env.QUEUE_URL === undefined) {
    return createMemoryQueue({ registry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** The single composition root: the only place adapters and process-wide objects are constructed. */
export function createContainer(env: Env = loadEnv(), options: ContainerOptions = {}): Container {
  const logger = createLogger({
    service: SERVICE,
    level: env.LOG_LEVEL,
    ...(options.logDestination ? { destination: options.logDestination } : {}),
  })

  const database = createDb(env.DATABASE_URL)
  const keys = createRemoteKeySet({
    url: env.AUTH_JWKS_URL,
    allowInsecureLocalhost: env.ENVIRONMENT === 'local',
    clock: systemClock,
    logger,
  })

  return {
    env,
    logger,
    clock: systemClock,
    store: createPostgresCoreStore(database.db),
    // No production provider is chosen yet (hub issue #35): without MAIL_LOCAL_URL delivery fails,
    // and so does creating an Invitation.
    invitationMailer: createInvitationMailer(env, logger),
    demoRequests: createPostgresDemoRequestStore(database.db),
    demoRateLimiter: createPostgresDemoRateLimiter(database.db),
    teamNoticeMailer: createTeamNoticeMailer(env, logger),
    events: createEvents(env),
    tokenVerifier: createTokenVerifier({
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      keys,
      clock: systemClock,
    }),
    close: database.close,
    readinessChecks: [
      {
        name: 'database',
        run: async () => {
          await database.db.execute(sql`select 1`)
        },
      },
    ],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      logger.error('unhandled error', { ...context, error: describeError(error) })
    },
  }
}

import { KMSClient } from '@aws-sdk/client-kms'
import { sql } from 'drizzle-orm'
import { MAX_PROSPECT_IMPORT_BYTES, type RequestId } from 'tula-closeline-contract'
import { createDb } from 'tula-closeline-db'
import {
  type CalendarPort,
  type Clock,
  createGoogleCalendar,
  createLogger,
  createRemoteKeySet,
  createTokenVerifier,
  type LogDestination,
  type Logger,
  type ObjectStore,
  type Queue,
  systemClock,
  type TokenVerifier,
} from 'tula-closeline-kit'
import { createSqsQueue } from 'tula-closeline-kit/queue'
import { createS3ObjectStore } from 'tula-closeline-kit/storage'
import {
  createMemoryCalendar,
  createMemoryObjectStore,
  createMemoryQueue,
} from 'tula-closeline-kit/testing'
import { createVoiceTurnReader } from '~/adapters/http/voice-turn-reader'
import { createHubspotCrmProvider } from '~/adapters/hubspot/crm-provider'
import { createSdkKmsClient, type KmsClient } from '~/adapters/kms/kms-client'
import { createKmsSecretBox } from '~/adapters/kms/secret-box'
import { createLoggingRepNotifier } from '~/adapters/logging/rep-notifier'
import {
  attemptTimeoutFor,
  createMailpitInvitationMailer,
  DEFAULT_LOCAL_MAIL_FROM,
} from '~/adapters/mailpit/invitation-mailer'
import { createMailpitRepNotifier } from '~/adapters/mailpit/rep-notifier'
import { createMailpitTeamNoticeMailer } from '~/adapters/mailpit/team-notice-mailer'
import { createMemoryConversationSummarizer } from '~/adapters/memory/conversation-summarizer'
import { createMemoryJudge } from '~/adapters/memory/judge'
import { createMemoryMomentSearch } from '~/adapters/memory/moment-search'
import { createMemoryPlaybookDeals } from '~/adapters/memory/playbook-deals'
import { createMemoryReplyClassifier } from '~/adapters/memory/reply-classifier'
import { createMemoryReplyWriter } from '~/adapters/memory/reply-writer'
import { createMemorySecretBox } from '~/adapters/memory/secret-box'
import { createMemoryTurnReader } from '~/adapters/memory/turn-reader'
import { createPostgresCoreStore } from '~/adapters/postgres/core-store'
import { createPostgresDemoRateLimiter } from '~/adapters/postgres/demo-rate-limiter'
import { createPostgresDemoRequestStore } from '~/adapters/postgres/demo-request-store'
import { createPostgresOutboxStore } from '~/adapters/postgres/outbox-store'
import { createUnconfiguredConversationSummarizer } from '~/adapters/unconfigured/conversation-summarizer'
import { createUnconfiguredInvitationMailer } from '~/adapters/unconfigured/invitation-mailer'
import { createUnconfiguredJudge } from '~/adapters/unconfigured/judge'
import { createUnconfiguredMomentSearch } from '~/adapters/unconfigured/moment-search'
import { createUnconfiguredPlaybookDeals } from '~/adapters/unconfigured/playbook-deals'
import { createUnconfiguredReplyClassifier } from '~/adapters/unconfigured/reply-classifier'
import { createUnconfiguredReplyWriter } from '~/adapters/unconfigured/reply-writer'
import { createUnconfiguredSecretBox } from '~/adapters/unconfigured/secret-box'
import { createUnconfiguredTeamNoticeMailer } from '~/adapters/unconfigured/team-notice-mailer'
import { createUnconfiguredTurnReader } from '~/adapters/unconfigured/turn-reader'
import { describeError } from '~/describe-error'
import { type Env, loadEnv } from '~/env'
import { SERVICE } from '~/info'
import {
  type AuditEnvelope,
  auditRegistry,
  type CoreEnvelope,
  type JobEnvelope,
  jobRegistry,
  registry,
} from '~/messages'
import type { ConversationSummarizer } from '~/ports/conversation-summarizer'
import type { CoreStore } from '~/ports/core-store'
import type { CrmProviders } from '~/ports/crm-provider'
import type { DemoRateLimiter } from '~/ports/demo-rate-limiter'
import type { DemoRequestStore } from '~/ports/demo-request-store'
import type { InvitationMailer } from '~/ports/invitation-mailer'
import type { Judge } from '~/ports/judge'
import type { MomentSearch } from '~/ports/moment-search'
import type { OutboxStore } from '~/ports/outbox'
import type { PlaybookDeals } from '~/ports/playbook-deals'
import type { RepNotifier } from '~/ports/rep-notifier'
import type { ReplyClassifier } from '~/ports/reply-classifier'
import type { ReplyWriter } from '~/ports/reply-writer'
import type { SecretBox } from '~/ports/secret-box'
import type { TeamNoticeMailer } from '~/ports/team-notice-mailer'
import type { TurnReader } from '~/ports/turn-reader'

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
   * Core's domain events (`prospect.created`, `prospect.updated`). Services write them to the
   * outbox in the transaction that decides them; the drain ({@link OutboxStore}) publishes them
   * here after the commit, so delivery is at least once and a message's id is its outbox row id.
   */
  events: Queue<CoreEnvelope>
  /** The drain's side of the transactional outbox, across every Organization. */
  outbox: OutboxStore
  /**
   * Core's own background jobs (`prospect.assign_chunk`). Core publishes and consumes this queue
   * itself, which is why it is not the events queue: a consumer of that one would take events meant
   * for other services.
   */
  jobs: Queue<JobEnvelope>
  /**
   * The audit queue: every other service publishes `audit.recorded` here (through the kit's audit
   * recorder) and core consumes it into the audit log. Its own queue, so core's consumer takes
   * nothing but audit events and a service publishes to it without core's other messages.
   */
  audit: Queue<AuditEnvelope>
  /** Uploaded Prospect import files: S3 when `STORAGE_BUCKET` is set, otherwise in memory (local and tests only). */
  objects: ObjectStore
  /**
   * Seals CRM tokens before they are stored. Local uses a memory box whose key lives only in this
   * process; elsewhere it is the unconfigured one, which refuses, until infra's AWS KMS adapter
   * is wired in here.
   */
  secretBox: SecretBox
  /**
   * Labels inbound replies. Local uses a keyword stand-in; elsewhere it is the unconfigured one,
   * which refuses (the job is retried) until the model adapter is wired in here.
   */
  classifier: ReplyClassifier
  /**
   * Tells a Rep a Prospect replied in a Conversation they took over. Ids and a fixed sentence
   * only. It logs the notice until the Rep's email goes out through the mail port.
   */
  repNotifier: RepNotifier
  /**
   * Writes the body of a Draft for an objection or a question. Local uses a deterministic
   * stand-in; elsewhere it is the unconfigured one, which refuses, so the Conversation is
   * escalated until the model adapter is wired in here.
   */
  writer: ReplyWriter
  /**
   * Summarizes a Conversation and picks its Outcome label. Local uses a deterministic stand-in;
   * elsewhere it is the unconfigured one, which refuses, so no summary is stored until the model
   * adapter is wired in here.
   */
  summarizer: ConversationSummarizer
  /**
   * Assesses a Draft against its Sources before it can release. Local uses a deterministic
   * fixture; elsewhere it is the unconfigured one, which refuses, so every Draft is held until the
   * model adapter is wired in here.
   */
  judge: Judge
  /** Reads the text of a Call turn for its Assessment. */
  turnReader: TurnReader
  /**
   * Searches the Organization's Playbook for moments of won Deals. Local uses planted moments;
   * elsewhere it is the unconfigured one, which refuses (the Conversation is escalated) until a
   * Playbook client that core can authenticate with is wired in here.
   */
  moments: MomentSearch
  /** The calendar vendor a Rep connects, or `null` when none is configured (the routes then answer 503). */
  calendar: CalendarSetup | null
  /** The CRMs this deployment can connect, by name. None is configured yet: the HubSpot adapter arrives with the sync work. */
  crmProviders: CrmProviders
  /** Where Deals and Outcomes pulled from a CRM go to be learned from. */
  playbookDeals: PlaybookDeals
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
 * The Transcript source: `read` (the turn check) stays on the memory reader locally and the
 * unconfigured one elsewhere, since voice's route has no cited-source text; `window` goes to
 * voice when `VOICE_INTERNAL_URL` is set, else to the same fallback.
 */
export function createTurnReader(env: Env): TurnReader {
  const fallback =
    env.ENVIRONMENT === 'local' ? createMemoryTurnReader() : createUnconfiguredTurnReader()
  if (env.VOICE_INTERNAL_URL === undefined || env.VOICE_INTERNAL_TOKEN === undefined) {
    return fallback
  }
  const voice = createVoiceTurnReader({
    baseUrl: env.VOICE_INTERNAL_URL,
    token: env.VOICE_INTERNAL_TOKEN,
  })
  return { read: fallback.read, window: voice.window }
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

/**
 * Chooses the Rep notifier: escalation emails go to the local mailbox when `MAIL_LOCAL_URL` is set
 * (local only, as for the other mailers); everything else is logged by id.
 */
export function createRepNotifier(env: Env, logger: Logger): RepNotifier {
  const logging = createLoggingRepNotifier(logger)
  if (env.MAIL_LOCAL_URL === undefined) {
    // No real mail provider exists yet (hub #35): outside local an escalation email must fail
    // visibly (the job logs it) rather than look delivered.
    return env.ENVIRONMENT === 'local'
      ? logging
      : {
          notify: async (notice, signal) => {
            if (notice.kind === 'conversation_escalated') {
              throw new Error('no mail provider is configured for escalation notices')
            }
            return logging.notify(notice, signal)
          },
        }
  }
  if (env.ENVIRONMENT !== 'local') {
    throw new Error('MAIL_LOCAL_URL is accepted only when ENVIRONMENT is local')
  }
  return createMailpitRepNotifier({
    baseUrl: env.MAIL_LOCAL_URL,
    from: env.MAIL_LOCAL_FROM ?? DEFAULT_LOCAL_MAIL_FROM,
    logger,
    fallback: logging,
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

/** The jobs queue: SQS when `JOBS_QUEUE_URL` is set, otherwise the kit's memory queue (local only). */
function createJobs(env: Env): Queue<JobEnvelope> {
  if (env.JOBS_QUEUE_URL === undefined) {
    return createMemoryQueue({ registry: jobRegistry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.JOBS_QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry: jobRegistry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** The audit queue: SQS when `AUDIT_QUEUE_URL` is set, otherwise the kit's memory queue (local only). */
function createAudit(env: Env): Queue<AuditEnvelope> {
  if (env.AUDIT_QUEUE_URL === undefined) {
    return createMemoryQueue({ registry: auditRegistry, clock: systemClock })
  }
  return createSqsQueue({
    queueUrl: env.AUDIT_QUEUE_URL,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    registry: auditRegistry,
    ...(env.QUEUE_ENDPOINT === undefined ? {} : { endpoint: env.QUEUE_ENDPOINT }),
  })
}

/** The S3 object store when `STORAGE_BUCKET` is set, otherwise the kit's memory store. */
function createObjects(env: Env, logger: Logger): ObjectStore {
  if (env.STORAGE_BUCKET === undefined) {
    return createMemoryObjectStore({ maxObjectBytes: MAX_PROSPECT_IMPORT_BYTES })
  }
  return createS3ObjectStore({
    bucket: env.STORAGE_BUCKET,
    region: env.AWS_REGION,
    environment: env.ENVIRONMENT,
    maxObjectBytes: MAX_PROSPECT_IMPORT_BYTES,
    logger,
    ...(env.STORAGE_ENDPOINT === undefined ? {} : { endpoint: env.STORAGE_ENDPOINT }),
  })
}

/**
 * Chooses the secret box: the AWS KMS one when `CRM_TOKEN_KMS_KEY_ARN` is set (in any environment;
 * `client` is for tests, otherwise the SDK client in the key's own Region, its retries off because
 * the box bounds and jitters its own), else the in-process one locally, else the one that refuses.
 */
export function createSecretBox(env: Env, client?: KmsClient): SecretBox {
  const arn = env.CRM_TOKEN_KMS_KEY_ARN
  if (arn !== undefined) {
    return createKmsSecretBox({
      keyArn: arn,
      client:
        client ??
        createSdkKmsClient(
          new KMSClient({ region: arn.split(':')[3] ?? env.AWS_REGION, maxAttempts: 1 })
        ),
    })
  }
  return env.ENVIRONMENT === 'local' ? createMemorySecretBox() : createUnconfiguredSecretBox()
}

/** The one connection code the local stand-in calendar accepts; paste it into the portal's local flow. */
export const LOCAL_CALENDAR_CODE = 'local-calendar-code'

/** A calendar vendor with the OAuth client the consent URL names. */
export type CalendarSetup = { port: CalendarPort; clientId: string; redirectUri: string }

/** Google Calendar when its client is configured, the in-process stand-in in `local`, else none. */
export function createCalendar(env: Env): CalendarSetup | null {
  const { GOOGLE_CALENDAR_CLIENT_ID: clientId, GOOGLE_CALENDAR_CLIENT_SECRET: clientSecret } = env
  const redirectUri = env.CALENDAR_REDIRECT_URI
  if (clientId && clientSecret && redirectUri) {
    return { port: createGoogleCalendar({ clientId, clientSecret }), clientId, redirectUri }
  }
  if (env.ENVIRONMENT !== 'local') {
    return null
  }
  const port = createMemoryCalendar()
  port.allowGrant(LOCAL_CALENDAR_CODE)
  return {
    port,
    clientId: 'local-calendar-client',
    redirectUri: redirectUri ?? `${env.PORTAL_BASE_URL}/calendar/callback`,
  }
}

/** The CRM providers whose OAuth app is configured; HubSpot needs its client id and secret. */
export function createCrmProviders(env: Env): CrmProviders {
  const { HUBSPOT_CLIENT_ID: clientId, HUBSPOT_CLIENT_SECRET: clientSecret } = env
  if (!(clientId && clientSecret)) {
    return {}
  }
  return {
    hubspot: createHubspotCrmProvider({
      clientId,
      clientSecret,
      ...(env.HUBSPOT_API_URL ? { apiBaseUrl: env.HUBSPOT_API_URL } : {}),
      ...(env.HUBSPOT_AUTHORISE_URL ? { authoriseUrl: env.HUBSPOT_AUTHORISE_URL } : {}),
    }),
  }
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
    outbox: createPostgresOutboxStore(database.db),
    jobs: createJobs(env),
    audit: createAudit(env),
    objects: createObjects(env, logger),
    secretBox: createSecretBox(env),
    classifier:
      env.ENVIRONMENT === 'local'
        ? createMemoryReplyClassifier()
        : createUnconfiguredReplyClassifier(),
    repNotifier: createRepNotifier(env, logger),
    writer:
      env.ENVIRONMENT === 'local' ? createMemoryReplyWriter() : createUnconfiguredReplyWriter(),
    summarizer:
      env.ENVIRONMENT === 'local'
        ? createMemoryConversationSummarizer()
        : createUnconfiguredConversationSummarizer(),
    judge: env.ENVIRONMENT === 'local' ? createMemoryJudge() : createUnconfiguredJudge(),
    turnReader: createTurnReader(env),
    moments:
      env.ENVIRONMENT === 'local' ? createMemoryMomentSearch() : createUnconfiguredMomentSearch(),
    calendar: createCalendar(env),
    crmProviders: createCrmProviders(env),
    // The Playbook has no Deal route yet: it is the memory sink locally and refuses elsewhere.
    playbookDeals:
      env.ENVIRONMENT === 'local' ? createMemoryPlaybookDeals() : createUnconfiguredPlaybookDeals(),
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

import { regionSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

/** The shortest internal API secret accepted, in characters. */
export const MIN_INTERNAL_TOKEN_LENGTH = 32

/** The most internal API secrets accepted at once; two is a rotation, more is a mistake. */
const MAX_INTERNAL_TOKENS = 5

/** The longest one internal API secret may be, so a pasted blob cannot be mistaken for one. */
const MAX_INTERNAL_TOKEN_LENGTH = 512

/** A secret is printable ASCII with no space, so it travels in a bearer header unchanged. */
const PRINTABLE_ASCII = /^[!-~]+$/

/** The `closeline_core` login of the compose Postgres, used only when `ENVIRONMENT` is `local`. */
const LOCAL_DATABASE_URL = 'postgres://closeline_core:closeline_core_local@127.0.0.1:5432/closeline'

/** The auth service's local address, used only when `ENVIRONMENT` is `local`. */
const LOCAL_AUTH_ORIGIN = 'http://127.0.0.1:3001'

/** The portal's local address, used only when `ENVIRONMENT` is `local`. */
const LOCAL_PORTAL_ORIGIN = 'http://127.0.0.1:3002'

/**
 * The three spellings of a local mailbox's origin, with an optional port (1 to 65535, no leading
 * zero) and an optional single trailing slash. Matched on the raw value, so no other spelling of
 * the same address (`127.1`, `2130706433`, `127.0.0.1.`, a full-width name, spaces) is accepted.
 */
const LOCAL_MAILBOX =
  /^http:\/\/(127\.0\.0\.1|\[::1\]|[lL][oO][cC][aA][lL][hH][oO][sS][tT])(?::([1-9]\d{0,4}))?\/?$/

/** The canonical origin of a local mailbox (lower-case, no trailing slash), or `undefined`. */
function localMailboxOrigin(value: string): string | undefined {
  const match = LOCAL_MAILBOX.exec(value)
  if (match === null) {
    return undefined
  }
  const port = match[2]
  if (port !== undefined && Number(port) > 65535) {
    return undefined
  }
  return `http://${(match[1] ?? '').toLowerCase()}${port === undefined ? '' : `:${port}`}`
}

/** The audience of every Closeline access token. */
const DEFAULT_AUTH_AUDIENCE = 'closeline'

/** The keys that must be set in every environment but `local`, where they have defaults. */
const REQUIRED_OUTSIDE_LOCAL = [
  'REGION',
  'DATABASE_URL',
  'AUTH_JWKS_URL',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'INTERNAL_API_TOKENS',
  'PORTAL_BASE_URL',
] as const

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: z.enum(['local', 'dev', 'staging', 'prod']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    /** The largest request body accepted, in bytes; anything bigger is a 413. */
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1).max(104_857_600).default(1_048_576),
    /** The Region this deployment serves; every Organization created here lives in it. */
    REGION: regionSchema.optional(),
    /** Postgres connection string of the `closeline_core` login. It carries a password: never log it. */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgres:// connection string')
      .optional(),
    /** Where the auth service publishes its signing keys (https; http only when local). */
    AUTH_JWKS_URL: z.url().optional(),
    /** The `iss` every access token must carry. */
    AUTH_ISSUER: z.string().min(1).max(2_048).optional(),
    /** The `aud` every access token must carry. */
    AUTH_AUDIENCE: z.string().min(1).max(2_048).optional(),
    /**
     * The secrets the auth service may present to the `/internal` routes, comma separated: more
     * than one lets a secret be rotated without downtime. Each is at least 32 characters.
     */
    INTERNAL_API_TOKENS: z
      .string()
      .max(MAX_INTERNAL_TOKENS * (MAX_INTERNAL_TOKEN_LENGTH + 1))
      .optional(),
    /**
     * Where the portal is served: the base of the link in an invitation email. https outside
     * `local`. It may carry a path prefix but no query or fragment.
     */
    PORTAL_BASE_URL: z.url().max(2_048).optional(),
    /** The longest the invitation mail adapter may take to hand over one message. */
    INVITATION_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(5_000),
    /**
     * Where a local mailbox (Mailpit) takes Invitation mail: exactly `http://127.0.0.1`,
     * `http://[::1]` or `http://localhost`, with an optional port and trailing slash and nothing
     * else. Accepted only when `ENVIRONMENT=local`. Without it the unconfigured mailer stays and
     * creating an Invitation fails and revokes it.
     */
    MAIL_LOCAL_URL: z.string().optional(),
    /** The `From` address of local mail. Accepted only when `ENVIRONMENT=local`. */
    MAIL_LOCAL_FROM: z.email().optional(),
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .superRefine((env, context) => {
    // Messages name the key and the rule, never the value: a URL can carry credentials.
    for (const key of ['MAIL_LOCAL_URL', 'MAIL_LOCAL_FROM'] as const) {
      if (env[key] !== undefined && env.ENVIRONMENT !== 'local') {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is accepted only when ENVIRONMENT is local`,
        })
      }
    }
    if (env.MAIL_LOCAL_URL !== undefined && localMailboxOrigin(env.MAIL_LOCAL_URL) === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['MAIL_LOCAL_URL'],
        message:
          'MAIL_LOCAL_URL must be written exactly as http://127.0.0.1, http://[::1] or http://localhost, optionally followed by :port and one trailing slash',
      })
    }
    if (env.ENVIRONMENT !== 'local') {
      for (const key of REQUIRED_OUTSIDE_LOCAL) {
        if (env[key] === undefined) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` })
        }
      }
    }
    if (env.PORTAL_BASE_URL !== undefined) {
      const portal = new URL(env.PORTAL_BASE_URL)
      if (portal.search !== '' || portal.hash !== '' || portal.username || portal.password) {
        context.addIssue({
          code: 'custom',
          path: ['PORTAL_BASE_URL'],
          message: 'PORTAL_BASE_URL must have no query, fragment or credentials',
        })
      }
      if (env.ENVIRONMENT !== 'local' && portal.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['PORTAL_BASE_URL'],
          message: 'PORTAL_BASE_URL must be https outside local',
        })
      }
    }
    if (env.INTERNAL_API_TOKENS !== undefined) {
      const entries = env.INTERNAL_API_TOKENS.split(',')
      // Messages name the position, never the secret.
      if (entries.length > MAX_INTERNAL_TOKENS) {
        context.addIssue({
          code: 'custom',
          path: ['INTERNAL_API_TOKENS'],
          message: `at most ${MAX_INTERNAL_TOKENS} secrets`,
        })
      }
      entries.forEach((entry, index) => {
        if (
          entry.length < MIN_INTERNAL_TOKEN_LENGTH ||
          entry.length > MAX_INTERNAL_TOKEN_LENGTH ||
          !PRINTABLE_ASCII.test(entry)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['INTERNAL_API_TOKENS'],
            message: `secret ${index + 1} must be ${MIN_INTERNAL_TOKEN_LENGTH} to ${MAX_INTERNAL_TOKEN_LENGTH} characters, with no empty entry or spaces`,
          })
        }
      })
    }
  })
  .transform((env) => ({
    ...env,
    REGION: env.REGION ?? regionSchema.parse('us'),
    DATABASE_URL: env.DATABASE_URL ?? LOCAL_DATABASE_URL,
    AUTH_JWKS_URL: env.AUTH_JWKS_URL ?? `${LOCAL_AUTH_ORIGIN}/.well-known/jwks.json`,
    AUTH_ISSUER: env.AUTH_ISSUER ?? LOCAL_AUTH_ORIGIN,
    AUTH_AUDIENCE: env.AUTH_AUDIENCE ?? DEFAULT_AUTH_AUDIENCE,
    PORTAL_BASE_URL: env.PORTAL_BASE_URL ?? LOCAL_PORTAL_ORIGIN,
    INTERNAL_API_TOKENS: (env.INTERNAL_API_TOKENS?.split(',') ?? []) as readonly string[],
    // The canonical origin, so nothing downstream sees another spelling of the address.
    ...(env.MAIL_LOCAL_URL === undefined
      ? {}
      : { MAIL_LOCAL_URL: localMailboxOrigin(env.MAIL_LOCAL_URL) ?? env.MAIL_LOCAL_URL }),
  }))

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}

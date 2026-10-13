import { z } from 'zod'

const schema = z.object({
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
})

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}

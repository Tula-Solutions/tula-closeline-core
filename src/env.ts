import { z } from 'zod'

const schema = z.object({
  ENVIRONMENT: z.enum(['local', 'dev', 'staging', 'prod']).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** The longest one readiness check may take before it counts as failed. */
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
  /** The longest shutdown waits for in-flight requests before closing them. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
})

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}

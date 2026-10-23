import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '~/http/types'

/** How long a browser may keep the answer to a preflight, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 600

/**
 * CORS for one browser-facing public route: only a request whose `Origin` is exactly `allowedOrigin`
 * gets any CORS header. A preflight (`OPTIONS`) is answered here with 204; it allows `POST` and
 * `OPTIONS`, the `Content-Type` and `Idempotency-Key` request headers and no credentials. Every
 * other origin (and a request without one) gets the same answer with no CORS header, so the
 * browser refuses it. `Vary: Origin` is always set, so a cache never mixes the two.
 */
export function exactOriginCors(allowedOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const allowed = c.req.header('origin') === allowedOrigin
    if (c.req.method === 'OPTIONS') {
      c.header('Vary', 'Origin')
      if (allowed) {
        c.header('Access-Control-Allow-Origin', allowedOrigin)
        c.header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        c.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key')
        c.header('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS))
      }
      return c.body(null, 204)
    }
    await next()
    c.res.headers.append('Vary', 'Origin')
    if (allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin)
    }
  }
}

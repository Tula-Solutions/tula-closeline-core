import type { Context, MiddlewareHandler } from 'hono'
import { type AuthVariables, createAuthMiddleware } from 'tula-closeline-kit'
import type { Container } from '~/container'
import type { AppEnv } from '~/http/types'
import type { Caller } from '~/modules/caller'

/** The Hono environment of a public route: the common variables plus the verified identity. */
export type AuthedEnv = {
  Bindings: AppEnv['Bindings']
  Variables: AppEnv['Variables'] & AuthVariables
}

/**
 * The middleware every public route sits behind: it requires a valid access token from the auth
 * service, verified offline against its published keys, and sets the caller's identity.
 */
export function authenticate(container: Container): MiddlewareHandler<AuthedEnv> {
  // The kit types its middleware for a context that has only the identity; ours also has the
  // request id and logger it never reads, so the handler is safe where the wider type is used.
  return createAuthMiddleware({
    verifier: container.tokenVerifier,
    logger: container.logger,
    clock: container.clock,
  }) as unknown as MiddlewareHandler<AuthedEnv>
}

/** Reads the caller from the context; the Organization and role come from the token only. */
export function callerOf(c: Context<AuthedEnv>): Caller {
  return {
    userId: c.get('userId'),
    organizationId: c.get('organizationId'),
    role: c.get('role'),
  }
}

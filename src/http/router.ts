import { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '~/http/types'

/**
 * Creates the router a module builds its routes on. A request that fails its route's schema is
 * thrown as a ZodError, so the one error handler turns it into the contract's validation error.
 */
export function createRouter(): OpenAPIHono<AppEnv> {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw result.error
      }
    },
  })
}

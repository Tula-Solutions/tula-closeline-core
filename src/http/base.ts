import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { createErrorHandler, notFoundHandler } from '~/http/errors'
import { requestId } from '~/http/request-id'
import { createRouter } from '~/http/router'
import type { AppEnv } from '~/http/types'

/** The app with the request id middleware, error handler and 404 handler, and no routes yet. */
export function createBaseApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createRouter()

  app.use('*', requestId(container))
  app.onError(createErrorHandler(container))
  app.notFound(notFoundHandler)

  return app
}

import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { createBaseApp } from '~/http/base'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createHealthRouter } from '~/modules/health/router'
import { createInternalRouter } from '~/modules/internal/router'
import { serveOpenApi } from '~/openapi'

/**
 * Build the HTTP app from a container. Modules are mounted here as they are added. The
 * `/internal` routes sit behind the internal secret and are a separate router.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)
  registerSecuritySchemes(app)

  app.route('/', createHealthRouter(container))
  app.route('/internal', createInternalRouter(container))

  serveOpenApi(app)

  return app
}

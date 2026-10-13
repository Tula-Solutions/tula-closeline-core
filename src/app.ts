import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createHealthRouter } from '~/modules/health/router'
import { createInternalRouter } from '~/modules/internal/router'
import { createInvitationRouter } from '~/modules/invitation/router'
import { createMemberRouter } from '~/modules/member/router'
import { createOrganizationRouter } from '~/modules/organization/router'
import { createTeamRouter } from '~/modules/team/router'
import { serveOpenApi } from '~/openapi'

/**
 * Build the HTTP app from a container. Modules are mounted here as they are added. The public
 * routes under `/v1` sit behind the access-token middleware; the `/internal` routes sit behind
 * the internal secret and are a separate router, so neither can be reached through the other.
 */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)
  registerSecuritySchemes(app)

  app.route('/', createHealthRouter(container))
  app.route('/internal', createInternalRouter(container))

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  publicRoutes.route('/', createOrganizationRouter(container))
  publicRoutes.route('/', createMemberRouter(container))
  publicRoutes.route('/', createInvitationRouter(container))
  publicRoutes.route('/', createTeamRouter(container))
  app.route('/v1', publicRoutes)

  serveOpenApi(app)

  return app
}

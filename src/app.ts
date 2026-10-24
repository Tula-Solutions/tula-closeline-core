import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { type AuthedEnv, authenticate } from '~/http/auth'
import { createBaseApp } from '~/http/base'
import { createRouter } from '~/http/router'
import { registerSecuritySchemes } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { createAgentInstructionRouter } from '~/modules/agent-instruction/router'
import { createAnalyticsRouter } from '~/modules/analytics/router'
import { createApiKeyRouter } from '~/modules/api-key/router'
import { createAuditRouter } from '~/modules/audit/router'
import { createConsentRouter } from '~/modules/consent/router'
import { createConsentFormRouter } from '~/modules/consent-form/router'
import { createConsentFormPublicRouter } from '~/modules/consent-form-public/router'
import { createConsentWordingRouter } from '~/modules/consent-wording/router'
import { createContactCheckRouter } from '~/modules/contact-check/router'
import { createCrmRouter } from '~/modules/crm/router'
import { createDemoRequestRouter } from '~/modules/demo-request/router'
import { createExportPublicRouter } from '~/modules/export/public-router'
import { createExportRouter } from '~/modules/export/router'
import { createHealthRouter } from '~/modules/health/router'
import { createInboxRouter } from '~/modules/inbox/router'
import { createInternalRouter } from '~/modules/internal/router'
import { createInvitationRouter } from '~/modules/invitation/router'
import { createMemberRouter } from '~/modules/member/router'
import { createOrganizationRouter } from '~/modules/organization/router'
import { createProspectRouter } from '~/modules/prospect/router'
import { createProspectCompanyRouter } from '~/modules/prospect-company/router'
import { createProspectImportRouter } from '~/modules/prospect-import/router'
import { createSuppressionRouter } from '~/modules/suppression/router'
import { createTeamRouter } from '~/modules/team/router'
import { createUnsubscribeRouter } from '~/modules/unsubscribe/router'
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

  // The one route with no token: a Visitor's Demo Request. It is mounted before the `/v1` router
  // below, whose access-token middleware therefore never runs for it (this handler answers first).
  app.route('/', createDemoRequestRouter(container))
  // The hosted consent form is public too: the link token in its path is the only credential.
  app.route('/', createConsentFormPublicRouter(container))
  app.route('/', createUnsubscribeRouter(container))
  // An export's download link is public too: its signed token is the only credential.
  app.route('/', createExportPublicRouter(container))

  const publicRoutes = createRouter<AuthedEnv>()
  publicRoutes.use('*', authenticate(container))
  publicRoutes.route('/', createOrganizationRouter(container))
  publicRoutes.route('/', createMemberRouter(container))
  publicRoutes.route('/', createInvitationRouter(container))
  publicRoutes.route('/', createTeamRouter(container))
  publicRoutes.route('/', createProspectRouter(container))
  publicRoutes.route('/', createProspectImportRouter(container))
  publicRoutes.route('/', createProspectCompanyRouter(container))
  publicRoutes.route('/', createSuppressionRouter(container))
  publicRoutes.route('/', createConsentRouter(container))
  publicRoutes.route('/', createConsentWordingRouter(container))
  publicRoutes.route('/', createConsentFormRouter(container))
  publicRoutes.route('/', createContactCheckRouter(container))
  publicRoutes.route('/', createAuditRouter(container))
  publicRoutes.route('/', createAgentInstructionRouter(container))
  publicRoutes.route('/', createCrmRouter(container))
  publicRoutes.route('/', createInboxRouter(container))
  publicRoutes.route('/', createAnalyticsRouter(container))
  publicRoutes.route('/', createExportRouter(container))
  publicRoutes.route('/', createApiKeyRouter(container))
  app.route('/v1', publicRoutes)

  serveOpenApi(app)

  return app
}

import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  CRM_ERRORS,
  CRM_ROUTES,
  crmCallbackQuerySchema,
  crmProviderParamsSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import { errorResponse } from '~/http/responses'
import type { AppEnv } from '~/http/types'
import * as Authorisation from './authorisation'

const callback = createRoute({
  method: 'get',
  path: '/v1/public/crm/{provider}/callback',
  tags: ['crm'],
  summary: 'Return from the CRM sign-in',
  description: CRM_ROUTES.crmOAuthCallback.description,
  request: { params: crmProviderParamsSchema, query: crmCallbackQuerySchema },
  responses: {
    302: { description: "Back to the portal's Integrations screen." },
    400: errorResponse('crm.authorisation_failed: the state or the code does not work.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The CRM sign-in callback: no access token, only the sealed `state` the start route made. Every
 * way a state or code can fail is the same generic 400. The browser is sent to the portal's
 * Integrations screen; a denied consent carries the closed word `crm.authorisation_failed`.
 */
export function createCrmPublicRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        // A malformed query is as generic as a bad state, and says nothing about which part.
        throw domainError(CRM_ERRORS['crm.authorisation_failed'])
      }
    },
  })

  router.openapi(callback, async (c) => {
    const query = c.req.valid('query')
    const outcome = await Authorisation.callback(container, c.req.valid('param').provider, query, {
      traceId: c.get('requestId'),
    })
    const target = new URL('/integrations', container.env.PORTAL_BASE_URL)
    target.searchParams.set('provider', c.req.valid('param').provider)
    if (outcome === 'connected') {
      target.searchParams.set('status', 'connected')
    } else {
      target.searchParams.set('error', 'crm.authorisation_failed')
    }
    return c.redirect(target.toString(), 302)
  })

  return router
}

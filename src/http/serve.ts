import { type Container, reportSafely } from '~/container'
import { internalErrorResponse } from '~/http/errors'
import { resolveRequestId } from '~/http/request-id'

/** The part of the app that the server needs. */
type Fetcher = { fetch: (request: Request) => Response | Promise<Response> }

/**
 * The options `Bun.serve` runs the app with. `development` follows `ENVIRONMENT`, never `NODE_ENV`.
 * The `error` hook is the last line of defence for a failure outside the app: it reports once and
 * answers with the contract's 500 body instead of Bun's own page.
 */
export function serveOptions(container: Container, app: Fetcher) {
  return {
    port: container.env.PORT,
    fetch: app.fetch,
    maxRequestBodySize: container.env.MAX_REQUEST_BODY_BYTES,
    development: container.env.ENVIRONMENT === 'local',
    error: (error: unknown): Response => {
      const requestId = resolveRequestId(undefined)
      reportSafely(container, error, { requestId, method: 'UNKNOWN', path: 'UNKNOWN' })
      return internalErrorResponse(requestId)
    },
  }
}

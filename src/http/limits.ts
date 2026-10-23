import { MAX_PROSPECT_IMPORT_BYTES, PROSPECT_ROUTES } from 'tula-closeline-contract'
import type { Env } from '~/env'

/**
 * What a multipart envelope may add to the file inside it: the boundary lines and the part's
 * headers, for the one part an upload has. A body over the file limit plus this is
 * `request.too_large`; a file over the file limit but inside the envelope is `prospect.import_invalid`.
 */
export const UPLOAD_BODY_OVERHEAD_BYTES = 65_536

/** The method and path of the Prospect import upload, the only route with a body limit of its own. */
export const IMPORT_UPLOAD_ROUTE_KEY = `POST ${PROSPECT_ROUTES.uploadProspectImport.path}`

/** The body limit of the Prospect import upload: the contract's CSV limit plus the envelope overhead. */
export const IMPORT_BODY_LIMIT = MAX_PROSPECT_IMPORT_BYTES + UPLOAD_BODY_OVERHEAD_BYTES

/**
 * The body limit of each route that has one of its own, keyed by `METHOD /path`. Every other route
 * gets `MAX_REQUEST_BODY_BYTES`.
 */
export function routeBodyLimits(): ReadonlyMap<string, number> {
  return new Map([[IMPORT_UPLOAD_ROUTE_KEY, IMPORT_BODY_LIMIT]])
}

/**
 * The largest body any route accepts. `Bun.serve` has one limit for the whole process and cannot
 * give a route its own, so this is what Bun is told; the app's per-route limits then hold every
 * other route to its own.
 */
export function largestBodyLimit(env: Pick<Env, 'MAX_REQUEST_BODY_BYTES'>): number {
  return Math.max(env.MAX_REQUEST_BODY_BYTES, ...routeBodyLimits().values())
}

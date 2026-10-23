import type { RequestId } from 'tula-closeline-contract'
import type { Logger } from 'tula-closeline-kit'

/** What the server hands the app besides the request. */
export type AppBindings = {
  /** The socket address of a request, or null when there is none; absent in tests that omit it. */
  requestIP?: (request: Request) => { address: string } | null
}

/** The Hono environment every route shares: what the middleware puts on the request context. */
export type AppEnv = {
  /** What the server passes to the fetch handler as its second argument (Bun's `server`). */
  Bindings: AppBindings
  Variables: {
    /** The request's id: the caller's when well-formed, otherwise minted here. */
    requestId: RequestId
    /** A logger that adds the request id to every line. */
    logger: Logger
  }
}

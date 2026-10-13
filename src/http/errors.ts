import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ERRORS, type ErrorDefinition } from 'tula-closeline-contract'
import { isAppError, toErrorBody } from 'tula-closeline-kit'
import { ZodError } from 'zod'
import type { Container } from '~/container'
import type { AppEnv } from '~/http/types'

/** Errors with this status or above are the service's fault and go to `reportError`. */
const SERVER_ERROR = 500

/** Builds the response for a registry error, with optional client-safe details. */
function respond(
  c: Context<AppEnv>,
  definition: ErrorDefinition,
  details?: Record<string, unknown>
) {
  const body = {
    error: {
      code: definition.code,
      message: definition.message,
      ...(details ? { details } : {}),
    },
  }
  return c.json(body, definition.status as ContentfulStatusCode)
}

/** The registry entry for an HTTP status, or the generic internal error when there is none. */
function definitionForStatus(status: number): ErrorDefinition {
  return (
    Object.values(ERRORS).find((definition) => definition.status === status) ??
    ERRORS['server.internal']
  )
}

/**
 * The one error handler. An AppError keeps its own code and status; a failed schema is a 400
 * `request.invalid`; anything else is a 500 with a generic body and goes to `reportError`.
 */
export function createErrorHandler(container: Container): ErrorHandler<AppEnv> {
  const report = (error: unknown, c: Context<AppEnv>): void => {
    try {
      container.reportError(error, {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
      })
    } catch {
      // A failing reporter must never turn a handled error into a dropped response.
    }
  }

  return (error, c) => {
    if (isAppError(error)) {
      if (error.status >= SERVER_ERROR) {
        report(error, c)
      }
      return c.json(toErrorBody(error), error.status as ContentfulStatusCode)
    }

    if (error instanceof ZodError) {
      return respond(c, ERRORS['request.invalid'], {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
          message: issue.message,
        })),
      })
    }

    if (error instanceof HTTPException) {
      const definition = definitionForStatus(error.status)
      if (definition.status >= SERVER_ERROR) {
        report(error, c)
      }
      return respond(c, definition)
    }

    report(error, c)
    return respond(c, ERRORS['server.internal'])
  }
}

/** The handler for a path no route matches: a 404 in the contract's error body. */
export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  respond(c, ERRORS['request.not_found'])

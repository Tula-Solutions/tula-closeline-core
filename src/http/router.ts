import { OpenAPIHono } from '@hono/zod-openapi'
import { ERRORS } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'
import type { ZodError } from 'zod'
import type { AppEnv } from '~/http/types'

/**
 * Creates the router a module builds its routes on. A request that fails its route's schema is
 * raised here as a `request.invalid` AppError, so the one error handler answers 400. A ZodError
 * thrown anywhere else is a bug in the service and stays an unexpected 500.
 */
export function createRouter<E extends AppEnv = AppEnv>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result) => {
      if (!result.success) {
        throw invalidRequest(result.error)
      }
    },
  })
}

/** The `request.invalid` AppError for a schema failure, naming each issue's path, code and message. */
export function invalidRequest(error: ZodError): AppError {
  return new AppError({
    code: ERRORS['request.invalid'].code,
    status: ERRORS['request.invalid'].status,
    message: ERRORS['request.invalid'].message,
    details: {
      issues: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    },
    cause: error,
  })
}

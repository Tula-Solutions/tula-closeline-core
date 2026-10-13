import type { ErrorDefinition } from 'tula-closeline-contract'
import { AppError } from 'tula-closeline-kit'

/** Builds the AppError for a registry error, so the one error handler answers with its status. */
export function domainError(definition: ErrorDefinition): AppError {
  return new AppError({
    code: definition.code,
    status: definition.status,
    message: definition.message,
  })
}

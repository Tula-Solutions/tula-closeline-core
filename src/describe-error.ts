/** The longest error message written to a log line; the kit redacts by key, not by content. */
export const MAX_LOGGED_MESSAGE = 200

/** The most stack frames written for one error. */
const MAX_FRAMES = 12

/** How deep a `cause` chain is followed, which also bounds a cyclic chain. */
const MAX_CAUSE_DEPTH = 5

function frames(stack: string | undefined): string[] {
  if (!stack) {
    return []
  }
  return stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim())
}

/**
 * Describes an error for a log line: name, a bounded message, the stack frames without the
 * message text, and the `cause` chain. A value that is not an Error is described by its type
 * only, never its content.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: 'NonError', type: typeof error }
  }
  return {
    name: error.name,
    message: error.message.slice(0, MAX_LOGGED_MESSAGE),
    stack: frames(error.stack),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  }
}

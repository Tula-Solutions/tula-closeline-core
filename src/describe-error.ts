/** The longest error message written to a log line; the kit redacts by key, not by content. */
export const MAX_LOGGED_MESSAGE = 200

/** The most stack frames written for one error. */
const MAX_FRAMES = 12

/** How deep a `cause` chain is followed, which also bounds a cyclic chain. */
const MAX_CAUSE_DEPTH = 5

/** The longest stack frame line written to a log. */
const MAX_FRAME_LENGTH = 300

/** A genuine frame: `at` then anything, ending in a file position such as `:12:5` or `:12:5)`. */
const FRAME = /^\s*at\s.*:\d+(?::\d+)?\)?$/

/**
 * The frame lines of a stack. The leading lines that belong to the message are dropped first
 * (counted from the message), then only lines shaped like a frame are kept, so message text can
 * never come through, and each frame and the frame count are bounded.
 */
function frames(error: Error): string[] {
  const lines = error.stack?.split('\n') ?? []
  const first = lines[0] ?? ''
  const messageLines = FRAME.test(first) ? 0 : error.message.split('\n').length
  return lines
    .slice(messageLines)
    .filter((line) => FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim().slice(0, MAX_FRAME_LENGTH))
}

/** The error's own name, or its class name when it kept the default `Error` (Hono's exceptions). */
function nameOf(error: Error): string {
  const className = error.constructor?.name
  return error.name === 'Error' && className && className !== 'Error' ? className : error.name
}

/** The `status` and `code` an error carries (AppError, HTTPException), when it has them. */
function statusAndCode(error: Error): { status?: number; code?: string } {
  const { status, code } = error as { status?: unknown; code?: unknown }
  return {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  }
}

/**
 * Describes an error for a log line: name, status and code when it has them, a bounded message, the stack frames without the
 * message text, and the `cause` chain. A value that is not an Error is described by its type
 * only, never its content.
 */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: 'NonError', type: typeof error }
  }
  return {
    name: nameOf(error),
    ...statusAndCode(error),
    message: error.message.slice(0, MAX_LOGGED_MESSAGE),
    stack: frames(error),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  }
}

/**
 * A LIKE pattern that matches text containing `text`, with `%`, `_` and `\` taken literally.
 * Use it with `escape '\'`.
 */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

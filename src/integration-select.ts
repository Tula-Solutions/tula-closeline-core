/** Picks the integration suites to run: all with no filters, else those matching a filter. */
export function selectSuites(all: readonly string[], filters: readonly string[]): string[] {
  if (filters.length === 0) {
    return [...all]
  }
  const wanted = filters.map((f) => f.replace(/^\.\//, ''))
  const picked = all.filter((file) => wanted.some((w) => file === w || file.includes(w)))
  const unmatched = wanted.filter((w) => !all.some((file) => file === w || file.includes(w)))
  if (unmatched.length > 0) {
    throw new Error(`no integration suite matches: ${unmatched.join(', ')}`)
  }
  return picked
}

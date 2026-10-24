import type { InstructionDiff } from 'tula-closeline-contract'

type Line = InstructionDiff['lines'][number]

/** The most cells of the longest-common-subsequence table; a bigger middle is shown as replaced. */
const MAX_TABLE_CELLS = 4_000_000

/**
 * The line-by-line difference of two texts. The common start and end are trimmed first; the middle
 * is a longest-common-subsequence table of at most {@link MAX_TABLE_CELLS} cells, and a middle
 * larger than that is reported as all removed then all added, so the work is bounded.
 */
export function diffLines(from: string, to: string): Line[] {
  const a = from.split('\n')
  const b = to.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const head: Line[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const tail: Line[] = a.slice(endA).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  return [...head, ...diffMiddle(midA, midB), ...tail]
}

/** The difference of the lines between the common start and end. */
function diffMiddle(a: string[], b: string[]): Line[] {
  const removed = (lines: string[]): Line[] => lines.map((text) => ({ kind: 'removed', text }))
  const added = (lines: string[]): Line[] => lines.map((text) => ({ kind: 'added', text }))
  if (a.length === 0 || b.length === 0 || (a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    return [...removed(a), ...added(b)]
  }
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const lines: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] as string })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: 'removed', text: a[i] as string })
      i += 1
    } else {
      lines.push({ kind: 'added', text: b[j] as string })
      j += 1
    }
  }
  return [...lines, ...removed(a.slice(i)), ...added(b.slice(j))]
}

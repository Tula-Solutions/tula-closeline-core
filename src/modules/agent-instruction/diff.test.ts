import { describe, expect, test } from 'bun:test'
import { diffLines } from './diff'

describe('diffLines', () => {
  test('identical text is all same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'same', text: 'b' },
    ])
  })

  test('marks a changed line as removed then added, keeping the context', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
    ])
  })

  test('finds an inserted and a deleted line', () => {
    expect(diffLines('a\nc\nd', 'a\nb\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'removed', text: 'd' },
    ])
  })

  test('a very different large text still answers in bounded work', () => {
    const left = Array.from({ length: 5000 }, (_, i) => `left ${i}`).join('\n')
    const right = Array.from({ length: 5000 }, (_, i) => `right ${i}`).join('\n')
    const lines = diffLines(left, right)
    expect(lines.filter((l) => l.kind === 'removed')).toHaveLength(5000)
    expect(lines.filter((l) => l.kind === 'added')).toHaveLength(5000)
  })
})

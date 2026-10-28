import { describe, expect, test } from 'bun:test'
import type { ProspectId, UserId } from 'tula-closeline-contract'
import type { FieldHistoryRow } from '~/ports/prospect-merge-store'
import { mergeHistories } from './merge-fields'

const A = 'prs_a' as ProspectId
const B = 'prs_b' as ProspectId
const C = 'prs_c' as ProspectId
const USER = 'usr_1' as UserId

const row = (
  field: string,
  value: string,
  state: FieldHistoryRow['state'],
  source: string,
  at: number
): FieldHistoryRow => ({
  field,
  value,
  state,
  source,
  sourceRef: null,
  setAt: new Date(at),
  setByUserId: source === 'manual' ? USER : null,
})

const current = (rows: readonly FieldHistoryRow[], field: string) =>
  rows.filter((r) => r.field === field && r.state === 'current')

describe('mergeHistories', () => {
  test('a chosen Prospect keeps its value as current and the other value becomes history', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [A, [row('jobTitle', 'VP', 'current', 'manual', 2)]],
        [B, [row('jobTitle', 'CTO', 'current', 'manual', 1)]],
      ]),
      choices: { jobTitle: B },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(current(result.rows, 'jobTitle').map((r) => r.value)).toEqual(['CTO'])
    const old = result.rows.find((r) => r.value === 'VP')
    expect(old?.state).toBe('superseded')
    expect(old?.source).toBe('manual')
    expect(old?.setAt).toEqual(new Date(2))
    expect(old?.setByUserId).toBe(USER)
  })

  test('without a choice a manual value beats an import, then the newer wins, then the survivor', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [
          A,
          [
            row('firstName', 'Al', 'current', 'import', 9),
            row('lastName', 'Old', 'current', 'import', 1),
            row('jobTitle', 'Same', 'current', 'import', 5),
          ],
        ],
        [
          B,
          [
            row('firstName', 'Alan', 'current', 'manual', 1),
            row('lastName', 'New', 'current', 'import', 2),
            row('jobTitle', 'Tie', 'current', 'import', 5),
          ],
        ],
      ]),
      choices: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(current(result.rows, 'firstName')[0]?.value).toBe('Alan')
    expect(current(result.rows, 'lastName')[0]?.value).toBe('New')
    expect(current(result.rows, 'jobTitle')[0]?.value).toBe('Same')
  })

  test('history and suggestions of every record are kept with their own state', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [A, [row('email', 'a@x.io', 'current', 'manual', 3)]],
        [
          B,
          [
            row('email', 'b@x.io', 'current', 'import', 1),
            row('email', 'old@x.io', 'superseded', 'import', 0),
            row('email', 'guess@x.io', 'suggested', 'enrichment:apollo', 2),
          ],
        ],
      ]),
      choices: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.rows.map((r) => [r.value, r.state]).sort()).toEqual([
      ['a@x.io', 'current'],
      ['b@x.io', 'superseded'],
      ['guess@x.io', 'suggested'],
      ['old@x.io', 'superseded'],
    ])
  })

  test('a choice of a Prospect with no current value for the field is a conflict', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [A, [row('phone', '+14155550100', 'current', 'manual', 1)]],
        [B, []],
      ]),
      choices: { phone: B },
    })
    expect(result.ok).toBe(false)
  })

  test('a choice for a field no record has is a conflict', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [A, []],
        [B, []],
      ]),
      choices: { phone: B },
    })
    expect(result.ok).toBe(false)
  })

  test('a choice naming a Prospect outside the merge is a conflict', () => {
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([[A, []]]),
      choices: { phone: C },
    })
    expect(result.ok).toBe(false)
  })

  test('a field keeps at most 50 entries: the oldest history goes, never the current value', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      row('jobTitle', `t${i}`, 'superseded', 'import', i + 10)
    )
    const result = mergeHistories({
      survivorId: A,
      histories: new Map([
        [A, [row('jobTitle', 'now', 'current', 'manual', 1), ...many]],
        [B, many.map((r) => ({ ...r, value: `b-${r.value}` }))],
      ]),
      choices: {},
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const ofField = result.rows.filter((r) => r.field === 'jobTitle')
    expect(ofField.length).toBe(50)
    expect(current(result.rows, 'jobTitle')[0]?.value).toBe('now')
  })
})

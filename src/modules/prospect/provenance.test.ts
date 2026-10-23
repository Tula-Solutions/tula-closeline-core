import { describe, expect, test } from 'bun:test'
import type { FieldRecord } from '~/ports/core-store'
import { decideFieldWrite, type FieldWrite } from './provenance'

const held = (source: string, value = 'old'): FieldRecord => ({
  field: 'jobTitle',
  value,
  source,
  sourceRef: source === 'manual' ? null : 'ref',
  setAt: new Date('2026-01-01T00:00:00Z'),
  setByUserId: null,
})

const write = (source: string, value: string | null = 'new'): FieldWrite => ({
  field: 'jobTitle',
  value,
  source,
  sourceRef: source === 'manual' ? null : 'ref',
})

describe('decideFieldWrite', () => {
  test('a first value of any Source is set', () => {
    expect(decideFieldWrite(undefined, write('import'))).toEqual({ kind: 'set' })
    expect(decideFieldWrite(undefined, write('enrichment:apollo'))).toEqual({ kind: 'set' })
  })

  test('a manual edit beats every other Source', () => {
    for (const source of ['import', 'crm:hubspot', 'form', 'enrichment:apollo']) {
      expect(decideFieldWrite(held(source), write('manual'))).toEqual({ kind: 'set' })
    }
  })

  test('a later automatic write never overrides a manual value', () => {
    expect(decideFieldWrite(held('manual'), write('import'))).toEqual({
      kind: 'record',
      state: 'superseded',
    })
    expect(decideFieldWrite(held('manual'), write('crm:salesforce'))).toEqual({
      kind: 'record',
      state: 'superseded',
    })
    expect(decideFieldWrite(held('manual'), write('enrichment:apollo'))).toEqual({
      kind: 'record',
      state: 'suggested',
    })
  })

  test('a newer import replaces an older import', () => {
    expect(decideFieldWrite(held('import'), write('import'))).toEqual({ kind: 'set' })
  })

  test('an import older than the held value is kept as history, a newer one replaces it', () => {
    const at = (iso: string) => ({ ...write('import'), at: new Date(iso) })
    expect(decideFieldWrite(held('import'), at('2025-12-31T00:00:00Z'))).toEqual({
      kind: 'record',
      state: 'superseded',
    })
    expect(decideFieldWrite(held('import'), at('2026-01-02T00:00:00Z'))).toEqual({ kind: 'set' })
  })

  test('an enrichment is only a suggestion over an import but replaces an older enrichment', () => {
    expect(decideFieldWrite(held('import'), write('enrichment:apollo'))).toEqual({
      kind: 'record',
      state: 'suggested',
    })
    expect(decideFieldWrite(held('enrichment:apollo'), write('enrichment:apollo'))).toEqual({
      kind: 'set',
    })
  })

  test('the same value again changes nothing', () => {
    expect(decideFieldWrite(held('import', 'same'), write('import', 'same'))).toEqual({
      kind: 'unchanged',
    })
    expect(decideFieldWrite(held('manual', 'same'), write('manual', 'same'))).toEqual({
      kind: 'unchanged',
    })
  })

  test('a manual write takes over the same value from another Source', () => {
    expect(decideFieldWrite(held('import', 'same'), write('manual', 'same'))).toEqual({
      kind: 'set',
    })
  })

  test('only a manual write clears a field, and only one that has a value', () => {
    expect(decideFieldWrite(held('import'), write('manual', null))).toEqual({ kind: 'clear' })
    expect(decideFieldWrite(held('manual'), write('import', null))).toEqual({ kind: 'unchanged' })
    expect(decideFieldWrite(undefined, write('manual', null))).toEqual({ kind: 'unchanged' })
  })
})

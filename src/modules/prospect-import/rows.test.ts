import { describe, expect, test } from 'bun:test'
import { evaluateRows, readHeader } from './rows'

const header = (...names: string[]) => {
  const read = readHeader(names)
  if (!read.ok) {
    throw new Error('header refused')
  }
  return read.columns
}

describe('readHeader', () => {
  test('accepts known columns in any order, trimmed and case-folded', () => {
    const read = readHeader([' Email ', 'FIRST_NAME'])
    expect(read).toEqual({ ok: true, columns: ['email', 'first_name'] })
  })

  test('refuses an unknown column, a duplicate and a header with no identity column', () => {
    expect(readHeader(['email', 'shoe_size']).ok).toBe(false)
    expect(readHeader(['email', 'Email']).ok).toBe(false)
    expect(readHeader(['first_name', 'last_name']).ok).toBe(false)
    expect(readHeader([]).ok).toBe(false)
  })
})

describe('evaluateRows', () => {
  const columns = header(
    'first_name',
    'email',
    'phone',
    'linkedin_url',
    'company_name',
    'company_domain',
    'owner_email',
    'tags'
  )

  test('normalises a good row and keeps empty cells out', () => {
    const [row] = evaluateRows(columns, [
      [' Ada ', ' ADA@Example.com ', '+1 (415) 555-0100', '', 'Acme', 'ACME.com', '', 'a; b ;;c'],
    ])
    expect(row).toEqual({
      ok: true,
      row: {
        firstName: 'Ada',
        email: 'ada@example.com',
        phone: '+14155550100',
        companyName: 'Acme',
        companyDomain: 'acme.com',
        tags: ['a', 'b', 'c'],
      },
    })
  })

  test('names each reason, in order, and never echoes a cell', () => {
    const results = evaluateRows(columns, [
      [''],
      ['x', 'a@b.co'],
      ['', '', '', '', '', '', '', ''],
      ['x'.repeat(101), 'a@b.co', '', '', '', '', '', ''],
      ['', 'not-an-email', '', '', '', '', '', ''],
      ['', '', '4155550100', '', '', '', '', ''],
      ['', '', '', 'https://example.com/in/x', '', '', '', ''],
      ['', 'a@b.co', '', '', '', 'not a domain', '', ''],
      ['', 'a@b.co', '', '', '', '', '', 'a;a'],
    ])
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'blank_row',
      'wrong_column_count',
      'missing_identity',
      'invalid_name',
      'invalid_email',
      'invalid_phone',
      'invalid_linkedin_url',
      'invalid_company',
      'invalid_tags',
    ])
  })

  test('rejects a row whose identity an earlier valid row already holds, by normalised value', () => {
    const results = evaluateRows(columns, [
      ['', 'a@b.co', '', '', '', '', '', ''],
      ['', 'A@B.CO', '', '', '', '', '', ''],
      ['', '', '+14155550100', '', '', '', '', ''],
      ['', 'c@d.co', '+1 415 555 0100', '', '', '', '', ''],
      ['', 'e@f.co', '', '', '', '', '', ''],
    ])
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'ok',
      'duplicate_in_file',
      'ok',
      'duplicate_in_file',
      'ok',
    ])
  })

  test('a duplicate does not hold its other identities, and an invalid row holds none', () => {
    const results = evaluateRows(columns, [
      ['', 'bad', '+14155550100', '', '', '', '', ''],
      ['', 'a@b.co', '+14155550100', '', '', '', '', ''],
      ['', 'a@b.co', '+14155550199', '', '', '', '', ''],
      ['', 'z@b.co', '+14155550199', '', '', '', '', ''],
    ])
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual([
      'invalid_email',
      'ok',
      'duplicate_in_file',
      'ok',
    ])
  })
})

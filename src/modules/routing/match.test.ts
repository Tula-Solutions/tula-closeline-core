import { describe, expect, test } from 'bun:test'
import type { RoutingAttributes, RoutingConditions } from 'tula-closeline-contract'
import { bandOf, isDefaultRule, matches } from './match'

const attrs: RoutingAttributes = {
  country: 'GB',
  region: 'London',
  companySizeBand: '51-200',
  accountOwnerMembershipId: null,
  source: 'manual',
}

describe('matches', () => {
  const cases: [string, RoutingConditions, boolean][] = [
    ['no conditions', {}, true],
    ['country in list', { countries: ['GB', 'US'] }, true],
    ['country not in list', { countries: ['US'] }, false],
    ['region in list', { regions: ['London'] }, true],
    ['region not in list', { regions: ['Paris'] }, false],
    ['size band in list', { companySizeBands: ['51-200'] }, true],
    ['size band not in list', { companySizeBands: ['1-10'] }, false],
    ['source in list', { sources: ['manual'] }, true],
    ['source not in list', { sources: ['import'] }, false],
    ['owner list but Prospect has no owner', { accountOwnerMembershipIds: [] }, false],
    ['all hold', { countries: ['GB'], regions: ['London'], sources: ['manual'] }, true],
    ['one of two fails', { countries: ['GB'], regions: ['Paris'] }, false],
  ]
  test.each(cases)('%s', (_name, conditions, expected) => {
    expect(matches(conditions, attrs, undefined)).toBe(expected)
  })

  test('a Booking Type condition needs that Booking Type', () => {
    const conditions = { bookingTypeIds: ['bkt_a' as never] }
    expect(matches(conditions, attrs, undefined)).toBe(false)
    expect(matches(conditions, attrs, 'bkt_a' as never)).toBe(true)
    expect(matches(conditions, attrs, 'bkt_b' as never)).toBe(false)
  })

  test('a missing value never matches a condition on it', () => {
    expect(matches({ countries: ['GB'] }, { ...attrs, country: null }, undefined)).toBe(false)
  })
})

describe('bandOf', () => {
  test.each([
    [0, null],
    [1, '1-10'],
    [10, '1-10'],
    [11, '11-50'],
    [200, '51-200'],
    [1000, '201-1000'],
    [5000, '1001-5000'],
    [5001, '5001+'],
    [Number.NaN, null],
  ] as const)('%p is %p', (count, band) => {
    expect(bandOf(count)).toBe(band)
  })
})

test('a rule without conditions is the default', () => {
  expect(isDefaultRule({})).toBe(true)
  expect(isDefaultRule({ countries: ['GB'] })).toBe(false)
})

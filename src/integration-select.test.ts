import { describe, expect, it } from 'bun:test'
import { selectSuites } from './integration-select'

const all = [
  'bench/prospect-search.bench.integration.ts',
  'src/invitations.integration.ts',
  'src/team-members.integration.ts',
]

describe('selectSuites', () => {
  it('returns every suite with no filters', () => {
    expect(selectSuites(all, [])).toEqual(all)
  })

  it('matches a file path, with or without ./', () => {
    expect(selectSuites(all, ['./src/invitations.integration.ts'])).toEqual([
      'src/invitations.integration.ts',
    ])
    expect(selectSuites(all, ['src/team-members.integration.ts'])).toEqual([
      'src/team-members.integration.ts',
    ])
  })

  it('matches a name filter and several filters at once', () => {
    expect(selectSuites(all, ['invitations', 'team-members'])).toEqual([
      'src/invitations.integration.ts',
      'src/team-members.integration.ts',
    ])
  })

  it('fails when a filter matches nothing', () => {
    expect(() => selectSuites(all, ['invitations', 'nope'])).toThrow('nope')
  })
})

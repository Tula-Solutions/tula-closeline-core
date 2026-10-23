import { expect, test } from 'bun:test'
import { CONSENT_ROUTES, PROSPECT_ROUTES, publicApiExtensions } from 'tula-closeline-contract'
import { createApp } from './app'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type Operation = Record<string, unknown>
type Document = { paths: Record<string, Record<string, Operation>> }

const document = buildOpenApiDocument(createApp(createTestDeps())) as unknown as Document

function operation(method: string, path: string): Operation {
  const found = document.paths[path]?.[method.toLowerCase()]
  if (found === undefined) {
    throw new Error(`${method} ${path} is not in the document`)
  }
  return found
}

test('a contract route marked publicApi shows both extensions in the generated document', () => {
  expect(PROSPECT_ROUTES.listProspects.publicApi).toEqual({ scope: 'prospects:read' })
  const listed = operation('GET', '/v1/prospects')
  expect(listed['x-closeline-public']).toBe(true)
  expect(listed['x-closeline-scopes']).toEqual(['prospects:read'])

  const created = operation('POST', '/v1/prospects')
  expect(created['x-closeline-public']).toBe(true)
  expect(created['x-closeline-scopes']).toEqual(['prospects:write'])
})

test('a route that is not marked publicApi carries neither extension', () => {
  const organization = operation('GET', '/v1/organization')
  expect('x-closeline-public' in organization).toBe(false)
  expect('x-closeline-scopes' in organization).toBe(false)
})

test('every core route named by a contract table carries exactly the marks the table gives it', () => {
  let checked = 0
  for (const table of [PROSPECT_ROUTES, CONSENT_ROUTES]) {
    for (const route of Object.values(table)) {
      const served = document.paths[route.path]?.[route.method.toLowerCase()]
      if (served === undefined) {
        continue
      }
      checked += 1
      const expected = publicApiExtensions(route)
      expect(served['x-closeline-public']).toEqual(expected['x-closeline-public'])
      expect(served['x-closeline-scopes']).toEqual(expected['x-closeline-scopes'] as unknown)
    }
  }
  expect(checked).toBeGreaterThan(10)
})

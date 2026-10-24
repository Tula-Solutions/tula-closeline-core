import { expect, test } from 'bun:test'
import { createApp } from './app'
import { SERVICE } from './info'
import { buildOpenApiDocument } from './openapi'
import { createTestDeps } from './testing'

type ServedDocument = {
  openapi: string
  info: { title: string }
  paths: Record<string, { get: { responses: Record<string, unknown> } }>
}

test('the app serves its OpenAPI document describing every route and the error body', async () => {
  const app = createApp(createTestDeps())

  const response = await app.request('/openapi.json')

  expect(response.status).toBe(200)
  const document = (await response.json()) as ServedDocument
  expect(document.openapi).toBe('3.1.0')
  expect(document.info.title).toBe(SERVICE)
  expect(Object.keys(document.paths).sort()).toEqual([
    '/healthz',
    '/internal/api-keys/verify',
    '/internal/invitations/accept',
    '/internal/membership',
    '/internal/messages',
    '/internal/organizations',
    '/internal/organizations/{organizationId}/abandon',
    '/internal/v1/agent-instructions/published',
    '/internal/v1/consent-withdrawals',
    '/internal/v1/contact-checks',
    '/internal/v1/directory/membership',
    '/internal/v1/directory/rep-check',
    '/internal/v1/directory/team-check',
    '/readyz',
    '/v1/agent-instructions/{agentKind}/diff',
    '/v1/agent-instructions/{agentKind}/published',
    '/v1/agent-instructions/{agentKind}/versions',
    '/v1/agent-instructions/{agentKind}/versions/{versionNumber}',
    '/v1/agent-instructions/{agentKind}/versions/{versionNumber}/publish',
    '/v1/analytics/series',
    '/v1/api-keys',
    '/v1/api-keys/{apiKeyId}/revoke',
    '/v1/audit-csv',
    '/v1/audit-events',
    '/v1/audit-events/{auditEventId}',
    '/v1/audit-verification',
    '/v1/consent-forms',
    '/v1/consent-forms/{formId}',
    '/v1/consent-forms/{formId}/closure',
    '/v1/consent-forms/{formId}/publication',
    '/v1/consent-wordings',
    '/v1/consent-wordings/{wordingId}',
    '/v1/consent-wordings/{wordingId}/versions',
    '/v1/contact-checks',
    '/v1/conversations',
    '/v1/conversations/{conversationId}',
    '/v1/conversations/{conversationId}/messages',
    '/v1/crm/connections',
    '/v1/crm/connections/{provider}',
    '/v1/exports',
    '/v1/exports/{exportId}',
    '/v1/exports/{exportId}/download-links',
    '/v1/invitations',
    '/v1/invitations/{invitationId}',
    '/v1/marketing/demo-requests',
    '/v1/members',
    '/v1/members/{membershipId}',
    '/v1/organization',
    '/v1/prospect-companies',
    '/v1/prospect-companies/{companyId}',

    '/v1/prospect-imports',

    '/v1/prospect-imports/{importId}',

    '/v1/prospect-imports/{importId}/report.csv',

    '/v1/prospect-imports/{importId}/rows',
    '/v1/prospects',
    '/v1/prospects/assign',
    '/v1/prospects/{prospectId}',
    '/v1/prospects/{prospectId}/consent',
    '/v1/prospects/{prospectId}/consent-events',
    '/v1/prospects/{prospectId}/consent-evidence',
    '/v1/prospects/{prospectId}/consent-withdrawals',
    '/v1/prospects/{prospectId}/consents',
    '/v1/prospects/{prospectId}/owner',
    '/v1/public/consent-forms/{token}',
    '/v1/public/consent-forms/{token}/submissions',
    '/v1/public/export-downloads/{token}',
    '/v1/public/unsubscribe/{token}',
    '/v1/suppression-entries',
    '/v1/suppression-entries/lookups',
    '/v1/suppression-entries/{entryId}',
    '/v1/suppression-entries/{entryId}/removal',
    '/v1/teams',
    '/v1/teams/{teamId}',
    '/v1/teams/{teamId}/members',
    '/v1/teams/{teamId}/members/{membershipId}',
  ])
  expect(document.paths['/healthz']?.get.responses['500']).toBeDefined()
  expect(document.paths['/readyz']?.get.responses['503']).toBeDefined()
  expect(JSON.stringify(document.paths['/healthz']?.get.responses['500'])).toContain('code')
})

test('the document written by the script is the document the app serves', async () => {
  const app = createApp(createTestDeps())

  const served = await (await app.request('/openapi.json')).json()

  expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(served)
})

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
    '/internal/v1/directory/team-reps',
    '/internal/v1/directory/team-ring-members',
    '/internal/v1/prospects/{prospectId}/enriched-fields',
    '/internal/v1/prospects/{prospectId}/enrichment-input',
    '/readyz',
    '/v1/agent-controls',
    '/v1/agent-controls/organization-pause',
    '/v1/agent-controls/{agentKind}/{channel}',
    '/v1/agent-instructions/{agentKind}/diff',
    '/v1/agent-instructions/{agentKind}/published',
    '/v1/agent-instructions/{agentKind}/versions',
    '/v1/agent-instructions/{agentKind}/versions/{versionNumber}',
    '/v1/agent-instructions/{agentKind}/versions/{versionNumber}/publish',
    '/v1/analytics/deals/{dealRecordId}/attribution',
    '/v1/analytics/series',
    '/v1/analytics/source-performance',
    '/v1/analytics/table',
    '/v1/analytics/table.csv',
    '/v1/api-keys',
    '/v1/api-keys/{apiKeyId}/revoke',
    '/v1/approval-policies',
    '/v1/approval-policies/{channel}',
    '/v1/approvals',
    '/v1/assessment-rates',
    '/v1/assessments',
    '/v1/assessments/{assessmentId}',
    '/v1/assessments/{assessmentId}/findings/{findingId}/feedback',
    '/v1/assessments/{assessmentId}/transcript',
    '/v1/audit-csv',
    '/v1/audit-events',
    '/v1/audit-events/{auditEventId}',
    '/v1/audit-verification',
    '/v1/availability',
    '/v1/booking-slots',
    '/v1/booking-types',
    '/v1/booking-types/{bookingTypeId}',
    '/v1/booking-types/{bookingTypeId}/retire',
    '/v1/bookings',
    '/v1/bookings/{bookingId}',
    '/v1/bookings/{bookingId}/cancel',
    '/v1/bookings/{bookingId}/reschedule',
    '/v1/calendar-connection',
    '/v1/calendar-connection/complete',
    '/v1/calendar-connection/start',
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
    '/v1/conversations/{conversationId}/handback',
    '/v1/conversations/{conversationId}/messages',
    '/v1/conversations/{conversationId}/messages/{messageId}/classification',
    '/v1/conversations/{conversationId}/replies',
    '/v1/conversations/{conversationId}/summary',
    '/v1/conversations/{conversationId}/takeover',
    '/v1/crm/connections',
    '/v1/crm/connections/{provider}',
    '/v1/crm/connections/{provider}/authorisations',
    '/v1/crm/connections/{provider}/completions',
    '/v1/decisions',
    '/v1/drafts/{draftId}',
    '/v1/drafts/{draftId}/approve',
    '/v1/drafts/{draftId}/reject',
    '/v1/drafts/{draftId}/sources',
    '/v1/escalation-rules',
    '/v1/escalation-rules/{trigger}',
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
    '/v1/public/booking-types/{token}/bookings',
    '/v1/public/booking-types/{token}/slots',
    '/v1/public/bookings/manage/{manageToken}',
    '/v1/public/bookings/manage/{manageToken}/cancel',
    '/v1/public/bookings/manage/{manageToken}/reschedule',
    '/v1/public/bookings/manage/{manageToken}/slots',
    '/v1/public/consent-forms/{token}',
    '/v1/public/consent-forms/{token}/submissions',
    '/v1/public/export-downloads/{token}',
    '/v1/public/unsubscribe/{token}',
    '/v1/routing-rules',
    '/v1/routing-rules/reorder',
    '/v1/routing-rules/test',
    '/v1/routing-rules/{ruleId}',
    '/v1/routing/route',
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

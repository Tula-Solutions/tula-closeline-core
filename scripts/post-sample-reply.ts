/**
 * Posts one sample inbound reply to a running core, as a channel service would.
 *
 * Usage: bun scripts/post-sample-reply.ts <prospectId> [body]
 * Reads CORE_URL (default http://127.0.0.1:3000), INTERNAL_API_TOKEN and ORGANIZATION_ID from the
 * shell. The provider message id is fresh each run; pass PROVIDER_MESSAGE_ID to repeat one and see
 * the idempotent 200.
 */
const prospectId = process.argv[2]
const body = process.argv[3] ?? 'Thanks for reaching out. Can you send pricing?'
const url = process.env.CORE_URL ?? 'http://127.0.0.1:3000'
const secret = process.env.INTERNAL_API_TOKEN
const organizationId = process.env.ORGANIZATION_ID

if (!prospectId || !secret || !organizationId) {
  console.error(
    'Usage: INTERNAL_API_TOKEN=... ORGANIZATION_ID=org_... bun scripts/post-sample-reply.ts <prospectId> [body]'
  )
  process.exit(2)
}

const response = await fetch(`${url}/internal/messages`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
    'x-organization-id': organizationId,
  },
  body: JSON.stringify({
    channel: 'email',
    providerMessageId: process.env.PROVIDER_MESSAGE_ID ?? `sample-${crypto.randomUUID()}`,
    prospectId,
    direction: 'inbound',
    body,
    sentAt: new Date().toISOString(),
  }),
  signal: AbortSignal.timeout(10_000),
})
const result = (await response.json()) as { message?: { id?: string; conversationId?: string } }
console.log(
  response.status,
  response.status === 201 || response.status === 200
    ? `message ${result.message?.id} in conversation ${result.message?.conversationId}`
    : JSON.stringify(result)
)
process.exit(response.ok ? 0 : 1)

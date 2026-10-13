import { expect, test } from 'bun:test'
import { createApp } from '~/app'
import { createTestDeps } from '~/testing'

type Operation = {
  description: string
  parameters: { name: string; in: string; description?: string }[]
  responses: Record<string, { description: string; headers?: Record<string, unknown> }>
}

async function operation(path: string): Promise<Operation> {
  const response = await createApp(createTestDeps()).request('/openapi.json')
  const document = (await response.json()) as {
    paths: Record<string, { post: Operation }>
  }
  const found = document.paths[path]?.post
  if (!found) {
    throw new Error(`no POST ${path}`)
  }
  return found
}

const header = (op: Operation) => op.parameters.find((p) => p.name === 'idempotency-key')

test('POST /v1/invitations says a key is stored once the email is handed over and cannot answer in progress', async () => {
  const op = await operation('/v1/invitations')

  expect(op.description).toContain('stored only once the email has been handed over')
  expect(op.description).toContain('invitation.already_pending')
  expect(op.description).toContain('request.idempotency_key_reused')
  expect(header(op)?.description).toContain('before the email is confirmed handed over')
  expect(header(op)?.description).not.toContain('idempotency_in_progress')
  expect(op.responses['409']?.description).toContain('invitation.already_pending')
  expect(op.responses['409']?.description).not.toContain('idempotency_in_progress')
  expect(op.responses['409']?.headers).toBeUndefined()
  expect(op.responses['422']?.description).toContain('request.idempotency_key_reused')
})

test('POST /v1/teams still documents request.idempotency_in_progress with Retry-After', async () => {
  const op = await operation('/v1/teams')

  expect(header(op)?.description).toContain('request.idempotency_in_progress')
  expect(op.responses['409']?.description).toContain('team.name_taken')
  expect(op.responses['409']?.description).toContain('request.idempotency_in_progress')
  expect(op.responses['409']?.headers).toHaveProperty('Retry-After')
  expect(op.responses['422']?.description).toContain('request.idempotency_key_reused')
})

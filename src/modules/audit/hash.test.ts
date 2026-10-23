import { describe, expect, test } from 'bun:test'
import type { OrganizationId } from 'tula-closeline-contract'
import { hashAuditEvent } from './hash'

const org = `org_${'1'.repeat(32)}` as OrganizationId
const event = {
  id: `aud_${'a'.repeat(32)}`,
  sequence: 1,
  occurredAt: new Date('2026-03-01T00:00:00Z'),
  actor: { kind: 'system' },
  action: 'a.b',
  subject: null,
  prospectId: null,
  instructionVersion: null,
  requestId: null,
  metadata: { b: 1, a: 2 },
  previousHash: null,
} as never

describe('hashAuditEvent', () => {
  test('is 64 lowercase hex and does not depend on key order', () => {
    const hash = hashAuditEvent(org, event)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAuditEvent(org, { ...(event as object), metadata: { a: 2, b: 1 } } as never)).toBe(
      hash
    )
  })

  test('changes with any field and with the Organization', () => {
    const hash = hashAuditEvent(org, event)
    expect(hashAuditEvent(org, { ...(event as object), action: 'a.c' } as never)).not.toBe(hash)
    expect(
      hashAuditEvent(org, { ...(event as object), previousHash: 'f'.repeat(64) } as never)
    ).not.toBe(hash)
    expect(hashAuditEvent(`org_${'2'.repeat(32)}` as OrganizationId, event)).not.toBe(hash)
  })
})

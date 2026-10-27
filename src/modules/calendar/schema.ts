import { type CalendarConnection, calendarConnectionSchema } from 'tula-closeline-contract'
import type { CalendarConnectionRecord } from '~/ports/core-store'
import type { SealedSecret } from '~/ports/secret-box'

/** The API shape of a connection: no credential and no sealed bytes, through the contract's schema. */
export function toCalendarConnectionResponse(record: CalendarConnectionRecord): CalendarConnection {
  return calendarConnectionSchema.parse({
    membershipId: record.membershipId,
    provider: record.provider,
    state: record.state,
    connectedAt: record.connectedAt.toISOString(),
    lastCheckedAt: record.lastCheckedAt?.toISOString() ?? null,
  })
}

/** One byte for the key id's length, the key id, then the ciphertext: the table has no key id column. */
export function packSealed(sealed: SealedSecret): Uint8Array {
  const keyId = new TextEncoder().encode(sealed.keyId)
  const out = new Uint8Array(1 + keyId.length + sealed.ciphertext.length)
  out[0] = keyId.length
  out.set(keyId, 1)
  out.set(sealed.ciphertext, 1 + keyId.length)
  return out
}

/** The inverse of {@link packSealed}; `null` for bytes that are not in that shape. */
export function unpackSealed(bytes: Uint8Array): SealedSecret | null {
  const length = bytes[0]
  if (length === undefined || bytes.length < 1 + length) {
    return null
  }
  return {
    keyId: new TextDecoder().decode(bytes.subarray(1, 1 + length)),
    ciphertext: bytes.subarray(1 + length),
  }
}

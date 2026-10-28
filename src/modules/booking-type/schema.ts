import { createHash, createHmac } from 'node:crypto'
import {
  BOOKING_ADMIN_ROLES,
  type BookingType,
  bookingTypeCursorSchema,
  bookingTypeSchema,
  type OrganizationId,
  type Role,
} from 'tula-closeline-contract'
import type { BookingTypeRecord } from '~/ports/booking-store'

/** The cursor of a list of Booking Types: the contract's. */
export const bookingTypeCursor = bookingTypeCursorSchema

/**
 * The link token of a Booking Type: the HMAC of its Organization and id under `BOOKING_LINK_KEY`,
 * 43 characters of base64url. Only its SHA-256 is stored; core derives it again to show it to an
 * Owner or Admin, and nobody without the key can derive it from the id.
 */
export function linkTokenOf(key: string, organizationId: OrganizationId, id: string): string {
  return createHmac('sha256', key)
    .update(`booking-link|${organizationId}|${id}`)
    .digest('base64url')
}

/**
 * The manage token of a public Booking: the HMAC of its id under `BOOKING_LINK_KEY`, 43
 * characters of base64url. Derived, so an idempotent replay shows the same one; only its SHA-256
 * is stored.
 */
export function manageTokenOf(key: string, bookingId: string): string {
  return createHmac('sha256', key).update(`booking-manage:${bookingId}`).digest('base64url')
}

/** The hex SHA-256 the table stores for a link token. */
export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The API shape of a Booking Type; the link token is shown to Owner and Admin only. */
export function toBookingTypeResponse(
  record: BookingTypeRecord,
  role: Role,
  key: string,
  organizationId: OrganizationId
): BookingType {
  const mayReadToken = (BOOKING_ADMIN_ROLES as readonly Role[]).includes(role)
  return bookingTypeSchema.parse({
    id: record.id,
    name: record.name,
    lengthMinutes: record.lengthMinutes,
    bufferBeforeMinutes: record.bufferBeforeMinutes,
    bufferAfterMinutes: record.bufferAfterMinutes,
    minimumNoticeMinutes: record.minimumNoticeMinutes,
    mode: record.mode,
    state: record.state,
    publicToken:
      mayReadToken && record.publicTokenHash !== null
        ? linkTokenOf(key, organizationId, record.id)
        : null,
    createdAt: record.createdAt.toISOString(),
  })
}

import {
  BOOKING_ERRORS,
  ERRORS,
  formatId,
  type PublicBookingConfirmation,
  type PublicBookRequest,
  publicBookingConfirmationSchema,
  type publicListSlotsQuerySchema,
  type publicSlotPageSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { hashClientAddress } from '~/http/client-address'
import { domainError, RetryAfterError } from '~/http/domain-error'
import * as Bookings from '~/modules/booking/service'
import { hashLinkToken } from '~/modules/booking-type/schema'

/** The most requests one client address may make to the public booking routes in one window. */
export const BOOKING_ADDRESS_LIMIT = 120

/** The most requests one Booking Type link may take in one window, from all addresses together. */
export const BOOKING_TOKEN_LIMIT = 600

/** The length of the rate-limit window, in seconds. */
export const BOOKING_RATE_WINDOW_SECONDS = 600

/** What the public booking service needs from the container. */
export type PublicBookingDeps = Bookings.BookingDeps & Pick<Container, 'env' | 'demoRateLimiter'>

/** Counts one request against a budget; refuses with `rate.limited` and the wait once it is spent. */
async function limit(
  deps: PublicBookingDeps,
  kind: 'address' | 'token',
  subject: string,
  max: number
): Promise<void> {
  // Keys of their own, so these budgets do not mix with the demo form's or the consent form's.
  const hash = hashClientAddress(subject, `${deps.env.DEMO_RATE_KEY}:booking-${kind}`)
  const allowed = await deps.demoRateLimiter.hit(hash, {
    windowSeconds: BOOKING_RATE_WINDOW_SECONDS,
    limit: max,
  })
  if (!allowed) {
    throw new RetryAfterError(ERRORS['rate.limited'], BOOKING_RATE_WINDOW_SECONDS, {
      retryAfter: BOOKING_RATE_WINDOW_SECONDS,
    })
  }
}

/**
 * Counts the request by client address, finds what the link token opens by its SHA-256 and counts
 * it by link; an unknown, wrong or retired token is `booking.type_not_found`. Unknown tokens are
 * counted by address only, so a guesser cannot grow the counter table.
 */
async function open(deps: PublicBookingDeps, token: string, address: string) {
  await limit(deps, 'address', address, BOOKING_ADDRESS_LIMIT)
  const tokenHash = hashLinkToken(token)
  const where = await deps.store.bookingTypeForToken(tokenHash)
  if (!where) {
    throw domainError(BOOKING_ERRORS['booking.type_not_found'])
  }
  await limit(deps, 'token', tokenHash, BOOKING_TOKEN_LIMIT)
  return where
}

/** One page of the link's free times: a start and an end each, and the Booking Type's name, length and mode. */
export async function slots(
  deps: PublicBookingDeps,
  input: {
    token: string
    address: string
    query: z.infer<typeof publicListSlotsQuerySchema>
  }
): Promise<z.infer<typeof publicSlotPageSchema>> {
  const where = await open(deps, input.token, input.address)
  return Bookings.listPublicSlots(deps, where, input.query)
}

/**
 * Books a time through the link. A non-empty honeypot answers like a real booking but stores
 * nothing and calls no calendar. Otherwise {@link Bookings.bookPublic}: 201 the first time, 200 on
 * a replay of the same Idempotency-Key.
 */
export async function bookTime(
  deps: PublicBookingDeps,
  input: { token: string; address: string; idempotencyKey: string; request: PublicBookRequest }
): Promise<{ status: 200 | 201; body: PublicBookingConfirmation }> {
  const where = await open(deps, input.token, input.address)
  if (input.request.website !== '') {
    const type = await deps.store.withOrganization(where.organizationId, (scope) =>
      scope.findBookingType(where.bookingTypeId)
    )
    if (type?.state !== 'active') {
      throw domainError(BOOKING_ERRORS['booking.type_not_found'])
    }
    const startsAt = new Date(input.request.startsAt)
    return {
      status: 201,
      body: publicBookingConfirmationSchema.parse({
        id: formatId('bkg', crypto.randomUUID()),
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + type.lengthMinutes * 60_000).toISOString(),
        mode: type.mode,
        // shortcut: a video type's real answer has a join URL, so a bot can tell this one apart; add a placeholder if bots adapt.
        joinUrl: null,
      }),
    }
  }
  return Bookings.bookPublic(deps, where, input.idempotencyKey, input.request)
}

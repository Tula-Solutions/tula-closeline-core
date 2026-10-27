import {
  BOOKING_ERRORS,
  type BookingType,
  type BookingTypeId,
  bookingTypeSchema,
  type CreateBookingTypeRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type listBookingTypesQuerySchema,
  type Page,
  type updateBookingTypeRequestSchema,
} from 'tula-closeline-contract'
import type { z } from 'zod'
import type { Container } from '~/container'
import { domainError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { BookingTypeNameTakenError } from '~/ports/booking-store'
import type { OrganizationScope } from '~/ports/core-store'
import { bookingTypeCursor, hashLinkToken, linkTokenOf, toBookingTypeResponse } from './schema'

/** What the Booking Type service needs from the container. */
export type BookingTypeDeps = Pick<Container, 'store' | 'clock' | 'logger' | 'env'>

/** The query of a list of Booking Types. */
type ListQuery = z.infer<typeof listBookingTypesQuerySchema>

/** What an update may change. */
type UpdateRequest = z.infer<typeof updateBookingTypeRequestSchema>

/** What a write call is given besides its request: the validated `Idempotency-Key`, if sent. */
export type BookingTypeCallOptions = { idempotencyKey?: string | undefined }

/** Lengths are offered in steps of this many minutes. */
const LENGTH_STEP_MINUTES = 5

/** `booking.type_invalid` unless the length is a whole number of steps. */
function requireValidLength(lengthMinutes: number): void {
  if (lengthMinutes % LENGTH_STEP_MINUTES !== 0) {
    throw domainError(BOOKING_ERRORS['booking.type_invalid'], { field: 'lengthMinutes' })
  }
}

/** Runs a whole transaction, answering a taken name as `request.conflict` (409). The store raises it as the transaction ends, so it can only be caught outside. */
async function orConflict<T>(transaction: () => Promise<T>): Promise<T> {
  try {
    return await transaction()
  } catch (error) {
    if (error instanceof BookingTypeNameTakenError) {
      throw domainError(ERRORS['request.conflict'], { field: 'name' })
    }
    throw error
  }
}

/** The Booking Type `id`, or `booking.type_not_found`. */
async function requireType(scope: OrganizationScope, id: BookingTypeId) {
  const found = await scope.findBookingType(id)
  if (!found) {
    throw domainError(BOOKING_ERRORS['booking.type_not_found'])
  }
  return found
}

/**
 * Creates a Booking Type with a fresh public link token (only its hash is stored). Owner and
 * Admin only. With an `Idempotency-Key` the same request again returns the first one (200).
 */
export async function create(
  deps: BookingTypeDeps,
  caller: Caller,
  request: CreateBookingTypeRequest,
  options: BookingTypeCallOptions
): Promise<IdempotentAnswer<200 | 201, BookingType>> {
  const now = deps.clock.now()
  const key = deps.env.UNSUBSCRIBE_TOKEN_KEY
  const answer = await orConflict(() =>
    deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: 'booking_types.create',
          request: { body: request },
          status: 201,
          response: bookingTypeSchema,
        },
        async () => {
          const access = await openOrganizationForWrite(scope, caller, 'booking_type.create')
          requireValidLength(request.lengthMinutes)
          const id = formatId('bkt', crypto.randomUUID())
          const record = await scope.insertBookingType({
            id,
            name: request.name,
            lengthMinutes: request.lengthMinutes,
            bufferBeforeMinutes: request.bufferBeforeMinutes,
            bufferAfterMinutes: request.bufferAfterMinutes,
            minimumNoticeMinutes: request.minimumNoticeMinutes,
            mode: request.mode,
            publicTokenHash: hashLinkToken(linkTokenOf(key, caller.organizationId, id)),
            now,
          })
          return toBookingTypeResponse(record, access.role, key, caller.organizationId)
        }
      )
    )
  )
  return { status: answer.replayed ? 200 : 201, body: answer.body, replayed: answer.replayed }
}

/** Reads one Booking Type. Any role; the link token is shown to Owner and Admin only. */
export async function get(
  deps: Pick<BookingTypeDeps, 'store' | 'env'>,
  caller: Caller,
  id: BookingTypeId
): Promise<BookingType> {
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'booking_type.read')
    return toBookingTypeResponse(
      await requireType(scope, id),
      caller.role,
      deps.env.UNSUBSCRIBE_TOKEN_KEY,
      caller.organizationId
    )
  })
}

/** Lists the Booking Types, newest first, one page at a time (at most 100), optionally of one state. */
export async function list(
  deps: Pick<BookingTypeDeps, 'store' | 'env'>,
  caller: Caller,
  query: ListQuery
): Promise<Page<BookingType>> {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, bookingTypeCursor)
  if (query.cursor !== undefined && after === undefined) {
    throw domainError(ERRORS['request.invalid'], { field: 'cursor' })
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'booking_type.read')
    const rows = await scope.listBookingTypes({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after: { at: new Date(after.createdAt), id: after.id } }),
      ...(query.state === undefined ? {} : { state: query.state }),
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map((row) =>
        toBookingTypeResponse(
          row,
          caller.role,
          deps.env.UNSUBSCRIBE_TOKEN_KEY,
          caller.organizationId
        )
      ),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    }
  })
}

/** Changes fields of a Booking Type. Owner and Admin only. */
export async function update(
  deps: BookingTypeDeps,
  caller: Caller,
  id: BookingTypeId,
  request: UpdateRequest
): Promise<BookingType> {
  const now = deps.clock.now()
  return orConflict(() =>
    deps.store.withOrganization(caller.organizationId, async (scope) => {
      const access = await openOrganizationForWrite(scope, caller, 'booking_type.update')
      await requireType(scope, id)
      if (request.lengthMinutes !== undefined) {
        requireValidLength(request.lengthMinutes)
      }
      const changed = await scope.updateBookingType(id, request, now)
      if (!changed) {
        throw domainError(BOOKING_ERRORS['booking.type_not_found'])
      }
      return toBookingTypeResponse(
        changed,
        access.role,
        deps.env.UNSUBSCRIBE_TOKEN_KEY,
        caller.organizationId
      )
    })
  )
}

/** Retires a Booking Type; retiring a retired one answers it unchanged. Owner and Admin only. */
export async function retire(
  deps: BookingTypeDeps,
  caller: Caller,
  id: BookingTypeId
): Promise<BookingType> {
  const now = deps.clock.now()
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    const access = await openOrganizationForWrite(scope, caller, 'booking_type.retire')
    const current = await requireType(scope, id)
    const retired = current.state === 'retired' ? current : await scope.retireBookingType(id, now)
    if (!retired) {
      throw domainError(BOOKING_ERRORS['booking.type_not_found'])
    }
    return toBookingTypeResponse(
      retired,
      access.role,
      deps.env.UNSUBSCRIBE_TOKEN_KEY,
      caller.organizationId
    )
  })
}

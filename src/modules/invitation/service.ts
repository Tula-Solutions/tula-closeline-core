import {
  CORE_ERRORS,
  type CreateInvitationRequest,
  decodeCursor,
  ERRORS,
  encodeCursor,
  formatId,
  type Invitation,
  type InvitationId,
  invitationSchema,
  type ListInvitationsQuery,
  type ListInvitationsResponse,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { domainError, RetryAfterError } from '~/http/domain-error'
import type { Caller } from '~/modules/caller'
import { type IdempotentAnswer, idempotent } from '~/modules/idempotency/service'
import { isAllowed } from '~/modules/member/permission'
import { openOrganization, openOrganizationForWrite } from '~/modules/organization/access'
import { InvitationAlreadyPendingError, LockTimeoutError } from '~/ports/core-store'
import type { InvitationMessage } from '~/ports/invitation-mailer'
import { invitationLink } from './link'
import { invitationCursorSchema, toInvitationCursor, toInvitationResponse } from './schema'
import {
  generateToken,
  hashToken,
  INVITATION_SEND_BUDGET,
  INVITATION_SEND_WINDOW_MS,
  INVITATION_TTL_MS,
  MAX_PENDING_INVITATIONS,
} from './token'

/** What the Invitation service needs from the container. */
export type InvitationDeps = Pick<
  Container,
  'store' | 'clock' | 'invitationMailer' | 'env' | 'logger'
>

/** What a create is given besides its request: the validated `Idempotency-Key` header, if sent. */
export type CreateInvitationOptions = { idempotencyKey?: string | undefined }

/** The route name an Invitation create is stored under. */
const CREATE_ROUTE = 'invitations.create'

/** The most expired pending Invitations one create revokes to make room under the cap. */
const EXPIRED_REVOKE_BATCH = 100

/**
 * Whole seconds until the oldest counted Invitation leaves the send window: at least 1 and at most
 * the window, whatever the clock and the stored time say.
 */
function secondsUntilWindowOpens(oldest: Date | null, now: Date): number {
  const windowSeconds = INVITATION_SEND_WINDOW_MS / 1000
  if (oldest === null) {
    return windowSeconds
  }
  const seconds = Math.ceil((oldest.getTime() + INVITATION_SEND_WINDOW_MS - now.getTime()) / 1000)
  return Math.min(windowSeconds, Math.max(1, seconds))
}

/** Maps the store's rule errors to the contract's codes; any other error passes unchanged. */
function asDomainError(error: unknown): unknown {
  if (error instanceof InvitationAlreadyPendingError) {
    return domainError(CORE_ERRORS['invitation.already_pending'])
  }
  return error
}

/**
 * Hands the message to the mail adapter within `INVITATION_DELIVERY_TIMEOUT_MS`. Whatever goes
 * wrong, the error that comes out names nothing: the adapter's own error may carry the message.
 */
async function deliver(deps: InvitationDeps, message: InvitationMessage): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.env.INVITATION_DELIVERY_TIMEOUT_MS)
  try {
    await Promise.race([
      deps.invitationMailer.deliver(message, controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('delivery timed out')))
      }),
    ])
  } catch {
    throw new Error('invitation delivery failed')
  } finally {
    clearTimeout(timer)
  }
}

/** How many times the compensating revoke runs: the first, and one more after a lock timeout. */
const REVOKE_ATTEMPTS = 2

/**
 * Revokes an Invitation whose message was not handed over, in a transaction of its own, and frees
 * the request's idempotency key so the retry is a new attempt. A lock
 * timeout (the Organization lock was held too long, which is what made the caller's request slow
 * in the first place) is tried once more; any other failure, or a second timeout, is logged.
 */
async function revokeUndelivered(
  deps: InvitationDeps,
  caller: Caller,
  invitationId: InvitationId,
  idempotencyKey: string | undefined
): Promise<void> {
  const now = deps.clock.now()
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.store.withOrganization(caller.organizationId, async (scope) => {
        await scope.lockOrganization()
        await scope.revokeInvitation(invitationId, now)
        // The create committed with its answer stored, but the answer was a failure after all: free the key.
        if (idempotencyKey !== undefined) {
          await scope.deleteIdempotencyKey({
            userId: caller.userId,
            route: CREATE_ROUTE,
            key: idempotencyKey,
          })
        }
      })
      return
    } catch (error) {
      if (error instanceof LockTimeoutError && attempt < REVOKE_ATTEMPTS) {
        continue
      }
      // The Invitation stays pending with no message behind it, which an Owner can see and revoke.
      deps.logger.error('could not revoke an invitation whose delivery failed', {
        invitationId,
        reason: error instanceof Error ? error.name : 'unknown',
      })
      return
    }
  }
}

/**
 * Invites someone. Owner: any invitable role. Admin: Manager or Rep. In one transaction, under the
 * Organization's lock: the caller's role is read again, a pending Invitation for the email is
 * locked, then the Team (if any), which must exist (the order accept takes them in); the pending
 * Invitation for the email that has expired is revoked to make room and one that has not is
 * `invitation.already_pending`; up to 100 other expired pending Invitations are revoked; and the
 * Organization may hold at most 1,000 pending Invitations and may create at most 2,000 in any 24
 * hours, revoked ones counted (both `rate.limited`, the second with `Retry-After`). Only the
 * SHA-256 of the 32-byte random token is stored. After the commit the message is handed to the mail adapter; if that fails the Invitation is revoked in a
 * second transaction and the answer is `server.unavailable`, so a pending Invitation always means
 * a message was handed over. (This becomes an outbox row and a queue job when the queue port
 * exists.) The raw token is in no response, log or error.
 *
 * With an `Idempotency-Key` the same request again returns the first Invitation (the
 * response, which never holds the token, is what is stored) and sends no second message. If the
 * delivery fails, the key is freed with the revoke, so a failed request can be retried with it.
 */
export async function create(
  deps: InvitationDeps,
  caller: Caller,
  request: CreateInvitationRequest,
  options: CreateInvitationOptions = {}
): Promise<IdempotentAnswer<201, Invitation>> {
  const now = deps.clock.now()
  const token = generateToken()
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS)
  const invitationId = formatId('inv', crypto.randomUUID())

  let organizationName = ''
  let created: IdempotentAnswer<201, Invitation>
  try {
    created = await deps.store.withOrganization(caller.organizationId, (scope) =>
      idempotent(
        deps,
        scope,
        caller,
        {
          key: options.idempotencyKey,
          route: CREATE_ROUTE,
          request: { body: request },
          status: 201,
          response: invitationSchema,
        },
        async () => {
          const { organization, role: actor } = await openOrganizationForWrite(
            scope,
            caller,
            'invitation.create'
          )
          if (!isAllowed({ actor, action: 'invitation.create', offeredRole: request.role })) {
            throw domainError(ERRORS['auth.forbidden'])
          }
          // The Invitation lock comes before the Team lock, the order accept takes them in.
          const pending = await scope.lockPendingInvitationByEmail(request.email)
          if (request.teamId !== undefined && !(await scope.lockTeam(request.teamId))) {
            throw domainError(CORE_ERRORS['team.not_found'])
          }
          if (pending) {
            if (pending.expiresAt.getTime() > now.getTime()) {
              throw domainError(CORE_ERRORS['invitation.already_pending'])
            }
            await scope.revokeInvitation(pending.id, now)
          }
          // Expired ones would count toward the cap until someone revoked them one by one; clear a
          // bounded batch first, so a bulk invite that went unanswered cannot lock the Organization out.
          await scope.revokeExpiredInvitations(
            now,
            EXPIRED_REVOKE_BATCH,
            new Date(now.getTime() - INVITATION_TTL_MS)
          )
          if (
            (await scope.countPendingInvitations(MAX_PENDING_INVITATIONS)) >=
            MAX_PENDING_INVITATIONS
          ) {
            throw domainError(ERRORS['rate.limited'])
          }
          // Counts the revoked ones too, which the cap above does not: revoking frees the cap, never
          // this, so create-and-revoke cannot send mail without limit.
          const sent = await scope.countInvitationsSince(
            new Date(now.getTime() - INVITATION_SEND_WINDOW_MS),
            INVITATION_SEND_BUDGET + 1
          )
          if (sent.count >= INVITATION_SEND_BUDGET) {
            throw new RetryAfterError(
              ERRORS['rate.limited'],
              secondsUntilWindowOpens(sent.oldest, now)
            )
          }
          const record = await scope.insertInvitation({
            id: invitationId,
            email: request.email,
            role: request.role,
            teamId: request.teamId ?? null,
            invitedByUserId: caller.userId,
            tokenHash: hashToken(token),
            expiresAt,
            now,
          })
          organizationName = organization.name
          return toInvitationResponse(record)
        }
      )
    )
  } catch (error) {
    throw asDomainError(error)
  }
  if (created.replayed) {
    return created
  }

  try {
    await deliver(deps, {
      email: created.body.email,
      role: created.body.role,
      organizationName,
      token,
      link: invitationLink(deps.env.PORTAL_BASE_URL, token),
      expiresAt,
    })
  } catch {
    await revokeUndelivered(deps, caller, invitationId, options.idempotencyKey)
    throw domainError(ERRORS['server.unavailable'])
  }
  return created
}

/** Lists Invitations in one state (pending unless asked), newest first, one page at a time. Owner and Admin. */
export async function list(
  deps: Pick<InvitationDeps, 'store'>,
  caller: Caller,
  query: ListInvitationsQuery
): Promise<ListInvitationsResponse> {
  const cursor =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor, invitationCursorSchema)
  if (query.cursor !== undefined && cursor === undefined) {
    throw domainError(ERRORS['request.invalid'])
  }
  return deps.store.withOrganization(caller.organizationId, async (scope) => {
    await openOrganization(scope, caller, 'invitation.list')
    // One extra row says whether another page follows without a count.
    const rows = await scope.listInvitations({
      state: query.state,
      ...(cursor === undefined
        ? {}
        : { after: { createdAt: new Date(cursor.createdAt), id: cursor.id } }),
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      items: page.map(toInvitationResponse),
      nextCursor: rows.length > query.limit && last ? encodeCursor(toInvitationCursor(last)) : null,
    }
  })
}

/**
 * Revokes a pending Invitation. Owner: any. Admin: one that offers Manager or Rep. One that is not
 * pending, or belongs to another Organization, is `invitation.not_found`.
 */
export async function revoke(
  deps: Pick<InvitationDeps, 'store' | 'clock'>,
  caller: Caller,
  invitationId: InvitationId
): Promise<void> {
  const now = deps.clock.now()
  await deps.store.withOrganization(caller.organizationId, async (scope) => {
    const { role: actor } = await openOrganizationForWrite(scope, caller, 'invitation.revoke')
    const target = await scope.lockInvitation(invitationId)
    if (target?.state !== 'pending') {
      throw domainError(CORE_ERRORS['invitation.not_found'])
    }
    if (!isAllowed({ actor, action: 'invitation.revoke', targetRole: target.role })) {
      throw domainError(ERRORS['auth.forbidden'])
    }
    if (!(await scope.revokeInvitation(target.id, now))) {
      throw domainError(CORE_ERRORS['invitation.not_found'])
    }
  })
}

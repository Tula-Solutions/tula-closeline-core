import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  contactCheckRequestSchema,
  contactCheckResultSchema,
  ingestMessageRequestSchema,
  ingestMessageResultSchema,
  internalAbandonOrganizationParamsSchema,
  internalAbandonOrganizationRequestSchema,
  internalAbandonOrganizationResponseSchema,
  internalAcceptInvitationResponseSchema,
  internalCreateOrganizationRequestSchema,
  internalCreateOrganizationResponseSchema,
  internalDirectoryMembershipRequestSchema,
  internalDirectoryMembershipResponseSchema,
  internalDirectoryRepCheckRequestSchema,
  internalDirectoryRepCheckResponseSchema,
  internalDirectoryTeamCheckRequestSchema,
  internalDirectoryTeamCheckResponseSchema,
  internalMembershipRequestSchema,
  internalMembershipResponseSchema,
  publishedInstructionsSchema,
  recordedSuppressionSchema,
  recordWithdrawalRequestSchema,
  verifyApiKeyRequestSchema,
  verifyApiKeyResponseSchema,
} from 'tula-closeline-contract'
import type { Container } from '~/container'
import { internalAuth } from '~/http/internal-auth'
import {
  errorResponse,
  errorResponseWithRetryAfter,
  idempotencyKeyHeaderSchema,
} from '~/http/responses'
import { createRouter } from '~/http/router'
import { INTERNAL_SECURITY } from '~/http/security'
import type { AppEnv } from '~/http/types'
import { internalPublishedRequestSchema } from '~/modules/agent-instruction/schema'
import * as AgentInstructions from '~/modules/agent-instruction/service'
import * as ApiKeys from '~/modules/api-key/service'
import * as ContactChecks from '~/modules/contact-check/service'
import * as Directory from '~/modules/directory/service'
import { organizationHeaderSchema } from '~/modules/inbox/schema'
import * as Inbox from '~/modules/inbox/service'
import { acceptInvitationBodySchema } from '~/modules/invitation/schema'
import * as Withdrawals from '~/modules/withdrawal/service'
import * as Internal from './service'

const security = [{ [INTERNAL_SECURITY]: [] }]

const createOrganization = createRoute({
  method: 'post',
  path: '/organizations',
  tags: ['internal'],
  summary: 'Create an Organization at sign-up',
  description:
    'Called only by the auth service. Creates the Organization and the user as its Owner in one ' +
    'transaction. Idempotent on the user id: a user who already owns an Organization gets it back. ' +
    "The request's email and name are stored on the Membership as core's copy (a missing or null " +
    'name is stored as null; a replay never changes a stored copy). The contract leaves email ' +
    'optional only so core can deploy before auth sends it, but a Membership cannot exist ' +
    'without one: a request without email is refused with request.invalid before anything is ' +
    'written.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalCreateOrganizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Organization the user owns, newly created or created by an earlier call.',
      content: { 'application/json': { schema: internalCreateOrganizationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse(
      'membership.already_member: the user belongs to an Organization they do not own.'
    ),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const ingestMessage = createRoute({
  method: 'post',
  path: '/messages',
  tags: ['internal'],
  summary: 'Store a Message a channel service reports',
  description:
    'Called only by the channel services, with the shared secret and no user token. The ' +
    'Organization is the one in the `X-Organization-Id` header, never the body; a Prospect outside ' +
    'it (unknown, or of another Organization) is `inbox.prospect_not_found` and nothing is stored. ' +
    'Idempotent on channel plus provider message id: the first post stores the Message and answers ' +
    '201, a repeat answers 200 with the same Message and stores nothing. The Conversation of the ' +
    'Prospect and channel is found or created, owned by the Prospect owner, with the Agent in ' +
    'control. An outbound Message that names a Draft must name a Draft of that Conversation. The ' +
    'body is untrusted text and is never logged.',
  security,
  request: {
    headers: organizationHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: ingestMessageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Message was already stored; it is returned unchanged.',
      content: { 'application/json': { schema: ingestMessageResultSchema } },
    },
    201: {
      description: 'The Message was stored.',
      content: { 'application/json': { schema: ingestMessageResultSchema } },
    },
    400: errorResponse('The request or the X-Organization-Id header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    404: errorResponse('inbox.prospect_not_found'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable'),
  },
})

const membership = createRoute({
  method: 'post',
  path: '/membership',
  tags: ['internal'],
  summary: 'Look up the membership of a user',
  description:
    'Called only by the auth service, from the token hook on every sign-in and refresh. Two ' +
    'indexed reads. A user with no membership is answered found: false, not an error.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalMembershipRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The user is a member (with the Organization status), or is not.',
      content: { 'application/json': { schema: internalMembershipResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const acceptInvitation = createRoute({
  method: 'post',
  path: '/invitations/accept',
  tags: ['internal'],
  summary: 'Accept an Invitation at sign-up',
  description:
    'Called only by the auth service with the raw token and the verified address. Creates the ' +
    "Membership with the offered role (never Owner) and stores the request's address, which must " +
    "equal the Invitation's, and its name (null when absent) as core's copy, adds it to the " +
    "Invitation's Team if it " +
    'names one, and marks the Invitation accepted, in one transaction. A retry by the same user ' +
    'answers as the first call did. Every way the Invitation cannot be used (unknown, expired, ' +
    'revoked, used, a different address, an Organization that is not active) is the same ' +
    'invitation.invalid; an Organization status is never revealed.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: acceptInvitationBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'The Organization joined and the role offered.',
      content: { 'application/json': { schema: internalAcceptInvitationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse('membership.already_member: the user belongs to an Organization.'),
    422: errorResponse('invitation.invalid'),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponse('server.unavailable: a lock timed out; try again.'),
  },
})

const abandonOrganization = createRoute({
  method: 'post',
  path: '/organizations/{organizationId}/abandon',
  tags: ['internal'],
  summary: 'Abandon an Organization whose Owner has no account',
  description:
    'Called only by the auth service, when the account write fails after core created the ' +
    'Organization and from its sweep of abandoned sign-ups. Defined by its end state: it answers ' +
    'status deleted whenever no live Organization with this id exists when the call returns ' +
    '(abandoned by this call, deleted or abandoned earlier, or never created), so success does ' +
    'not mean this call deleted it and a repeat, with the same key, a new key or another user, ' +
    'answers success. A live Organization is abandoned only if it is active (a suspended one is never abandoned: a ' +
    'suspension is deliberate), has exactly one member, that ' +
    'member is the userId and it was created less than 24 hours ago by the database clock; ' +
    'otherwise organization.not_abandonable and nothing changes. The check and the delete are ' +
    'one transaction holding the Organization lock, so a concurrent accept either lands first ' +
    '(then this refuses) or finds the Organization deleted. The only member is removed in the ' +
    'same transaction, so the user id is free when it returns; Teams, Invitations and the rest ' +
    'are left to the deletion job, and a pending Invitation can no longer be accepted.',
  security,
  request: {
    headers: idempotencyKeyHeaderSchema,
    params: internalAbandonOrganizationParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: internalAbandonOrganizationRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'No live Organization with this id exists any more.',
      content: { 'application/json': { schema: internalAbandonOrganizationResponseSchema } },
    },
    400: errorResponse('The request or the Idempotency-Key header is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    409: errorResponse(
      'organization.not_abandonable: a live Organization has another member, a different sole member, is a day old or more, or is suspended.'
    ),
    500: errorResponse('Something went wrong on our side.'),
    503: errorResponseWithRetryAfter('server.unavailable: a lock timed out; try again.'),
  },
})

const contactCheck = createRoute({
  method: 'post',
  path: '/v1/contact-checks',
  tags: ['internal'],
  summary: 'Check whether a contact may be reached',
  description:
    'Called only by the services that contact people, with the shared secret and no user token; ' +
    'the Organization is named in the body. Always answers 200 with a result: allowed (with the ' +
    'basis) or denied (with a code and, for a suppressed address, the Suppression reason). Fails ' +
    'closed: a missing or deleted Organization and an unknown Prospect are `consent.missing`. ' +
    'Every answer about a live Organization is written to the audit log first; if that fails the ' +
    'call fails with 500 and the caller must treat it as `consent.unavailable` and not contact. ' +
    'An Agent may call, text or message on WhatsApp only with a granted Contact Consent for the ' +
    'channel; email needs no consent, only that the address is not suppressed; LinkedIn is not ' +
    'allowed to an Agent. A suppressed address is refused for every purpose. A check by address ' +
    'reads no consent, so a channel that needs consent is `consent.missing`. A Prospect together ' +
    'with the address about to be used (`phone`, `email` or `linkedinUrl`, by the channel) must name ' +
    "one of that Prospect's own addresses, or the answer is `consent.missing`; Suppression is then " +
    "tested on that address and consent is read from the Prospect's ledger. There is no setting " +
    'that turns the check off (ADR 0003).',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: contactCheckRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The result of the check.',
      content: { 'application/json': { schema: contactCheckResultSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side: treat as consent.unavailable.'),
  },
})

const recordWithdrawal = createRoute({
  method: 'post',
  path: '/v1/consent-withdrawals',
  tags: ['internal'],
  summary: 'Record a STOP a channel adapter received',
  description:
    'Called only by the channel adapters, with the shared secret and no user token; the ' +
    "Organization is named in the body, from the adapter's own record of the message. Adds a " +
    '`stop` Suppression entry for the address and appends a `stop_reply` withdrawal on the ' +
    'channel (or on every channel with `stopAll`) for the Prospect that holds the address, in one ' +
    'transaction; an address no Prospect holds is still suppressed. Exactly one address is given ' +
    'and it must be the kind the channel uses. Idempotent by state: a repeat of the same STOP ' +
    'answers the same entry and writes and publishes nothing. A suspended Organization still ' +
    'takes a STOP; a deleted one is `organization.deleted`.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: recordWithdrawalRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Suppression entry and the Prospect, if one is known.',
      content: { 'application/json': { schema: recordedSuppressionSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    404: errorResponse('organization.not_found: no such Organization.'),
    409: errorResponse('organization.deleted: the Organization is deleted.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const DIRECTORY_NOTE =
  'Called only by other services (voice), with the shared secret and no user token; the ' +
  'Organization is named in the body. One indexed read inside that Organization, never a list. '

const verifyApiKey = createRoute({
  method: 'post',
  path: '/api-keys/verify',
  tags: ['internal'],
  summary: 'Check an API key secret for the token exchange',
  description:
    'Called only by the auth service. Compares the presented secret in constant time against the ' +
    'stored hash and answers the key, its Organization, scopes, role ceiling and expiry. An ' +
    'unknown or malformed secret is apikey.invalid; a revoked or expired key (or one of an ' +
    'Organization that is not active) is apikey.revoked; a key over its limit is ' +
    'apikey.rate_limited with Retry-After. A good use is counted against the key. The secret is ' +
    'never logged and the Organization is never taken from the caller.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: verifyApiKeyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The key is good.',
      content: { 'application/json': { schema: verifyApiKeyResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('apikey.invalid, apikey.revoked, or the internal secret is wrong.'),
    429: errorResponseWithRetryAfter('apikey.rate_limited'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const agentInstructionsPublished = createRoute({
  method: 'post',
  path: '/v1/agent-instructions/published',
  tags: ['internal'],
  summary: 'Read the published Agent instructions of an Organization',
  description:
    'Called only by Agent services (voice, outbound), with the shared secret and no user token; ' +
    'the Organization is named in the body. Answers the published version with its text and ' +
    'number, or version: null when none is published or the Organization is not active. Two indexed reads, nothing written.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: internalPublishedRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The published version, or version: null.',
      content: { 'application/json': { schema: publishedInstructionsSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const directoryMembership = createRoute({
  method: 'post',
  path: '/v1/directory/membership',
  tags: ['internal'],
  summary: "Look up a user's Membership in an Organization",
  description:
    `${DIRECTORY_NOTE}Answers found: false for a user who is not a member of that Organization, ` +
    'including one who belongs to another.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: internalDirectoryMembershipRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The Membership with the Organization status, or found: false.',
      content: { 'application/json': { schema: internalDirectoryMembershipResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const directoryRepCheck = createRoute({
  method: 'post',
  path: '/v1/directory/rep-check',
  tags: ['internal'],
  summary: 'Check that a Membership is a Rep',
  description:
    `${DIRECTORY_NOTE}True only when the Membership exists in that Organization and has the ` +
    'Rep role.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: internalDirectoryRepCheckRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Whether the Membership is a Rep.',
      content: { 'application/json': { schema: internalDirectoryRepCheckResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

const directoryTeamCheck = createRoute({
  method: 'post',
  path: '/v1/directory/team-check',
  tags: ['internal'],
  summary: 'Check that a Team exists',
  description:
    `${DIRECTORY_NOTE}True only when the Team exists in that Organization; a Team of another ` +
    'Organization is false.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: internalDirectoryTeamCheckRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Whether the Team exists.',
      content: { 'application/json': { schema: internalDirectoryTeamCheckResponseSchema } },
    },
    400: errorResponse('The request is not valid.'),
    401: errorResponse('The internal secret is missing or wrong.'),
    500: errorResponse('Something went wrong on our side.'),
  },
})

/**
 * The calls only other services make (mostly auth), under `/internal`. They sit behind the shared secret and
 * never behind the public access-token middleware, and they take no Organization from the caller.
 */
export function createInternalRouter(container: Container): OpenAPIHono<AppEnv> {
  const router = createRouter()
  router.use('*', internalAuth(container.env.INTERNAL_API_TOKENS))

  router.openapi(createOrganization, async (c) =>
    c.json(await Internal.createOrganization(container, c.req.valid('json')), 200)
  )

  router.openapi(acceptInvitation, async (c) =>
    c.json(await Internal.acceptInvitation(container, c.req.valid('json')), 200)
  )

  router.openapi(abandonOrganization, async (c) =>
    c.json(
      await Internal.abandonOrganization(
        container,
        c.req.valid('param').organizationId,
        c.req.valid('json')
      ),
      200
    )
  )

  router.openapi(membership, async (c) =>
    c.json(await Internal.lookupMembership(container, c.req.valid('json').userId), 200)
  )

  router.openapi(ingestMessage, async (c) => {
    const result = await Inbox.ingestMessage(
      container,
      c.req.valid('header')['x-organization-id'],
      c.req.valid('json')
    )
    return c.json(result, result.created ? 201 : 200)
  })

  router.openapi(contactCheck, async (c) =>
    c.json(await ContactChecks.check(container, c.req.valid('json')), 200)
  )

  router.openapi(verifyApiKey, async (c) =>
    c.json(await ApiKeys.verify(container, c.req.valid('json')), 200)
  )

  router.openapi(agentInstructionsPublished, async (c) =>
    c.json(await AgentInstructions.internalPublished(container, c.req.valid('json')), 200)
  )

  router.openapi(directoryMembership, async (c) =>
    c.json(await Directory.lookupMembership(container, c.req.valid('json')), 200)
  )

  router.openapi(directoryRepCheck, async (c) =>
    c.json(await Directory.repCheck(container, c.req.valid('json')), 200)
  )

  router.openapi(directoryTeamCheck, async (c) =>
    c.json(await Directory.teamCheck(container, c.req.valid('json')), 200)
  )

  router.openapi(recordWithdrawal, async (c) =>
    c.json(
      await Withdrawals.recordWithdrawal(container, c.req.valid('json'), c.get('requestId')),
      200
    )
  )

  return router
}

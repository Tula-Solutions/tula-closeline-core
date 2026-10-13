# tula-closeline-core

Closeline core service: Organizations, Teams, roles, Prospects, integrations, billing and metering

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `docker compose up -d --wait` then `bun run test:integration` | the `*.integration.ts` suites against real Postgres (`POSTGRES_PORT=5436` if 5432 is taken; `docker compose down` after) |

Other scripts are in `package.json`. `verify` does not run the integration suites (they need
Postgres); run them before a PR.

## Routes

| Prefix | Who calls | Guard | Routes |
| --- | --- | --- | --- |
| `/internal` | the auth service only | `INTERNAL_API_TOKENS` bearer secret (`src/http/internal-auth.ts`) | `POST /organizations` (create at sign-up), `POST /invitations/accept` (accept at sign-up), `POST /membership` (token-hook lookup) |
| `/v1` | signed-in users | kit access-token middleware; Organization and role come only from the token | `GET`/`PATCH /organization`, `GET /members`, `PATCH`/`DELETE /members/{membershipId}`, `GET`/`POST /invitations`, `DELETE /invitations/{invitationId}`, `GET`/`POST /teams`, `PATCH`/`DELETE /teams/{teamId}`, `POST /teams/{teamId}/members`, `DELETE /teams/{teamId}/members/{membershipId}` |

Who may do what is one pure function, `src/modules/member/permission.ts` (members, Invitations and Teams). All data goes through
the `CoreStore` port (`src/ports/core-store.ts`); its Postgres adapter runs every query inside the
db library's `withOrganization` and retries serialization failures and deadlocks (three runs,
jittered, `src/adapters/postgres/retry.ts`). A driver failure leaves the store as a
`DatabaseQueryError` (`driver-error.ts`): the SQLSTATE only, no `cause`, query text or parameters,
because the query builder's message holds the token hashes and addresses the Invitation queries bind.

## Writes decide on current, locked data

Every write (renaming the Organization, changing a role, removing a member, creating or revoking an
Invitation, any Team change, accepting an Invitation) runs in one transaction that does
these in order (`openOrganizationForWrite` in `src/modules/organization/access.ts`, then the
service): lock the Organization row `FOR NO KEY UPDATE` (the lock the database's Owner trigger
takes, first in the db library's lock order) and read its status; read the caller's own
Membership by user id and use its role, not the token's (none: `auth.forbidden`); for a member,
read the target `FOR UPDATE`, apply `isAllowed` with both current roles, then write. So writes
to one Organization queue, a suspension cannot be raced, a stale token never grants a write, and
the last Owner cannot be removed over HTTP (`member.last_owner` stays mapped for a race the
queue does not cover). The Organization still comes only from the token. Do not use `FOR SHARE`
on the row: two holders upgrading it would deadlock. The memory store refuses a write made before
`lockOrganization`, so a service that forgets the order fails its tests.

The `FOR UPDATE` on the target (a member, an Invitation, a Team) is defence in depth for writers
that do not take the Organization lock first (a retention job); every writer here takes it, so keep
it anyway.
`lockOrganization` also sets `lock_timeout` to 2 s (`WRITE_LOCK_TIMEOUT_MS`) for the rest of the
write's transaction, so a write queued behind a slow lock holder gives its connection back and
cannot starve the token hook that shares the pool. The timeout (55P03) is a `LockTimeoutError`,
answered `server.unavailable` (503) with `Retry-After: 1`: not retried by the retry helper and not
reported. Reads and the membership lookup set no timeout and take no lock.

## Invitations

- **Token.** 32 bytes from `node:crypto`, base64url; only its SHA-256 is stored (`invitation/token.ts`).
  The raw token and the link (`<PORTAL_BASE_URL>/sign-up#invitation=<token>`, built by
  `invitationLink`, the token in the fragment only) exist in the mail adapter's message and the
  accept call, never in a response, log, error or report. Expiry is 7 days (`INVITATION_TTL_MS`);
  at most 1,000 pending per Organization (`MAX_PENDING_INVITATIONS`, a bounded count; past it
  `rate.limited`). Create revokes, in the same transaction and before it counts, the expired pending
  Invitation of the same email and up to 100 other expired ones (`revokeExpiredInvitations`, oldest
  first, on the pending index), so a bulk invite nobody answered cannot hold the cap; more than 100
  expired ones are cleared over the next creates. The sweep also requires `created_at` at or before
  now minus `INVITATION_TTL_MS`, the same constant that sets `expires_at`, so the index scan stops
  at the first live Invitation instead of reading all 1,000 pending ones on every create.
- **Send budget.** One Organization may create at most 2,000 Invitations in any 24 hours
  (`INVITATION_SEND_BUDGET`, `INVITATION_SEND_WINDOW_MS`), counted in every state, revoked ones
  included, in the create transaction by one bounded query (`countInvitationsSince`, limit
  budget + 1): one sub-query per state, each a range scan on `invitations_state_list_idx` (or, for
  pending, the pending partial index) that stops at budget + 1 rows, joined by `union all`. The
  index range bounds each arm, and an integration plan test guards the plan on 100,000 old rows
  (10 buffers; the earlier single query read a whole table by sequential scan, 7,284). Past it the answer is `rate.limited` with `Retry-After` in seconds until the oldest
  counted Invitation leaves the window (at least 1, at most the window). This is what bounds mail
  volume, since revoking frees the pending cap but not the budget; it must stay in place before a
  mail provider is wired. A delivery that failed leaves a revoked row that counts too.
- **List order.** Every state lists newest first, `created_at` then `id`, both descending, with a
  keyset cursor `{dir: 'desc', createdAt, id}` so `invitations_state_list_idx` serves a page with no
  sort. The cursor is opaque to clients; one from the earlier oldest-first order has no `dir` and
  is answered `request.invalid` (the contract's bad-cursor answer), never read in the new order. So
  is a cursor whose time, in UTC, is outside the years 1970 to 9999 (the database would refuse it).
- **Delivery** goes through the `InvitationMailer` port (`src/ports/invitation-mailer.ts`), called
  after the Invitation commits with the email, role, Organization name, token, link and expiry.
  If it fails or exceeds `INVITATION_DELIVERY_TIMEOUT_MS`, the Invitation is revoked in a second
  transaction and the request answers `server.unavailable`, so a pending Invitation means a message
  was handed over. This is best-effort: a process stop between the commit and the send, or a
  failing revoke, leaves a pending Invitation nobody was mailed; the recovery is to revoke it and
  invite again (a revoked Invitation also stays in the revoked list for good). The revoke is tried
  again once after a lock timeout. A delivery that times out may have been sent all the same, so the
  Invitation can be revoked with its message in an inbox: that invitee's link answers
  `invitation.invalid`, and the Owner invites again. Only the unconfigured adapter (always fails, as in the auth service) is wired in
  `container.ts`. This becomes an outbox row and a queue job when the queue port exists.
- **Accepting** (`Internal.acceptInvitation`): hash, `invitationForToken` (directory function), then
  one transaction in the db library's lock order: Organization row, Invitation row, then the
  Membership, the Team (lock) and its place and the state change. Create takes the Invitation lock
  before the Team lock as well: one order everywhere. Unknown, expired, revoked, used, wrong-address
  and inactive-Organization tokens are all `invitation.invalid` (same status and body); the codes
  are asserted against `INTERNAL_CALL_ERRORS`. The accepted Membership's id is derived from the
  Invitation's id (`membershipIdFor`), and **that is how a retry is recognised**: the Invitation is
  accepted, was offered to the request's address, and the user's Membership has that id. The schema
  records no accepting user, and the derived id needs no column. Consequence: a retry that reaches
  the service while the Organization is suspended answers `invitation.invalid` although the
  Membership exists; the auth service sees a failure, and ADR 0011's reconciliation covers it.
- Email domains in internationalised form are converted to ASCII (`invitation/email.ts`) on create
  and on accept; the contract's `emailSchema` then folds and validates. Two inputs never give one
  address: a domain with `/ \\ ? # % : @ [ ]`, whitespace or a control character is not converted,
  and the result must convert back to the lower-cased input, else the schema refuses the input.
- The Team list is ordered by Team id, not name: a name-keyed cursor can exceed the 512-character
  cursor limit for long non-ASCII names.

## Hot paths

- `Internal.lookupMembership` (`src/modules/internal/service.ts`), behind `POST /internal/membership`:
  the auth service's token hook calls it on every sign-in and refresh. It must stay two indexed
  reads, O(1) whatever the size of any Organization: the directory function, then the Membership
  under that Organization. Benchmark: `bench/membership-lookup.bench.test.ts`.
- `isAllowed` (`src/modules/member/permission.ts`), on every public request, O(1).
  Benchmark: `bench/permission.bench.test.ts`.

## Known gaps

- **Internal calls use a shared secret**, not signed service tokens (no decision record covers
  calls between services yet). `internalAuth` is the one place to replace.
- **Reads trust the token's role.** Getting the Organization and listing members use the role in
  the token with no extra query and no lock (they are the common case). A caller demoted or
  removed after their token was issued can therefore still read, for the rest of the token's
  life, what they could read a moment before; they cannot write (below).
- **Public POSTs ignore `Idempotency-Key`.** The contract says a replay of create Invitation or
  create Team returns the original result; there is no idempotency store (no table in
  `tula-closeline-db` 0.5.0), so a replay answers `invitation.already_pending` or `team.name_taken`.
- **No mail provider is wired**, so creating an Invitation fails with `server.unavailable` (and
  revokes it) until an adapter replaces `createUnconfiguredInvitationMailer` in `container.ts`. A
  real adapter owns its bounded, jittered retry.
- **Deleting a Team is proportional to its size**, done by the database's cascade inside the
  request while the Organization lock is held. No member is loaded into the process, but a very
  large Team would hold the lock; move it to a job if Teams can reach tens of thousands.
- **Accept timing.** Every refusal for a user with no Organization (the case at sign-up) makes the
  same store calls: the token lookup, the user lookup and one transaction (a real one for a wrong
  address, one on ids that cannot exist otherwise), asserted in `accept.test.ts`. A user who already
  has an active Organization still gets the replay lookup instead, a different transaction, with
  an identical status and body.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:core`.

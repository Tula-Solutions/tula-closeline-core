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
jittered, `src/adapters/postgres/retry.ts`).

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
  `rate.limited`). A pending Invitation that has expired is revoked to make room for a new one for
  the same email; it still counts toward the cap until then.
- **Delivery** goes through the `InvitationMailer` port (`src/ports/invitation-mailer.ts`), called
  after the Invitation commits with the email, role, Organization name, token, link and expiry.
  If it fails or exceeds `INVITATION_DELIVERY_TIMEOUT_MS`, the Invitation is revoked in a second
  transaction and the request answers `server.unavailable`, so a pending Invitation means a message
  was handed over. This is best-effort: a process stop between the commit and the send, or a
  failing revoke, leaves a pending Invitation nobody was mailed; the recovery is to revoke it and
  invite again (a revoked Invitation also stays in the revoked list for good). Only the unconfigured adapter (always fails, as in the auth service) is wired in
  `container.ts`. This becomes an outbox row and a queue job when the queue port exists.
- **Accepting** (`Internal.acceptInvitation`): hash, `invitationForToken` (directory function), then
  one transaction in the db library's lock order: Organization row, Invitation row, then the
  Membership, the Team place and the state change. Unknown, expired, revoked, used, wrong-address
  and inactive-Organization tokens are all `invitation.invalid` (same status and body); the codes
  are asserted against `INTERNAL_CALL_ERRORS`. The accepted Membership's id is derived from the
  Invitation's id (`membershipIdFor`), and **that is how a retry is recognised**: the Invitation is
  accepted, was offered to the request's address, and the user's Membership has that id. The schema
  records no accepting user, and the derived id needs no column.
- Email domains in internationalised form are converted to ASCII (`invitation/email.ts`) on create
  and on accept; the contract's `emailSchema` then folds and validates.
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
  `tula-closeline-db` 0.4.0), so a replay answers `invitation.already_pending` or `team.name_taken`.
- **No mail provider is wired**, so creating an Invitation fails with `server.unavailable` (and
  revokes it) until an adapter replaces `createUnconfiguredInvitationMailer` in `container.ts`. A
  real adapter owns its bounded, jittered retry.
- **Accepted and revoked Invitation lists have no index** (only pending ones do): they page by the
  same key but filter by state, bounded by the page size and not by the rows scanned. Ask the db
  library for an index on `(organization_id, state, created_at, id)`.
- **Deleting a Team is proportional to its size**, done by the database's cascade inside the
  request while the Organization lock is held. No member is loaded into the process, but a very
  large Team would hold the lock; move it to a job if Teams can reach tens of thousands.
- **Accept timing.** A token the directory does not know does one lookup plus the user's own
  Organization; a wrong address does a transaction. The status and body are identical; the work is
  not.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:core`.

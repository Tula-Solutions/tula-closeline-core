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
| `/internal` | the auth service only | `INTERNAL_API_TOKENS` bearer secret (`src/http/internal-auth.ts`) | `POST /organizations` (create at sign-up), `POST /invitations/accept` (accept at sign-up), `POST /membership` (token-hook lookup), `POST /organizations/{organizationId}/abandon`, `POST /v1/contact-checks` (the Contact Check, `src/modules/contact-check`) |
| `/v1` | signed-in users | kit access-token middleware; Organization and role come only from the token | `GET`/`PATCH /organization`, `GET /members`, `PATCH`/`DELETE /members/{membershipId}`, `GET`/`POST /invitations`, `DELETE /invitations/{invitationId}`, `GET`/`POST /teams`, `PATCH`/`DELETE /teams/{teamId}`, `GET`/`POST /teams/{teamId}/members`, `DELETE /teams/{teamId}/members/{membershipId}`, `GET`/`POST /prospects`, `GET`/`PATCH /prospects/{prospectId}`, `PUT /prospects/{prospectId}/owner`, `POST /prospects/assign` (`.claude/rules/prospect-assign.md`), `GET`/`POST /prospect-companies`, `GET`/`PATCH /prospect-companies/{companyId}`, `GET`/`POST /suppression-entries`, `POST /suppression-entries/lookups`, `GET /suppression-entries/{entryId}`, `POST /suppression-entries/{entryId}/removal`, `GET /contact-checks` (the log; owner and admin only) |
| `/v1/marketing` | the marketing site's form (browser) | none; mounted before the token router | `POST /demo-requests` |

Who may do what is one pure function, `src/modules/member/permission.ts` (members, Invitations, Teams and Prospects). All data goes through
the `CoreStore` port (`src/ports/core-store.ts`); its Postgres adapter runs every query inside the
db library's `withOrganization` and retries serialization failures and deadlocks (three runs,
jittered, `src/adapters/postgres/retry.ts`). A driver failure leaves the store as a
`DatabaseQueryError` (`driver-error.ts`): the SQLSTATE only, no `cause`, query text or parameters,
because the query builder's message holds the token hashes and addresses the Invitation queries bind.

## Demo Requests (public)

`POST /v1/marketing/demo-requests` takes a marketing-site form with no token. Every body or header
failure is `marketing.invalid_request` (400, never 415); a filled `website` honeypot answers 201
with a fresh id and stores nothing; the same `Idempotency-Key` and body replays the first id (200),
a different body is `request.idempotency_key_reused`. Code: `src/modules/demo-request/`
(`router.ts`, `service.ts`, `worker.ts`).

- **Rate limit.** 10 requests per 3600 s per client address, then `marketing.rate_limited` (429)
  with `Retry-After` 3600 and `details.retryAfter`. The counter is shared in Postgres
  (`DemoRateLimiter` port, `src/adapters/postgres/demo-rate-limiter.ts`, db `hitDemoRateLimit`);
  the memory adapter is for tests.
- **Client address.** Never stored or logged raw: `src/http/client-address.ts` hashes it with
  HMAC-SHA256 under `DEMO_RATE_KEY` (at least 32 chars; a fixed default only when
  `ENVIRONMENT=local`). `TRUSTED_PROXY_HOPS` (0 to 3; default 0 only locally, required elsewhere so a missing value cannot pool every Visitor in one bucket): at 0 the socket address from
  Bun's `server.requestIP`; at N the Nth entry from the right of `X-Forwarded-For` (the ALB
  deployment sets 1), so a forged leftmost entry is ignored. An address that cannot be resolved
  shares one "unknown" bucket (fails closed).
- **CORS** (`src/http/cors.ts`) applies to this route only: the origin must equal
  `PORTAL_BASE_URL`'s origin exactly; `POST, OPTIONS`; `Content-Type, Idempotency-Key`; no
  credentials. Any other origin gets no CORS headers.
- **Notices.** A pending `team-notice` mail per request, sent by the outbox worker
  (`startDemoBackground`, five at a time, started by `src/server.ts`) to `DEMO_NOTICE_TO` (a local default reaches
  Mailpit; required elsewhere). Delivery never blocks the request. A send failure leaves the notice
  pending for a retry after 60 s; at 8 attempts it settles `failed`. The mailer is
  `src/adapters/mailpit/team-notice-mailer.ts` (local only; otherwise the unconfigured one, which
  fails). A given-up notice logs at error level (`demo notice given up`); until a provider exists
  (hub issue #35) the team is not told outside local, though the rows are kept. The `message` is
  HTML-escaped.
- **Purge.** Hourly: Demo Requests older than 12 months and ended rate counters, in batches.
- No log line or error carries a Visitor field (name, email, company, message, page, address).

## Contact Check and suppression (ADR 0003)

- `POST /internal/v1/contact-checks` answers "may this Agent contact this Prospect on this
  channel?" for the voice and outbound services. It fails closed: any doubt (no Prospect, no
  consent, a withdrawal, a suppressed address, an address that does not normalise, an unknown
  Organization) is a denial with an `area.reason` code, and a log write that fails is a 500, which
  the caller treats as `consent.unavailable`. No setting turns it off. Every answer that has an
  Organization is logged in `core.contact_check_log` (never the address).
- Addresses are normalised (`src/modules/suppression/address.ts`) and stored as an HMAC-SHA256 hash
  under `CONSENT_HASH_KEY` (at least 32 chars; required outside `ENVIRONMENT=local`, a fixed
  default only there; infra sets it per Region) plus a masked form. The raw address is never kept.
- Retention: about one check in sixteen (last hex digit of the check id is `0`) deletes at most 100
  log rows older than 90 days, after the insert and outside the answer, so a purge failure never
  fails a check.

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
  `invitation.pending_limit`, 409). A member's address is `invitation.already_member` (409). Create revokes, in the same transaction and before it counts, the expired pending
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
  index range (`created_at` inside the window) bounds each arm to the rows of that window, which
  the budget itself caps, so an index scan, index-only scan or bitmap scan all stay bounded and
  only a sequential scan would break it. An integration plan test on 100,000 old rows asserts no
  sequential scan, only the two allowed indexes and few buffers (10 on an index scan; the earlier
  single query read a whole table by sequential scan, 7,284). Past it the answer is `invitation.daily_limit` (429) with `Retry-After` and `details.retryAfter` in seconds until the oldest
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
  again once after a lock timeout. A delivery that times out may still have been sent, so a revoked
  Invitation can have its message in an inbox (`.claude/rules/mail.md`). This becomes an outbox
  row and a queue job with the queue port.
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

## Idempotency keys

Public `POST`s with effects (`invitations.create`, `teams.create`, `teams.add_member`) take an
optional `Idempotency-Key` header (the contract's `idempotencyKeySchema`; a bad one is
`request.invalid`). The `/internal` POSTs are idempotent on the user id and store nothing. Without
the header a route behaves as it always did. Mechanics: `idempotent()` in
`src/modules/idempotency/service.ts`, called first inside `withOrganization`; rows are
`core.idempotency_keys` via five `OrganizationScope` methods (reserve, find, complete, delete, purge).

- **One transaction (Teams).** Insert the row in flight, run the write, complete it (`update ...
  where status is null`), purge, commit. An in-flight row is never committed; any failure rolls it
  back with the write, so only a committed 2xx is stored and a failed request retries with its key.
- **Request hash**: SHA-256 over `canonicalJson({route, request})` (keys sorted, `undefined`
  dropped) of the validated body and the path parameters, so address case and key order do not
  matter and the same key on another Team is another request.
- **Same key**: same hash replays the stored status and body (read back through the contract's
  response schema) with no second effect; another hash is `request.idempotency_key_reused` (422). A
  row older than 24 hours (`IDEMPOTENCY_TTL_MS`) counts as absent. A replay does not re-check the
  caller's role or the Organization's status. A stored body that no longer parses (a deploy tightened
  a schema) is logged, its row deleted and the request runs as if the key were new: never a 500.
- **Waiting.** The insert is `on conflict do nothing`, so a concurrent same-key request waits on the
  first transaction, bounded by `lock_timeout` `IDEMPOTENCY_WAIT_MS` (2 s). On expiry:
  `request.idempotency_in_progress` (409), `Retry-After` and `details.retryAfter` (seconds, at least
  1). If the first commits in time the waiter returns its stored answer; if it rolls back, it works.
- **Lock order: the idempotency row, then the Organization row.** No deadlock with the
  Organization-first order elsewhere: a transaction waits on an idempotency row only before it holds
  the Organization lock; after it, it only completes or deletes its own row (no one else locks it)
  and the purge is `for update skip locked`, so it never waits. Waits go idempotency row ->
  Organization lock -> row locks, never back. The memory store refuses a reserve after the lock.
- **Purge**: after the write, one batch of at most `IDEMPOTENCY_PURGE_BATCH` (100) of this
  Organization's keys older than 24 hours, oldest first, on `idempotency_keys_purge_idx`; never a
  loop, so an idle Organization keeps old rows until its next keyed write. It runs in a savepoint and
  never fails the request: an error is logged (name, route, ids) and the request carries on.
- **No secret is stored.** The stored body is the route's response (an Invitation without its token,
  a Team, a Team place). An answer over `IDEMPOTENCY_RESPONSE_MAX_BYTES` (jsonb text size,
  `storedResponseBytes`) is returned, its key deleted before commit and the route and ids logged.
- **`invitations.create` stores its key after the mail is handed over**, in a second short
  transaction (`recordAnswer`: reserve, complete, purge). The create transaction writes no key row;
  it only looks the key up (`findIdempotencyKey`) and honours a completed one. Why: the Invitation
  commits before delivery, so a key stored with it would replay a 201 while delivery runs, or after
  it failed (revoked, or the revoke failed too) for an Invitation nobody was mailed. Now such a retry
  gets what it got without a key: `invitation.already_pending`, or a fresh attempt once revoked. If
  the second transaction fails the route logs route and ids and still answers 201. Two concurrent
  same-key requests end as one 201 and one `already_pending`. It returns to the one-transaction
  model when the outbox exists (hub issue #35).
- **Cost** of a keyed request: an insert, an update, a bounded delete (~4 buffers per purged row);
  an Invitation adds a lookup and a second short transaction. No hot path.

## Hot paths

- `Internal.lookupMembership` (`src/modules/internal/service.ts`), behind `POST /internal/membership`:
  the auth service's token hook calls it on every sign-in and refresh. It must stay two indexed
  reads, O(1) whatever the size of any Organization: the directory function, then the Membership
  under that Organization. Benchmark: `bench/membership-lookup.bench.test.ts`.
- `listProspects` (`src/modules/prospect/service.ts`), the Prospect list: O(page size), a keyset on
  `(created_at, id)` served by the `prospects_*_list_idx` indexes (ordered `nulls last` to match
  them; a plain `desc` re-sorts the whole Organization), visibility and filters applied in index
  order, one query for the page's fields. `q` has no trigram index yet (known gap). The identity
  lookup (`findProspectByIdentity`, every create, edit and import row) is one primary-key read.
  Benchmark: `bench/prospect.bench.test.ts`; plans checked by `src/prospects.integration.ts`.
- `ContactCheck.check` (`src/modules/contact-check/service.ts`), behind `POST /internal/v1/contact-checks`:
  O(1) whatever the size of any Organization: the Prospect, its identity, the live suppression
  entry (`suppression_entry_live_key`), the newest consent event
  (`contact_consent_events_channel_idx`) and one log insert, plus a sampled purge bounded to 100
  rows. Every ordered read is `nulls last` to match its index. Benchmark:
  `bench/contact-check.bench.test.ts`; plans checked by `src/consent.integration.ts`.
- `isAllowed` (`src/modules/member/permission.ts`), on every public request, O(1).
  Benchmark: `bench/permission.bench.test.ts`.

## Known gaps

- **Prospect events are published after commit with no outbox**: a failed publish is logged, not
  retried, so `prospect.created`/`updated` can be lost. Also, `q` is an `ilike` over the page's
  candidates with no trigram index, and a duplicate company domain answers `request.invalid`.
- **`PATCH /internal/members/{userId}` is contracted, not served** (needs an ordering guard; answers 404); see `.claude/rules/member-copy.md`.
- **Internal calls use a shared secret**, not signed service tokens (no decision record covers
  calls between services yet). `internalAuth` is the one place to replace.
- **Reads trust the token's role.** Getting the Organization and listing members use the role in
  the token with no extra query and no lock (they are the common case). A caller demoted or
  removed after their token was issued can therefore still read, for the rest of the token's
  life, what they could read a moment before; they cannot write (below).
- **No production mail provider; local delivery only** (hub issue #35). `MAIL_LOCAL_URL`
  (`ENVIRONMENT=local` only) sends Invitations to a local Mailpit mailbox (`.claude/rules/mail.md`);
  otherwise creating one fails with `server.unavailable` (and revokes it) until a real adapter
  replaces `createUnconfiguredInvitationMailer` in `container.ts`.
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

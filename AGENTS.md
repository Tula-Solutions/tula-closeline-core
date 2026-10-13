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
| `/internal` | the auth service only | `INTERNAL_API_TOKENS` bearer secret (`src/http/internal-auth.ts`) | `POST /organizations` (create at sign-up), `POST /membership` (token-hook lookup) |
| `/v1` | signed-in users | kit access-token middleware; Organization and role come only from the token | `GET`/`PATCH /organization`, `GET /members`, `PATCH`/`DELETE /members/{membershipId}` |

Who may do what is one pure function, `src/modules/member/permission.ts`. All data goes through
the `CoreStore` port (`src/ports/core-store.ts`); its Postgres adapter runs every query inside the
db library's `withOrganization` and retries serialization failures and deadlocks (three runs,
jittered, `src/adapters/postgres/retry.ts`).

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
- The Organization status is read in the same transaction as a write but not locked, so a write
  that races an operator's suspension can land just after it. The Owner rule has no such gap
  (the database holds it).
- A role change applies when the token is next refreshed (ADR 0005); a stale token is why
  `member.last_owner` is reachable over HTTP.
- Accepting an Invitation, Invitations and Teams are not built yet (hub issue 9, part B).

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:core`.

---
paths:
  - "src/adapters/mailpit/**"
  - "src/adapters/unconfigured/**"
  - "src/env.ts"
  - "src/container.ts"
---

# Mail

There is no production mail provider yet (hub issue #35). `createInvitationMailer` in
`src/container.ts` returns the unconfigured mailer, which fails every delivery, so creating an
Invitation answers 503 `server.unavailable` and revokes it.

Local development only: `MAIL_LOCAL_URL` selects `src/adapters/mailpit/invitation-mailer.ts`, which
renders the Invitation email (`invitation-email.ts`) and posts it to Mailpit's send API
(`POST /api/v1/send`: `From {Email}`, `To [{Email}]`, `Subject`, `Text`, `HTML`). `MAIL_LOCAL_FROM`
is its sender (default `no-reply@closeline.test`). The auth service has the same adapter and the
same two settings, so the hub's dev script passes one value to both; the two are duplicated on
purpose until the kit has a mail port.

- `src/env.ts` accepts both keys only when `ENVIRONMENT=local`, and the URL only as an `http`
  origin written exactly `http://127.0.0.1`, `http://[::1]` or `http://localhost` (optional port
  1 to 65535, optional trailing slash; no other spelling of the address), stored as that canonical
  origin. A blank value is refused: leave the key out. `createInvitationMailer` throws if the URL
  is set in any other environment. A refusal names the key and the rule, never the value.
- Time. The route gives a delivery `INVITATION_DELIVERY_TIMEOUT_MS` (default 5 s) and aborts the
  `signal` it passes to `deliver` when that is spent. The adapter has no setting of its own: each
  attempt is bounded by `attemptTimeoutFor(INVITATION_DELIVERY_TIMEOUT_MS)` (the bound less two
  longest pauses, shared by 3 attempts, at most 2 s; 1566 ms by default), so 3 attempts and 2
  pauses of at most 150 ms fit inside the route's bound. The route's `signal` also ends an attempt
  or a pause and nothing is tried after it, so a send never outlives the time the route gave it.
- At most 3 attempts, a jittered pause, on a network error, a timeout or a 5xx. A 4xx or a
  redirect is final. The failure is `MailDeliveryFailed`.
- Nothing logs or throws an address, subject, link, token, body or the mailbox's answer: only an
  HTTP status, a failure kind and an attempt number. `invitation-mailer.test.ts` fails on any leak.
- The adapter sends with `node:http`, never `fetch`: Bun's `fetch` obeys `HTTP_PROXY` and would hand
  the link and address to the proxy. A test sets every proxy variable and fails if the proxy sees a
  request; it restores them to a saved value or an empty string, never `delete` (in this Bun
  version a deleted variable is still honoured by later `fetch` calls).
- The connection is pinned to loopback: a `lookup` refuses any address that is not in
  `127.0.0.0/8` or `::1`, so a hosts-file or resolver answer for `localhost` that points elsewhere
  fails the send (final, not retried) and the address is never repeated in an error or log.

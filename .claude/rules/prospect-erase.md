---
paths:
  - "src/modules/prospect/erase*.ts"
  - "src/messages.ts"
  - "src/adapters/**/prospect-*.ts"
---

# Erasing a Prospect

- `DELETE /prospects/{id}` is Owner and Admin only (`prospect.erase`; Rep and Manager get
  `auth.forbidden`). It checks the role, finds the Prospect (`prospect.not_found` if it is missing,
  of another Organization or already erased), publishes one `prospect.erase` job and answers 202.
  A queue that refuses the job is 503 `server.unavailable` and nothing has changed. The request
  does constant work whatever the Prospect holds.
- The job (`processErase`, run by the same worker as the assign chunks) commits in steps, so a
  redelivery resumes: (1) a suppression entry (reason `erased`, no mask) for every email, phone
  and LinkedIn address the Prospect holds or held, hashed with `CONSENT_HASH_KEY` as the
  Suppression list hashes them; (2) its field history, `ERASE_BATCH_ROWS` per transaction;
  (3) the Prospect row, whose cascades remove the identities and consent events, which frees the
  addresses for a new Prospect (a new Contact Consent is still needed to contact them).
- The suppression pass runs again in the transaction that deletes the row, so an address added by
  an edit while the job runs is still hashed. An address that already has a live suppression entry
  keeps that entry as it is; if it is removable (manual, unsubscribe), it can still be removed
  later (accepted).
- `prospect.erased` carries the id alone; `suppression.added` events carry `prospectId: null`.
  Both go out after their commit, so a failed publish loses the event until the outbox (#339).
- Never log a value, address or name. The log line carries the two ids only.
- Not removed: rows that hold only ids (`prospect_import_rows`, `contact_check_log`,
  `prospect_merges`), and a stored Idempotency-Key response from `createProspect` until it expires.

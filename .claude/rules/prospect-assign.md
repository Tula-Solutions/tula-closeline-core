---
paths:
  - "src/modules/prospect/assign*.ts"
  - "src/messages.ts"
  - "src/adapters/**/prospect-*.ts"
---

# Assigning Prospect owners

- `PUT /prospects/{id}/owner` and `POST /prospects/assign` are Owner and Admin only
  (`prospect.assign`). The owner must be a Rep or Manager Membership of this Organization, else
  `prospect.forbidden_owner`. The contract has no route for "all of a Rep's Prospects" (gap).
- Up to `REASSIGN_MAX_IDS` (500) ids run in one transaction (`reassignProspects`, one locked
  select and one `IS DISTINCT FROM` update) and answer 200 `applied`. More answer 202 `queued`:
  the request is checked, split into `prospect.assign_chunk` jobs of 100 ids on `deps.jobs`
  (`JOBS_QUEUE_URL`; memory queue locally) and the key's answer is stored after the jobs are sent.
- `startAssignWorker` (`assign-worker.ts`, started in `server.ts`) applies each chunk in its own
  transaction and decides again on current data: the actor must still be Owner or Admin, the
  Organization active, the owner a Rep or Manager. A refused chunk is dropped and logged; a failed
  one is left for the queue to redeliver. Chunks set end states, so a repeat changes nothing.
- `prospect.updated` (`ownerChanged`) is written to the outbox, in the same transaction, for the Prospects that changed
  only, in batches of 10. No outbox: a failed publish is logged (known gap).
- If `recordAnswer` fails after the jobs are sent, a retry can queue the work twice (harmless). A 503 on a queued request may follow some batches already sent; retrying
  with the same body is safe (end-state chunks).
- Core has no durable processed-job store; lock contention across chunks is hub issue #340.

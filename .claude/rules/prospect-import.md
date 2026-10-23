---
paths:
  - src/modules/prospect-import/**
  - src/modules/prospect/assign-worker.ts
  - src/http/body.ts
  - src/http/limits.ts
---

# Prospect CSV import

- `POST /v1/prospect-imports` (multipart, one `file` part, owner and admin) only stores the file
  in the object store and queues `prospect.import_process`; parsing and every row happen in the
  job (`process.ts`), never on the request path. The `Idempotency-Key` is core's `idempotent()`
  over the file's sha256. If queuing fails the import, key and object are removed and the
  answer is 503 `server.unavailable`.
- Limits: 10 MiB and 50,000 rows (contract constants). Type, size and header are refused at
  upload with `prospect.import_invalid`; `too_many_rows` and `unreadable` are found in the job and
  leave the import `failed`. The upload route has its own body limit (`src/http/limits.ts`).
- The job applies rows in batches of 100, one transaction each, storing row results and
  `processedRows` together, so a stopped run resumes with no duplicates. After 60 s it queues a
  fresh job and acknowledges the old one. Every list is a cursor page of at most 100.
- Writes use Source `import`. A held manual value stays (`manual_values_kept`). On a match the
  owner, tags and company are left alone. Never log row contents, emails or phone numbers.
- `processAssignJobs` dispatches by job type; a new type needs a branch there and a test that it
  is not dropped.
- The job does not check the uploader's role again (the upload was authorised); a removed uploader
  does not stop it. A suspended Organization leaves the job unacknowledged so the queue redelivers
  it (bounded by its retry limit and dead-letter queue); a deleted one acknowledges it.

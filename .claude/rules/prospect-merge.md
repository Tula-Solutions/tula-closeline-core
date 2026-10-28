---
paths:
  - "src/modules/prospect/merge*.ts"
  - "src/adapters/**/prospect-merge*.ts"
  - "src/ports/prospect-merge-store.ts"
---

# Duplicate suggestions, merge and undo

- Owner and Admin only (`prospect.merge`). Every route is tenant-scoped; a Prospect of another
  Organization is `prospect.not_found`, so nothing merges or suggests across Organizations.
- A pair is suggested when one Prospect's current email, phone or LinkedIn URL equals a
  superseded or suggested value of the other (ADR 0020 history). The query reads
  `prospect_fields` rows that are not current, so its cost follows history rows, not the table; a
  cursor and `limit` (100 at most) bound each request.
- Merge: the survivor keeps, per field, the chosen Prospect's value, else a manual one, else the
  newer one; every other value stays as `superseded` history with its own Source. The merged
  Prospects' Conversations and Bookings move to the survivor and their rows are deleted. A merged
  Prospect with a consent event is refused (`prospect.merge_conflict`): the ledger is append-only.
  Merged tags and notes are kept only in the snapshot. The keyed POST publishes `prospect.merged`
  once; Deal links follow it from the event (no link table yet).
- Undo (within `undoableUntil`, 30 days) restores both records from `prospect_merges.snapshot`,
  moves the links back and publishes `prospect.merge_undone`. After 30 days, if the survivor was
  edited since, or if an address was taken meanwhile, the answer is `prospect.merge_conflict`. A
  repeat undo returns the merge unchanged.
- Known limit: snapshots are not purged after 30 days; they go with an erase of the survivor.

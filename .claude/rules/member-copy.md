---
paths:
  - "src/modules/internal/**"
  - "src/modules/member/**"
---

# Member copy and abandoning

- **Core keeps a copy of each member's `email` and `name`** on the Membership (ADR 0015), stored at
  create-Organization and accept-Invitation and returned in every member payload by the one list
  query (`memberships_organization_id_id_key`, no per-row lookup). `email` is optional in the
  contract's create request only so core can deploy before auth sends it; a Membership cannot
  exist without one, so a create without it is `request.invalid` before anything is written.
  Accept stores the request's address, which must equal the Invitation's (folded). An absent or
  null `name` is stored as null. A replay writes nothing, so it never changes a stored copy.
- **`PATCH /internal/members/{userId}` is contracted but not served.** ADR 0015 requires an
  ordering guard on it (an older change must not overwrite a newer one) that contract `0.6.0` does
  not carry, and auth has no profile editing yet. Serve it when the guard is contracted.
- **Abandoning** (`Internal.abandonOrganization`, hub #36): answers `deleted` whenever no live
  Organization with the id exists afterwards (abandoned now, earlier, or never created). One
  transaction: `lockOrganization` (bounded by the 2 s write lock timeout, a miss is 503), then
  `scope.abandonOrganization`, one statement that checks (not deleted, exactly one Membership and
  it is the user's, `created_at` newer than `clock_timestamp()` minus `ABANDON_MAX_AGE_HOURS`, the
  database clock) and sets the status `deleted`, then deletes that one Membership so the user id is
  free at once. A live failing Organization is `organization.not_abandonable` (409), untouched. It
  reads at most two Memberships and writes the Organization, its status row, one Membership with
  its directory row and that member's Team places; Teams, Invitations and the rest wait for the
  deletion job (ADR 0011), and a pending Invitation cannot be accepted (the Organization is not
  active). It logs only the Organization id and the outcome.

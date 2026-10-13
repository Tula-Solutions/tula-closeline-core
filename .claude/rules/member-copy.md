---
paths:
  - "src/modules/internal/**"
  - "src/modules/member/**"
---

# Member copy

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

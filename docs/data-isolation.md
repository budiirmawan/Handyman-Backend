# BE-02G — Building Data Isolation

The backend is the final authority for Building-scoped data isolation. It never
trusts a `buildingId` (or `propertyId` / `clientId`) supplied by the frontend
without validating it against the authenticated User's explicit assignments.

## Access model

```text
Authentication
    +
Permission
    +
Explicit Building Assignment
    →
Building-scoped request access
```

A User may operate within a Building only when ALL of the following hold:

- the User is authenticated (BE-01),
- the User has the required capability via RBAC Permission (BE-01),
- the User has an **ACTIVE** `user_building_assignment` to that Building (BE-02F), and
- the Building itself is **ACTIVE** (BE-02E).

## Isolation rules

- **No assignment ≠ global access.** A User with zero Building assignments has
  an empty accessible set.
- **Assignment to one Building ≠ access to sibling Buildings.** Assignment to
  Building A1 under a Property/Client does not grant Building A2.
- **No same-Client shortcut.** Having access to one Building under a Client does
  not authorize the other Buildings of that Client.
- **Inactive assignment or inactive Building ⇒ denied.** Even if the other
  dimension is active, access is denied.
- **Cross-Client access is allowed only when explicitly assigned.** Each
  cross-Client Building requires its own explicit assignment.

## Reusable authority

`ContextAccessService` (`src/modules/context-access`) provides:

- `getAccessibleBuildingIds(userId)` — the set of Building IDs the User can
  access; the query-scope foundation for future scoped repositories
  (`WHERE building_id IN (...)`).
- `canAccessBuilding(userId, buildingId)` / `assertBuildingAccess(...)` —
  Building-context validation.
- `canAccessProperty(userId, propertyId)` / `canAccessClient(userId, clientId)` —
  derived only from explicit Building assignments.

It reuses the BE-02F resolver (`resolveBuildingsForUser`) and never re-queries
assignments independently.

## Middleware

`requireBuildingAccess(paramName = 'id')` enforces the Building context on a
route:

```text
authenticate
  → requirePermission(...)
    → requireBuildingAccess(...)
      → controller
```

A valid but inaccessible Building yields `403 BUILDING_ACCESS_DENIED` (whether
or not the Building exists, to avoid leaking existence). A malformed id is
deferred to controller validation (`400 VALIDATION_ERROR`).

## Never filter after a global fetch

Future scoped modules must scope at the repository/database level using the
resolved accessible Building IDs, rather than fetching all records and filtering
in application memory. This reduces accidental cross-Client exposure.

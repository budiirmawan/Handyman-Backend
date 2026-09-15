# Effective User Context (BE-01I + BE-02H + BE-25B)

`GET /api/v1/auth/me` returns the single authoritative context for the
authenticated User. It is assembled by `effectiveContextService.getEffectiveUserContext`
and reflects only data the backend can authoritatively support.

## Authoritative dimensions

```text
User
Roles
Permissions
Client
Property
Building
Workforce (BE-25B)
Data Scope (BE-25B)
Entitlements
```

- **User / Roles / Permissions** — BE-01 identity, active roles, and effective
  permissions. Permissions reported here always match what BE-01 RBAC
  (`requirePermission`) enforces.
- **Client / Property / Building** — the reachable commercial hierarchy. It
  comes from the User's explicit Building assignments via the BE-02F resolver
  (`resolveBuildingsForUser`), which is the same source BE-02G data isolation
  uses. A Building is never exposed that isolation would deny.
- **Workforce** (`context.workforce`, BE-25B) — the Workforce Profile(s)
  linked to the authenticated User (identity only: id, client, employee code,
  name, type, status). A profile is exposed only when its Client is inside the
  accessible scope; a User without a linked profile receives `[]`. This is the
  identity foundation mobile uses (assignment feeds arrive in BE-25C) and is
  NOT a separate mobile identity/context engine.
- **Data Scope** (`scope`, BE-25B) — the flat accessible Building/Client id
  sets (`buildingIds` / `clientIds`), derived from the same BE-02F resolver.
  A zero-scope User receives empty arrays.
- **Entitlements** — effective Module Entitlements resolved via the BE-02C
  authoritative resolver (`resolveEffectiveEntitlements`), aggregated across the
  reachable Clients' Subscriptions. Entitlements are never derived from
  Permission, and no module is assumed enabled by default.

## Invariants

```text
Context Buildings   = BE-02G accessible Buildings
Scope buildingIds   = BE-02G accessible Buildings (same source)
Scope clientIds     = Clients reachable through the accessible Buildings
Effective Entitlements = BE-02C authoritative entitlements
Permissions reported   = Permissions enforced by RBAC
Workforce exposed      = linked profile with Client inside the accessible scope
```

## Deferred dimensions

The following are NOT exposed by `/auth/me` in this Wave (they do not exist yet):

```text
Organization
Department
Team
Position
Operational Data Scope
Available Workspace
Configuration
```

The linked Workforce Profile is exposed as identity only; its Organization /
Department / Team / Position dimensions stay deferred and are not expanded.

A zero-assignment User still authenticates successfully and receives an empty
`context.clients`, empty `context.workforce`, empty `scope` arrays and empty
`entitlements`; no default Client/Building is fabricated.

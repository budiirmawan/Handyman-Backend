# CR-HM-BE-CLIENT-MASTER-01 — Master Client API & First-Client Provisioning

**Consumer:** `budiirmawan/Handyman-Operations` PR #18
**Authority:** Handyman Backend (PostgreSQL + RBAC + data scope). OpenAPI source of
truth: [`openapi.yaml`](./api/openapi.yaml) (`Clients` tag).
**Base path:** `/api/v1` (prepend the deployed backend origin).
**Contract version:** additive to BE-02A / CR-BE-MOB-CONTRACT-01 PART 02.

All example bodies are the `data` member of the standard envelope:

```json
{ "success": true, "data": {}, "meta": {} }
```

Errors use the standard shape:

```json
{
  "success": false,
  "error": {
    "code": "CLIENT_ACCESS_DENIED",
    "message": "Client access denied.",
    "category": "FORBIDDEN",
    "retryable": false,
    "requestId": "..."
  }
}
```

Authenticated calls use `Authorization: Bearer <sessionToken>`. A role label, a
selected Client, or frontend state is never authorization: the Backend resolves
session → permission → data scope on every request.

---

## 1. What already existed vs. what this CR changed

Discovered before any code change (Production migration 0453 applied, Owner
`PLATFORM_ADMIN` present, zero Properties/Buildings):

| Capability | Status before | Outcome |
| --- | --- | --- |
| `POST /clients` (create) | Present, `client.manage`, server UUID | Kept; duplicate race now `409`, audited |
| `GET /clients` (list) | Present, `client.read`, **unbounded and RBAC-only** | Additive filters + opt-in pagination + **authorized Client reach** |
| `GET /clients/{clientId}` | Present, `client.read`, unscoped | **Client reach enforced** |
| `PATCH /clients/{clientId}` | Present, `client.manage`, `code` silently ignored | `code` now rejected (immutable), empty body `400`, audited |
| Client status/lifecycle | `ACTIVE` / `INACTIVE` | Unchanged (documented below) |
| Client ↔ Property | `properties.client_id` FK; Property create requires an ACTIVE Client | Unchanged; verified end-to-end |
| PLATFORM_ADMIN with **zero** Client scope creates the first Client | Yes (`client.manage` is seeded) | Now explicitly tested + documented |

No parallel Client model, no new permission code, no new Client↔User table, no
public registration.

**One migration is required:** `0454_extend_client_audit_events` (adds
`CLIENT_CREATED` / `CLIENT_UPDATED` to the existing audit-event CHECK
vocabulary, additively). It changes **no** Client/Property/Building table.

---

## 2. Authorization model

Two independent layers, both resolved server-side:

1. **RBAC** — canonical permission vocabulary (unchanged):
   * `client.read` — list/detail,
   * `client.manage` — create/update.
   The foundation seed grants both to `PLATFORM_ADMIN` (Owner) only. No
   canonical persona role (`SYSTEM_ADMIN`, `CUSTOMER_CARE`, `OPERATIONS`,
   `MANAGER`, `MOBILE_STAFF`) carries any `client.*` code. Role names never
   grant anything.
2. **Client reach (data scope)** — applies to reads and updates:
   * **Owner** = ACTIVE `PLATFORM_ADMIN` role → installation-wide registry.
     This is the *same* protected-role precedent already used for Building
     assignment administration.
   * **Every other caller** → exactly the Clients reachable through their
     ACTIVE Building assignments (the single BE-02G resolver also used by
     `/auth/me` and by operational data isolation). An empty reach returns an
     empty list — never the global registry.

Consequences that must not be re-derived in the frontend:

* Client creation needs no pre-existing Client scope. The first Owner creates
  the first Client with an empty `scope.clientIds`.
* A non-owner who is explicitly granted `client.manage` **can** create a Client
  (canonical RBAC) but gains **no read reach** over it until a governed
  Building assignment exists. Creation is never an implicit tenant grant.
* `SYSTEM_ADMIN` cannot list, read, create or update Clients.
* Out-of-reach ≠ unknown: an existing but unreachable Client is `403
  CLIENT_ACCESS_DENIED`; an unknown UUID is `404 CLIENT_NOT_FOUND`.

---

## 3. Endpoints

### 3.1 `POST /clients` — create a Client

* **Permission:** `client.manage`
* **Body:** `CreateClientRequest` (below). A supplied `id` is ignored — the id
  is always Backend-issued.
* **201 `data`:** `PublicClient`
* **Audit:** `CLIENT_CREATED` (actor, request id, Client id/code/status).
* **Errors:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`,
  `403 PERMISSION_DENIED`, `409 CLIENT_CODE_ALREADY_EXISTS` (case-insensitive,
  including concurrent creation).

```http
POST /api/v1/clients
Authorization: Bearer <ownerSessionToken>
Content-Type: application/json

{ "code": "acme_corp", "name": "ACME Corporation", "legalName": "PT ACME", "taxId": "01.234.567.8-901.000" }
```

```json
{
  "success": true,
  "data": {
    "id": "6b0f4d1e-2f4a-4c55-9b6f-1f0a1f6d8a21",
    "code": "ACME_CORP",
    "name": "ACME Corporation",
    "legalName": "PT ACME",
    "taxId": "01.234.567.8-901.000",
    "description": null,
    "status": "ACTIVE"
  },
  "meta": {}
}
```

### 3.2 `GET /clients` — authorized registry listing

* **Permission:** `client.read`
* **Query (all optional):**

| Parameter | Rules |
| --- | --- |
| `status` | Exact. `ACTIVE` or `INACTIVE`; anything else → `400 VALIDATION_ERROR`. |
| `search` | Literal, case-insensitive substring over `code` **and** `name`. Trimmed; 1–120 chars; `%`/`_` are literal (no wildcard injection). |
| `page` | 1-based integer ≥ 1. |
| `pageSize` | Integer 1–200 (default 50). |

* **Pagination is opt-in.** With **no** `page`/`pageSize` the historical
  unbounded array is returned and `meta` is `{}` (Web compatibility). Sending
  **either** parameter returns one page and
  `meta: { page, pageSize, total, totalPages }`.
* Ordering: `code ASC`.
* **200 `data`:** `PublicClient[]`
* **Errors:** `400 VALIDATION_ERROR`, `401 AUTHENTICATION_REQUIRED`,
  `403 PERMISSION_DENIED`.

```http
GET /api/v1/clients?status=ACTIVE&search=acme&page=1&pageSize=20
```

```json
{
  "success": true,
  "data": [ { "id": "…", "code": "ACME_CORP", "name": "ACME Corporation", "legalName": "PT ACME", "taxId": null, "description": null, "status": "ACTIVE" } ],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

### 3.3 `GET /clients/{clientId}` — Client detail

* **Permission:** `client.read`
* **200 `data`:** `PublicClient`
* **Errors:** `400 VALIDATION_ERROR` (malformed UUID), `401`,
  `403 PERMISSION_DENIED`, `403 CLIENT_ACCESS_DENIED` (exists, out of reach),
  `404 CLIENT_NOT_FOUND`.

### 3.4 `PATCH /clients/{clientId}` — update Client identity/status

* **Permission:** `client.manage`
* **Reach:** same rule as detail (Owner installation-wide, others reachable-only).
* **Body:** `UpdateClientRequest` — at least one field; `code` is **immutable**
  and rejected if supplied.
* **200 `data`:** `PublicClient`
* **Audit:** `CLIENT_UPDATED` (changed field names only).
* **Errors:** `400 VALIDATION_ERROR`, `401`, `403 PERMISSION_DENIED`,
  `403 CLIENT_ACCESS_DENIED`, `404 CLIENT_NOT_FOUND`.

```http
PATCH /api/v1/clients/{clientId}
{ "name": "ACME Corporation (Renamed)", "status": "INACTIVE" }
```

---

## 4. Schemas

### `CreateClientRequest`

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `code` | string | yes | Normalized to UPPERCASE. Starts with a letter; only letters, digits, `_`; 2–64 chars. Unique (`409`). Immutable after creation. |
| `name` | string | yes | 1–160 chars after trimming. |
| `legalName` | string | no | ≤ 255 chars. |
| `taxId` | string | no | ≤ 64 chars. |
| `description` | string | no | ≤ 512 chars. |
| `status` | enum | no | `ACTIVE` (default) or `INACTIVE`. |

`additionalProperties` are ignored, **except** that `id` can never influence
the stored id.

### `UpdateClientRequest`

`name` (1–160), `legalName` (≤255, nullable), `taxId` (≤64, nullable),
`description` (≤512, nullable), `status` (`ACTIVE` | `INACTIVE`).
`minProperties: 1`. `code` is not a member and is rejected.

### `PublicClient`

```json
{
  "id": "uuid",
  "code": "ACME_CORP",
  "name": "ACME Corporation",
  "legalName": "PT ACME",
  "taxId": "01.234.567.8-901.000",
  "description": null,
  "status": "ACTIVE"
}
```

Exactly these seven keys — no timestamps, no internal fields.

### `ClientStatus`

```text
ACTIVE | INACTIVE
```

Lifecycle rules:

* `ACTIVE` — usable as the parent of a new Property.
* `INACTIVE` — preserved for history; **never deleted**; cannot host a new
  Property (`400 CLIENT_INACTIVE` on `POST /properties`). Existing Properties,
  Buildings and operational data are untouched.
* Status changes are reversible via `PATCH /clients/{clientId}`.
* Only these two values are part of the **business** Client API. The shared
  `clients` table is also the SaaS customer registry (CR-BE-SAAS-01), whose
  `PROSPECT` / `TRIAL` / `GRACE` / `SUSPENDED` / `TERMINATED` states are
  platform-plane lifecycle states: such rows are omitted from `GET /clients`
  and answered with `404 CLIENT_NOT_FOUND` by detail/update. They are managed
  only through `/api/v1/platform/customers` (`platform.*` authority, withheld
  by default).

---

## 5. First-Client bootstrap (Owner with zero scope)

Precondition in Production: one `PLATFORM_ADMIN` Owner exists (provisioned by
`db:bootstrap-owner`), **zero** Clients/Properties/Buildings, and
`GET /auth/me` returns `scope.clientIds: []`. That is expected and does **not**
block provisioning.

```text
1. POST /api/v1/clients                       (client.manage)
   → 201; read data.id                         ← authoritative clientId
2. POST /api/v1/properties                    (property.manage)
   { "clientId": <data.id>, "code": "...", "name": "..." }
   → 201; read data.id                         ← propertyId
3. POST /api/v1/buildings                     (building.manage)
   { "propertyId": <propertyId>, "code": "...", "name": "...", "timezone": "Asia/Jakarta" }
   → 201; read data.id                         ← buildingId
4. POST /api/v1/users/{ownerUserId}/buildings (building.manage)
   { "buildingId": <buildingId> }
   → 201
5. GET  /api/v1/auth/me
   → scope.clientIds == [<clientId>], scope.buildingIds == [<buildingId>]
```

Steps 1–4 are all existing, RBAC-gated HTTP operations. **No direct SQL, no
seeded Client, no guessed/fake UUID, and no privacy bypass is involved.** The
Owner may administer the Building assignment installation-wide (protected-role
precedent); everyone else needs `contextAccessService` reach.

> `/auth/me` → `scope.clientIds` remains **Building-derived** by contract. It is
> deliberately *not* widened by creating a Client (that would hand every module
> that calls `getAccessibleClientIds` a tenant-wide data scope). Use the 201
> `data.id` (or the registry) for the newly created Client, and use
> `scope.clientIds` only for Clients the user actually operates.

---

## 6. Client → Property → Building creation example

```http
POST /api/v1/clients
{ "code": "BUMI_SERUA", "name": "Bumi Serua Residence" }

201 { "data": { "id": "11111111-1111-4111-8111-111111111111", "code": "BUMI_SERUA", … } }
```

```http
POST /api/v1/properties
{ "clientId": "11111111-1111-4111-8111-111111111111", "code": "SERUA_CLUSTER", "name": "Serua Cluster", "city": "Depok", "province": "Jawa Barat" }

201 { "data": { "id": "22222222-2222-4222-8222-222222222222", "clientId": "11111111-1111-4111-8111-111111111111", "code": "SERUA_CLUSTER", "status": "ACTIVE", … } }
```

```http
POST /api/v1/buildings
{ "propertyId": "22222222-2222-4222-8222-222222222222", "code": "TOWER_A", "name": "Tower A", "timezone": "Asia/Jakarta" }

201 { "data": { "id": "33333333-3333-4333-8333-333333333333", "propertyId": "22222222-2222-4222-8222-222222222222", "code": "TOWER_A", "status": "ACTIVE", "timezone": "Asia/Jakarta", … } }
```

`PublicProperty` fields: `id, clientId, code, name, description, status,
addressLine, city, province, postalCode, countryCode`.
`PublicBuilding` fields: `id, propertyId, campusId, code, name, description,
status, addressLine, city, province, postalCode, countryCode, timezone`.

---

## 7. How the frontend obtains a valid `clientId`

Use these in order; never synthesize a UUID.

1. **Create response (authoritative for a new Client).**
   `POST /clients` → `data.id`. Persist it; it is the id Property creation
   requires.
2. **Registry read (authoritative for existing Clients).**
   `GET /clients` → `data[].id`. Use `search`/`status`/pagination to find the
   target. This is the only list the Owner needs when seeding the first tenant;
   it works even when `scope.clientIds` is empty.
3. **Operational scope (do not use for provisioning).**
   `GET /auth/me` → `scope.clientIds` / `context.clients`. These are
   Building-derived and only populated after step 4 of the bootstrap. They are
   correct for selectors in **operational** screens, but they are intentionally
   empty for a fresh Owner.

What the frontend must **not** do:

* Do not accept a typed/pasted `clientId` from a user without validating it via
  `GET /clients/{id}` (a `403`/`404` means it is not usable).
* Do not enable a generic “Create Client” button for `SYSTEM_ADMIN`; it will
  receive `403 PERMISSION_DENIED`. Gate the action on the `client.manage`
  permission from `GET /auth/me` → `access.permissions` **and** treat `403` /
  `403 CLIENT_ACCESS_DENIED` as authoritative.
* Do not infer Client visibility from role names or from `/auth/me` reach.

---

## 8. Error reference

| Status | Code | Meaning / frontend action |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body/query/param invalid (`details[]` names the field). Includes: bad code, missing name, unknown status, `code` on PATCH, empty PATCH body, malformed UUID, invalid `status`/`page`/`pageSize`/`search`. Fix and retry — never retry unchanged. |
| 401 | `AUTHENTICATION_REQUIRED` | Missing/expired session. Re-authenticate. |
| 403 | `PERMISSION_DENIED` | Caller lacks `client.read` / `client.manage` (e.g. `SYSTEM_ADMIN`). Hide the action. |
| 403 | `CLIENT_ACCESS_DENIED` | Client exists but is outside the caller's reach. Do not retry; the frontend cannot widen its own scope. |
| 404 | `CLIENT_NOT_FOUND` | Unknown Client id. |
| 409 | `CLIENT_CODE_ALREADY_EXISTS` | Duplicate `code` (case-insensitive, race-safe). Ask for a different code. |
| 400 | `CLIENT_INACTIVE` | `POST /properties` against an INACTIVE Client. Reactivate the Client or choose another. |
| 400 | `PROPERTY_INACTIVE` | `POST /buildings` against an INACTIVE Property (existing contract). |

`400`/`403`/`404`/`409` are never retryable; `retryable` is `false` in the
envelope.

---

## 9. Deployment / migration note

* Migration **`0454_extend_client_audit_events`** is additive and only widens
  the `authentication_audit_events.event_type` CHECK constraint.
* The API refuses to admit traffic when applied migrations ≠ the artifact’s
  migration set (`verifyMigrationReadiness`). Run the existing one-shot
  migration (`npm run db:migrate:prod`) **before** deploying this build.
* `recordEvent` is best-effort: if 0454 has not been applied, Client
  create/update succeeds but its audit row is dropped with a warning. Apply the
  migration to retain the `CLIENT_CREATED` / `CLIENT_UPDATED` evidence.
* No data backfill, no Client seed, and no Production Client is created by this
  CR.

---

## 10. Verification evidence (this CR)

Disposable PostgreSQL **18.4** (embedded), never Railway Production:

* `tests/cr-hm-be-client-master-01.test.ts` — 10 focused tests / 1 suite, all
  passing: first-Client bootstrap with zero scope, server-issued UUID,
  Property + Building + assignment chain, unauthorized creation (401/403
  including the canonical `SYSTEM_ADMIN` set), cross-tenant denial, invalid and
  duplicate handling (including the concurrent 23505 race), authorized listing
  with filters/pagination, non-owner creator gaining no automatic reach,
  platform-plane status exclusion, and unchanged Property/Building behavior.
* `tests/clients.test.ts` — 17 tests, all passing (owner-shaped session;
  immutable `code`; empty PATCH rejection).
* `tests/buildings.test.ts`, `tests/building-assignments.test.ts`,
  `tests/audit.test.ts` — 52 tests, all passing.
* `tests/iam-bootstrap.test.ts` — 24 tests, all passing (audit vocabulary +
  migration 0454 applied).
* `tests/openapi-contract.test.ts` — 7 tests, all passing; all 19,277 local
  OpenAPI `$ref`s resolve.
* `npm run typecheck` and `npm run build` — clean.

---

## 11. Explicit non-goals / residual boundaries

* **No** public or self-service Client registration.
* **No** new permission code, role, or Client↔User membership table.
* **No** automatic Client-wide access for `SYSTEM_ADMIN` or any tenant role.
* **Property registry authorization is unchanged.** `property.read` /
  `property.manage` remain Owner-level RBAC capabilities as before; this CR did
  not rewrite the Property domain. Operational data isolation remains
  Building-scoped (BE-02G).
* `/auth/me` → `scope.clientIds` semantics are unchanged (Building-derived).
* Client deletion remains unsupported by design; use `INACTIVE`.

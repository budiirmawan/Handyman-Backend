# Asentra Backend → Mobile Integration Handoff

> **Status:** CR-BE-MOB-CONTRACT-01 PART 08 — final contract handoff for the
> Asentra Mobile (Flutter) integration boundary.
> **Authoritative machine-readable contract:** `docs/api/openapi.yaml`
> (single source of truth for paths, request/response schemas, operationIds,
> statuses, permissions, and error behavior).
> **Date:** 2026-08-19
> **Baseline:** Arena branch `arena/01a01872-asentra-backend`, PART 01–07.

This document lets the Asentra Mobile repository bind its existing API
adapter **without guessing** endpoint paths, schemas, statuses, permissions,
or error behavior. When this document and `openapi.yaml` disagree, the
**backend router** and `openapi.yaml` win.

> **Update (CR-BE-MOB-01 PART 08):** this document covers the CORE mobile
> surface (auth, task, work order, checklist, evidence, finding, QR, sync
> envelope, notifications). The Housekeeping, Security, Engineering and Work
> Order material-context surfaces published later — plus the QR, sync and push
> **boundaries** — are in
> [`CR_BE_MOB_01_MOBILE_HANDOFF.md`](./CR_BE_MOB_01_MOBILE_HANDOFF.md). Read
> both; neither restates the other.

---

## 1. Base URL configuration expectations

| Item | Value |
|---|---|
| Base path | `API_PREFIX` (default `/api/v1`); matches `servers[0].url` in `openapi.yaml` |
| Transport | HTTPS in production |
| Authentication | Opaque bearer session token only (no API keys, no basic auth) |
| Request correlation | `X-Request-ID` header — client-supplied value is echoed when it matches `^[A-Za-z0-9._-]{1,128}$`, else backend-generated; return it on retries for support correlation |
| Device context (BE-25N) | Optional `X-Device-Id`, `X-Platform` (ANDROID/IOS), `X-App-Version` — sanitized, logged only, never stored as authority |

Mobile must read the base path from configuration (`API_PREFIX`), never
hard-code `/api/v1`.

---

## 2. Authentication / session contract

| Endpoint | Request | Response `data` |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | `{ sessionToken, expiresAt, user }` |
| `GET /auth/me` | bearer | effective context (see §5) |
| `POST /auth/logout` | bearer | `{ revoked: true }` |

- `sessionToken` is a cryptographically-random opaque base64url token,
  returned **once**; only its SHA-256 hash is stored server-side.
- `expiresAt` is ISO-8601 UTC; bounded by `SESSION_TTL_MINUTES` (default 480).
- There is **no** session-state endpoint and **no** token refresh/rotation:
  session validation is implicit in the auth middleware on every protected
  route; expiry is handled by re-login.

### Authorization header / token behavior

- Send `Authorization: Bearer <sessionToken>` on every protected request.
- Store the token securely (Keychain/Keystore); never log it.
- The backend hashes the presented token, verifies the session is ACTIVE and
  unexpired, then re-validates the user's account state.

### Session expiry / 401 behavior

| Code | Meaning | Mobile action |
|---|---|---|
| `AUTHENTICATION_REQUIRED` | missing/invalid Authorization header | re-authenticate |
| `INVALID_SESSION` | unknown or non-ACTIVE session | re-authenticate |
| `SESSION_EXPIRED` | expired ACTIVE session | re-authenticate |
| `INVALID_CREDENTIALS` | login: unknown email / wrong password / non-login state (indistinguishable) | show generic error |
| `AUTH_RATE_LIMITED` (429) | login throttle | retry later |

Mobile must treat **any 401 as "re-authenticate"**.

---

## 3. Effective user / role / permission source

`GET /auth/me` is the **single authoritative context** (BE-01I + BE-02H +
BE-25B). Its shape:

```
data: {
  user:      { id, email, displayName, status, createdAt, updatedAt }
  access:    { roles: [{id, code, name}], permissions: [ "<domain>.<verb>" ] }
  context:   { clients: [ Client → Property → Building ], workforce: [{...}] }
  scope:     { buildingIds: [], clientIds: [] }
  entitlements: [ { moduleCode, status: "ACTIVE" } ]
}
```

- `access.permissions` is the exact deduplicated set that `requirePermission`
  enforces — the backend is the authority; mobile must never infer
  permissions from role names.
- `access.roles` lists only effective ACTIVE roles.
- Refresh after login and after re-login; never cache across user changes.

### Entitlement source

- Effective module entitlements are in `entitlements` (BE-02C resolver).
- Administration reads are `GET /entitlements`,
  `GET /subscriptions/:id/entitlements(/effective)`.

### Role / permission / entitlement semantics

- Default-deny RBAC: a protected route without the required permission yields
  `403 PERMISSION_DENIED`. Permission codes are `<domain>.<verb>`.
- Supervisor capability (Teknisi / Cleaning Service) is **permission-based**
  (`finding.review`, `review.manage`, `work_order.manage`, …) — there is NO
  hard-coded mobile role logic.

---

## 4. Client / Property / Building context rules

- Reachable hierarchy: `GET /auth/me` → `context.clients`
  (Client → Property → Building).
- Flat accessible sets: `GET /auth/me` → `scope.buildingIds` /
  `scope.clientIds`; also `GET /auth/me/buildings` (authentication only).
- Never send `clientId` / `buildingId` as **authority** — the backend always
  validates scope. Inaccessible resources → `403 BUILDING_ACCESS_DENIED`;
  zero-scope users receive well-formed empty lists.

### Building isolation rules

- By-id reads resolve the record's Building and require an ACTIVE caller
  assignment (`requireBuildingAccess` / `assertBuildingAccess`).
- Building-nested list/create routes pass `requireBuildingAccess('buildingId')`.
- Cross-Building records can never be returned; QR resolution hides existence
  (inaccessible = same 404 as unknown).

---

## 5. Endpoint / operationId map (mobile-required)

The authoritative map is `docs/api/openapi.yaml` (344 paths / 452 operations,
all with unique `operationId`). The mobile-required surface (180 operations)
is pinned by `tests/mobile-openapi-completeness.test.ts` and grouped by tag:

| Tag | Operations | Contract PART |
|---|---|---|
| Authentication | 3 | PART 01 |
| Effective Context | 2 | PART 01 |
| Users | 5 | PART 02 |
| Roles & Permissions | 16 | PART 02 / 07 |
| Clients / Properties / Buildings / Building Assignments | 17 | PART 02 |
| Work Orders | 29 | PART 03 / 07 |
| Mobile Execution | 39 | PART 03 / 04 / 05 |
| Checklist & Measurement | 13 | PART 04 |
| Evidence / Evidence Requirements | 13 | PART 04 |
| Findings | 25 | PART 05 |
| Location & Asset Context | 21 | PART 06 / 07 |

> Rule: **no-mock-fallback**. In backend mode the mobile adapter must call the
> backend and surface backend errors — it must never fabricate success
> payloads, statuses, or available-actions locally.

---

## 6. Request / response envelope conventions

- Success: `{ success: true, data: <payload>, meta: {} }` — `meta` carries
  pagination (`{page, pageSize, total, totalPages}`) only for paginated lists.
- Error: `{ success: false, error: { code, message, ... } }`.
- Mutations return the updated resource; known exceptions: checklist response
  save returns `data: {}`; evidence upload returns the metadata record.
- Status codes: `200` update/action, `201` created.

### Error code conventions (BE-25K)

Every error also carries additive mobile-facing fields:

| Field | Meaning |
|---|---|
| `error.code` | stable machine-readable code (branch on this, never on `message`) |
| `error.message` | human-readable (never a stack trace / secret) |
| `error.category` | `VALIDATION` / `BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `RATE_LIMITED` / `SERVER` |
| `error.retryable` | `true` for 5xx and 429; `false` for client errors |
| `error.requestId` | same as `X-Request-ID` |
| `error.details` | `[{field, message}]` on `VALIDATION_ERROR` |
| `error.resource` / `error.conflict` | where applicable |

Key codes: `VALIDATION_ERROR`, `BAD_REQUEST`, `AUTHENTICATION_REQUIRED`,
`INVALID_SESSION`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS`,
`AUTH_RATE_LIMITED`, `PERMISSION_DENIED`, `BUILDING_ACCESS_DENIED`,
`NOT_FOUND`, `WORK_ORDER_INVALID_TRANSITION`,
`FINDING_ACTION_NOT_ALLOWED`, `ASSET_IDENTIFIER_NOT_RESOLVABLE`.

---

## 7. Status / enums required by mobile

- `UserStatus` — INVITED / ACTIVE / INACTIVE / SUSPENDED
- `WorkOrderStatus` — OPEN / ASSIGNED / IN_PROGRESS / ON_HOLD / COMPLETED /
  CANCELLED / CLOSED
- `WorkOrderPriority` — LOW / MEDIUM / HIGH / CRITICAL
- `FindingStatus` — OPEN / ASSIGNED / IN_PROGRESS / PENDING_REVIEW / REJECTED /
  REWORK_REQUIRED / RESUBMITTED / VERIFIED / CLOSED / CANCELLED
- `ReviewDecision` — APPROVED / REJECTED / REWORK_REQUIRED (shared by finding
  and work-order verification)
- `ChecklistExecution.status` — DRAFT / IN_PROGRESS / COMPLETED / CANCELLED
- `ChecklistItemType` — CHECK / BOOLEAN / TEXT / NUMBER
- `AssetStatus` — ACTIVE / INACTIVE / UNDER_MAINTENANCE / RETIRED
- `AssetIdentifierType` — QR / TAG / BARCODE / LEGACY
- Evidence types — PHOTO / DOCUMENT / SIGNATURE

Status is the backend lifecycle authority. Mobile must **never infer
transitions from `status`**; it renders only backend-authoritative
`availableActions` (findings: `GET /findings/:id/available-actions`; task /
work order: `GET /mobile/assignments`).

---

## 8. Evidence / upload contract

- Submission metadata: `POST /evidence` (BE-07; execution-scoped).
- File bytes: `POST /evidence/:id/file` (multipart `file`, ≤50 MB, MIME gated
  by evidence type) and the single-call `POST /mobile/evidence`
  (`file` + `evidenceType` + `executionType` + `executionId` + …).
- Download: `GET /evidence/:id/file/content`.
- Evidence requirements (required/type/min/max): `GET /evidence-requirements`.
- Bytes never enter PostgreSQL; internal storage paths never exposed.

---

## 9. QR / location contract

- `GET /mobile/qr/resolve/:identifier` and `GET /assets/resolve/:identifier`
  resolve an opaque identifier via the BE-05H Asset Identifier authority
  (targetType `ASSET`, Building/Functional-Location context, Asset/Equipment
  context, read-model action hints).
- Location hierarchy: `GET /buildings/:id/hierarchy`,
  `GET /functional-locations/:id/context`, floor/area/room/space lists+gets,
  asset `GET /assets/:id/location` (asset + resolved operational context).
- Physical device GPS / geofencing is **not** a backend capability — mobile
  handles device location locally; the backend provides only operational
  location context via canonical backend IDs.

---

## 10. Offline / sync considerations supported by backend

- `POST /mobile/sync` — batch offline operations (task execution, checklist
  responses, evidence metadata, task assignment) with `operationId`
  idempotency (BE-25H) and `baseVersion` conflict detection (BE-25I).
- `GET /mobile/assignments` — unified "my assignments" feed with
  backend-authoritative `availableActions`.
- `POST /mobile/push-tokens` — device push token registration.
- `GET /mobile/app-version/:platform` — app version metadata (public).
- `GET /mobile/diagnostics` — correlation/diagnostics metadata.

Evidence **bytes** upload stays online (`POST /mobile/evidence`); sync carries
metadata only.

---

## 11. Capabilities intentionally NOT supported

- No session refresh/rotation endpoint.
- No QR target types beyond `ASSET`.
- No GPS / geofencing authority.
- No standalone single-resource `availableActions` for Task / Work Order
  (only via `/mobile/assignments`).
- No offline evidence byte queue.
- No anonymous QR scan (resolution is authenticated + Building-scoped).

---

## 12. No-mock-fallback rule (backend mode)

In backend mode the Asentra Mobile adapter:

1. Calls the backend endpoints documented here (`openapi.yaml`).
2. Branches on `error.code` / `error.category` — never on `message`.
3. Renders only backend-authoritative `availableActions` / context.
4. Treats any 401 as re-authenticate; does not cache context across users.
5. Never fabricates success, statuses, transitions, or data locally.

---

## 13. Regression coverage

- `tests/mobile-openapi-completeness.test.ts` — pins the 180-operation mobile
  surface and detects drift in both directions + structural invariants.
- `tests/mobile-cross-contract.test.ts` — cross-contract chain + shared-schema
  consistency + representative end-to-end runtime chain.
- PART 01–07 `tests/mobile-*-contract.test.ts` — per-domain runtime contract
  (RBAC + Building isolation asserted throughout).

# Mobile API Contract — Conventions (BE-25A)

> **Status:** BE-25A — Mobile API Contract Stabilization. Contract conventions
> only; no offline sync / idempotency / conflict handling yet (BE-25G/H/I).
> **Authoritative machine-readable contract:** `docs/api/openapi.yaml`.
> This document fixes the *conventions* asentra-mobile (Flutter) relies on.

## 1. Transport & base path

- Base URL: `API_PREFIX` (default `/api/v1`), matching `servers[0]` in
  `docs/api/openapi.yaml`.
- HTTPS in production; bearer sessions only.
- Every response carries `X-Request-ID` (echoed client value when it matches
  `^[A-Za-z0-9._-]{1,128}$`, otherwise backend-generated). Mobile logs it for
  support correlation and may send it on retries.

## 2. Authentication / session contract

| Endpoint | Request | Response `data` |
|---|---|---|
| `POST /auth/login` | `{ email, password }` | `{ sessionToken, expiresAt, user }` |
| `GET /auth/me` | `Authorization: Bearer <sessionToken>` | Effective context (BE-25B): `{ user, access, context: { clients, workforce }, scope, entitlements }` |
| `POST /auth/logout` | bearer | `{ revoked: true }` |

- `sessionToken` is an opaque bearer token; store it securely, never in
  plaintext logs. `expiresAt` is ISO-8601 UTC.
- 401 codes: `AUTHENTICATION_REQUIRED` (missing), `INVALID_SESSION` /
  `SESSION_EXPIRED` (invalid/expired). Mobile treats any of these as
  "re-authenticate".
- `/auth/me` is the single authoritative context (BE-25B — Mobile Effective
  Context):
  - `user` — authenticated user identity.
  - `access.roles` / `access.permissions` — effective roles and permissions
    (identical to what backend RBAC enforces).
  - `context.clients` — Client → Property → Building reachable hierarchy.
  - `context.workforce` — Workforce Profile(s) linked to the user (identity
    only: `{ id, clientId, employeeCode, fullName, workforceType, status }`);
    empty when none or when the profile's Client is not in the accessible
    scope. `id` is the `workforceProfileId` used by BE-25C assignment feeds.
  - `scope.buildingIds` / `scope.clientIds` — flat accessible data scope
    (same BE-02G source as every scoped read); use for filtering and offline
    caching boundaries. Empty arrays for a zero-scope user.
  - `entitlements` — effective module entitlements.
  - Available actions are NOT part of the context: they remain on resource
    endpoints (`GET /findings/{id}/available-actions`, approval endpoints),
    which stay backend-authoritative.
  Never cache it across user changes; refresh after login and after re-login.
- `GET /auth/me/buildings` returns the user's accessible buildings (same
  BE-02G source as all scoped reads).

## 3. Response / error envelope

All endpoints use the uniform envelope (never changed by BE-25):

```json
{ "success": true, "data": { }, "meta": { } }
```

```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "…", "details": [ ] } }
```

- `meta` is an empty object when not applicable; paginated lists populate it
  (see §4).
- Error codes are the authoritative `ERROR_CODES` in `src/shared/errors.ts`.
  Mobile must branch on `error.code`, never on the human-readable `message`.
- `details` (array of `{ field, message }`) appears on `VALIDATION_ERROR`.
- Unknown routes → `NOT_FOUND`; unhandled errors → `INTERNAL_SERVER_ERROR`;
  stack traces are never returned.

## 3b. Mobile error contract (BE-25K)

Every error response carries the BE-25K additive fields (the shared envelope
is unchanged, Web compatible):

| Field | Meaning |
|---|---|
| `error.code` | Stable machine-readable code (`ERROR_CODES`). |
| `error.message` | Human-readable message (never a stack trace or secret). |
| `error.category` | Stable classification: `VALIDATION` / `BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `RATE_LIMITED` / `SERVER`. Branch on this to distinguish error families without maintaining the full code list. |
| `error.retryable` | `true` for 5xx and 429 (safe to retry); `false` for client errors (correct the request, re-authenticate, or reload per conflict guidance). |
| `error.requestId` | Correlation id (same as the `X-Request-ID` header). |
| `error.details` | `[{ field, message }]` on `VALIDATION_ERROR`. |
| `error.resource` | Optional `{ type, id }` resource/context reference where useful (e.g. `CHECKLIST_EXECUTION` / `EVIDENCE_SUBMISSION` on not-found). |
| `error.conflict` | Optional BE-25I-style conflict metadata: `{ current, guidance: { action: "reload", reloadEndpoint, message } }` where applicable (e.g. immutable verification). |

Category mapping: `VALIDATION_ERROR` → `VALIDATION`; generic 4xx (e.g.
`BAD_REQUEST`, 413) → `BAD_REQUEST`; 401 → `UNAUTHORIZED`; 403 →
`FORBIDDEN`; 404 → `NOT_FOUND`; 409 → `CONFLICT`; 429 → `RATE_LIMITED`;
5xx (incl. `DATABASE_UNAVAILABLE`) → `SERVER`. Sync per-item results
(BE-25G/H/I) carry the same `resource` / `conflict` fields on `error`.

## 4. Pagination (mobile opt-in)

Mobile list endpoints (tasks, checklist executions, evidence, reviews,
operational events, workforce/team task feeds) support an **opt-in** page
convention:

```text
GET /tasks?page=1&pageSize=50
```

- `page`: 1-based integer ≥ 1 (default 1).
- `pageSize`: integer 1..200 (default 50).
- Response `meta`:

```json
{ "page": 1, "pageSize": 50, "total": 137, "totalPages": 3 }
```

- Invalid values → `400 VALIDATION_ERROR` with field details (never a silent
  clamp).
- **Web compatibility:** when no pagination parameters are sent, the endpoint
  keeps its historical full-list behavior (`meta: {}`). Mobile SHOULD always
  paginate. Legacy surfaces using `limit`/`offset` (`/auth/audit-events`,
  `/reports/export`) are unchanged.
- Page stability: paginated reads order by the documented key (e.g.
  `occurrence_at, id`); a new page re-issued after changes may shift, which is
  expected for a live list.

## 5. Write responses

- Mutations return the **updated resource** in `data` (e.g. task
  start/complete/cancel return the task; checklist start/complete/cancel
  return the execution).
- Known exceptions (documented in OpenAPI): some checklist response saves
  return `data: {}`; evidence file upload returns the updated metadata record.
- Status codes: `200` for updates/actions, `201` for created resources.

## 6. Status + available_actions

- The backend is the workflow authority. Mobile renders **only**
  `GET /findings/{id}/available-actions` (and the equivalent approval
  endpoints) — it never infers valid transitions from a `status` value.
- `GET /findings/{id}/state` returns `{ findingId, state, stateChangedAt }`.
- The finding `available-actions` read model (`{ findingId, state,
  availableActions[] }`) is the reference shape; work-order / corrective-action
  / vendor-work action projections arrive in BE-25J.

## 7. Mobile execution surface (BE-25A documented set)

| Resource | Endpoints |
|---|---|
| Tasks | `GET /tasks`, `GET /tasks/{taskId}`, `POST /tasks/{taskId}/start\|complete\|cancel` |
| Task assignment feeds | `GET /workforce/{workforceId}/tasks`, `GET /teams/{teamId}/tasks` |
| Checklist executions | `GET /checklist-executions`, `GET /checklist-executions/{executionId}`, `POST …/start\|complete\|cancel`, `GET …/responses` |
| Evidence | `GET /evidence`, `GET /evidence/{evidenceId}`, plus file upload/metadata/download (`/evidence/{evidenceId}/file`, `/file/content`) |
| Reviews | `GET /reviews` |
| Timeline | `GET /operational-events` |
| Finding workflow | `GET /findings/{findingId}/available-actions`, `GET /findings/{findingId}/state` |
| QR resolution | `GET /assets/resolve/{identifier}` |
| My assignments feed (BE-25C) | `GET /mobile/assignments` |
| Checklist mobile contract (BE-25D) | `GET /mobile/checklist-executions/{executionId}` |
| Evidence upload contract (BE-25E) | `POST /mobile/evidence`, `GET /mobile/evidence/{evidenceId}` |
| QR resolution (BE-25F) | `GET /mobile/qr/resolve/{identifier}` |
| Offline sync contract (BE-25G) | `POST /mobile/sync` |
| Supervisor verification (BE-25J) | `GET/POST /mobile/verification/:targetType/:targetId` |
| Push token registration (BE-25L) | `POST/GET /mobile/push-tokens`, `DELETE /mobile/push-tokens/:tokenId` |
| App version metadata (BE-25M) | `GET /mobile/app-version/:platform?appVersion=` |
| Mobile diagnostics (BE-25N) | `GET /mobile/diagnostics` |

All are documented in `docs/api/openapi.yaml` under the `Mobile Execution`
tag; shapes mirror the backend projections exactly.

## 7b. Mobile assignment feed (BE-25C)

`GET /mobile/assignments` returns the authenticated user's active assignments
in one call — a discriminated composition over the authoritative BE-07 Task
and BE-08 Work Order assignment tables (no separate assignment engine):

- **Scope** — only assignments inside the accessible Client/Building set
  (BE-02G), keyed to the user's linked Workforce Profile (BE-25B) and their
  Team. Direct `WORKFORCE` and `TEAM` assignment types only.
- **Item shape** — `id` (assignment id), `type` (`TASK` / `WORK_ORDER`),
  `status` (current authoritative work status), `assignee` (assignee type,
  workforce profile / team, assigned-by, assigned-at), `context` (client,
  building code/name, asset / functional-location refs), `schedule`
  (`occurrenceAt` for tasks; `dueAt` is always `null` — no authoritative due
  date yet), `reference` (type-specific work fields), `availableActions`.
- **`availableActions` is backend-authoritative** — resolved by the same
  authorities the execution endpoints enforce (`task-action`,
  `work-order-action ACTION_RULES`) and gated on the caller's
  `task.manage` / `work_order.manage` permissions. Mobile renders only these
  actions; it never infers transitions from `status`.
- **Permissions** — the endpoint requires `task.read` and `work_order.read`.
- **Pagination** — opt-in `page`/`pageSize` per the BE-25A convention; without
  parameters the full scoped feed is returned.
- Full work-order available-actions projections (close/verification etc.)
  arrive in BE-25J.

## 7c. Checklist mobile contract (BE-25D)

`GET /mobile/checklist-executions/{executionId}` returns the mobile checklist
execution read model (composition over the BE-07 Checklist Template /
Execution / Measurement / Evidence authorities — no separate mobile checklist
engine):

- **Checklist/task reference** — `checklist` (template id/code/name/status)
  and `task` (the first generated task targeting the template:
  `{ taskId, scheduleDefinitionId, occurrenceAt, targetId, buildingId,
  taskStatus }`, or `null` when the execution is not task-bound).
- **Checklist items** — ordered ACTIVE items with `itemType`
  (`CHECK`/`BOOLEAN`/`TEXT`/`NUMBER`), `required`, `displayOrder`, and the
  stored response `value` / `result` / `notes`.
- **Item status/value** — `itemStatus` (`PENDING` when unanswered,
  `ANSWERED` when a value is stored); `value` is the authoritative stored
  value.
- **Measurement/UOM where applicable** — `measurement` on NUMBER items:
  `{ uom: { id, code, name, symbol, category } | null, minimumValue,
  maximumValue, decimalPrecision }` (null when not configured).
- **Evidence requirement** — `evidenceRequirements` at template level and per
  item (`evidenceType` PHOTO/DOCUMENT/SIGNATURE, required, min/max count,
  description). Submission of evidence bytes is BE-25E.
- **Execution status** — `status` (DRAFT / IN_PROGRESS / COMPLETED /
  CANCELLED) plus startedAt/completedAt/createdAt/updatedAt.
- **`availableActions` is backend-authoritative** — `START` (DRAFT only),
  `SAVE_RESPONSES`/`COMPLETE`/`CANCEL` (DRAFT + IN_PROGRESS), mirroring the
  execution endpoints' rules. Mobile renders only these.
- Scope: the execution's Client must be in the accessible set (BE-02G);
  `403 BUILDING_ACCESS_DENIED` otherwise.

## 7d. Evidence upload contract (BE-25E)

`POST /mobile/evidence` is the single-call mobile evidence upload (multipart
field `file` + `evidenceType` + `executionType` + `executionId`, optional
`evidenceRequirementId` / `capturedAt` / `originalFileName`). It reuses the
BE-07 Evidence authority and the CR-BE-API-01 PART 03 storage abstraction —
no separate mobile evidence engine, no bytes in PostgreSQL, no internal
storage paths exposed. The existing Web endpoints (`POST /evidence`,
`POST /evidence/:id/file`, …) are unchanged.

Validation (backend-authoritative, same rules as the existing submission
endpoints):
- execution must exist and be inside the caller's accessible Client scope
  (BE-02G); terminal executions (`COMPLETED`/`CANCELLED`) are rejected,
- when `evidenceRequirementId` is supplied: requirement must be ACTIVE, its
  `evidence_type` must match, its Client must match the execution, and the
  `maximum_count` must not be exceeded,
- file ≤ 50 MB and MIME type must match `evidenceType`
  (PHOTO: jpeg/png/webp; SIGNATURE: png/svg+xml; DOCUMENT: pdf/jpeg/png).

`GET /mobile/evidence/{evidenceId}` returns the reference read model of an
existing submission (same contract shape).

Response contract:
- `id`, `clientId`, `status` (ACTIVE/REMOVED), `submittedByUserId`,
  `createdAt`, `updatedAt`,
- `building` — Building context when resolvable through the target task
  (`{id, code, name}`, else `null`),
- `evidenceRequirement` — validated requirement reference
  (`{id, evidenceType, required, minimumCount, maximumCount, description}`,
  else `null`),
- `target` — `{executionType, executionId, checklist|null, form|null,
  task|null}` (task = first generated task targeting the checklist template,
  with `occurrenceAt`/`taskStatus`/`buildingId`),
- `evidenceType` (PHOTO/DOCUMENT/SIGNATURE),
- `file` — `{originalFileName, mimeType, fileSize, capturedAt,
  uploadStatus: UPLOADED|PENDING, fileAvailable}`. `uploadStatus` is
  `UPLOADED` when the bytes are storage-backed (`PENDING` for metadata-only
  rows). The storage key (`fileReference`) is deliberately not exposed.

Download remains `GET /evidence/{evidenceId}/file/content` (CR-BE-API-01
PART 03). Offline capture/queue is BE-25G.

## 7e. QR resolution contract (BE-25F)

`GET /mobile/qr/resolve/{identifier}` resolves an opaque identifier (QR
label, tag, barcode) through the existing BE-05H Asset Identifier authority —
no separate QR engine. Requires `asset_identifier.read`.

- **QR/identifier input** — `identifier` path value: 6–64 chars of uppercase
  letters, digits, hyphens, underscores (same value contract as BE-05H).
- **Resolve target type** — `targetType: "ASSET"` (discriminated; ready for
  future target types).
- **Target reference** — `targetId` (the Asset id) + `identifier {id,
  identifierType, identifierValue}`.
- **Building / Location context** — `location.building {id, code, name}` and
  `location.functionalLocation {id, code, name, description, status}` (null
  when not bound).
- **Asset / Equipment context where applicable** — `asset` with
  `assetCode`/`assetName`/`description`/`manufacturer`/`model`/`serialNumber`/
  `status` and `equipment {equipmentCode, equipmentName, …, status}` from the
  BE-05D Equipment Profile (null when none).
- **Available mobile action/context** — `available.actions` are read-model
  hints only (`VIEW_DETAILS`, `START_FINDING` for ACTIVE assets). Workflow
  authority stays on the resource endpoints (`/findings/:id/available-actions`,
  work-order actions, …) — nothing workflow-related is invented here.
- **Scope** — resolution is restricted to the accessible Client/Building set
  (BE-02G): an identifier whose Asset's Building is not accessible yields the
  SAME `404 ASSET_IDENTIFIER_NOT_RESOLVABLE` as an unknown value (existence
  is hidden, matching the existing resolve endpoint).
- The existing `GET /assets/resolve/:identifier` endpoint is unchanged.

## 7f. Offline sync contract (BE-25G)

`POST /mobile/sync` is the lightweight batch contract for mobile offline
synchronization. Each operation is executed through the SAME shared services
the REST endpoints use — validation, per-item RBAC, data scope, and workflow
rules are never bypassed, and no separate mobile business engine exists.

**Request** — `{ operations: [ { operationId, resourceType, resourceId,
operation, clientTimestamp, data } ] }` (1–100 items):

- `operationId` — client-generated identifier (1–128 chars of letters,
  digits, dots, underscores, hyphens). **Idempotency key (BE-25H):** unique
  per user — a retry with the same `operationId` (same or later batch)
  replays the ORIGINAL stored result without executing the write again.
- `resourceType` / `operation`:
  - `TASK_EXECUTION` — `START` / `COMPLETE` / `CANCEL` (resourceId = taskId;
    data: `{ completionNotes? }` for COMPLETE),
  - `CHECKLIST_RESPONSES` — `SAVE` (resourceId = executionId; data:
    `{ responses: [...] }`, same body as `PUT /checklist-executions/:id/responses`),
  - `EVIDENCE_SUBMISSION` — `SUBMIT` (resourceId = executionId; data: the
    `POST /evidence` metadata body incl. `evidenceType`/`executionType`/
    `fileReference`/`mimeType`/`fileSize`/…),
  - `TASK_ASSIGNMENT` — `UPDATE` (resourceId = taskId; data:
    `{ assignmentId, status? }`, same as `PATCH /tasks/:taskId/assignments/:assignmentId`).
- `clientTimestamp` — ISO-8601 device time; echoed in the result (not used
  for writes yet — conflict handling is BE-25I).

**Response** — `{ batchId, receivedAt, results[] }`; each result carries
`operationId`, `clientTimestamp`, `success`, `status` (`SUCCESS`/`FAILED`),
`result` (the written public resource on success), `error
{code, message}` on failure, and `serverTimestamp`.

- Per-item execution is independent: a failing item never blocks the rest of
  the batch.
- Envelope violations (missing fields, bad enum/uuid/timestamp, unknown
  operation for the resource type, >100 items) → `400 VALIDATION_ERROR`
  before any write.
- Per-item business failures keep the authoritative codes
  (`PERMISSION_DENIED`, `BUILDING_ACCESS_DENIED`, `BAD_REQUEST`,
  `VALIDATION_ERROR`, …) — identical to the online endpoints.
- Conflict handling (versions, 409s) is BE-25I; offline evidence byte upload
  remains the BE-25E endpoint.

## 7g. Idempotency (BE-25H)

Sync operations are idempotent via the client `operationId`:

- **Idempotency key / client operation ID** — `operationId` (per-item).
- **Request/resource binding** — the key is stored bound to the calling
  user, `resourceType`, `resourceId`, and `operation` in the
  `mobile_sync_idempotency` store.
- **Stored processing result/reference** — on first execution the full
  result is persisted (status, result JSON, error code/message, client and
  server timestamps).
- **Duplicate replay detection** — a retry with the same
  `(user, operationId)` returns the stored result WITHOUT executing the
  write again. Both SUCCESS and FAILED outcomes are stored and replayed,
  so a transient failure retried with the same id does not re-run (issue a
  NEW operationId to retry a failed write).
- **Safe replay response** — the replayed item carries the original
  `result`/`error`/`serverTimestamp`; the response shape is identical to a
  first execution (clients can treat replays as success-of-delivery).
- **Race safety** — the `(user_id, operation_id)` unique key guards
  concurrent duplicate batches: exactly one executes, the other reads the
  stored result.
- **No bypass** — idempotency applies only AFTER the item passes the same
  envelope validation; per-item RBAC, data scope, and workflow rules remain
  untouched (the stored replay skips re-execution, never the authority).

## 7h. Conflict handling (BE-25I)

Sync operations can carry the server version the client last saw:

- **`data.baseVersion`** — the resource's `updatedAt` (ISO-8601) the client
  last received, per operation.
- **Detect stale client update / compare client vs server version** — the
  server compares `baseVersion` with the CURRENT authoritative `updatedAt`
  of the resource (the existing `updated_at` timestamp pattern — no new
  version engine).
- **Return conflict status** — when `baseVersion < server updatedAt`, the
  item returns `success: false`, `status: FAILED`,
  `error.code: SYNC_CONFLICT`; the write is NOT executed. Invalid
  `baseVersion` is also treated as a conflict (reload instead of writing
  blind). An absent `baseVersion` keeps the exact BE-25G behavior.
- **Return current server state/reference** —
  `error.conflict.current` carries the authoritative current resource
  (task, checklist execution, or assignment state), so the client can
  reload without an extra round-trip.
- **Retry/reload guidance** — `error.conflict.guidance`:
  `{ action: "reload", reloadEndpoint, message }` (e.g. reload
  `/tasks/{taskId}` and re-apply the change on top of the fresh state).
- **No automatic merge** — the backend never merges; the client reloads and
  re-applies. Newer server data is never silently overwritten.
- **Scope/authority preserved** — conflict detection runs through the same
  scoped readers as the write services (BE-02G enforced; a cross-Client
  resource yields `BUILDING_ACCESS_DENIED` before any conflict logic).
- **Idempotency interplay** — a replayed operationId returns the stored
  result BEFORE conflict detection; conflicts are not stored (no write
  happened), so a corrected retry with a fresh operationId executes.
- Evidence submissions have no pre-existing row to conflict with (the
  resource is created); replay protection is BE-25H idempotency.

## 7i. Supervisor verification contract (BE-25J)

`GET /mobile/verification/:targetType/:targetId` and
`POST /mobile/verification/:targetType/:targetId` expose the mobile
supervisor verification contract. `targetType` ∈ `CHECKLIST_EXECUTION` |
`FORM_INSTANCE` | `FINDING`. Thin composition over the shared BE-07 review
authority and the BE-09 finding verification workflow — no separate mobile
verification engine.

- **Reviewable resource reference** — `resource` carries the type-specific
  reference: `{ status, checklist | form | finding }`.
- **Supervisor/reviewer context** — `reviewer { userId, displayName,
  workforceProfileId, fullName, employeeCode }` of the pending or latest
  completed verification (user + linked workforce profile).
- **Current verification state** — `verification.state`: review targets →
  `NOT_REVIEWABLE` (target not COMPLETED), `PENDING` (awaiting decision),
  `VERIFIED` / `REJECTED` / `REWORK_REQUIRED` (completed decision state);
  FINDING → the authoritative finding status (`PENDING_REVIEW`, `VERIFIED`,
  `REJECTED`, `REWORK_REQUIRED`, …).
- **Verification decision / notes / verified_at** —
  `verification.decision` (APPROVED / REJECTED / REWORK_REQUIRED), `notes`,
  `verifiedAt` (the review's `reviewed_at`), plus `reviewId`/`reviewStatus`.
- **Available actions (backend-authoritative)** — review targets:
  `['SUBMIT_DECISION']` when the target is COMPLETED and no completed
  verification exists, else `[]`. FINDING: the BE-09 verification subset
  allowed for the caller (`OPEN_REVIEW` / `APPROVE` / `REJECT` /
  `REQUEST_REWORK`) via `resolveFindingActionAuthority` — identical to the
  Web verification endpoint's authority.
- **Submit** — `POST` with `{ decision, notes? }` executes through the SAME
  services as the Web endpoints (review create/decision for review targets;
  finding open-review + submit-verification for FINDING, incl. the
  `finding.review` permission and the BE-09 action authority). A single-call
  mobile flow opens a review when none is pending; a COMPLETED verification
  is **immutable** — a second decision is rejected (`BAD_REQUEST` /
  `FINDING_REVIEW_*`), never silently overwritten.
- **Supervisor authorization** — per-target-type RBAC enforced in the
  service: `review.read`/`review.manage` for review targets,
  `finding.read`/`finding.review` for FINDING (the same permissions the Web
  endpoints require); FINDING additionally requires the BE-09 action
  authority for the decision.
- **Scope** — BE-02G preserved: review targets assert the accessible-Client
  set; FINDING asserts Building access (like the Web finding-verification
  endpoint). Returns 201 with the refreshed contract after a submit.

## 7j. Push token registration (BE-25L)

`POST /mobile/push-tokens` registers the authenticated user's device push
token; `GET /mobile/push-tokens` lists the user's registrations;
`DELETE /mobile/push-tokens/:tokenId` deactivates/unregisters one.

- **User/device reference** — the token always belongs to the AUTHENTICATED
  user (user_id comes from the session, never the body); `deviceId` is the
  stable client-generated device identifier.
- **Push token** — provider opaque token (`pushToken`, 8–512 chars).
- **Platform/device type** — `platform` (ANDROID / IOS) plus optional
  `appVersion`, `deviceModel`, `deviceOsVersion` metadata.
- **registered_at / last_seen_at** — `registeredAt` = first registration;
  `lastSeenAt` refreshes on every registration/touch.
- **Status** — `ACTIVE` / `INACTIVE` / `INVALID`. Deactivated rows are kept as
  history (`INACTIVE`); a registration the push provider rejected is retired to
  `INVALID` by the backend and is also returned by the listing. A row is never
  deleted. A client seeing `INVALID` should re-register that device.
- **Duplicate prevention / rotation** — one ACTIVE registration per
  (user, deviceId): re-registering the same device ROTATES the token
  (UPDATE, no duplicate row); the same token can never be ACTIVE twice for
  one user (re-registration from another device replaces the old device's
  registration). Enforced by partial unique indexes + service rules.
- **Deactivate/unregister** — DELETE sets the row INACTIVE (owner-only;
  404 `NOT_FOUND` with `resource: { type: PUSH_TOKEN, id }` when absent).
- **Registration is not delivery** — registering sends nothing, and a
  successful registration must never be shown to the user as "push enabled".
  Push delivery (CR-BE-PUSH-01) is produced only by the shared outbound
  delivery engine from an existing notification; no endpoint sends, tests or
  resends a push. Client/Building isolation is trivially preserved
  (registrations are user-scoped).
- **Acceptance is not delivery** — when a push is sent, provider acceptance
  means the provider QUEUED it. The backend cannot observe whether the device
  received, displayed or read it, so no API ever reports a push as
  "delivered". The IN_APP inbox remains the authoritative record.
- **Push is not in notification history** — push attempt evidence is retained
  server-side for audit only; it is not exposed through the history endpoints,
  whose channels stay `IN_APP` / `EMAIL` / `WHATSAPP`.

## 7k. App version metadata (BE-25M)

`GET /mobile/app-version/:platform?appVersion=<running version>` returns the
read-only app version metadata contract (public — no authentication, so the
app can check for a required update before login):

- **platform** — ANDROID / IOS.
- **current supported version** — `currentVersion` (latest supported).
- **minimum supported version** — `minimumSupportedVersion` (oldest still
  supported).
- **update required flag** — `updateRequired`: true when the caller's
  `appVersion` is below the minimum (must update to keep working).
- **update available flag** — `updateAvailable`: true when the caller's
  version is below the current version.
- **release metadata where applicable** — `release { version, notes, date }`.

Rules: metadata/read contract only — no app distribution/update delivery, no
hardcoded Flutter UI behavior (clients decide their own UX from the flags;
a client that omits `appVersion` receives the metadata with both flags
false). Version comparison is numeric segment-wise (`1.10.0` > `1.9.0`).
Unknown platform → 400; no active metadata → 404 with
`resource: { type: APP_VERSION, id: platform }`.

## 7l. Mobile observability (BE-25N)

Lightweight backend observability for mobile API usage — no separate
monitoring platform:

- **Mobile request correlation ID** — every response carries
  `X-Request-ID` (client-supplied when it matches the allowed pattern,
  else backend-generated). Logs and error responses include the same id;
  `GET /mobile/diagnostics` echoes it as `requestId`.
- **Device/app version metadata in logs where available** — mobile clients
  may send `X-Device-Id`, `X-Platform` (ANDROID/IOS), `X-App-Version`;
  the BE-25N middleware validates/sanitizes them and the request logger and
  error handler include them (`mobileDeviceId` / `mobilePlatform` /
  `mobileAppVersion` fields). Invalid values are ignored; **tokens, bodies,
  and evidence payloads are never logged**.
- **Sync operation trace/reference** — each `POST /mobile/sync` batch logs a
  structured summary (batchId + requestId + userId + operation/success/
  failed/replayed counts) and one warn line per failed operation
  (operationId + resource type/id + error code). The `batchId` in the
  response is the trace reference.
- **Error/event logging for mobile API failures** — the shared error handler
  logs mobile failures with the correlation id + mobile context (BE-25K
  envelope is unchanged; **stack traces are never exposed to mobile
  clients**).
- **Basic mobile API health/diagnostic metadata** — `GET /mobile/diagnostics`
  (authenticated) returns `{ status: "OK", requestId, serverTime,
  uptimeSeconds, device? }` (sanitized device context echo).

## 8. Scope & isolation

- Reads are scoped by the authenticated user's accessible Buildings/Clients
  (BE-02G). A zero-scope user receives well-formed empty lists, never an error.
- Inaccessible resources → `403 BUILDING_ACCESS_DENIED`; malformed ids →
  `400 VALIDATION_ERROR`.
- Never send `clientId`/`buildingId` as authority — the backend always
  validates scope.

## 9. Out of scope for BE-25A

- Offline sync contract (BE-25G), idempotency keys (BE-25H), conflict handling
  (BE-25I), push tokens (BE-25L), app version metadata (BE-25M), mobile
  observability (BE-25N), unified "my assignments" feed (BE-25C), checklist
  assignment binding (BE-25D), supervisor verification contract (BE-25J).
  Flutter (`asentra-mobile`) is not modified by this wave.

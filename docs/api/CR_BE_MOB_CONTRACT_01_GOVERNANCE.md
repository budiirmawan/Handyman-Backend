# CR-BE-MOB-CONTRACT-01 — Mobile Operational API Contract (START GOVERNANCE)

> **Status:** START GOVERNANCE — inspection, mapping, gap identification and
> documentation only. No PART is implemented, no new endpoint is added, no
> existing domain is redesigned by this step.
> **Baseline:** Arena branch `arena/01a01872-asentra-backend` at
> `3ffcf4dd798fb84e802e4313b14be513d9915a94` (merge of PR #36), working tree
> clean, `main` at `3ffcf4d`.
> **Parent artifacts:**
> - `docs/api/mobile-contract.md` (BE-25A — Mobile API Contract conventions)
> - `docs/BE_25_MOBILE_PLATFORM_INTEGRATION_GOVERNANCE.md` (BE-25 START GOVERNANCE)
> - `docs/api/API_CONTRACT_CHECKPOINT_01.md` (BE-00…BE-23 contract audit)
> - `docs/api/CR_BE_API_01_GOVERNANCE.md` (P1–P4 remediation governance)
> - `docs/api/openapi.yaml` (authoritative machine-readable contract)
> **Date:** 2026-08-19

---

## 1. Objective

Establish the **backend-authoritative API contract** required by the existing
Asentra **mobile** integration boundary. The backend is already the runtime
authority for every operational domain (BE-07…BE-27 + CR waves are merged and
passing). This CR exists to make the **contract** for mobile complete and
machine-readable — it must:

- reuse existing backend authorities and endpoints wherever possible,
- **not** redesign existing domains,
- **not** duplicate existing endpoints or domain logic,
- **not** create mobile-specific business rules,
- prefer existing OpenAPI contracts (`docs/api/openapi.yaml`),
- **not** modify frontend (`asentra-web`) or mobile (`asentra-mobile`) repositories,
- preserve authentication, RBAC, Building isolation, operational workflow,
  evidence, finding and verification behavior.

For START GOVERNANCE only: inspect, map, identify gaps, document findings,
validate the repository. **PART 01 is NOT implemented.**

---

## 2. Frozen scope

CR-BE-MOB-CONTRACT-01 is a **contract-publishing / contract-fixing** CR over an
already-implemented mobile integration (BE-25A–N are merged). Its deliverables
are documentation and, in later PARTs, **additive** OpenAPI/path-documentation
and gap-closure work only where a capability is genuinely under-contracted.
It must not rebuild any engine.

```text
PART 01 — Authentication & Session Contract
PART 02 — User, Role, Permission & Building Context Contract
PART 03 — Task & Work Order Mobile Read Contract
PART 04 — Checklist, Measurement & Evidence Contract
PART 05 — Finding, Rework & Verification Contract
PART 06 — QR, Location & Operational Context Contract
PART 07 — OpenAPI Mobile Contract Completeness
PART 08 — Cross-Contract Regression & Handoff
FINAL REVIEW — Fix → Final Validation → Pull Request
```

> The Pull Request is created only at **FINAL REVIEW** (per governance, and
> explicitly excluded from START GOVERNANCE and from every individual PART).

---

## 3. Governance rules (applied)

1. Use the current Arena branch (`arena/01a01872-asentra-backend`).
2. Do not create or rename branches.
3. Do not create a Pull Request during START GOVERNANCE.
4. Backend remains the source of truth.
5. Do not duplicate existing endpoints or domain logic.
6. Do not create mobile-specific business rules.
7. Prefer existing OpenAPI contracts.
8. Do not modify frontend or mobile repositories.
9. Preserve existing authentication, RBAC, Building isolation, operational
   workflow, evidence, finding and verification behavior.

---

## 4. Baseline facts (verified this step)

| Item | Value | Evidence |
|---|---|---|
| Repository | Node.js 22 + TypeScript (strict) + PostgreSQL | `package.json`, `tsconfig.json` |
| Migrations | **276** versioned migrations | `src/database/migrations/` |
| Modules | **284** domain modules | `src/modules/` |
| Route registrations | **~1,023+** method registrations (`router.<verb>(`) across `src/modules/**/*.routes.ts` | grep over route files (BE-25 doc records 1,023; count has grown with BE-26/27 + CR waves) |
| Error contract | `ERROR_CODES` = **1,295** named codes in `src/shared/errors.ts` | awk over `ERROR_CODES` block |
| Permission codes | **277** seeded codes in `src/database/seeds/foundation-access.seed.ts` | grep unique literals |
| Envelope | `{success, data, meta}` / `{success, error:{code,message,category,retryable,details?,resource?,conflict?}}` via `sendSuccess`/`sendError` | `src/shared/api-response.ts`, `src/shared/errors.ts` |
| Correlation | `X-Request-ID` on every response (client id accepted when `^[A-Za-z0-9._-]{1,128}$`) | `src/app.ts` middleware |
| OpenAPI | `docs/api/openapi.yaml` — OpenAPI 3.0.3, **242 paths, 43 tags, ~782 schemas**; `Mobile Execution` tag holds **33** path entries | `docs/api/openapi.yaml` |
| Auth/session | Opaque bearer token, hash-only storage, TTL (`SESSION_TTL_MINUTES=480`), revoke on logout | `src/modules/auth/*`, `src/database/migrations/0004` |
| Mobile integration | BE-25A–N implemented (assignments, checklist, evidence, QR, sync, verification, push, app-version, diagnostics) | `src/modules/mobile-*`, `src/modules/push-tokens`, `src/modules/app-versions` |

---

## 5. Capability map (mobile operational contract)

Legend: **AVAILABLE** = backend endpoint exists AND is published in the OpenAPI
contract (or the mobile contract is otherwise fully frozen); 
**AVAILABLE_WITH_CONTRACT_GAP** = backend endpoint/authority exists and works,
but the OpenAPI contract does not (fully) publish it; **NOT_AVAILABLE** = no
backend endpoint/authority exists.

### 5.1 Authentication & session

| Capability | Backend source | Classification |
|---|---|---|
| Login / authentication | `POST /auth/login` → `{sessionToken, expiresAt, user}` | **AVAILABLE** (OpenAPI `Authentication` tag) |
| Authenticated / current user | `GET /auth/me` → effective context | **AVAILABLE** (OpenAPI `Effective Context`) |
| Session validation / expiry | Opaque bearer token, hash-only storage, `SESSION_TTL_MINUTES=480`, `AUTHENTICATION_REQUIRED` / `INVALID_SESSION` / `SESSION_EXPIRED` | **AVAILABLE** |
| Logout / revoke | `POST /auth/logout` → `{revoked:true}` | **AVAILABLE** (OpenAPI `Authentication`) |
| Login throttling / audit | `AUTH_LOGIN_RATE_LIMIT_*`, `GET /auth/audit-events` | **AVAILABLE** |
| Session refresh (extend TTL) | — (expiry handled by re-login) | **NOT_AVAILABLE** (no refresh/rotate endpoint) |

### 5.2 User, role, permission & Building context

| Capability | Backend source | Classification |
|---|---|---|
| Client / Property / Building context | `GET /auth/me` `context.clients→properties→buildings`, `GET /auth/me/buildings`, structure routes (`clients`, `properties`, `buildings`, `campuses`, `floors`, `areas`, `rooms`, `spaces`, `functional-locations`) | **AVAILABLE_WITH_CONTRACT_GAP** — context is OpenAPI-published; the standalone structure CRUD routes are **not** in OpenAPI |
| Assigned Building access | `GET /auth/me/buildings`, `scope.buildingIds` (BE-02G), `user_building_assignments` | **AVAILABLE** |
| Roles | `roles` module (`POST/GET /roles`, `GET /roles/:id`, `POST/GET /users/:userId/roles`) | **AVAILABLE_WITH_CONTRACT_GAP** — endpoints exist, RBAC enforced; **not** in OpenAPI |
| Permissions | `permissions` module + `access.permissions` in `/auth/me` | **AVAILABLE_WITH_CONTRACT_GAP** — `access.permissions` is OpenAPI-published; `/permissions` routes **not** in OpenAPI |
| Module entitlements | `entitlements` module + `entitlements` in `/auth/me` (BE-02H) | **AVAILABLE** |
| Workforce profile resolution | `context.workforce` in `/auth/me` (BE-25B) | **AVAILABLE** |

### 5.3 Operational execution

| Capability | Backend source | Classification |
|---|---|---|
| Task assignment | `task-assignments`, `GET /workforce/{id}/tasks`, `GET /teams/{id}/tasks`, unified `GET /mobile/assignments` (BE-25C) | **AVAILABLE** (OpenAPI `Mobile Execution`) |
| Work orders | `work-orders` + `work-order-actions` / `-assignments` / `-evidence` / `-verification` / `-history` | **AVAILABLE_WITH_CONTRACT_GAP** — only `/work-orders/{id}/close` + procurement/material paths are OpenAPI-published; core lifecycle undocumented |
| Work-order `available-actions` read model | `GET /work-orders/:id/actions` is **history**, not allowed actions | **NOT_AVAILABLE** (mobile resolves actions via `/mobile/assignments.availableActions`, which is backend-authoritative) |
| Checklist execution | `checklist-executions` (start/responses/complete/cancel) + `GET /mobile/checklist-executions/{id}` (BE-25D) | **AVAILABLE** (OpenAPI `Mobile Execution`) |
| Measurements / UOM | `uoms` module + measurement on NUMBER checklist items (`uom`, `minimumValue`, `maximumValue`, `decimalPrecision`) | **AVAILABLE_WITH_CONTRACT_GAP** — measurement shape is published via `/mobile/checklist-executions`; `/clients/:clientId/uoms` etc. **not** in OpenAPI |
| Evidence | `evidence` + `evidence-requirements` + file upload/download (`POST/GET /evidence/{id}/file`, `…/file/content`) + `POST /mobile/evidence` (BE-25E) | **AVAILABLE** (OpenAPI `Evidence` + `Mobile Execution`) |
| Findings | `findings` + `GET /findings/{id}/available-actions` + `GET|PATCH /findings/{id}/state` | **AVAILABLE_WITH_CONTRACT_GAP** — available-actions/state published; full finding CRUD/assignments/classification/severity undocumented |
| Rework | `finding-rework`, `vendor-rework` | **AVAILABLE_WITH_CONTRACT_GAP** — endpoints exist; **not** in OpenAPI |
| Verification | `GET/POST /mobile/verification/{targetType}/{targetId}` (BE-25J) + `finding-reviews`, `work-order-verification`, `corrective-action-verification`, `vendor-verification` | **AVAILABLE** — `/mobile/verification` is OpenAPI-published; per-domain verification endpoints are not |

### 5.4 Operational context & error contract

| Capability | Backend source | Classification |
|---|---|---|
| QR / location / asset context | `GET /mobile/qr/resolve/{identifier}` (BE-25F), `GET /assets/resolve/{identifier}`, `GET /buildings/{id}/hierarchy`, `POST /contractor-contexts/resolve` | **AVAILABLE** (OpenAPI `Mobile Execution`) |
| QR for non-asset target types (room/floor/space/functional-location) | — `targetType` discriminated to `ASSET` only | **NOT_AVAILABLE** |
| Deterministic validation/error responses | BE-25K mobile error contract (`category`, `retryable`, `requestId`, `resource`, `conflict`), `ERROR_CODES` (1,295), uniform envelope | **AVAILABLE** |
| Offline sync / idempotency / conflict | `POST /mobile/sync` (BE-25G), `operationId` idempotency (BE-25H), `baseVersion` conflict (BE-25I) | **AVAILABLE** (OpenAPI `Mobile Execution`) |
| Push token / app version / diagnostics | `push-tokens`, `app-versions`, `mobile-diagnostics` (BE-25L/M/N) | **AVAILABLE** (OpenAPI `Mobile Execution`) |

**Headline finding:** *None* of the capabilities the mobile integration
boundary requires are missing at the endpoint level — the backend is the
complete runtime authority. Every gap is a **contract-publication gap** (OpenAPI
coverage / documentation), not a missing capability. The two genuine
`NOT_AVAILABLE` rows are additive conveniences (session refresh; QR for
non-asset target types; a direct work-order `available-actions` read model) that
are outside the frozen scope unless a PART explicitly needs them.

---

## 6. Authentication / session model (verified)

- `POST /auth/login` (public) → bcrypt credential check → opaque `sessionToken`
  (random bytes, `SESSION_TOKEN_BYTES=32`), stored **hashed-only**
  (`hashSessionToken`), returns `{ sessionToken, expiresAt, user }`.
- `GET /auth/me` (auth) → `{ user, access:{roles, permissions}, context:{clients, workforce}, scope:{buildingIds, clientIds}, entitlements }`
  (BE-01I + BE-02H + BE-25B). `access.permissions` is the exact deduplicated set
  `requirePermission(...)` enforces — single source of truth.
- `POST /auth/logout` (auth) → revokes the session (`revokeSession`) → `{revoked:true}`.
- Expiry: `SESSION_TTL_MINUTES=480`; invalid/expired tokens map to
  `INVALID_SESSION` / `SESSION_EXPIRED` (401) — mobile treats any 401 as
  "re-authenticate".
- Rate limiting: per-IP login throttle (`AUTH_LOGIN_RATE_LIMIT_*`).
- Audit: `GET /auth/audit-events` (`auth.audit.read`) + persistent
  `authentication_audit_events` (0005-era).
- Invitation onboarding: `POST /invitations`, `POST /invitations/accept`
  (one-time token), revoke, account lifecycle (deactivate/suspend/reactivate).

## 7. Building context model (verified)

- Hierarchy: `Client → Property → Building → (Campus → Floor → Area → Room →
  Space → Functional Location)` via `structure-context` + per-entity modules.
- Isolation (BE-02G): `contextAccessService.getAccessibleBuildingIds /
  getAccessibleClientIds / assertBuildingAccess` + `requireBuildingAccess`
  middleware; `GET /auth/me/buildings` + `scope.buildingIds` expose the
  accessible set. Inaccessible resource → `403 BUILDING_ACCESS_DENIED`;
  zero-scope user → well-formed empty lists.
- Assignment: `user_building_assignments` (0019) + `workforce_building_assignments` (0030).

## 8. Roles / permissions model (verified)

- Default-deny RBAC: `requirePermission(code)` middleware; 277 seeded permission
  codes (`<domain>.<verb>`) assigned to `PLATFORM_ADMIN` idempotently.
- Roles/permissions/assignments modules; effective set resolved through
  `role_permission_assignments` + `user_role_assignments` (ACTIVE roles only).
- Dedicated execution permissions (`checklist.*`, `task.*`, `evidence.*`,
  `review.*`, `schedule.*`) from CR-BE-API-01 PART 04 — `form_template.*` no
  longer gates execution surfaces.

---

## 9. Operational endpoints available to mobile (verified)

**Documented under `Mobile Execution` (33 path entries) — consumable directly:**
`/tasks` (+ `/{taskId}` `start|complete|cancel`), `/workforce/{id}/tasks`,
`/teams/{id}/tasks`, `/checklist-executions` (+ `/{id}` `start|responses|
complete|cancel`), `/evidence` (+ `/{id}`, `/{id}/file`, `/{id}/file/content`),
`/reviews`, `/operational-events`, `/findings/{id}/available-actions`,
`/findings/{id}/state`, `/assets/resolve/{identifier}`,
`/mobile/assignments`, `/mobile/checklist-executions/{id}`, `/mobile/evidence`
(+ `/{id}`), `/mobile/qr/resolve/{identifier}`, `/mobile/sync`,
`/mobile/verification/{type}/{id}`, `/mobile/push-tokens` (+ `/{tokenId}`),
`/mobile/app-version/{platform}`, `/mobile/diagnostics`.

**Operational endpoints that exist and work, but are NOT OpenAPI-published**
(the core `PART 07` surface): `work-orders` (list/get/actions/assignments/
verification/history — only `/close` + procurement/material documented),
`work-requests`, `finding-*` (CRUD/assignments/reviews/rework/closure/history/
escalations/classification/severity — only `available-actions`/`state`
documented), `checklist-templates`, `uoms`, `evidence-requirements`,
`form-*`, `schedules`, `task-assignments`, `corrective-action-*`,
`vendor-work*`, `daily-cleaning`, engineering/security/housekeeping executions,
`roles`, `permissions`, `users`, `clients`, `properties`, `buildings`,
`invitations`.

---

## 10. OpenAPI coverage assessment

- `docs/api/openapi.yaml` is well-formed OpenAPI 3.0.3, bearer scheme, shared
  `SuccessEnvelope`/`ErrorEnvelope`/pagination schemas, incremental-extension
  rule in the header — all validated by `tests/openapi-contract.test.ts` (6/6
  passing).
- **Coverage is partial and intentionally incremental.** 242 paths are
  documented vs ~1,023+ registered routes. The spec's "documented only if it
  exists in the router" invariant is enforced by test (no invented endpoints).
- **Published today:** health, auth/session, effective context, `Mobile
  Execution` (BE-25A–N), Evidence file API, Management read models (BE-24),
  Reporting export, Notifications (BE-26), Configuration/Studio (BE-27), and
  the R2P procurement chain (Material Requests → PO → Work Contract → Receiving
  → Vendor Invoice).
- **Not published (mobile-relevant):** core operational domains in §9 second
  block — most importantly work orders, findings (full surface), rework,
  per-domain verification, checklist templates, UOMs, evidence requirements,
  roles/permissions/users/clients/properties/buildings/invitations.

---

## 11. Missing contract areas (gap inventory)

| ID | Gap | Class | Planned PART |
|---|---|---|---|
| G-M01 | OpenAPI does not publish the user/role/permission management surface (`/users`, `/roles`, `/permissions`, `/users/:id/roles`) | Contract gap | PART 02 |
| G-M02 | OpenAPI does not publish Client/Property/Building structure routes (`/clients`, `/properties`, `/buildings`, hierarchy) | Contract gap | PART 02 |
| G-M03 | Work-order lifecycle is undocumented except `/close` + procurement/material; no list/get/actions/assignments/verification/history paths | Contract gap | PART 03 |
| G-M04 | Work orders / corrective actions / vendor work lack a direct `available-actions` read model (checkpoint G07, partially mitigated by `/mobile/assignments`) | Contract gap | PART 03 (documented as authoritative `/mobile/assignments` feed) |
| G-M05 | Checklist templates, UOMs (`/clients/:clientId/uoms`, `/uoms/:id`, measurement bindings), evidence requirements are undocumented | Contract gap | PART 04 |
| G-M06 | Finding CRUD/assignments/reviews/rework/closure/history/classification/severity undocumented (only `available-actions`/`state`) | Contract gap | PART 05 |
| G-M07 | Per-domain verification endpoints (`work-order-verification`, `finding-reviews`, `corrective-action-verification`, `vendor-verification`) undocumented | Contract gap | PART 05 |
| G-M08 | QR resolution limited to `ASSET` target type; no room/floor/space/functional-location resolution | Not available (additive; out of frozen scope) | PART 06 (document boundary only) |
| G-M09 | No session-refresh/rotation endpoint (expiry → re-login) | Not available (additive; out of frozen scope) | PART 01 (document boundary only) |
| G-M10 | Invitation/onboarding surface undocumented in OpenAPI | Contract gap | PART 01 |

---

## 12. Proposed PART 01–08 map

| PART | Title | Scope (contract only) | Reuse | Key output |
|---|---|---|---|---|
| **01** | Authentication & Session Contract | Freeze/publish `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, session expiry/error codes, `GET /auth/audit-events`, invitations | `src/modules/auth/*`, `session.*` | OpenAPI `Authentication` tag + mobile-contract §2 refresh |
| **02** | User, Role, Permission & Building Context Contract | Publish `/users`, `/roles`, `/permissions`, `/users/:id/roles`, `/clients`/`/properties`/`/buildings`, `GET /auth/me/buildings`, `scope`/`entitlements` | `users`, `roles`, `permissions`, `building-assignments`, `context-access` | OpenAPI `User/Role/Permission` + `Building Context` tags |
| **03** | Task & Work Order Mobile Read Contract | Publish task feeds (`/tasks`, `/workforce/:id/tasks`, `/teams/:id/tasks`, `/mobile/assignments`) and work-order read surface (list/get/actions/assignments/verification/history); document `availableActions` authority | `tasks`, `task-*`, `work-orders`, `work-order-*`, `mobile-assignments` | OpenAPI `Task` + `Work Order` read paths |
| **04** | Checklist, Measurement & Evidence Contract | Publish checklist templates/executions, UOM/measurement shapes, evidence requirements + upload/download | `checklist-*`, `uoms`, `evidence*`, `mobile-checklist`, `mobile-evidence` | OpenAPI `Checklist/Measurement/Evidence` paths |
| **05** | Finding, Rework & Verification Contract | Publish finding CRUD/assignments/reviews/rework/closure/history + per-domain verification + `/mobile/verification` | `findings`, `finding-*`, `*-verification`, `mobile-verification` | OpenAPI `Finding/Rework/Verification` paths |
| **06** | QR, Location & Operational Context Contract | Publish QR resolution, asset/structure context, location hierarchy, operational timeline | `asset-identifiers`, `structure-context`, `mobile-qr-resolution`, `operational-events` | OpenAPI `QR/Location/Context` paths; document ASSET-only boundary |
| **07** | OpenAPI Mobile Contract Completeness | Diff OpenAPI vs router for the mobile-consumed surface; close residual path/schema gaps; assert no invented endpoints | `openapi.yaml`, `tests/openapi-contract.test.ts` | Completeness matrix + spec extension |
| **08** | Cross-Contract Regression & Handoff | Run `typecheck`, `openapi-contract`, mobile contract tests; verify envelope/error/scope invariants across PART 01–07; update handoff docs | full suite | Regression report + `frontend-r2p-contract-handoff.md` |
| **FINAL REVIEW** | Fix → Final Validation → Pull Request | Acceptance-criteria check across all PARTs, commit/push same branch, open PR | — | PR (the only PR in this CR) |

Execution order: **PART 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → FINAL REVIEW**.
PART 02–06 are independent of each other but all depend on PART 01's frozen
auth/session conventions; PART 07 depends on 01–06; PART 08 is the regression
gate.

---

## 13. Validation result (this step)

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ PASS |
| `tests/openapi-contract.test.ts` (6 subtests) | ✅ PASS (6/6) — OpenAPI well-formed, bearer scheme, envelopes, pagination, no invented endpoints, protected/public behavior matches router |
| `tests/mobile-error-contract.test.ts` (HTTP/envelope subtests) | ✅ PASS (non-DB subtests); DB-backed subtests require local PostgreSQL |
| DB-backed test suites | ⚠️ NOT RUN — no local PostgreSQL (`localhost:5432`) in the sandbox; `asentra_test` unavailable; environment limitation, not a code defect |
| Working tree / branch | ✅ Clean on `arena/01a01872-asentra-backend` |
| OpenAPI ↔ router drift | ✅ Invariant enforced by test (documented paths exist in router) |

---

## 14. What was NOT done (per instructions)

- No PART implemented; no new endpoint, route, migration, seed, or business
  logic added or changed.
- No frontend/mobile repository modified (not present in this repository).
- No PR created, no merge, no branch created/renamed.

---

## 15. Readiness for PART 01

- **Ready: YES — PART 01 only** (Authentication & Session Contract).
- All auth/session endpoints already exist and are largely OpenAPI-published;
  PART 01 is therefore a **contract-freeze/publish** part (session error-code
  alignment, invitation surface, `/auth/me` shape), not an engine build.
- Blockers before PART 01: **none.** The only NOT_AVAILABLE items (§11 G-M08,
  G-M09) are additive and explicitly out of the frozen scope; they are recorded
  as boundaries, not deliverables.

Next: **CR-BE-MOB-CONTRACT-01 PART 01 — Authentication & Session Contract.**

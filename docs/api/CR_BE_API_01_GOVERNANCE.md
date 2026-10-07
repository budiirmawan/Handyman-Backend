# CR-BE-API-01 — API Contract & Security Remediation (Governance)

> **Status:** START GOVERNANCE — documentation only. No remediation implemented in this step.
> **Baseline:** Arena branch `arena/01a00e91-asentra-backend` at `c5fe360` (`docs(api): add contract checkpoint 01`), on top of merged BE-23 baseline `515e8f3` (PR #25).
> **Parent artifact:** `docs/api/API_CONTRACT_CHECKPOINT_01.md` (checkpoint 01, POTENTIAL_CR gaps P1–P4).
> **Date:** 2026-08-17

---

## 1. Frozen scope

CR-BE-API-01 exists **only** to remediate the four critical contract/security gaps identified by API Contract Checkpoint 01.

```text
PART 01 — OpenAPI Contract Foundation          → P1
PART 02 — Legacy Operational Data Scope Remediation → P2
PART 03 — Evidence File API Foundation         → P3
PART 04 — Shared Operational Permission Alignment  → P4
FINAL REVIEW
```

Execution order: **PART 01 → PART 02 → PART 03 → PART 04 → FINAL REVIEW** (recommended; PART 02/03/04 are independent of each other but all depend on PART 01's contract conventions being in place first).

## 2. P1–P4 mapping

| Gap | Checkpoint reference | Remediation PART | Affected areas | Acceptance criteria (see §9) |
|---|---|---|---|---|
| P1 — Authoritative OpenAPI contract missing (`docs/api/openapi.yaml` does not exist; all ~1,004 route registrations undocumented) | Checkpoint §3, §4, §8.1, P1 | PART 01 | `docs/api/`, shared envelope (`src/shared/api-response.ts`, `src/shared/errors.ts`), BE-00/BE-01 platform routes | AC-01.1…AC-01.5 |
| P2 — Legacy operational list endpoints have incomplete Client/Building data isolation (global `SELECT *`, no accessible-building scope) | Checkpoint §5, §8.2, P2 | PART 02 | BE-07-era modules: `checklist-executions`, `form-instances`, `tasks`, `task-assignments`, `evidence`, `evidence-requirements`, `schedules`, `recurrence`, `reviews`, `uoms`, `operational-events` | AC-02.1…AC-02.5 |
| P3 — Evidence exposes metadata/`fileReference` without a complete file upload/download contract | Checkpoint §5, §8.3, P3 | PART 03 | `evidence` module, `evidence_submissions` table (0073), domain evidence surfaces (`work-order-evidence`, `housekeeping-evidence`, `vendor-work-evidence`, `permit-evidence`, `utility-meter-reading-evidence`, `visitor-photo`, `supporting-documents`), storage abstraction (new) | AC-03.1…AC-03.6 |
| P4 — Operational permission reuse is inconsistent (`form_template.read/manage` reused across form/checklist/task/evidence surfaces) | Checkpoint §5, §7, §8.7, P4 | PART 04 | `foundation-access.seed.ts` + 17 route files gated on `form_template.*` | AC-04.1…AC-04.5 |

## 3. Governance review — confirmed findings

### 3.1 Baseline
- Branch: `arena/01a00e91-asentra-backend` (session-fixed). Working tree clean.
- Commits: `c5fe360` (checkpoint 01) → `515e8f3` (BE-23 merge, PR #25).
- `docs/api/API_CONTRACT_CHECKPOINT_01.md` exists; P1–P4 recorded as POTENTIAL_CR (Checkpoint §9).

### 3.2 P1 — OpenAPI
- `grep -ri openapi` over the repository returns **nothing**. No `docs/api/openapi.yaml`, no schema registry, no spec tooling.
- README "REST API" section documents only BE-01-era endpoints; every BE-02…BE-23 endpoint is documented only in route-file prose comments.

### 3.3 P2 — Affected modules (verified)
Unscoped/global list queries exist in:
- `checklist-executions` — `GET /checklist-executions` (`SELECT * FROM checklist_executions ORDER BY created_at DESC`)
- `form-instances` — `GET /form-instances` (global `SELECT *`)
- `tasks` — `GET /tasks` (optional `clientId` filter only)
- `task-assignments` — `GET /tasks/:taskId/assignments`, `GET /workforce/:workforceId/tasks`, `GET /teams/:teamId/tasks` (no access assertion)
- `evidence` — `GET /evidence` (`executionId`/`requirementId` filters only)
- `evidence-requirements` — `GET /evidence-requirements` (`targetType`/`targetId`/`clientId` filters only)
- `schedules` — `GET /schedules` (`clientId`/`buildingId`/`targetType` filters only, no access assertion)
- `recurrence` — `GET /schedules/:scheduleId/recurrence`
- `reviews` — `GET /reviews` (`targetType`/`targetId` only)
- `uoms`, `operational-events` — list routes gated only by permission

**Schema nuance (verified):** several BE-07 tables carry `client_id` but **no `building_id`** (`evidence_submissions`, `evidence_requirements`, `reviews`, `checklist_executions`, `form_instances`); `generated_tasks` and `schedule_definitions` do carry `building_id`. Scoping must therefore be expressed as **accessible-building set → derived accessible-client set → `WHERE client_id IN (...)`** (and `WHERE building_id IN (...)` where present), not a single building column.

### 3.4 Existing data-scope conventions (to reuse)
- `src/modules/context-access/context-access.service.ts` — `getAccessibleBuildingIds(userId)` (query-scope foundation), `assertBuildingAccess(userId, buildingId)` (403 `BUILDING_ACCESS_DENIED`), `canAccessClient`/`canAccessProperty` derived from explicit building assignments (BE-02G).
- `src/modules/context-access/context-access.middleware.ts` — `requireBuildingAccess(paramName = 'id')`; order: authenticate → permission → building access → controller.
- `docs/data-isolation.md` — "Never filter after a global fetch"; scope at repository level with `WHERE building_id IN (...)`.

### 3.5 Existing evidence/storage foundation (verified)
- `evidence_submissions` (migration `0073`): `file_reference TEXT NOT NULL`, `original_file_name`, `mime_type`, `file_size` (0…52,428,800), `captured_at`, `status` (`ACTIVE`/`REMOVED`), `evidence_type` (`PHOTO`/`DOCUMENT`/`SIGNATURE`), `execution_type` (`FORM_INSTANCE`/`CHECKLIST_EXECUTION`).
- **No storage abstraction exists:** no storage/upload env vars in `.env.example`, no storage config in `src/config`, no upload/download endpoints, no multipart middleware in `package.json` (deps: bcryptjs, cors, express, helmet, pg). `JSON_BODY_LIMIT=1mb`.
- Governance principle (`docs/GOVERNANCE.md`): "File / evidence storage must remain abstracted so local, cloud, hybrid, or on-premise deployment can be supported later." PART 03 must introduce that abstraction as its foundation.

### 3.6 Existing permission conventions (verified)
- Seed `foundation_access` (`src/database/seeds/foundation-access.seed.ts`): 230 `FOUNDATION_PERMISSIONS` codes inserted idempotently (`ON CONFLICT (code) DO NOTHING`), all assigned to `PLATFORM_ADMIN` via `role_permission_assignments` (`ON CONFLICT DO NOTHING`). Pattern: `<domain>.<verb>` (`read`/`manage` + verbs such as `approve`, `review`, `close`, `archive`).
- 17 route files gate on `form_template.read`/`form_template.manage` — 5 belong to the form-template domain legitimately (`form-templates`, `form-sections`, `form-template-versions`, `form-instances`, `form-conditions`); **12 do not** (`checklist-templates`, `checklist-executions`, `evidence`, `evidence-requirements`, `tasks`, `task-assignments`, `task-execution`, `schedules`, `recurrence`, `reviews`, `uoms`, `operational-events`).

### 3.7 Current API documentation approach
- Route-file prose comments (e.g., "BE-08E — Work Order Assignment endpoints…"), README REST section (BE-01 only), module `*.types.ts` as the de-facto response contract, `shared/errors.ts` `ERROR_CODES` map as the error contract. No generated or machine-readable documentation.

## 4. Dependency / reuse rules

1. **Isolation engine:** reuse `contextAccessService` and `requireBuildingAccess`; do not create a parallel scoping mechanism.
2. **Scope expression:** accessible-building set → derived accessible-client set; `WHERE client_id IN (...)` / `WHERE building_id IN (...)` at the SQL layer; never post-fetch filtering.
3. **Envelope/errors:** all new endpoints use `sendSuccess`/`sendError` (`{success, data, meta}` / `{success, error:{code,message,details?}}`); new error codes only via `ERROR_CODES` in `src/shared/errors.ts`.
4. **Permissions:** additive-only changes to `FOUNDATION_PERMISSIONS`; removal of a permission is prohibited in this CR; `PLATFORM_ADMIN` keeps all permissions through the existing seed loop.
5. **Evidence storage:** exactly one storage abstraction module; domain evidence modules delegate to it; no per-domain upload logic; bytes never stored in PostgreSQL; internal storage paths never exposed.
6. **OpenAPI:** one authoritative `docs/api/openapi.yaml`, introduced incrementally (PART 01 defines the foundation + starter surface); every endpoint added or changed by PART 02/03/04 must be reflected in it before FINAL REVIEW.
7. **Behavior preservation:** no route path changes; no response-shape changes (except P2 scoping results: denied → `403 BUILDING_ACCESS_DENIED`, zero-access → well-formed empty list) and P3 additions (new upload/download endpoints + optional reference). BE-00…BE-23 behavior must remain intact.

## 5. Explicit exclusions (boundary)

- BE-24 Management & Owner Read Models — not implemented (including Operations/Engineering/Housekeeping KPI read models and export-dataset extension from checkpoint G03/G04).
- BE-25 Mobile Platform Integration — Offline Sync, Idempotency, Conflict Handling, mobile API stabilization, Push Token, App Version Metadata, unified "my assignments" feed (checkpoint G05–G08).
- BE-26 Notification & Omnichannel.
- BE-27 Configuration / CMS / White Label.
- New business domains; new operational tables not required by P1–P4 (e.g., no `building_id` backfill migration unless P2 requires it — prefer client-set scoping).
- Frontend (`asentra-web`) and Flutter/mobile code — no changes.
- No redesign of existing APIs beyond what P1–P4 require (no pagination overhaul, no `availableActions` additions, no error-code renames — those remain checkpoint PARTIAL items for future waves/CRs).

## 6. Risks / blockers

| ID | Risk / blocker | Mitigation |
|---|---|---|
| R1 | P1 must be hand-authored: no OpenAPI tooling or dependency exists; risk of drift from actual routes | Incremental spec; route-file comments + types as source; FINAL REVIEW diff against changed routes; no codegen dependency introduced |
| R2 | BE-07 tables lack `building_id` (client-scoped only); naive `building_id IN (...)` scoping impossible on them | Derive accessible client set from `resolveBuildingsForUser`; document the rule in the spec/data-isolation notes; by-id reads assert per-record access |
| R3 | No multipart/storage dependency; `express.json` limit 1 mb — file upload path must not break the JSON contract | PART 03 introduces a storage abstraction + file-capable request path (multipart middleware decision documented in PART 03), separate from JSON routes; new env vars added to `.env.example` |
| R4 | Routes already accepting `clientId`/`buildingId` query filters (tasks, schedules) could double-authorize | Single scope resolution per request; explicit filter validation against accessible set; existing behavior preserved |
| R5 | P4 switches permissions on 12 execution surfaces — custom roles holding only `form_template.*` would lose access after switch | Additive seed codes; document role re-provisioning in PART 04; no permission removal; PLATFORM_ADMIN unaffected; risk note in PART 04 delivery |
| R6 | Scope creep into checkpoint PARTIAL items (pagination, availableActions, error-code alignment) | Frozen scope enforcement in each PART; FINAL REVIEW gate checks exclusions |

## 7. Implementation order & part boundaries

1. **PART 01 — OpenAPI Contract Foundation.** Create `docs/api/openapi.yaml`: OpenAPI 3.x, info/servers, bearer security scheme, shared `SuccessEnvelope`/`ErrorEnvelope`/`AppError` schemas, documented incremental extension mechanism, and a defined starter path surface (health, auth login/me/logout, audit-events, invitations accept, `/auth/me/buildings`) that later parts extend. **Do not** attempt to document every existing route in this part.
2. **PART 02 — Legacy Operational Data Scope Remediation.** Scope the list/read endpoints of the 11 modules in §3.3 to the authenticated user's accessible set via `contextAccessService`; per-record access assertion on by-id reads where the table is client-scoped only.
3. **PART 03 — Evidence File API Foundation.** Storage abstraction (config-driven backend; local default; interface for cloud/hybrid later), upload + download endpoints (auth + permission + same data scope as the evidence record), wire evidence submission to the file API while preserving the `evidence_submissions` metadata contract; `file_size` limit 50 MB honored; env vars documented.
4. **PART 04 — Shared Operational Permission Alignment.** Additive permission codes in `foundation-access.seed.ts` for the shared operational surfaces; switch the 12 misaligned route files to the dedicated codes; `form_template.*` remains only on the 5 form-template-domain modules; document role re-provisioning impact.
5. **FINAL REVIEW.** Verify AC-01…AC-04, OpenAPI reflects all P2–P4 changes, no boundary violation, checkpoint 01 updated only if factual (no new gaps introduced), commit + push same branch, no PR.

## 8. Governance review evidence (inspected, not modified)

- `docs/api/API_CONTRACT_CHECKPOINT_01.md` (P1–P4 + affected rows)
- `src/routes/index.ts` + per-module `*.routes.ts` (route/permission inventory)
- `src/modules/context-access/*` (BE-02G conventions)
- `src/database/seeds/foundation-access.seed.ts` (permission conventions)
- `src/database/migrations/0073_create_evidence_submissions.ts` (evidence storage shape)
- `src/shared/api-response.ts`, `src/shared/errors.ts` (envelope/error contract)
- `.env.example`, `src/config/*`, `package.json` (no storage/multipart/OpenAPI tooling)
- `docs/GOVERNANCE.md`, `docs/data-isolation.md`, `docs/effective-context.md`

No repository tests run, no migrations run, no build executed (per CR instructions).

## 9. Acceptance criteria per PART

**PART 01 — OpenAPI Contract Foundation**
- AC-01.1 `docs/api/openapi.yaml` exists, is valid OpenAPI 3.x YAML, and parses.
- AC-01.2 Defines: bearer security scheme, shared success/error envelopes, `X-Request-ID` header, and the platform starter path surface (health, auth, context).
- AC-01.3 Documents the incremental extension rule (how PART 02/03/04 and future waves add paths/schemas without a rewrite).
- AC-01.4 No route behavior changed; no dependency added unless required for validation tooling.
- AC-01.5 Spec is committed alongside a short usage note (how to extend; what is intentionally out of scope for now).

**PART 02 — Legacy Operational Data Scope Remediation**
- AC-02.1 No global `SELECT *` list remains on the 11 affected modules; every list is scoped by the accessible set at the SQL layer.
- AC-02.2 A user with zero accessible buildings receives well-formed empty lists (no leakage, no error), matching BE-23 KPI zeroed conventions.
- AC-02.3 A user without access to a requested resource receives `403 BUILDING_ACCESS_DENIED`; malformed ids keep `400 VALIDATION_ERROR`.
- AC-02.4 By-id reads on client-scoped-only tables assert per-record client access.
- AC-02.5 Existing route paths, request shapes, and response shapes preserved; behavior change limited to scope enforcement.

**PART 03 — Evidence File API Foundation**
- AC-03.1 Storage abstraction exists (interface + config-driven backend; local default) and is the only file I/O path.
- AC-03.2 Upload endpoint(s) accept authenticated, permission-checked requests; 50 MB `file_size` cap enforced; MIME handling aligned with `evidence_type` (`PHOTO`/`DOCUMENT`/`SIGNATURE`).
- AC-03.3 Download endpoint enforces the same data scope as the owning evidence record; no internal storage path leaked.
- AC-03.4 `evidence_submissions` metadata contract unchanged (fields, statuses, constraints); submission may reference an uploaded file.
- AC-03.5 New env vars documented in `.env.example`; no bytes stored in PostgreSQL; no new domain evidence endpoints duplicated.
- AC-03.6 OpenAPI (PART 01) extended with the new file paths and schemas.

**PART 04 — Shared Operational Permission Alignment**
- AC-04.1 Dedicated permission codes added to `FOUNDATION_PERMISSIONS` (additive, idempotent) for the shared operational surfaces.
- AC-04.2 The 12 misaligned route files use the dedicated codes; the 5 form-template-domain modules keep `form_template.*`.
- AC-04.3 Seed remains idempotent; `PLATFORM_ADMIN` automatically holds the new codes; no permission removed anywhere.
- AC-04.4 Role re-provisioning impact for custom roles documented (additive; no auto-migration).
- AC-04.5 OpenAPI permission descriptions aligned with the new codes.

**FINAL REVIEW**
- AC-FR.1 P1–P4 each mapped to merged implementation evidence; checkpoint 01 gaps P1–P4 resolvable.
- AC-FR.2 No BE-24/25/26/27 capability, no new domain, no frontend/mobile change introduced.
- AC-FR.3 OpenAPI reflects all P2–P4 surface changes; exclusions (§5) upheld.
- AC-FR.4 Committed on `arena/01a00e91-asentra-backend` and pushed; no PR created, no merge.

## 10. Git governance for this CR

- This step (governance only): commit `docs(api): start CR-BE-API-01 governance`, push the **same** Arena branch, no PR.
- Each PART commits with a scoped message (`docs(api)`/`feat(api)`/`fix(api)` per change), pushed to the same branch.
- No automatic PR creation; no merge without explicit instruction.

## 11. Readiness for PART 01

- Baseline confirmed; P1–P4 confirmed with evidence; affected modules enumerated; conventions (data scope, permissions, envelope, storage principle) captured.
- **Blockers before PART 01:** none. R1 (hand-authored YAML, no tooling) is a managed risk, not a blocker.
- Next: **CR-BE-API-01 PART 01 — OpenAPI Contract Foundation** (incremental starter spec; no attempt to document all routes).

# CR-HM-SEC-01 — PART 02 DECISION REPORT (Handyman-Backend only)

**Status: IMPLEMENTED + VERIFIED, 2026-10-08.** Assigned branch:
`arena/a266c5e9-handyman-backend`; this PART's base HEAD:
`c81e187` (PART 01 commit); tracked tree clean at start. No branch
creation/switch. No PR/merge.

Scope of this PART: extend the PART 01 BE-02G building-scope guard to the
remaining in-scope Handyman **request read / triage / inspection /
diagnosis** operations and the **quotation revision / read / lines /
totals / issue / expire / supersede / decision** operations, including
their relevant resource-read helpers. PART 01's reusable guard
(`assertBuildingScopedResourceAccess` / `canAccessBuildingScopedResource`
in `src/modules/context-access`) was confirmed present and reused — NOT
recreated.

## 1. Source evidence (authority — unchanged from PART 01)

| # | Source | What it establishes |
|---|---|---|
| E1 | `docs/data-isolation.md` (BE-02G) | Access = auth + RBAC permission + explicit ACTIVE `user_building_assignment` to the EXACT Building. "No same-Client shortcut." |
| E2 | Migration `0019` | `user_building_assignments` is per-building only; no user↔client assignment exists. |
| E3 | `src/modules/roles/role.types.ts`, permission seed | Roles carry capabilities only — no scope dimension; no client-wide grant exists for any local User (even PLATFORM_ADMIN stays inside its assigned Buildings). |
| E4 | `src/modules/context-access/context-access.service.ts` | `canAccessClient` is derived reachability, reserved for Client-scoped-only tables; the PART 01 reusable guard is the building-scoped authority. |
| E5 | Migration `0378` | `handyman_service_requests.building_id UUID NOT NULL` — the request (and every stage record and quotation thread derived from it) is a building-scoped resource. |
| E6 | Migration `0391` | `handyman_quotations` carries `client_id` + `handyman_request_id` but **NO building_id** — a quotation thread's Building must be TRACED from the parent request. |
| E7 | Migration `0395` + `handyman-execution-scope.types.ts` | `handyman_execution_scopes.building_id` is an authoritative server-derived location snapshot — the scope read is directly guardable. |
| E8 | `handyman-service-request.repository.ts` (C6 read wall) | The customer-care list/detail per-row SQL wall already requires `b.id = r.building_id` (assignment to the row's exact building) — building-scoped per row, unchanged. |

**Tracing rule implemented:** request-module operations guard on the
request's own `building_id`; quotation operations trace
`quotation → parent request → building_id` via the new
`assertQuotationThreadBuildingAccess` helper; the execution-scope read
guards on the scope's own authoritative `building_id`.

## 2. Endpoint coverage (guarded in this PART)

| Operation | Route | Mechanism |
|---|---|---|
| `recordHandymanRequestTriage` | `POST /handyman/requests/:id/triage` | direct guard on `request.buildingId` |
| `getHandymanRequestTriage` | `GET /handyman/requests/:id/triage` | direct guard (read helper) |
| `recordHandymanInspection` | `POST /handyman/requests/:id/inspection` | direct guard |
| `getHandymanRequestInspection` | `GET /handyman/requests/:id/inspection` | direct guard (read helper) |
| `recordHandymanDiagnosis` | `POST /handyman/requests/:id/diagnosis` | direct guard |
| `getHandymanRequestDiagnosis` | `GET /handyman/requests/:id/diagnosis` | direct guard (read helper) |
| `getHandymanServiceRequestDetail` | `GET /handyman/requests/:id` | direct guard on `request.buildingId`; C6 SQL wall unchanged (stricter, per-row) |
| `createHandymanQuotationRevision` | `POST /handyman/quotations/:quotationId/versions` | trace → parent request |
| `getHandymanQuotation` | `GET /handyman/requests/:id/quotation` | trace → parent request |
| `addHandymanQuotationLine` | `POST /handyman/quotation-versions/:vid/lines` | trace → parent request |
| `listHandymanQuotationVersionLines` | `GET /handyman/quotation-versions/:vid/lines` | trace → parent request |
| `getHandymanQuotationVersionTotals` | `GET /handyman/quotation-versions/:vid/totals` | trace → parent request |
| `issueHandymanQuotationVersion` | `POST /handyman/quotation-versions/:vid/issue` | trace via shared `requireAccessibleQuotation` helper |
| `expireHandymanQuotationVersion` | `POST /handyman/quotation-versions/:vid/expire` | trace via shared `requireAccessibleQuotation` helper |
| `supersedeHandymanQuotationVersion` | `POST /handyman/quotation-versions/:vid/supersede` | trace via shared `requireAccessibleQuotation` helper |
| `decideHandymanQuotation` | `POST /handyman/quotation-versions/:vid/decision` | trace → parent request |
| `getHandymanQuotationDecision` | `GET /handyman/quotation-versions/:vid/decision` | trace decision → quotation → parent request |
| `getCurrentHandymanIssuedQuotationVersion` | `GET /handyman/requests/:id/quotation/presented` | trace → parent request |
| `getHandymanExecutionScopeByQuotationVersion` | `GET /handyman/quotation-versions/:vid/execution-scope` | direct guard on the scope's own `buildingId` (E7) |

Plus PART 01's `createHandymanQuotation` (unchanged in this PART).

**Files changed:** new `src/modules/handyman-quotations/
handyman-quotation-access.ts` (the trace helper, exported via the module
index); targeted in-place replacements of the client-level
`canAccessClient` wall with the guard in `handyman-quotation.service.ts`,
`handyman-quotation-line.service.ts`, `handyman-quotation-lifecycle.service.ts`
(incl. the shared `requireAccessibleQuotation` helper), `handyman-quotation-decision.service.ts`,
`handyman-execution-scope.service.ts`, `handyman-request-triage.service.ts`,
`handyman-request-inspection.service.ts`, `handyman-request-diagnosis.service.ts`,
`handyman-service-request.service.ts` (detail read only).

**Preserved semantics (verified):** route-level `requirePermission`
checks untouched; state-transition gates, UNIQUE/idempotency contracts
and transaction boundaries untouched (the guard replaces only the access
check, in its original position); denial is the same 403
`BUILDING_ACCESS_DENIED` with no existence leak; the C6
represented-customer SQL wall is unchanged; the request-list keeps its
established empty-list no-leak posture (per-row wall is the authority).

## 3. Focused tests — `tests/handyman-building-scope-guard-part02.test.ts` (9 cases, all pass)

| # | Coverage |
|---|---|
| 1 | Triage command: same-building allowed (service + HTTP 201); same-client SIBLING denied (service 403 + HTTP 403 `BUILDING_ACCESS_DENIED`); permission-only actor denied; **zero mutation** (no triage row, status stays INTAKE, no events) |
| 2 | Inspection + diagnosis commands: sibling denied with zero mutation (no row, status unchanged); same-building allowed (status projections intact) |
| 3 | Stage resource-read helpers (triage/inspection/diagnosis reads): same-building allowed; sibling denied 403 |
| 4 | Request detail read: same-building (PLATFORM_ADMIN + assigned building) allowed (service + HTTP 200); sibling and permission-only denied 403 (no leak); list keeps per-row wall (sibling gets 0 rows, not 403 — preserved contract) |
| 5 | Quotation revision + read: same-building allowed (v2 DRAFT, HTTP 201); sibling denied on both, version count unchanged, no new events |
| 6 | Lines + totals: sibling cannot add/list/totals (403, zero line rows); same-building adds, lists, totals correctly |
| 7 | Issue / expire / supersede: sibling denied with zero mutation (status stays DRAFT/ISSUED, no events); same-building issues (HTTP 200), expires (server-side validUntil moved), supersedes |
| 8 | Decision (decide + read): same-building decides over HTTP (201, REJECT — no scope); sibling + permission-only denied on decide AND read (no content leak); still exactly one decision, no scope, no new events |
| 9 | Execution-scope read + presented read: presented read allowed while ISSUED; APPROVE creates the scope; scope read allowed for same-building (scope's own `buildingId` asserted); sibling denied on both (service + HTTP 403) |

**Vulnerability-detection check:** with three representative source files
temporarily reverted to the pre-PART-02 client-level wall, tests
1 / 3 / 7 / 8 / 9 **fail** (sibling actors wrongly allowed); with the
guard in place all 9 pass. The suite detects the vulnerability rather
than passing vacuously.

## 4. Verification evidence (2026-10-08, this branch, embedded PostgreSQL)

- `npx tsc --noEmit` (project typecheck, changed src files): **clean**.
  Standalone strict typecheck of the new test file: **clean**.
- `git diff --check`: **clean**.
- Focused + directly affected suites (run sequentially, no broad suite):

| Suite | Result |
|---|---|
| `handyman-building-scope-guard-part02` (new) | 9/9 pass |
| `handyman-request-triage` | 10/10 pass |
| `handyman-request-inspection` | 10/10 pass |
| `handyman-request-diagnosis` | 10/10 pass |
| `handyman-request-referral` | 10/10 pass |
| `handyman-customer-care-request-reads` | 8/8 pass |
| `handyman-care-workspace-request-detail` | 13/13 pass |
| `handyman-quotation` | 10/10 pass |
| `handyman-quotations-api` | 10/10 pass |
| `handyman-quotation-decision` | 10/10 pass |
| `handyman-quotation-lifecycle` | 10/10 pass |
| `handyman-quotation-line` | 10/10 pass |
| `handyman-quotation-scope-guard` (PART 01) | 4/4 pass |
| `handyman-execution-scope` | 10/10 pass |
| `handyman-arrival-challenges` | 10/10 pass |
| `handyman-arrival-locations` | 10/10 pass |
| `handyman-execution-scope-assignments` | 10/10 pass |
| `handyman-execution-scope-assignment-service` | 10/10 pass |
| `handyman-geospatial-policies` | 10/10 pass |
| `handyman-provider-availability` | 4/4 pass |

- **Pre-existing failures, identical on the pristine tree (verified by
  stashing this PART's tracked changes and re-running): NOT caused by
  this PART.**
  - `handyman-lifecycle-api`: 9/10 — OpenAPI/runtime parity path-list
    drift (extra `permit-readiness`, `quotation` paths).
  - `handyman-api`: 10/11 — OpenAPI/runtime parity (extra `get` on
    `/handyman/requests`).
  - `handyman-care-workspace-requests`: 14/16 — care-workspace session
    token-hash duplicate (23505) + a 200-vs-404 surface assertion.
  - `handyman-scope-assignments-api`: 9/10 — OpenAPI/runtime parity path
    drift (baseline from PART 01, unchanged).
  - `handyman-customer-care-transport-certification`: 0/5 — environmental
    git-revision check (`fatal: bad revision '2fcfad9..HEAD'`; baseline
    from PART 01, unchanged).
- Runtime DB was available (embedded PostgreSQL); no ENV_BLOCKED
  condition.

## 5. Residual gaps (NOT in this PART's scope — documented)

1. **Request intake create** (`createHandymanServiceRequest`,
   `handyman-service-request.service.ts:248`) still uses the client-level
   `canAccessClient` wall over the attribution's client. A sibling-only
   actor can still CREATE a request at a sibling building. Out of the
   enumerated PART 02 scope ("read/triage/inspection/diagnosis"); guard
   with the attribution's `buildingId` in a later PART.
2. **Referral** (`handyman-request-referral.service.ts:97,217`) still
   uses the client-level wall (command + read helper). Not in the
   enumerated scope; same direct-guard fix applies.
3. **Request list pre-check** (`listHandymanServiceRequests`,
   `handyman-service-request.service.ts:316`) intentionally keeps the
   coarse client-reach pre-check: the list is a client-scoped COLLECTION
   whose per-row C6 SQL wall already requires the actor's ACTIVE
   assignment to each row's exact building (`b.id = r.building_id`), and
   the established contract is the empty-list no-leak posture (empty,
   not 403/404). Verified by test 4 (sibling actor receives 0 rows).
4. **Wider handyman surface** still on the client-level wall (same
   authority, same guard): `handyman-arrival-challenges`,
   `handyman-arrival-locations`, `handyman-arrival-results`,
   `handyman-bast`, `handyman-catalog`, `handyman-chargeable-additional-works`,
   `handyman-customer-ledger-*`, `handyman-sla-status-api`,
   `handyman-care-actors` property scope, and the care-workspace request
   projections. Legacy Client-scoped-only tables (no `building_id`)
   legitimately keep `getAccessibleClientIds` scoping (E4) — unaffected.
5. The five pre-existing test failures listed in §4 remain open on main
   and are unrelated to this PART.

## 6. Exclusions observed

No schema/migration change. No OpenAPI change. No route/permission
change. No change to assignment, work sessions, QC, BAST, finance, or
unrelated routes. No client-level shortcut retained on any guarded
boundary; no new client-wide privilege. No PR/merge. Branch unchanged.
STOP.

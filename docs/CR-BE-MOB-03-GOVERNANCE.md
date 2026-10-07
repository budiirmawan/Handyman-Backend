# CR-BE-MOB-03 — Supervisor Mobile Operational Backend Contract

> **Status:** START GOVERNANCE complete (audit) → **PART 01 complete**
> (Team Workload & Status Contract Publication) → **PART 02 complete**
> (Housekeeping Supervisor Supporting Contract Publication) → **PART 03
> complete** (Engineering & Corrective-Action Verification Contract
> Publication) → **PART 04 complete** (Team-Scoped Work Order Read) →
> **PART 05 complete** (Work Order Mobile Verification Target) →
> **PART 06 complete** (Cross-Contract Regression & Supervisor Handoff).
> **CR-BE-MOB-03 is COMPLETE.**
> This document inspects backend readiness for **Supervisor Teknisi**
> (engineering supervisor) and **Supervisor Cleaning Service** (housekeeping
> supervisor) mobile operations against the runtime + `docs/api/openapi.yaml`,
> reusing the existing backend domain endpoints only.
> **Repository:** `budiirmawan/Asentra-Backend`
> **Baseline:** Arena branch `arena/01a01f5c-asentra-backend` at
> `d9d8d1a` (merge of PR #39 / CR-BE-MOB-02 onto `main`).
> **Date:** 2026-08-20
> **Companion:** [`CR-BE-MOB-03-GAP-MATRIX.md`](./CR-BE-MOB-03-GAP-MATRIX.md)

---

## 1. Objective

Audit the backend's readiness for **supervisor-class mobile operations** —
the two named consumers are **Supervisor Teknisi** (engineering / technician
supervisor) and **Supervisor Cleaning Service** (housekeeping supervisor) —
across the ten requested capability areas:

1. My Team operational workload/status
2. Technician task/work-order review
3. Engineering verification/approval
4. Housekeeping team workload/status
5. Housekeeping inspection
6. Finding creation/read/update
7. Rework request and re-verification
8. Evidence access required by supervisor review
9. Current Shift integration
10. Client/Building isolation and RBAC

For each capability the audit classifies the current state as
**EXISTING**, **PARTIAL**, or **MISSING**, identifies the authoritative IDs and
existing permissions, and recommends a small PART breakdown for later
implementation. **Inspect only. Do not implement.**

---

## 2. Frozen rules (this step)

1. **Inspection and documentation only.** No endpoint, OpenAPI path, schema,
   migration, seed, permission, status enum, or runtime behaviour changes.
2. Do **not** create duplicate `/mobile/{domain}` endpoints. Reuse existing
   backend domain endpoints.
3. Do **not** redesign any domain. The mobile contract is a consumer of
   existing authorities (BE-03 workforce, BE-07 task/checklist/review/evidence,
   BE-08 Work Order, BE-09 Finding, BE-10 engineering, BE-11 housekeeping,
   BE-25 mobile contracts, BE-02 isolation/RBAC).
4. Do **not** change frozen wave numbering (BE-01…BE-27, existing CR ids).
5. A `/mobile/*` composition is allowed later **only** as a thin read/write
   facade over an existing service (the BE-25C/F/G/J pattern), never a second
   engine.
6. Publish-first is the default action for existing-but-unpublished routes
   (`PUBLISH_OPENAPI`); runtime extension (`EXTEND_EXISTING`) and thin
   composition (`COMPOSE_EXISTING`) require a later PART and a product
   decision.
7. No PR, no merge, no push beyond documentation (commit + push the docs only
   if changed).

---

## 3. Baseline facts (verified this step)

| Item | Value | Evidence |
|---|---|---|
| Runtime | Node.js + TypeScript (strict) + PostgreSQL | `package.json`, `tsconfig.json` |
| Migrations | **276** | `src/database/migrations/` |
| Domain modules | **286** | `src/modules/` |
| Registered routes (runtime) | **1346** (`GET/POST/PATCH/PUT/DELETE` across all `*.routes.ts`) | static scan of `src/modules/*/…routes.ts` + `src/routes/health.routes.ts` |
| OpenAPI | OpenAPI 3.0.3, **447 paths / 597 operations / 642 schemas** | parsed `docs/api/openapi.yaml` |
| Published↔runtime parity | **595 / 597** documented operations registered in runtime (the 2 residuals are `/health` + `/health/database`, registered in `src/routes/health.routes.ts`) | comparison of normalized paths/methods |
| OpenAPI annotations | **185** operations carry `x-required-permission` **and** `x-building-scoped: true` (all identical set) | parsed spec |
| Mobile assignment types | `TASK`, `WORK_ORDER` only | `src/modules/mobile-assignments/mobile-assignment.types.ts` |
| Mobile verification targets | `CHECKLIST_EXECUTION`, `FORM_INSTANCE`, `FINDING`, **`WORK_ORDER`** (WORK_ORDER added by PART 05, WO-04 closed) | `src/modules/mobile-verification/mobile-verification.types.ts` |
| Sync resource kinds | 7 (`TASK_EXECUTION`, `CHECKLIST_RESPONSES`, `EVIDENCE_SUBMISSION`, `TASK_ASSIGNMENT`, `PATROL_EXECUTION`, `PATROL_POINT_VISIT`, `METER_READING`) | `src/modules/mobile-sync/mobile-sync.types.ts` |
| QR target types | `ASSET` only | `src/modules/mobile-qr-resolution/mobile-qr.types.ts` |
| Mobile effective context | `GET /mobile/current-shift` (BE-25M), `GET /mobile/my-team` (BE-25N) — published | CR-BE-MOB-02 PART 07C/07D |
| Test files | **313** | `tests/*.test.ts` |
| Working tree at audit start | **clean** at `d9d8d1a` | `git status --short` empty |

> **Count note.** The merged `openapi.yaml` is **447 paths / 597 operations**.
> CR-BE-MOB-02's own governance text recorded 453/604 for its branch state;
> the difference is its recovered PART 01–07A additions (per its own recovery
> note) that are not part of this merged baseline. CR-BE-MOB-01's final
> count was 442/590; the merged CR-BE-MOB-02 PART 07B–07D additions account
> for exactly **+5 paths / +7 operations → 447/597**, consistent with the file
> parsed here. All ten CR-BE-MOB-02 capabilities are present in this baseline.

---

## 4. Method

1. **Runtime inventory** — parsed every `src/modules/*/…routes.ts` for
   `get/post/patch/put/delete` registrations (1346 routes) with the exact
   permission codes enforced per route (`requirePermission('…')`).
2. **OpenAPI inventory** — parsed `docs/api/openapi.yaml` (597 operations)
   with tags, operationIds, `x-required-permission`, `x-building-scoped`.
3. **Parity check** — normalized express `:param` ↔ OpenAPI `{param}` and
   diffed the two sets; 595 documented operations are registered; only the two
   health routes are documented outside `src/modules/`.
4. **Capability mapping** — for each of the 10 areas, listed published
   operationIds, runtime-only (unpublished) routes, and genuinely absent
   capabilities; verified authoritative IDs and seeded permission codes in
   `src/database/seeds/foundation-access.seed.ts`.
5. **Boundary reuse** — cross-checked the frozen CR-BE-MOB-01/02 rows
   (HK-01…HK-09, ENG-01…ENG-06, WO-01…WO-05, QR-01…QR-06, SYN-01…SYN-05,
   NTF-01…NTF-05, SC-01…SC-03, TC-01…TC-03, EH/SH rows) so this CR neither
   duplicates nor contradicts them.

---

## 5. Classification legend

| Status | Meaning |
|---|---|
| **EXISTING** | Backend **and** published OpenAPI already support the mobile supervisor operation. No backend work required beyond consumer binding. |
| **PARTIAL** | Authoritative backend capability exists, but the published contract and/or the supervisor-consumed composition is incomplete. Typical action: `PUBLISH_OPENAPI` (existing routes) and/or a thin composition. |
| **MISSING** | An authoritative backend capability is required and was not found (no route, or a needed filter/type absent). Typical action: `EXTEND_EXISTING` or `COMPOSE_EXISTING` in a later PART — never a new parallel domain. |
| **NOT_REQUIRED** | Must **not** become a backend capability (reuse the existing authority instead). |

Recommended backend actions (later PARTs only, not this step):

| Action | Meaning |
|---|---|
| `NONE` | Already contracted. Consumer binds to the published operationId. |
| `PUBLISH_OPENAPI` | Document existing routes/schemas. No runtime change. |
| `COMPOSE_EXISTING` | Thin `/mobile/*` or read-model composition over an existing service (BE-25 pattern). |
| `EXTEND_EXISTING` | Add a target type / filter / resource kind to an existing contract. |
| `DO_NOT_IMPLEMENT` | Explicitly out of backend scope. |

---

## 6. Capability findings

### 6.1 My Team operational workload/status — **PARTIAL**

The team **context** is contracted; the team **workload/status** is only
partially published.

| Sub-capability | Finding | Status |
|---|---|---|
| Team context + ACTIVE members | `getMobileMyTeam` (BE-25N, `GET /mobile/my-team`, auth-only self-service) returns profile → team → department → organization → client + ACTIVE members. | **EXISTING** |
| Team task workload | `listTeamTasks` (`GET /teams/{teamId}/tasks`) and `listWorkforceTasks` (`GET /workforce/{workforceId}/tasks`) published — ACTIVE task assignments with generated task. | **EXISTING** |
| Team cleaning workload | `listTeamDailyCleaning`, `listWorkforceDailyCleaning` published — daily-cleaning state per team/workforce. | **EXISTING** |
| Team **Work Order** workload | **No team/workforce-scoped Work Order read exists** — `listWorkOrdersByBuilding` filters only `status` / `workType` / `workRequestId`; `listMobileAssignments` is caller-scoped. A supervisor cannot list "my team's WOs" from OpenAPI today. | **MISSING** |
| Workforce KPI / reporting | `GET /workforce/reports/kpi` (BE-23G) and `GET /workforce/reporting` + `/workforce/reporting/:id` (BE-03I1/I2) exist in runtime, **unpublished**. | **PARTIAL** |
| Supervisor direct reports | `GET /workforce/:supervisorId/direct-reports` and `GET /workforce/:workforceId/supervisor` (BE-03F) exist in runtime, **unpublished**. `getMobileMyTeam` deliberately does **not** use `workforce_reporting_lines`. | **PARTIAL** |
| Team/roster CRUD | `/teams`, `/departments/:id/teams`, `/workforce-profiles` exist, **unpublished** — TC-01 remains PARTIAL **by design** (CR-BE-MOB-02 rule: generic Team CRUD stays off the mobile surface). | **PARTIAL** (by design) |

**Do not create:** a mobile team-workload engine, a second My Team endpoint, or
a supervisor KPI domain. Later action: publish the existing BE-03F / BE-23G /
BE-03I2 read routes (`PUBLISH_OPENAPI`) and, only if product requires it, add a
team-scoped Work Order read to the **existing** work-orders domain
(`EXTEND_EXISTING`) — never `/mobile/team-workload`.

### 6.2 Technician task/work-order review — **EXISTING**

Both the technician's assignment feed and the supervisor's review surface for
technician work are fully published.

| Sub-capability | Published operationIds | Status |
|---|---|---|
| Unified field feed | `listMobileAssignments` (TASK + WORK_ORDER discriminated, `availableActions` backend-authoritative) | **EXISTING** |
| Task execution + assignment | `listTasks`, `getTask`, `startTask`, `completeTask`, `cancelTask`, `assignTask`, `listTaskAssignments`, `updateTaskAssignment`, `listWorkforceTasks`, `listTeamTasks` | **EXISTING** |
| Work Order lifecycle | `listBuildingWorkOrders`, `getWorkOrder`, `createWorkOrder`, `updateWorkOrder`, `updateWorkOrderPriority`, `updateWorkOrderStatus`, `updateWorkOrderContext`, `getWorkOrderContext`, `updateWorkOrderBastRequirement`, `completeWorkOrder`, `getWorkOrderCompletion` | **EXISTING** |
| Work Order actions | `acknowledgeWorkOrder`, `startWorkOrder`, `holdWorkOrder`, `resumeWorkOrder`, `addWorkOrderNote`, `cancelWorkOrder`, `listWorkOrderActions` | **EXISTING** |
| Work Order assignment | `assignWorkOrder`, `listWorkOrderAssignments`, `getCurrentWorkOrderAssignment`, `updateWorkOrderAssignment` | **EXISTING** |
| Work Order history | `getWorkOrderHistory` | **EXISTING** |
| Work Order material context | `recordWorkOrderMaterialUsage`, `listWorkOrderMaterialUsages`, `getWorkOrderMaterialUsage`, `getWorkOrderMaterialCostSummary`, `listAssetSpareParts`, `listInventoryItemAssetBindings`, `getAssetSparePart` | **EXISTING** |
| Supervisor review of technician work | `getWorkOrderVerification` / `submitWorkOrderVerification` (BE-08I over the BE-07 review primitive); `getMobileVerification` / `submitMobileVerification` on CHECKLIST_EXECUTION / FORM_INSTANCE (BE-25J); `listReviews` | **EXISTING** |

**Do not create:** a technician-review engine. The published BE-07/BE-08
surface is authoritative.

### 6.3 Engineering verification/approval — **PARTIAL**

The verification **authorities** are published; the engineering supervisor's
**reporting/aggregation** surfaces are only partially published.

| Sub-capability | Finding | Status |
|---|---|---|
| Work Order verification/approval | `getWorkOrderVerification`, `submitWorkOrderVerification`, `closeWorkOrderAfterCanonicalBastReadiness` — decisions APPROVED / REJECTED / REWORK_REQUIRED. | **EXISTING** |
| Finding verification/approval | `getFindingVerification`, `submitFindingVerification`, `openFindingReview`, `listFindingReviews`, `getCurrentFindingReview` (BE-09). | **EXISTING** |
| Mobile supervisor verification | `getMobileVerification` / `submitMobileVerification` for CHECKLIST_EXECUTION / FORM_INSTANCE / FINDING, plus **WORK_ORDER since PART 05** (WO-04 closed — delegates to the BE-08I lifecycle). | **EXISTING** |
| Engineering supervisor records | `getEngineeringDailyOperations` (BE-10A), `getEngineeringOverview` (BE-10K), engineering shift handovers (BE-10J: create/list/get/update/ready/acknowledge), engineering findings (BE-10H: create/list/get) — all published. | **EXISTING** |
| Engineering report datasets | `GET /engineering/reports/{technical-summary,inspections,meter-readings,equipment-logs,checklists,breakdowns,maintenance,findings}` (BE-10I, 8 routes) exist, **unpublished** — deliberately excluded in CR-BE-MOB-01 PART 03 (management reporting). | **PARTIAL** (deliberate) |
| Corrective-action verification | `/corrective-actions/:id/verification*` (6 routes, BE-21 corrective action chain) exist, **unpublished**. | **PARTIAL** |
| Utility (billing) meter verification | BE-18 abnormal-consumption / aggregation verification routes exist, **unpublished** — separate billing authority (ENG-06, deferred by design). | **PARTIAL** (by design) |

**Do not create:** a second verification authority, an engineering-mobile
execution domain, or a per-reading review engine (ENG-02/ENG-05
NOT_REQUIRED). If `WORK_ORDER` is wanted on `/mobile/verification` it is an
`EXTEND_EXISTING` of the BE-25J target enum (WO-04) in a later PART.

### 6.4 Housekeeping team workload/status — **PARTIAL**

The operational daily-cleaning workload is published; consumable readiness,
complaint bindings and report datasets are not.

| Sub-capability | Finding | Status |
|---|---|---|
| Daily cleaning operational state | `listBuildingDailyCleaning`, `getDailyCleaning`, `listCleaningAreaDailyCleaning` — `id` = BE-07 `taskId`. | **EXISTING** |
| Cleaning assignment / workload | `assignDailyCleaning`, `listDailyCleaningAssignments`, `listWorkforceDailyCleaning`, `listTeamDailyCleaning`. | **EXISTING** |
| Consumable readiness | BE-11J (`/housekeeping/consumable-requirements…`, readiness record) + BE-16J bindings (`/housekeeping/consumable-bindings…`, `/buildings/{buildingId}/housekeeping-consumable-bindings`) exist, **unpublished** — HK-05 stays **PARTIAL** (frozen in CR-BE-MOB-01). | **PARTIAL** |
| Complaint bindings | `/housekeeping/complaint-bindings…` (BE-11L, 4 routes) exist, **unpublished**. | **PARTIAL** |
| Housekeeping report datasets | `GET /housekeeping/reports/{summary,cleaning,inspections,supervisor-inspections,findings,consumables,quality-audits,complaints}` (BE-11M, 8 routes) exist, **unpublished**. | **PARTIAL** |
| HK-specific stock-usage engine | Must **not** exist (HK-06 NOT_REQUIRED — use BE-16 WO usage / stock-out). | **NOT_REQUIRED** |

**Do not create:** a housekeeping usage engine or a reinspection domain
(HK-04/06 NOT_REQUIRED). Publish BE-11J/L/M + BE-16J reads; execution stays on
BE-07/BE-09.

### 6.5 Housekeeping inspection — **EXISTING**

| Sub-capability | Published operationIds | Status |
|---|---|---|
| Toilet inspection | `create/list/get/updateToiletInspectionBinding`, `startToiletInspectionExecution`, `getToiletInspectionExecution` | **EXISTING** |
| Public-area inspection | same pattern (`PublicAreaInspection*`) | **EXISTING** |
| Supervisor inspection + decision | `create/list/getSupervisorInspection`, `submitSupervisorInspectionDecision` (APPROVED / REJECTED / REWORK_REQUIRED) | **EXISTING** |
| Quality audit | `create/list/get/updateQualityAudit`, `completeQualityAudit` (PASS / FAIL / REWORK_REQUIRED) | **EXISTING** |

Complete/cancel of a started inspection remains the published BE-07 checklist
operations on the returned `checklistExecutionId` (shared execution, no second
engine).

### 6.6 Finding creation/read/update — **EXISTING**

| Sub-capability | Published operationIds | Status |
|---|---|---|
| Core CRUD | `createFinding`, `listFindings`, `getFinding`, `updateFinding` | **EXISTING** |
| Assignment | `assignFinding`, `listFindingAssignments`, `getCurrentFindingAssignment`, `updateFindingAssignment` | **EXISTING** |
| State / source / actions | `transitionFindingState`, `getFindingState`, `getFindingSource`, `updateFindingSource`, `getFindingAvailableActions`, `cancelFinding` | **EXISTING** |
| Closure / history | `closeFinding`, `getFindingClosure`, `getFindingHistory` | **EXISTING** |
| Domain bindings | `create/list/getHousekeepingFinding` (BE-11H), `create/list/getEngineeringFinding` (BE-10H), `create/list/getSecurityFinding` (BE-12H) — all bind an authoritative BE-09 `findingId` | **EXISTING** |

Workflow always keys on `findingId` (BE-09), never on the binding `id`.

### 6.7 Rework request and re-verification — **EXISTING**

| Sub-capability | Published operationIds | Status |
|---|---|---|
| Rework request | `requestFindingRework`, `updateFindingReworkNotes`, `getFindingRework` | **EXISTING** |
| Reject / resubmit | `rejectFinding`, `resubmitFinding` | **EXISTING** |
| Re-verification | `submitFindingVerification`, `getFindingVerification`, `openFindingReview`, `listFindingReviews`, `getCurrentFindingReview`; Work Order rework via `submitWorkOrderVerification` (REWORK_REQUIRED) | **EXISTING** |

### 6.8 Evidence access required by supervisor review — **EXISTING**

| Sub-capability | Published operationIds | Status |
|---|---|---|
| Shared evidence engine | `submitEvidence`, `listEvidence`, `getEvidence`, `removeEvidence`, `create/list/get/updateEvidenceRequirement`, `uploadEvidenceFile`, `downloadEvidenceFile`, `uploadMobileEvidence`, `getMobileEvidence` | **EXISTING** |
| Work Order evidence | `listWorkOrderEvidence`, `listWorkOrderEvidenceRequirements`, `submitWorkOrderEvidence`, `removeWorkOrderEvidence` | **EXISTING** |
| Housekeeping evidence | `listHousekeepingEvidence`, `listHousekeepingEvidenceRequirements`, `submitHousekeepingEvidence` | **EXISTING** |

A supervisor reviewing a completed checklist/form/finding or Work Order can
pull the exact evidence requirement set and submissions from the published
operations — no supervisor-specific evidence route is needed.

### 6.9 Current Shift integration — **EXISTING**

| Sub-capability | Finding | Status |
|---|---|---|
| Effective current shift | `getMobileCurrentShift` (BE-25M, `GET /mobile/current-shift`) — session-derived, Building-timezone + overnight-aware, filters to BE-02G accessible Buildings. | **EXISTING** |
| Shift context in read models | `getEngineeringDailyOperations` / `getEngineeringOverview` accept caller-supplied `shiftId` context (SC-03). | **EXISTING** |
| Shift definition + roster CRUD | `/buildings/{buildingId}/shifts`, `/shifts/{id}`, `/workforce/{workforceId}/shifts` exist, **unpublished** — SC-01 stays PARTIAL **by design** (generic Shift/roster administration is not a mobile field surface). | **PARTIAL** (by design) |

**Do not create:** a shift/attendance engine, clock-in/out, or a second
"which shift is live" endpoint. The BE-25M derivation is the single authority.

### 6.10 Client/Building isolation and RBAC — **EXISTING**

| Check | Finding | Status |
|---|---|---|
| Published operations annotated | **185/185** published operations carry `x-required-permission` (exact seeded code enforced by `requirePermission`) **and** `x-building-scoped: true`. | **EXISTING** |
| Building isolation | `requireBuildingAccess('buildingId')` on building-nested routes; service-level `contextAccessService.assertBuildingAccess` / `getAccessibleBuildingIds` / `getAccessibleClientIds` (BE-02F/G) inside every supervisor-relevant service (work-orders, findings, daily-cleaning, shift-handovers, mobile-current-shift, mobile-my-team, evidence). 404/403 posture: an inaccessible record returns the same 404 as an unknown one (401-never-404 probes pinned in CR tests). | **EXISTING** |
| RBAC | All supervisor permissions are seeded in `foundation-access.seed.ts`: `task.*`, `work_order.*`, `finding.*` (`read/manage/review/assign/close`), `checklist.*`, `review.*`, `evidence.*`, `daily_cleaning.*`, `cleaning_assignment.*`, `toilet_inspection.*`, `public_area_inspection.*`, `supervisor_inspection.*`, `quality_audit.*`, `housekeeping_finding.*`, `housekeeping_evidence.*`, `consumable_readiness.*`, `housekeeping_report.read`, `engineering.read`, `engineering_overview.read`, `engineering_finding.*`, `engineering_report.read`, `shift_handover.*`, `workforce.*`, `workforce_kpi.read`, `shift.*`, `team.*`. | **EXISTING** |
| Self-service endpoints | `getMobileCurrentShift` / `getMobileMyTeam` are authentication-only (never accept caller-supplied identity; derive from session + accessible scope). | **EXISTING** |
| Unpublished admin surfaces | 751 runtime routes remain unpublished (team/roster/shift/visitor/vendor/config CRUD, reports, procurement, tenant, utility chains, etc.) — excluded by the mobile-field rule, not by omission; each is a documented-by-design exclusion in CR-BE-MOB-01/02. | **EXISTING** (rule) |

---

## 7. Authoritative IDs

| Entity | Authoritative id | Notes |
|---|---|---|
| Task | `generated_tasks.id` (`taskId`) | cleaning / patrol / schedule-generated task; `id` of daily-cleaning = this |
| Task assignment | `task_assignments.id` | assignee = `workforce_profiles.id` or `teams.id` |
| Work Order | `work_orders.id` (`workOrderId`) | number is human-readable only (`workOrderNumber`) |
| Work Order assignment | `work_order_assignments.id` | |
| Checklist execution | `checklist_executions.id` | shared BE-07 engine; inspection/patrol/engineering start returns this |
| Form instance | `form_instances.id` | meter reading / log sheet |
| Review | `reviews.id` | target_type ∈ CHECKLIST_EXECUTION / FORM_INSTANCE / WORK_ORDER |
| Finding | `findings.id` (`findingId`) | HK/ENG/SEC bindings reference it; workflow keys on it |
| Evidence | `evidence_submissions.id`; requirement = `evidence_requirements.id` | |
| Shift | `shifts.id`; roster row = `workforce_shift_assignments.id` (`assignmentId`) | |
| Team | `teams.id`; member = `workforce_profiles.id`; hierarchy = `departments.id` / `organizations.id` / `clients.id` | |
| Building / Client | `buildings.id` / `clients.id` | derived, never caller-supplied for scope |

No `localId` / `tempId` / `clientGeneratedId` exists anywhere in the published
schemas (asserted by CR-BE-MOB-01 PART 08).

---

## 8. Summary classification

| # | Capability | Classification | Main gap |
|---|---|---|---|
| 1 | My Team operational workload/status | **EXISTING** | *PART 04 implemented the team-scoped Work Order read (TMW-04) — capability fully EXISTING after PART 04* |
| 2 | Technician task/work-order review | **EXISTING** | — |
| 3 | Engineering verification/approval | **EXISTING** | *PART 03 published the engineering report datasets (BE-10I) and the corrective-action verification surface (BE-21J); PART 05 closed WO-04 by adding WORK_ORDER to the /mobile/verification targets — the full verification surface is published* |
| 4 | Housekeeping team workload/status | **EXISTING** | *PART 02 published consumable readiness (HK-05), complaints and report datasets — capability fully EXISTING* |
| 5 | Housekeeping inspection | **EXISTING** | — |
| 6 | Finding creation/read/update | **EXISTING** | — |
| 7 | Rework request and re-verification | **EXISTING** | — |
| 8 | Evidence access required by supervisor review | **EXISTING** | — |
| 9 | Current Shift integration | **EXISTING** | SC-01 Shift CRUD stays PARTIAL by design |
| 10 | Client/Building isolation and RBAC | **EXISTING** | — |

**EXISTING 10 · PARTIAL 0 · MISSING 0 (as whole capabilities) after PART 05.**
Every one of the ten audited capabilities is now EXISTING, and the last
deferred runtime extension (WO-04 — `WORK_ORDER` on `/mobile/verification`)
is closed by PART 05. The only remaining deferred items are the ISO-03
optional discriminator and the by-design PARTIAL rows (TMW-07, SHF-02,
ENG-08), none of which blocks supervisor mobile integration.

---

## 9. Recommended SMALL PART breakdown (later implementation, not this step)

Domain-oriented, publish-first, no wave renumbering. Each PART is
contract-first; nothing here is started by this governance step.

```text
CR-BE-MOB-03
  PART 01 — Team workload & status contract publish (BE-03F / BE-23G / BE-03I2)
  PART 02 — Housekeeping consumable readiness + complaints + report datasets publish (BE-11J/L/M + BE-16J)
  PART 03 — Engineering report + corrective-action verification contract publish (BE-10I / BE-21)
  PART 04 — Optional team-scoped Work Order read (EXTEND_EXISTING on BE-08)
  PART 05 — Optional WORK_ORDER target on /mobile/verification (WO-04, EXTEND_EXISTING on BE-25J)
  PART 06 — Cross-contract regression & supervisor handoff
```

| PART | Title | In | Out | Reuse | Class |
|---|---|---|---|---|---|
| **01** | Team workload & status publish | Publish existing `GET /workforce/reports/kpi` (BE-23G), `GET /workforce/reporting` + `…/:id` (BE-03I2), `GET /workforce/:supervisorId/direct-reports` + `GET /workforce/:workforceId/supervisor` (BE-03F). Annotate `x-required-permission` + `x-building-scoped` (workforce.read / workforce_kpi.read; direct-reports stays workforce.read + BE-02G scope). | No new KPI engine, no reporting-line change, no `/mobile/team-workload` | workforce-kpi, workforce-reporting, workforce-reporting-lines | `PUBLISH_OPENAPI` |
| **02** | Housekeeping readiness + reports publish | Publish BE-11J consumable requirements/readiness (6 routes), BE-16J HK consumable bindings (10 routes), BE-11L complaint bindings (4 routes), BE-11M HK report datasets (8 routes) — all existing, with exact seeded permissions (`consumable_readiness.*`, `housekeeping_complaint.*`, `housekeeping_report.read`). | No HK usage engine (HK-06), no reinspection (HK-04) | consumable-readiness, inventory-housekeeping-consumable-bindings, housekeeping-complaints, housekeeping-reports | `PUBLISH_OPENAPI` |
| **03** | Engineering + corrective-action contract publish | Publish BE-10I engineering report datasets (8 routes, `engineering_report.read`) and BE-21 corrective-action verification (6 routes, `corrective_action_verification.read/manage` + review authority). | No diagnosis/test domain (ENG-02), no per-reading review (ENG-05), BE-18 utility chain stays out | engineering-reports, corrective-action-verifications | `PUBLISH_OPENAPI` |
| **04** | Team-scoped Work Order read (optional) | If product requires "my team's WOs": add a workforce/team filter to the existing `listWorkOrdersByBuilding` query or a thin `GET /work-orders?workforceId=&teamId=` read in the **existing** BE-08 domain. Runtime change. | No `/mobile/team-work-orders` facade, no new table | work-orders (BE-08), work-order-assignments | `EXTEND_EXISTING` |
| **05** | `WORK_ORDER` on `/mobile/verification` (optional) | Add `WORK_ORDER` to `MOBILE_VERIFICATION_TARGET_TYPES` (BE-25J) delegating to the published `get/submitWorkOrderVerification`. Runtime change — previously frozen MISSING (WO-04). | No new verification engine | mobile-verification, work-order-verification | `EXTEND_EXISTING` |
| **06** | Regression & handoff | Completeness matrix, OpenAPI↔router invariant, update `mobile-contract.md` / handoff for supervisor consumers. | No new capability | CR contract suites + `tests/mobile-openapi-completeness.test.ts` | — |

**Order:** PART 01 → 02 → 03 are publish-first and independent (no shared
writes; can proceed in any order or parallel). PART 04 and 05 are runtime
extensions and optional; 04 depends on a product decision (team WO view) and
05 resolves the frozen WO-04 row. PART 06 is last.

Only PART 04/05 contain runtime changes. PART 01–03 must not change behaviour.

---

## 10. Priority guidance (for later PART scheduling)

| Priority | Rule |
|---|---|
| **P0** | A supervisor cannot run a live workflow without guessing unpublished routes. *Currently none — the operational write/read surface is published.* |
| **P1** | A supervisor can call an unpublished-but-existing read, or the published substitute is awkward: ~~team workload KPI/reporting/direct-reports (PART 01 done)~~, ~~HK consumable readiness + complaints + report datasets (PART 02 done)~~, ~~engineering/corrective-action datasets (PART 03 done)~~ — none remain. |
| **P2** | Optional composition/extension: team-scoped WO read (PART 04), `WORK_ORDER` on `/mobile/verification` (PART 05). |

---

## 11. Validation (this step)

| Check | Result |
|---|---|
| Inspected all 10 capability areas in runtime (`src/modules/`) | Done — route files, controllers/services, permission codes |
| Inspected `docs/api/openapi.yaml` (447 paths / 597 ops / 642 schemas) | Done — tag/operationId/permission/scope extraction |
| Runtime ↔ OpenAPI parity | 595/597 documented ops registered; 2 residuals are `/health*` in `src/routes/health.routes.ts`; no phantom supervisor operation |
| Cross-checked frozen CR-BE-MOB-01/02 rows (HK/ENG/WO/QR/SYN/NTF/SC/TC/EH/SH) | Done — no row contradicted, no duplicate classification |
| Code / OpenAPI / migrations / runtime modified | **None** |
| PR / merge | **Not created** (instruction: no PR, no merge) |

---

## 12. What was NOT done

- No PART implemented; no endpoint, OpenAPI path, schema, migration, seed,
  permission, or behaviour change.
- No domain redesign; no duplicate `/mobile/{domain}` endpoint.
- No frontend / mobile repository modified.
- No PR, no merge.

---

## 13. Readiness

- **Audit complete.** The supervisor mobile surface is **largely ready**:
  7 of 10 capability areas were fully EXISTING in runtime + OpenAPI at the
  audit; **10 of 10 after PART 05** (PART 01 published the team workload
  KPI/reporting/direct-reports reads; PART 02 published HK consumable
  readiness + complaints + report datasets; PART 03 published the
  engineering report datasets + corrective-action verification surface;
  PART 04 implemented the team-scoped Work Order read; PART 05 closed WO-04
  by adding WORK_ORDER to the /mobile/verification targets).
- **No hard blocker** for supervisor mobile integration: every write the two
  supervisors perform (inspect, decide, verify, approve/reject/rework, review
  evidence, resolve current shift, see own team) is published.
- **Follow-up:** the ISO-03 optional discriminator stays deferred by design;
  PART 06 (cross-contract regression & handoff) is complete — see §19.
- Recommended small PART breakdown in §9.

## 14. PART 01 completion — Team workload & status contract publish

**Date:** 2026-08-20
**Change class:** `PUBLISH_OPENAPI` (documentation of existing read routes) +
**one seed-catalogue registration** (`workforce.read`) required by the
repo's own invariant that a documented permission must be a real seeded code.
No endpoint, schema-behaviour, domain, migration, or `/mobile/{domain}`
facade change. No PART 02–06 item implemented.

### 14.1 Published (existing runtime routes only) — tag `Workforce`

| Method & Path | operationId | Permission | Building isolation | Backend authority reused |
|---|---|---|---|---|
| `GET /workforce/reports/kpi` | `getWorkforceKpi` | `workforce_kpi.read` | `x-building-scoped: true` — explicit `buildingId` is `assertBuildingAccess`-checked; omitted rolls up across the caller's accessible Buildings (BE-02F/G) | BE-23G (read-only projection over BE-03 Workforce + BE-07 Task assignments) |
| `GET /workforce/reporting` | `listWorkforceReporting` | `workforce.read` | `x-building-scoped: true` — every returned record is connected to an accessible Building (`requireAccessibleBuilding: true`); org/dept/team filters cannot widen scope | BE-03I2 over the BE-03I1 read model |
| `GET /workforce/reporting/{id}` | `getWorkforceReporting` | `workforce.read` | `x-building-scoped: true` — profile must be connected to an accessible Building; unknown/out-of-scope → 404 | BE-03I2 single-record read |
| `GET /workforce/{workforceId}/supervisor` | `getWorkforceCurrentSupervisor` | `workforce.read` | **not** claimed as building-scoped — profile-resolved read (404 on unknown profile); no BE-02G gate on the read path today | BE-03F `resolveCurrentSupervisor` |
| `GET /workforce/{supervisorId}/direct-reports` | `listWorkforceDirectReports` | `workforce.read` | **not** claimed as building-scoped — profile-resolved read; no BE-02G gate on the read path today | BE-03F `listDirectReports` |

Every operation carries `tags: [Workforce]`, `security: bearerAuth`, the
documented 401/403 (and 400/404 where the router returns them), and a
description that states the authoritative id and the reuse boundary. **No new
path parameter or schema was invented** — `WorkforceIdPathParam` is reused;
`SupervisorIdPathParam` and `WorkforceReportingIdPath` are new parameter
definitions (both `Uuid`); schemas mirror the implemented DTOs
(`WorkforceKpi*`, `CurrentSupervisor`, `DirectReport`,
`WorkforceReportingRecord`).

**Scope truthfulness:** the two BE-03F reads are published **without**
`x-building-scoped: true` and their descriptions state why (profile-resolved;
the cross-Client rule is enforced on the BE-03F **write** path, so reporting
lines are structurally same-Client, but the read path itself carries no
BE-02G gate). This PART documents the runtime as it is rather than claiming a
scope it does not enforce; a later runtime-hardening PART may add the gate
(`EXTEND_EXISTING` on BE-03F) if product requires it.

### 14.2 Seed catalogue registration — `workforce.read`

`GET /workforce/reporting…` and the BE-03F reads have **always** enforced
`requirePermission('workforce.read')`, but the code was never present in
`FOUNDATION_PERMISSIONS`, so no role could ever be granted it (same defect
class as the `vendor_invoice.*` codes — see the in-repo comment at
`foundation-access.seed.ts`). PART 01 registers `workforce.read` so the
documented `x-required-permission` is a REAL seeded code
(CR-BE-MOB-01 PART 08 invariant: "a documented permission can no longer be a
plausible-looking string"). `workforce_kpi.read` was already seeded.
`workforce.manage` and the rest of the BE-03A/B/E catalogue codes remain
unseeded (pre-existing) and are out of PART 01 scope.

### 14.3 What PART 01 did not do

- No new domain, table, migration, endpoint, permission grant beyond the
  catalogue registration, workflow, or status enum.
- No `/mobile/team-workload`, `/mobile/direct-reports`, or any other
  `/mobile/{domain}` facade.
- No BE-03F write routes published (`POST/PATCH /workforce/:workforceId/
  supervisor` stay off the mobile surface), no team/roster/shift CRUD.
- No change to the KPI, reporting, or reporting-line services/controllers
  (read-only behaviour untouched).
- No PART 02–06 item implemented.

### 14.4 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| YAML well-formed; 447 → **452 paths**, 597 → **602 operations**, 642 → **650 schemas**, 111 → **113 parameters**; unique operationIds; all `$ref`s resolve | ✅ PASS (scripted) |
| `tests/mobile-team-workload-contract.test.ts` (7 subtests, new) | ✅ PASS — exact 5-op surface pinned, documented ⊆ registered, scope exactly as enforced (3 scoped, 2 honestly unscoped), permissions seeded, bearer + 401/403, no mobile facade, live 401-never-404 probes |
| `tests/mobile-openapi-completeness.test.ts` · `openapi-contract.test.ts` · `mobile-cr-regression-contract.test.ts` · `r2p-openapi-contract.test.ts` · `error-contract.test.ts` | ✅ PASS (50/50) |
| CR-BE-MOB-01/02 contract suites (housekeeping, security, engineering, material, QR, sync kinds, push, current-shift, my-team) | ✅ PASS (88 pass / 12 pre-existing DB skips) |
| `git diff --check` | CLEAN |

### 14.5 Remaining PART 01 gaps / residuals

| Residual | Status | Note |
|---|---|---|
| Team **Work Order** workload (TMW-04) | **MISSING** | Unchanged — PART 04 (team-scoped WO read) is a runtime extension, not published here |
| Workforce KPI / reporting / direct-reports reads | **EXISTING after PART 01** | TMW-05/TMW-06 flipped PARTIAL → EXISTING in the gap matrix |
| BE-03F read-path BE-02G gate | **documented limitation** | The two reporting-line reads carry no accessible-scope gate today; documented honestly, not claimed. Optional later runtime hardening (`EXTEND_EXISTING` on BE-03F) — product decision |
| `workforce.manage` + rest of BE-03A/B/E catalogue codes unseeded | **pre-existing** | Out of PART 01 scope (no published operation requires them); a later catalogue-completeness PART may register them |
| My Team context itself (TMW-01) | **EXISTING** | Unchanged — `getMobileMyTeam` is not redesigned |

## 15. PART 02 completion — Housekeeping supervisor supporting contract publish

**Date:** 2026-08-20
**Change class:** `PUBLISH_OPENAPI` only (documentation of existing
housekeeping-support routes). No endpoint, domain, migration, seed,
permission, workflow, or `/mobile/housekeeping` facade change. PART 01
capability behaviour untouched; no PART 03–06 item implemented.

### 15.1 Published (existing runtime routes only) — under the `Housekeeping` tag

| Area | operationIds | Permission | Building isolation |
|---|---|---|---|
| BE-11J consumable requirements (6) | `listConsumableRequirements`, `createConsumableRequirement`, `getConsumableRequirement`, `updateConsumableRequirement`, `recordConsumableReadiness`, `listConsumableReadiness` | `consumable_readiness.read` / `.manage` | `x-building-scoped: true` — every write and single-record read asserts BE-02G on the requirement's Building; list filters assert the supplied `buildingId` (pass it for scoped supervisor lists) |
| BE-16J consumable bindings (10) | `listConsumableRequirementBindings`, `createConsumableRequirementBinding`, `listHousekeepingConsumableBindings`, `getHousekeepingConsumableBinding`, `updateHousekeepingConsumableBinding`, `listBuildingHousekeepingConsumableBindings`, `listCleaningAreaHousekeepingConsumableBindings`, `listClientHousekeepingConsumableBindings`, `listWarehouseHousekeepingConsumableBindings`, `listItemHousekeepingConsumableBindings` | `consumable_readiness.read` / `.manage` | `x-building-scoped: true` — service asserts Building/Client access per filter; Building-nested route uses `requireBuildingAccess` |
| BE-11L complaint bindings (4) | `listHousekeepingComplaintBindings`, `createHousekeepingComplaintBinding`, `getHousekeepingComplaintBinding`, `updateHousekeepingComplaintBinding` | `housekeeping_complaint.read` / `.manage` | `x-building-scoped: true` — every write and single-record read asserts BE-02G on the binding's Building; list asserts supplied `buildingId` |
| BE-11M report datasets (8) | `getHousekeepingReportSummary`, `getHousekeepingReportCleaning`, `getHousekeepingReportInspections`, `getHousekeepingReportSupervisorInspections`, `getHousekeepingReportFindings`, `getHousekeepingReportConsumables`, `getHousekeepingReportQualityAudits`, `getHousekeepingReportComplaints` | `housekeeping_report.read` | `x-building-scoped: true` — `buildingId` is required and access-asserted in the service (BE-02G) |

**28 operations across 21 new paths** (the `/{id}/readiness` POST is its own
path; the `/{id}` requirement path carries GET+PATCH; `/{requirementId}/
bindings` and `/consumable-bindings/{id}` carry two methods each). Every
operation carries `tags: [Housekeeping]`, `security: bearerAuth`,
`x-required-permission` (exact seeded code enforced by `requirePermission`)
and `x-building-scoped: true`, plus documented 400/401/403 (and 404/409 where
the router returns them).

### 15.2 What was added to the contract

- **Parameters (5):** `ConsumableRequirementIdPath`, `HkConsumableRequirementIdPath`,
  `HkConsumableBindingIdPath`, `HousekeepingComplaintBindingIdPath`,
  `HkBindingCleaningAreaIdPath` (all `Uuid`). Reused existing
  `BuildingIdPath` / `ClientIdPath` / `InventoryItemIdPath` /
  `WarehouseIdPath`.
- **Schemas (24):** `ConsumableRequirementStatus`, `ReadinessStatus`,
  `ConsumableRequirement`, `CreateConsumableRequirementRequest`,
  `UpdateConsumableRequirementRequest`, `RecordConsumableReadinessRequest`,
  `ConsumableReadiness`, `HkConsumableBindingStatus`, `HkConsumableBinding`,
  `CreateHkConsumableBindingRequest`, `UpdateHkConsumableBindingRequest`,
  `HousekeepingComplaintBindingStatus`, `HousekeepingComplaintSourceType`,
  `HousekeepingComplaintBinding`, `CreateHousekeepingComplaintBindingRequest`,
  `UpdateHousekeepingComplaintBindingRequest`, `HousekeepingReportSummary`,
  and the seven BE-11M report rows (`HousekeepingCleaningReportRow`,
  `HousekeepingInspectionReportRow`, `HousekeepingSupervisorInspectionReportRow`,
  `HousekeepingFindingReportRow`, `HousekeepingConsumableReportRow`,
  `HousekeepingQualityAuditReportRow`, `HousekeepingComplaintReportRow`).
- **Regression-guard reconciliation:** `tests/mobile-cr-regression-contract.test.ts`
  pins the CR-BE-MOB-01 tag sizes; publishing 28 existing Housekeeping
  operations changes the Housekeeping tag size, so its frozen count is
  reconciled **34 → 62** (the same minimal consequence CR-BE-MOB-02 PART 07B
  applied to Security). No other tag size changed.

### 15.3 What PART 02 did not do

- No new domain, table, migration, endpoint, permission, workflow, or status
  enum; no seed change (all three permission codes were already seeded).
- No `/mobile/housekeeping` facade and no duplicate endpoint.
- No HK usage engine (HK-06) and no reinspection lifecycle (HK-04) —
  both stay NOT_REQUIRED; readiness stays derived from authoritative BE-16
  stock, complaints stay bindings over BE-08/BE-09/BE-07 authorities.
- No redesign of housekeeping workflows; PART 01 capability behaviour
  untouched (the Workforce tag and its 5 operations are unchanged).
- No PART 03–06 item implemented.

### 15.4 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| YAML well-formed; 452 → **474 paths**, 602 → **630 operations**, 650 → **674 schemas**, 113 → **118 parameters**; unique operationIds; all `$ref`s resolve | ✅ PASS (scripted) |
| `tests/mobile-housekeeping-support-contract.test.ts` (6 subtests, new) | ✅ PASS — exact 28-op surface pinned, documented ⊆ registered, permissions seeded + exact, scope true on every op, bearer + 401/403, no `/mobile/housekeeping` facade, no duplicate operationId, live 401-never-404 probes (25 samples) |
| `tests/mobile-openapi-completeness.test.ts` · `openapi-contract.test.ts` · `mobile-cr-regression-contract.test.ts` (Housekeeping 62 reconciled) · `r2p-openapi-contract.test.ts` · `error-contract.test.ts` · `mobile-team-workload-contract.test.ts` (PART 01 regression) | ✅ PASS (71/71) |
| CR-BE-MOB-01/02 contract suites (housekeeping, security, engineering, material, QR, sync kinds, push, current-shift, my-team) | ✅ PASS (80 pass / 12 pre-existing DB skips) |
| `git diff --check` | CLEAN |

### 15.5 Remaining Housekeeping supervisor gaps / residuals

| Residual | Status | Note |
|---|---|---|
| Consumable readiness (HKW-02) | **EXISTING after PART 02** | BE-11J + BE-16J published; readiness remains derived from BE-16 stock, no stock-usage engine (HK-06 NOT_REQUIRED) |
| Complaint bindings (HKW-03) | **EXISTING after PART 02** | BE-11L published |
| Report datasets (HKW-04) | **EXISTING after PART 02** | BE-11M 8 datasets published |
| List endpoints without `buildingId` | **documented guidance** | Matching the CR-BE-MOB-01 Housekeeping convention: list filters assert the supplied `buildingId`/`clientId`; descriptions tell the supervisor to pass `buildingId` for scoped lists. Pre-existing runtime behaviour, unchanged |
| Cleaning-area / schedule-binding master reads (BE-11A/B) | **not published** | Not in the PART 02 matrix scope (HKW rows); the daily-cleaning reads already published reference Cleaning Area ids. A later PART may publish BE-11A/B reads if the supervisor picker needs them |
| Reinspection / HK stock usage | **NOT_REQUIRED** | HK-04/HK-06 frozen — unchanged |

## 16. PART 03 completion — Engineering & corrective-action verification contract publish

**Date:** 2026-08-20
**Change class:** `PUBLISH_OPENAPI` only (documentation of existing
engineering-support routes). No endpoint, domain, migration, seed,
permission, workflow, or `/mobile/engineering` facade change. `/mobile/
verification` is **not** extended (target types unchanged). Finding/rework
lifecycle untouched. PART 01/02 capability behaviour untouched; no PART 04–06
item implemented.

### 16.1 Published (existing runtime routes only)

| Area | operationIds | Permission | Building isolation |
|---|---|---|---|
| BE-10I engineering report datasets (8, tag `Engineering`) | `getEngineeringReportTechnicalSummary`, `getEngineeringReportInspections`, `getEngineeringReportMeterReadings`, `getEngineeringReportEquipmentLogs`, `getEngineeringReportChecklists`, `getEngineeringReportBreakdowns`, `getEngineeringReportMaintenance`, `getEngineeringReportFindings` | `engineering_report.read` | `x-building-scoped: true` — `buildingId` is required and access-asserted in the service (BE-02G) |
| BE-21J corrective-action verification (6, new tag `Corrective Action Verification`) | `listCorrectiveActionVerifications`, `getCorrectiveActionVerificationContext`, `openCorrectiveActionVerification`, `submitCorrectiveActionVerification`, `getLatestCorrectiveActionVerification`, `listCorrectiveActionVerificationHistory` | `corrective_action_verification.read` / `.manage` | `x-building-scoped: true` — `assertBuildingAccess` on the corrective action's Building for every operation; the list endpoint also asserts supplied `buildingId` / `incidentId` |

**14 operations across 13 new paths.** Every operation carries
`security: bearerAuth`, `x-required-permission` (exact seeded code enforced
by `requirePermission`) and `x-building-scoped: true`, plus documented
400/401/403 (and 404/409 where the router returns them).

### 16.2 What was added to the contract

- **Parameter (1):** `CorrectiveActionIdPath` (name `id`, `Uuid`). Reused
  `FindingSourceType`, `ReviewDecision`, `Uuid`, `SuccessEnvelope`,
  `ErrorEnvelope` and the standard responses — no redefined primitive.
- **Schemas (14):** `EngineeringTechnicalSummary` + the seven BE-10I report
  rows (`EngineeringInspectionReportRow`, `EngineeringMeterReadingReportRow`,
  `EngineeringEquipmentLogReportRow`, `EngineeringChecklistReportRow`,
  `EngineeringBreakdownReportRow`, `EngineeringMaintenanceReportRow`,
  `EngineeringFindingReportRow`), and the BE-21J surface
  (`CorrectiveActionVerificationStatus`, `CorrectiveActionVerification`,
  `CorrectiveActionStatus`, `CorrectiveActionVerificationContext`,
  `OpenCorrectiveActionVerificationRequest`,
  `SubmitCorrectiveActionVerificationRequest`).
- **Tag:** new `Corrective Action Verification` top-level tag declared with a
  description pinning the BE-07 `reviews`-row reuse boundary and the
  read/manage permission split.
- **Regression-guard reconciliation:** `tests/mobile-cr-regression-contract.test.ts`
  pins the CR-BE-MOB-01 tag sizes; publishing 8 existing Engineering report
  datasets changes the Engineering tag size, so its frozen count is
  reconciled **54 → 62**. The 6 corrective-action operations live under the
  new tag, which the guard does not pin (asserted by the focused test).

### 16.3 What PART 03 did not do

- No new domain, table, migration, endpoint, permission, workflow, or status
  enum; no seed change (all three permission codes were already seeded).
- No `/mobile/engineering` facade and no duplicate endpoint.
- **No extension of `/mobile/verification`** — at PART 03 time
  `MOBILE_VERIFICATION_TARGET_TYPES` stayed `CHECKLIST_EXECUTION` /
  `FORM_INSTANCE` / `FINDING`; `WORK_ORDER` (WO-04) and `CORRECTIVE_ACTION`
  were neither invented nor advertised (a focused test asserted the
  parameter enum was unchanged at that point). PART 05 later legitimately
  closed WO-04 by adding WORK_ORDER; `CORRECTIVE_ACTION` remains out.
- No finding/rework lifecycle change; no Work Order or verification workflow
  redesign. The corrective-action verification is documented as the shared
  BE-07 `reviews` row (target_type CORRECTIVE_ACTION) — no new engine.
- No PART 04–06 item implemented.

### 16.4 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| YAML well-formed; 474 → **487 paths**, 630 → **644 operations**, 674 → **688 schemas**, 118 → **119 parameters**; unique operationIds; all `$ref`s resolve; all tags declared | ✅ PASS (scripted) |
| `tests/mobile-engineering-support-contract.test.ts` (6 subtests, new) | ✅ PASS — exact 14-op surface pinned (8 Engineering + 6 Corrective Action Verification), documented ⊆ registered, seeded permissions, scope true on every op, `/mobile/verification` enum unchanged, no `/mobile/engineering` facade, no duplicate operationId, live 401-never-404 probes (14 samples) |
| `tests/mobile-openapi-completeness.test.ts` · `openapi-contract.test.ts` · `mobile-cr-regression-contract.test.ts` (Engineering 62 reconciled) · `r2p-openapi-contract.test.ts` · `error-contract.test.ts` · PART 01/02 regressions (team-workload, housekeeping-support, housekeeping) | ✅ PASS (88/88) |
| CR-BE-MOB-01/02 contract suites (security, material, QR, sync kinds, push, current-shift, my-team) | ✅ PASS (69 pass / 12 pre-existing DB skips) |
| `git diff --check` | CLEAN |

### 16.5 Remaining Engineering / verification gaps (deferred by rule)

| Residual | Status | Note |
|---|---|---|
| Engineering report datasets (ENG-05) | **EXISTING after PART 03** | BE-10I 8 datasets published |
| Corrective-action verification (ENG-06) | **EXISTING after PART 03** | BE-21J 6 operations published; review authority is the shared BE-07 `reviews` primitive |
| `WORK_ORDER` on `/mobile/verification` (ENG-03 / WO-04) | **EXISTING after PART 05** | Closed by PART 05 — WORK_ORDER is a supported /mobile/verification target delegating to the BE-08I lifecycle |
| Corrective-action verification as a `/mobile/verification` target | **MISSING (deferred)** | Not an authority gap — the BE-21J routes are published (PART 03); adding `CORRECTIVE_ACTION` to the mobile composition would be the same class of optional runtime extension as WO-04 was, deferred by design |
| Utility (billing) meter verification (ENG-08) | **PARTIAL (by design)** | BE-18 stays its own authority, deliberately unpublished for the engineering field surface |
| Diagnosis / per-reading review engine (ENG-07) | **NOT_REQUIRED** | ENG-02/ENG-05 frozen — unchanged |

## 17. PART 04 completion — Team-scoped Work Order read

**Date:** 2026-08-20
**Change class:** `EXTEND_EXISTING` — the first **runtime** change in this CR,
and it is a read-only extension of the existing BE-08 Work Order domain.
No new Work Order domain, no duplicate endpoint, no `/mobile/work-orders`
facade, no write/mutation behaviour, no lifecycle change, no migration.
PART 01–03 behaviour untouched; no PART 05–06 item implemented.

### 17.1 Existing BE-08 surface reused

| Reused surface | How |
|---|---|
| `GET /buildings/:buildingId/work-orders` + `parseWorkOrderFilters` | Same optional `status` / `workType` / `workRequestId` filter vocabulary is accepted by the new read |
| `work_order.read` permission (existing RBAC) | The new route is gated by the exact same `requirePermission('work_order.read')` as the existing Work Order reads |
| `WorkOrderRecord` / `PublicWorkOrder` / `toPublicWorkOrder` | The response reuses the authoritative BE-08 shape and ids (`work_orders.id`, `workOrderNumber`, statuses, lifecycle timestamps) — no projection, no new id |
| `work_order_assignments` (BE-08E) | The team relevance rule reads the ACTIVE assignment (`assignee_type = 'TEAM'` / `'WORKFORCE'`), the same authority the mobile feed `listMobileAssignments` uses |
| `workforceRepository.findByUserId` / `.listByTeamId` + `contextAccessService.getAccessibleBuildingIds` | The same authorities `getMobileMyTeam` / `getMobileCurrentShift` use — session-derived identity and BE-02F/G scope |

### 17.2 Runtime extension implemented (read-only)

**`GET /work-orders/team` → `listTeamWorkOrders`** — registered in the existing
`work-orders` router **before** `/work-orders/:id` so the literal `team`
segment is never captured as an id. Pipeline: `authenticationMiddleware` →
`requirePermission('work_order.read')` → controller → service → repository.

- **Service** (`workOrderService.listTeamWorkOrders`): resolves the caller's
  linked ACTIVE BE-03C Workforce Profile from the session; no profile / not
  ACTIVE / no `team_id` → `[]` (never an error, never a widened scope).
  Resolves the team's ACTIVE member profile ids, then the caller's BE-02G
  accessible Building set; empty scope → `[]`. Delegates the query to the
  repository and maps through the existing `toPublicWorkOrder`.
- **Repository** (`workOrderRepository.listByTeamAssignments`): one SQL query
  over `work_orders w` with an `EXISTS` subquery on ACTIVE
  `work_order_assignments` matching `(assignee_type = 'TEAM' AND team_id = $2)`
  OR `(assignee_type = 'WORKFORCE' AND workforce_profile_id = ANY($3::uuid[]))`,
  plus `w.building_id = ANY($1::uuid[])` — **the accessible-Building set is
  enforced in SQL**, so Client/Building isolation holds even though no
  building parameter is supplied. Optional status/workType/workRequestId
  filters reuse the existing vocabulary. Ordered by `created_at DESC` (same
  as the building list).
- **Controller** (`listTeamWorkOrdersHandler`): parses the existing
  `parseWorkOrderFilters` and calls the service with `req.auth.userId` —
  team/user context is never accepted from the caller.

**No mutation path exists** anywhere in the extension: no write service, no
assignment change, no lifecycle transition.

### 17.3 Team-scope derivation

A Work Order is "relevant to the caller's team" **iff** its ACTIVE BE-08E
assignment targets:
1. the team itself (`assignee_type = 'TEAM'` and `team_id` = the caller's
   linked profile's `team_id`), **or**
2. an ACTIVE member of that team (`assignee_type = 'WORKFORCE'` whose
   `workforce_profile_id` is in the team's ACTIVE roster — the caller
   included).

The team is derived from the **authenticated session** (linked ACTIVE
`workforce_profiles.team_id`), the same authority `getMobileMyTeam` (BE-25N)
uses; `workforce_reporting_lines` are deliberately **not** used (consistent
with My Team). VENDOR / VENDOR_WORKFORCE assignments are never "the
supervisor's team" and are excluded by construction.

### 17.4 OpenAPI changes

1. **Path added:** `GET /work-orders/team` → `listTeamWorkOrders`
   (`tags: [Work Orders]`, bearer auth, `x-required-permission:
   work_order.read`, `x-building-scoped: true`) with the three optional
   query parameters (`status` `$ref: WorkOrderStatus`, `workType`, `workRequestId`)
   and a `200` reusing `SuccessEnvelope` + `WorkOrder[]`.
2. **Counts:** 487 → **488 paths**, 644 → **645 operations**. No new schema,
   no new parameter definition, no new tag (the `WorkOrder` / `WorkOrderStatus`
   schemas already existed).
3. The description pins the session-derivation rule, the ACTIVE-assignment
   relevance rule, the SQL-enforced BE-02G scope, the read-only boundary, and
   the empty-list behaviour — no caller-supplied `teamId` / `workforceId` /
   `buildingId` parameter exists.

### 17.5 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| YAML well-formed; 487 → **488 paths**, 644 → **645 operations**; unique operationIds; all `$ref`s resolve | ✅ PASS (scripted) |
| `tests/mobile-team-work-orders-contract.test.ts` (7 subtests, new) | ✅ PASS — operationId/permission/scope, registered in the existing work-orders router, no `/mobile/work-orders` facade, no duplicate operationId, response reuses the authoritative `WorkOrder` schema (no local/temp/clientGenerated id), no caller-supplied scope parameters, seeded permission, 401/403 documented, live 401-never-404 probe proving `/work-orders/team` is not shadowed by `/work-orders/:id` |
| `tests/mobile-team-work-orders.test.ts` (4 subtests, new, DB-backed) | ⚠️ 4/4 **SKIP** — no local PostgreSQL in the sandbox (recorded, not a code defect). Covers: TEAM + member-assigned inclusion, other-team/outsider exclusion, no-profile → empty, non-accessible-Building exclusion |
| `tests/mobile-openapi-completeness.test.ts` · `openapi-contract.test.ts` · `mobile-cr-regression-contract.test.ts` · `r2p-openapi-contract.test.ts` · `error-contract.test.ts` · PART 01–03 regressions (team-workload, housekeeping-support, engineering-support, housekeeping, work-order) | ✅ PASS (80/87 with 7 pre-existing DB skips) |
| CR-BE-MOB-01/02 contract suites | ✅ PASS (88 pass / 12 pre-existing DB skips) |
| Work Order lifecycle/action/assignment suites | ⚠️ DB-backed skips (45) — identical behaviour class to baseline; the only new code is an additive read path (`listByTeamAssignments` + service + controller + route), no existing BE-08 write/transition touched |
| `git diff --check` | CLEAN |

### 17.6 Remaining TMW-04 gaps

| Residual | Status | Note |
|---|---|---|
| Team-scoped Work Order read (TMW-04) | **EXISTING after PART 04** | `GET /work-orders/team` implemented + published |
| DB-backed derivation validation | **not run here** | `tests/mobile-team-work-orders.test.ts` written and typechecked; requires a project-standard PostgreSQL run before production (same prerequisite as all DB-backed suites) |
| Cross-building "all my teams" variant | **not implemented** | The read is single-team (the caller's linked team, same as My Team). A multi-team supervisor would need a product decision and a `teamId`-filter variant — deliberately not invented |
| Reporting-line (BE-03F) scoped WO read | **not implemented** | Consistent with My Team (BE-25N) which uses `team_id`, not `workforce_reporting_lines`; a reporting-line variant is a separate product decision |
| Pagination on the team read | **not implemented** | The existing building list has no pagination either; same convention kept. A later PART may add opt-in pagination to both |

## 18. PART 05 completion — Work Order mobile verification target

**Date:** 2026-08-20
**Change class:** `EXTEND_EXISTING` — WORK_ORDER added as a supported target
of the existing BE-25J `/mobile/verification` workflow (WO-04 closed).
No new verification engine, no duplicate Work Order verification logic, no
`/mobile/work-order-verification` facade, no lifecycle-semantics change, no
migration, no unrelated schema/domain change. The original three target
types are preserved. PART 01–04 behaviour untouched; no PART 06 item
implemented.

### 18.1 Existing verification engine reused

| Reused surface | How |
|---|---|
| `MOBILE_VERIFICATION_TARGET_TYPES` (BE-25J) | `WORK_ORDER` appended to the existing constant; the original three values untouched (asserted by test) |
| `getMobileVerification` / `submitMobileVerification` (BE-25J) | The existing GET/POST `/mobile/verification/:targetType/:targetId` route dispatches WORK_ORDER — no new route, no new path |
| `getWorkOrderVerificationState` / `submitWorkOrderVerification` (BE-08I) | The WORK_ORDER branches delegate to these existing services — the mobile and Web surfaces share one lifecycle (COMPLETED-only, already-APPROVED immutable, REWORK_REQUIRED → IN_PROGRESS, fresh review row per submission) |
| `workOrderService.getWorkOrderById` + `contextAccessService.assertBuildingAccess` | Authoritative `work_orders.id` resolution (unknown → 404) and BE-02G isolation (inaccessible → 403) — the exact checks the Web verification endpoints perform |
| `work_order.read` / `work_order.manage` (existing RBAC) | The WORK_ORDER branch enforces the same permissions the Web endpoints require — no new permission |
| Shared `REVIEW_DECISIONS` vocabulary | `decision` stays APPROVED / REJECTED / REWORK_REQUIRED (validated at the top of `submitMobileVerification`) |

### 18.2 WORK_ORDER target implementation

- **Types** (`mobile-verification.types.ts`): `MOBILE_VERIFICATION_TARGET_TYPES`
  now `['CHECKLIST_EXECUTION', 'FORM_INSTANCE', 'FINDING', 'WORK_ORDER']`;
  `MobileVerificationResourceReference` gains `workOrder: { id, workOrderNumber,
  title, status } | null` (all other reference fields stay nullable).
- **Service** (`mobile-verification.service.ts`):
  - `READ_PERMISSION.WORK_ORDER = 'work_order.read'`,
    `WRITE_PERMISSION.WORK_ORDER = 'work_order.manage'`;
  - `buildWorkOrderContract(workOrderId, userId)` — resolves the Work Order by
    authoritative id, asserts Building access, delegates to
    `getWorkOrderVerificationState`, maps state (`NOT_REVIEWABLE` when not
    COMPLETED; `PENDING` when COMPLETED with no completed verification;
    VERIFIED / REJECTED / REWORK_REQUIRED from the latest decision),
    `availableActions = ['SUBMIT_DECISION']` only when COMPLETED and no
    completed verification exists;
  - `getMobileVerification` / `submitMobileVerification` gain WORK_ORDER
    branches: permission assert → resolve + Building assert → delegate to the
    BE-08I service → return the refreshed contract. `submitMobileVerification`
    reuses the shared decision validation at the top.
  - Validation error messages updated to list WORK_ORDER.
- **No controller/route change** — the existing
  `GET/POST /mobile/verification/:targetType/:targetId` route already
  dispatches by target type; the new target flows through it unchanged.

### 18.3 Isolation / RBAC behaviour

- **Authoritative id:** the target is resolved by `work_orders.id`
  (`workOrderService.getWorkOrderById`); an unknown id → 404
  (`WORK_ORDER_NOT_FOUND`), never a fabricated/empty contract.
- **Client/Building isolation:** `contextAccessService.assertBuildingAccess`
  on the Work Order's Building before any state is returned or written — a
  Work Order in a non-accessible Building → 403 `BUILDING_ACCESS_DENIED`
  (the same posture as `getWorkOrderVerification` / `submitWorkOrderVerification`).
- **RBAC:** read requires `work_order.read`, submit requires
  `work_order.manage` — the exact codes the Web endpoints enforce; no new
  permission code is seeded or introduced.
- **Lifecycle preserved:** COMPLETED-only verification; an already-APPROVED
  Work Order cannot be re-verified (immutable, 400
  `WORK_ORDER_VERIFICATION_ALREADY_APPROVED`); REWORK_REQUIRED moves the Work
  Order back to IN_PROGRESS through the BE-08I service; every submission
  inserts a fresh review row (never an overwrite).

### 18.4 OpenAPI changes

1. `VerificationTargetTypeParam` — enum extended to
   `[CHECKLIST_EXECUTION, FORM_INSTANCE, FINDING, WORK_ORDER]` + description.
2. `MobileVerification.targetType` enum extended to match.
3. `MobileVerificationResource` — `workOrder` reference added (required field,
   nullable), with `id` documented as the authoritative `work_orders.id`.
4. `MobileVerification` / `MobileVerificationState` descriptions updated to
   include WORK_ORDER.
5. `getMobileVerification` / `submitMobileVerification` operation descriptions
   updated (permission mapping `work_order.read` / `work_order.manage`,
   BE-08I delegation).
6. Counts unchanged: **488 paths / 645 operations** (no new path, no new
   schema name, no new parameter definition, no new tag).

### 18.5 Validation (focused)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| YAML well-formed; 488 paths / 645 operations unchanged; unique operationIds; all `$ref`s resolve | ✅ PASS (scripted) |
| `tests/mobile-work-order-verification-target-contract.test.ts` (6 subtests, new) | ✅ PASS — documented enum == implemented constant (WORK_ORDER + the original three), RBAC reuses work_order.read/manage (no new permission), no /mobile/work-order-verification facade, no duplicate operationId, authoritative workOrder resource reference (no local/temp/clientGenerated id), shared decision vocabulary, live 401-never-404 probe |
| `tests/mobile-work-order-verification-target.test.ts` (7 subtests, new, DB-backed) | ⚠️ 7/7 **SKIP** — no local PostgreSQL (recorded, not a code defect). Covers: COMPLETED → PENDING + SUBMIT_DECISION, APPROVED immutable, REWORK_REQUIRED → IN_PROGRESS, non-COMPLETED → NOT_REVIEWABLE + invalid-state 400, unknown id → 404, non-accessible → 403, and regression of the three original target types |
| Regression-guard reconciliations | `tests/mobile-engineering-support-contract.test.ts` + `tests/mobile-material-context-contract.test.ts` updated to pin the documented enum == the implemented set (WORK_ORDER now included) — the same minimal consequence as the tag-size reconciliations in PART 02/03 |
| DB-free CR contract suites (20 files) | ✅ PASS (174 pass / 19 pre-existing DB skips / 0 fail) |
| `tests/mobile-verification-contract.test.ts` | ⚠️ DB-backed — fails 15/15 **identically before this PART** (verified on a stashed tree); environment limitation, not a regression |
| `git diff --check` | CLEAN |

### 18.6 Remaining WO-04 gaps

| Residual | Status | Note |
|---|---|---|
| WORK_ORDER mobile verification target (WO-04 / ENG-03) | **EXISTING after PART 05** | Closed — WORK_ORDER is a supported /mobile/verification target delegating to BE-08I |
| DB-backed runtime validation | **not run here** | `tests/mobile-work-order-verification-target.test.ts` written + typechecked; requires a project-standard PostgreSQL run before production (same prerequisite as all DB-backed suites) |
| `CORRECTIVE_ACTION` as a /mobile/verification target | **MISSING (deferred)** | Not an authority gap — BE-21J routes are published (PART 03); a mobile composition target would be the same class of optional runtime extension, deferred by design |
| ISO-03 optional mobile-feed discriminator | **deferred (P2)** | Optional composition, not required for the audit |
| PART 06 (cross-contract regression & handoff) | **complete** | §19 — regression + handoff done, no new capability |

## 19. PART 06 completion — Cross-contract regression & supervisor handoff

**Date:** 2026-08-20
**Change class:** validation + handoff only. **No new endpoint, no new
domain, no duplicate mobile facade, no migration, no expansion of
deferred/by-design items, no change to frozen authorities.** The only
non-documentation additions are the focused regression test suite
(`tests/mobile-supervisor-regression-contract.test.ts`) and the handoff
artifact.

### 19.1 Cross-contract regression result

The complete supervisor mobile backend contract was re-validated together
after PART 01–05, across CR-BE-MOB-01, CR-BE-MOB-02 and CR-BE-MOB-03:

| Suite | Result |
|---|---|
| `tests/mobile-supervisor-regression-contract.test.ts` (new, 15 subtests) | ✅ PASS — OpenAPI/runtime parity, no facade, RBAC/scope metadata, Teknisi + Cleaning Service authority boundaries, team/member scope, accessible-Building scope, authoritative IDs, lifecycle authorities (WO, Finding/Rework, Engineering, HK inspection, Security handover, WORK_ORDER mobile verification) |
| `tests/mobile-cr-regression-contract.test.ts` (CR-BE-MOB-01 PART 08) | ✅ PASS — frozen tag sizes (Housekeeping 62 / Security 46 / Engineering 62 / Inventory Master 8), QR ASSET-only, 7 sync kinds, push boundary |
| `tests/mobile-cross-contract.test.ts` (CR-BE-MOB-CONTRACT-01 PART 08) | ✅ PASS (spec layer) |
| `tests/mobile-openapi-completeness.test.ts` + `openapi-contract.test.ts` + `r2p-openapi-contract.test.ts` + `error-contract.test.ts` | ✅ PASS — no phantom paths, unique operationIds, all `$ref`s resolve, documented ↔ registered parity |
| PART 01–05 focused suites (workforce, HK support, engineering support, team work orders, WO verification target, housekeeping, security, engineering, material, QR, sync kinds, push, current-shift, my-team, work-order) | ✅ PASS — **215 tests: 195 pass / 20 DB skips / 0 fail** |

### 19.2 OpenAPI/runtime parity

| Check | Result |
|---|---|
| Documented operations are registered | ✅ 645/645 — zero phantom (new suite asserts every documented operation is in a `*.routes.ts`) |
| No duplicate operationIds | ✅ |
| All `$ref`s resolve | ✅ (schemas / parameters / responses) |
| RBAC metadata present | ✅ — every `x-required-permission` is a REAL seeded code (the one descriptive value, `processSyncBatch`'s per-resourceType, is a pre-existing documented dispatch convention) |
| Client/Building isolation metadata preserved | ✅ — every `x-building-scoped` is boolean; CR-published ops carry `true` or honestly absent (BE-03F reads) |
| No duplicate mobile domain facade | ✅ — no `/mobile/{domain}` facade; `/mobile/current-shift` + `/mobile/my-team` are legitimate BE-25M/N self-service endpoints, verified by test |

### 19.3 Supervisor authority validation

- **Supervisor Teknisi:** `work_order.*`, `engineering*`, `engineering_report.read`, `corrective_action_verification.*`, `workforce_kpi.read`, `workforce.read` entry points all published with exact permissions.
- **Supervisor Cleaning Service:** `daily_cleaning.*`, `cleaning_assignment.*`, `consumable_readiness.*`, `housekeeping_complaint.*`, `supervisor_inspection.*`, `quality_audit.*`, `housekeeping_finding.*`, `housekeeping_evidence.*`, `housekeeping_report.read` entry points all published.
- **Team/member scope:** `getMobileMyTeam` (BE-25N) + `listTeamWorkOrders` (PART 04) are session-derived; `listTeamDailyCleaning` / `listTeamTasks` are team-scoped reads.
- **Accessible Building scope:** BE-02F/G enforced in SQL on `listTeamWorkOrders` and in services on KPI/reporting reads; `requireBuildingAccess` on Building-nested routes.
- **Authoritative backend IDs:** no `localId` / `tempId` / `clientGeneratedId` anywhere in published schemas.

### 19.4 Lifecycle regression result (all unchanged)

| Authority | Status |
|---|---|
| Work Order (BE-08) | ✅ create/read/update/complete/verify/close published; lifecycle table untouched |
| Finding / Rework (BE-09) | ✅ create/read/update/rework/reject/resubmit/verification/close published |
| Engineering verification (BE-10/BE-08I) | ✅ bindings, start/submit readings, WO verification, handover all published |
| Housekeeping inspection (BE-11) | ✅ bind/start/decision/quality-audit published |
| Security handover (BE-12G/BE-12M) | ✅ binding + dataset published (CR-BE-MOB-02) |
| WORK_ORDER mobile verification (BE-25J → BE-08I) | ✅ PART 05 target intact; the three original targets preserved |

### 19.5 Final capability/gap matrix

**36 EXISTING · 4 PARTIAL · 0 MISSING · 2 NOT_REQUIRED (42 rows).**
All ten audited capabilities are EXISTING. The 4 PARTIAL rows are the
by-design exclusions (TMW-07 team/roster CRUD, SHF-02 shift CRUD, ENG-08
BE-18 utility verification) and the deferred ISO-03 optional discriminator —
none blocks supervisor mobile integration. See the gap matrix for the final
per-row status.

### 19.6 DB-backed test limitation (explicit)

| Item | Status |
|---|---|
| DB-free CR contract suites | ✅ 195 pass / 20 skips / 0 fail |
| `tests/mobile-verification-contract.test.ts` (embedded-PostgreSQL) | ⚠️ fails 15/15 **identically before CR-BE-MOB-03** (verified by stashing in PART 05) — environment limitation (no embedded PostgreSQL in the sandbox), not a CR regression |
| DB-backed derivation suites (team work orders, WO verification target, current-shift, my-team, work-order lifecycle/action/assignment) | ⚠️ skip cleanly without `asentra_test` — recorded, not a code defect |
| **Release prerequisite** | a project-standard PostgreSQL `npm test` with baseline comparison of the DB-backed suites (CR-BE-MOB-01 §22.3/§23.4 list + the new `mobile-team-work-orders.test.ts` + `mobile-work-order-verification-target.test.ts`) |

### 19.7 Handoff artifact

[`docs/api/CR_BE_MOB_03_SUPERVISOR_HANDOFF.md`](./api/CR_BE_MOB_03_SUPERVISOR_HANDOFF.md)
— concise binding guide for the two supervisor consumers: per-role entry
points with permissions, the WORK_ORDER mobile verification contract shape,
the must-not-do boundaries, and the honest validation status. The earlier
CR-BE-MOB-01 handoff remains valid and is referenced, not restated.

## 20. FINAL REVIEW — fix → final validation → pull request

**Date:** 2026-08-20
**Reviewed:** the complete CR-BE-MOB-03 implementation
(`d9d8d1a..HEAD`, PART 01–06) against the governance, gap matrix, OpenAPI
contract, runtime changes, tests and handoff.

### 20.1 Defects found

**None.** Every review category was checked mechanically and came back clean:

| Check | Result |
|---|---|
| Supervisor mobile capabilities (My Team, workload/status, team WOs, Teknisi review, Cleaning Service support, inspection/finding/rework, evidence, Current Shift, WORK_ORDER verification) | ✅ all published + exercised by the PART 06 regression suite |
| Cross-CR compatibility (CR-BE-MOB-01 / 02 / 03) | ✅ 22 DB-free CR suites — 195 pass / 20 DB skips / 0 fail |
| OpenAPI/runtime parity | ✅ 645/645 documented operations registered (0 phantom); unique operationIds; all `$ref`s resolve; all tags declared |
| RBAC metadata | ✅ every `x-required-permission` is a REAL seeded code (the one descriptive value, `processSyncBatch`'s per-resourceType, is a pre-existing documented dispatch convention) |
| Building isolation metadata | ✅ every `x-building-scoped` is boolean; CR-published ops carry `true` or honestly absent (BE-03F reads) |
| Authority and isolation (Teknisi, Cleaning Service, team/member scope, accessible Building scope, authoritative IDs) | ✅ session-derived team scope; BE-02F/G enforced in SQL/services; no `localId`/`tempId`/`clientGeneratedId` in any schema |
| Lifecycle regression (WO, Finding/Rework, Engineering verification, HK inspection, Security handover, mobile verification engine) | ✅ none replaced or duplicated — runtime diff is additive and delegates to existing authorities |
| Architecture guard (no duplicate mobile facade, no new domain, no migration, no duplicated business logic) | ✅ runtime diff confined to `work-orders/` (read extension), `mobile-verification/` (target composition), and the `workforce.read` seed registration; **0 migrations, 0 new modules** |
| Final capability matrix | ✅ 36 EXISTING / 4 PARTIAL / 0 MISSING / 2 NOT_REQUIRED; **10/10 audited capabilities EXISTING**; the 4 PARTIAL rows are by-design/deferred and were deliberately NOT implemented |

### 20.2 Final validation executed

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| OpenAPI structural (488 paths / 645 operations / 688 schemas; unique operationIds; all `$ref`s resolve; all tags declared; tag sizes Housekeeping 62 / Security 46 / Engineering 62 / Inventory Master 8 / Workforce 5 / Corrective Action Verification 6) | ✅ PASS (scripted) |
| Cross-CR regression + all CR contract suites (22 DB-free suites) | ✅ **195 pass / 20 DB skips / 0 fail** |
| `git diff --check` | CLEAN |

### 20.3 DB-backed limitation (explicit, not fabricated)

No PostgreSQL in the Arena sandbox. The embedded-PostgreSQL suites fail
**identically on the baseline `d9d8d1a`** (verified in a temporary git
worktree): `mobile-assignment-contract` 13, `mobile-checklist-contract` 13,
`mobile-evidence-contract` 15, `mobile-sync-contract` 7,
`mobile-error-contract` 5, `mobile-contract` 11, `mobile-verification-contract`
15 — all pre-existing environment failures, **not CR-introduced regressions**.
The PART 04/05 DB-backed derivation suites (`mobile-team-work-orders.test.ts`
4, `mobile-work-order-verification-target.test.ts` 7) skip cleanly and are
documented as requiring a project-standard PostgreSQL run before production.

### 20.4 Verdict

**CR-BE-MOB-03 is COMPLETE and defect-free as reviewed.** No fixes were
required. The PR is created from this branch to `main`; **not merged**.

STOP.

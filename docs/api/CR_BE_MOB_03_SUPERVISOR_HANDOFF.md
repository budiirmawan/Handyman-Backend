# CR-BE-MOB-03 — Supervisor Mobile Backend Handoff

> **Status:** PART 01–05 complete, PART 06 cross-contract regression passed.
> **Authoritative machine-readable contract:** `docs/api/openapi.yaml`.
> When this document and the spec disagree, **the backend router and
> `openapi.yaml` win.**
> **Companions:** [`CR-BE-MOB-03-GOVERNANCE.md`](../CR-BE-MOB-03-GOVERNANCE.md)
> (narrative + per-PART record) · [`CR-BE-MOB-03-GAP-MATRIX.md`](../CR-BE-MOB-03-GAP-MATRIX.md)
> (42-row classification) · [`CR_BE_MOB_01_MOBILE_HANDOFF.md`](./CR_BE_MOB_01_MOBILE_HANDOFF.md)
> (the earlier CR-BE-MOB-01 field-operations handoff — auth, task, work
> order, checklist, evidence, finding, sync, QR, push boundaries; still valid
> and not restated here).
> **Date:** 2026-08-20

This CR made the backend ready for the two **supervisor** mobile consumers:
**Supervisor Teknisi** (engineering / technician supervisor) and
**Supervisor Cleaning Service** (housekeeping supervisor). It published
existing supervisor-supporting surfaces (PART 01–03), added two small
runtime read/verification extensions (PART 04 team-scoped Work Orders,
PART 05 `WORK_ORDER` mobile verification target), and validated everything
together (PART 06).

OpenAPI is now **488 paths / 645 operations / 688 schemas**.

---

## 1. What CR-BE-MOB-03 delivered

| PART | Delivered | Size |
|---|---|---|
| 01 | Team workload & status contract (tag `Workforce` — KPI, reporting, direct reports) | 5 operations |
| 02 | Housekeeping supervisor support (tag `Housekeeping` — consumables, complaints, report datasets) | 28 operations |
| 03 | Engineering + corrective-action verification contract (tag `Engineering` + new tag `Corrective Action Verification`) | 14 operations |
| 04 | Team-scoped Work Order read (`GET /work-orders/team`) | 1 operation (runtime) |
| 05 | `WORK_ORDER` mobile verification target (BE-25J) | 0 new paths (runtime) |
| 06 | Cross-contract regression + this handoff | 0 new |

---

## 2. Ready for supervisor mobile integration (bind now)

All of the following are implemented, published, RBAC-gated and (where the
annotation convention applies) Building-scoped. Bind by `operationId`.

### 2.1 Supervisor Teknisi (engineering / technician supervisor)

| Area | Entry points | Notes for the client |
|---|---|---|
| **Team context** | `getMobileMyTeam` | Auth-only self-service: caller's team + ACTIVE members (BE-25N). No `teamId` parameter — derived from session |
| **Team Work Orders** | `listTeamWorkOrders` (`GET /work-orders/team`) | PART 04: Work Orders whose ACTIVE BE-08E assignment targets the caller's team or an ACTIVE team member. Session-derived team; BE-02G accessible Buildings enforced in SQL. Optional `status` / `workType` / `workRequestId` filters. Read-only |
| **Team workload KPI** | `getWorkforceKpi` | Headcount / assignments / man-hours per accessible scope; optional `teamId`, `workforceId`, `buildingId`, `workforceType`, date window, `graceMinutes` |
| **Direct reports** | `listWorkforceDirectReports`, `getWorkforceCurrentSupervisor` | BE-03F reporting lines (`workforce.read`). Note: documented **without** `x-building-scoped` — the read path carries no BE-02G gate today |
| **Technician / WO review** | `listMobileAssignments`, `getWorkOrder`, `listWorkOrderActions`, `getWorkOrderCompletion`, `getWorkOrderHistory` | Core CR-BE-MOB-CONTRACT-01 surface — unchanged |
| **WO verification (Web surface)** | `getWorkOrderVerification`, `submitWorkOrderVerification` | BE-08I: COMPLETED-only, APPROVED immutable, REWORK_REQUIRED → IN_PROGRESS |
| **WO verification (mobile)** | `getMobileVerification` / `submitMobileVerification` with `targetType=WORK_ORDER` | PART 05: same BE-08I lifecycle through the mobile route. `decision` ∈ APPROVED / REJECTED / REWORK_REQUIRED |
| **Engineering records** | `getEngineeringDailyOperations` (`date` required), `getEngineeringOverview`, engineering shift handovers `create/list/get/update/ready/acknowledge` | Published in CR-BE-MOB-01 PART 03 |
| **Engineering report datasets** | `getEngineeringReportTechnicalSummary`, `…Inspections`, `…MeterReadings`, `…EquipmentLogs`, `…Checklists`, `…Breakdowns`, `…Maintenance`, `…Findings` | BE-10I: `buildingId` required + access-asserted |
| **Corrective-action verification** | `getCorrectiveActionVerificationContext`, `openCorrectiveActionVerification`, `submitCorrectiveActionVerification`, `getLatestCorrectiveActionVerification`, `listCorrectiveActionVerificationHistory`, `listCorrectiveActionVerifications` | BE-21J over the shared BE-07 `reviews` row (target_type CORRECTIVE_ACTION). Read/manage split |
| **Current Shift** | `getMobileCurrentShift` | Auth-only self-service; timezone + overnight aware (BE-25M) |

### 2.2 Supervisor Cleaning Service (housekeeping supervisor)

| Area | Entry points | Notes for the client |
|---|---|---|
| **Team context** | `getMobileMyTeam` | Same BE-25N self-service |
| **Team cleaning workload** | `listTeamDailyCleaning`, `listWorkforceDailyCleaning`, `listBuildingDailyCleaning`, `getDailyCleaning`, `listDailyCleaningAssignments`, `assignDailyCleaning` | Daily cleaning `id` **is** the BE-07 `taskId`; execute with `startTask` / `completeTask` / `cancelTask` |
| **Consumable readiness** | `listConsumableRequirements`, `getConsumableRequirement`, `listConsumableReadiness`, `recordConsumableReadiness`, `listConsumableRequirementBindings`, `listHousekeepingConsumableBindings`, `listBuildingHousekeepingConsumableBindings`, `listCleaningArea…` / `listClient…` / `listWarehouse…` / `listItemHousekeepingConsumableBindings`, `createConsumableRequirementBinding`, `updateHousekeepingConsumableBinding` | BE-11J + BE-16J; readiness (READY / LOW / NOT_READY / UNKNOWN) derived from authoritative BE-16 stock. Pass `buildingId` for scoped lists |
| **Complaints** | `listHousekeepingComplaintBindings`, `createHousekeepingComplaintBinding`, `getHousekeepingComplaintBinding`, `updateHousekeepingComplaintBinding` | BE-11L bindings over BE-08/BE-09/BE-07 authorities |
| **Inspection** | toilet / public-area `…Binding*`, `start…Execution`, `get…Execution`; complete via the shared BE-07 checklist ops | Bind + start; complete/pass stays on checklist |
| **Supervisor decision** | `create/list/getSupervisorInspection`, `submitSupervisorInspectionDecision` | APPROVED / REJECTED / REWORK_REQUIRED |
| **Quality audit** | `create/list/get/updateQualityAudit`, `completeQualityAudit` | PASS / FAIL / REWORK_REQUIRED |
| **Findings** | `create/list/getHousekeepingFinding` (+ published BE-09 ops keyed by `findingId`) | HK link `id` ≠ `findingId`; workflow keys on `findingId` |
| **Evidence** | `listHousekeepingEvidenceRequirements`, `listHousekeepingEvidence`, `submitHousekeepingEvidence` (+ `uploadMobileEvidence` / file API) | BE-11I over BE-07 evidence metadata |
| **Report datasets** | `getHousekeepingReportSummary`, `…Cleaning`, `…Inspections`, `…SupervisorInspections`, `…Findings`, `…Consumables`, `…QualityAudits`, `…Complaints` | BE-11M: `buildingId` required + access-asserted |
| **Current Shift** | `getMobileCurrentShift` | Same BE-25M self-service |

### 2.3 Shared supervisor surfaces

| Area | Entry points | Notes |
|---|---|---|
| **Finding / rework lifecycle** | `createFinding`, `getFinding`, `updateFinding`, `requestFindingRework`, `updateFindingReworkNotes`, `rejectFinding`, `resubmitFinding`, `submitFindingVerification`, `openFindingReview`, `getFindingAvailableActions`, `closeFinding` | BE-09 — keyed by `findingId` |
| **Evidence access** | `submitEvidence`, `listEvidence`, `getEvidence`, `listEvidenceRequirements`, `uploadEvidenceFile`, `downloadEvidenceFile`, `uploadMobileEvidence`, `getMobileEvidence` | Shared engine; attach to execution / finding ids |
| **Building-scope rule** | — | Pass `buildingId` for scoped lists; inaccessible → 403 `BUILDING_ACCESS_DENIED`; unknown ids → 404. Lists are constrained to the caller's accessible Buildings |
| **RBAC rule** | — | Every CR-published operation records `x-required-permission` (a real seeded code) and `x-building-scoped` (true or honestly absent). Bearer session required |

---

## 3. Supervisor authority boundaries (validated in PART 06)

| Boundary | How it is enforced |
|---|---|
| **Supervisor Teknisi** | `work_order.read/manage`, `engineering.read`, `engineering_overview.read`, `engineering_report.read`, `engineering_finding.*`, `shift_handover.*`, `inspection_binding.*`, `meter_reading_binding.*`, `log_sheet_binding.*`, `corrective_action_verification.read/manage`, `workforce.read`, `workforce_kpi.read` |
| **Supervisor Cleaning Service** | `daily_cleaning.*`, `cleaning_assignment.*`, `toilet_inspection.*`, `public_area_inspection.*`, `supervisor_inspection.*`, `quality_audit.*`, `housekeeping_finding.*`, `housekeeping_evidence.*`, `consumable_readiness.*`, `housekeeping_complaint.*`, `housekeeping_report.read` |
| **Team / member scope** | `getMobileMyTeam` (BE-25N) + `listTeamWorkOrders` (PART 04) derive the team from the session's linked ACTIVE Workforce Profile — never from a caller-supplied id; `listTeamDailyCleaning` / `listTeamTasks` are team-scoped reads |
| **Accessible Building scope** | BE-02F/G `getAccessibleBuildingIds` / `assertBuildingAccess`; enforced in SQL on `listTeamWorkOrders`, in services on the KPI/reporting reads, and via `requireBuildingAccess` on Building-nested routes |
| **Authoritative backend IDs** | `work_orders.id`, `findings.id`, `checklist_executions.id`, `form_instances.id`, `reviews.id`, `teams.id`, `workforce_profiles.id`, `shifts.id` — no `localId` / `tempId` / `clientGeneratedId` anywhere in the published schemas |

---

## 4. WORK_ORDER mobile verification (PART 05)

`GET/POST /mobile/verification/:targetType/:targetId` now accepts
`targetType=WORK_ORDER` alongside CHECKLIST_EXECUTION / FORM_INSTANCE /
FINDING. It delegates to the existing BE-08I services, so the mobile and Web
surfaces share one lifecycle:

- **COMPLETED-only** — a non-COMPLETED Work Order is `NOT_REVIEWABLE` with no
  actions; submitting a decision returns 400
  `WORK_ORDER_VERIFICATION_INVALID_STATE`.
- **APPROVED is immutable** — a second submission returns 400
  `WORK_ORDER_VERIFICATION_ALREADY_APPROVED`.
- **REWORK_REQUIRED** moves the Work Order back to IN_PROGRESS (the BE-08C
  rework path) and the contract reflects `IN_PROGRESS` / `NOT_REVIEWABLE`.
- **Fresh review row per submission** — completed verifications are never
  overwritten; `reviewId` in the contract is the latest review row.
- **Permissions** — read requires `work_order.read`; submit requires
  `work_order.manage`. Building access is asserted on the Work Order's
  Building (inaccessible → 403).

The contract shape is the same as the other targets:
`{ targetType, targetId, clientId, buildingId, resource.workOrder { id,
workOrderNumber, title, status }, verification { state, decision, notes,
verifiedAt, reviewId, reviewStatus }, reviewer, availableActions, updatedAt }`.
`availableActions` is `['SUBMIT_DECISION']` when the Work Order is COMPLETED
and no completed verification exists, `[]` otherwise.

---

## 5. What the mobile client must NOT do

- **No `/mobile/{domain}` facades** — none exist; the mobile surface is the
  published domain routes + the BE-25 mobile contracts.
- **No `CORRECTIVE_ACTION` verification target** — deferred by design; use
  the published BE-21J routes directly.
- **No QR for locations / Work Orders / checkpoints** — QR stays ASSET-only
  (CR-BE-MOB-01 PART 05 boundary).
- **No offline sync for supervisor decisions / WO actions / material usage /
  incident/finding creates** — keep local; `x-sync-unsupported-resource-types`
  documents the online operations to use instead.
- **No shift/attendance engine, no clock-in/out** — `getMobileCurrentShift`
  is the only "which shift is live" authority.
- **No reinspection or HK stock-usage engine** — after a failed HK
  inspection, start a new checklist execution + use BE-09 rework; usage is
  BE-16 WO material usage.
- **No push delivery** — the IN_APP inbox is the delivery path today
  (CR-BE-MOB-01 PART 07 boundary).

---

## 6. Validation status (honest)

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ PASS |
| OpenAPI structural (488 paths / 645 ops / 688 schemas; unique operationIds; all `$ref`s resolve; all tags declared) | ✅ PASS |
| OpenAPI/runtime parity (every documented operation registered; no phantom) | ✅ PASS |
| CR contract suites (CR-BE-MOB-01/02/03, DB-free) | ✅ 195 pass / 20 DB skips / 0 fail across 22 suites |
| `git diff --check` | CLEAN |
| DB-backed suites (mobile verification contract, team work orders, WO verification target, current-shift, my-team, work-order lifecycle/action/assignment, …) | ⚠️ **NOT RUN** — no local PostgreSQL in the sandbox. `mobile-verification-contract.test.ts` (embedded-PostgreSQL) fails 15/15 identically before CR-BE-MOB-03 (environment limitation, not a regression); the DB-backed derivation tests skip cleanly. A project-standard PostgreSQL run is required before production — see the CR-BE-MOB-03 governance §17.6 / §18.5 residuals |

**Release prerequisite:** a full `npm test` against a project-standard
`asentra_test` PostgreSQL, with baseline comparison of the DB-backed suites
listed in CR-BE-MOB-01 §22.3/§23.4 and the new PART 04/05 DB-backed suites
(`mobile-team-work-orders.test.ts`, `mobile-work-order-verification-target.test.ts`).

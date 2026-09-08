# CR-BE-MOB-03 — Supervisor Mobile Operational Backend Contract — Gap Matrix

> **Status:** START GOVERNANCE complete (audit) → **PART 01 complete**
> (Team Workload & Status Contract Publication — TMW-05, TMW-06 flipped to
> EXISTING) → **PART 02 complete** (Housekeeping Supervisor Supporting
> Contract Publication — HKW-02, HKW-03, HKW-04 flipped to EXISTING) →
> **PART 03 complete** (Engineering & Corrective-Action Verification Contract
> Publication — ENG-05, ENG-06 flipped to EXISTING) → **PART 04 complete**
> (Team-Scoped Work Order Read — TMW-04 flipped to EXISTING) → **PART 05
> complete** (Work Order Mobile Verification Target — ENG-03 / WO-04 flipped
> to EXISTING) → **PART 06 complete** (Cross-Contract Regression & Supervisor
> Handoff — no row changes). **CR-BE-MOB-03 is COMPLETE.**
> Companion to [`CR-BE-MOB-03-GOVERNANCE.md`](./CR-BE-MOB-03-GOVERNANCE.md).
> **Baseline:** Arena branch `arena/01a01f5c-asentra-backend` @ `d9d8d1a`
> (merge of PR #39 / CR-BE-MOB-02 onto `main`).
> **Date:** 2026-08-20
>
> Classification: **EXISTING** | **PARTIAL** | **MISSING** | **NOT_REQUIRED**.
> Actions: `NONE` | `PUBLISH_OPENAPI` | `COMPOSE_EXISTING` | `EXTEND_EXISTING` | `DO_NOT_IMPLEMENT`.
>
> "Unpublished" means the route is registered in `src/modules/*/…routes.ts`
> but has no operationId in `docs/api/openapi.yaml` (path shown is the
> registered Express route, prefix `/api/v1`).
>
> Consumers audited: **Supervisor Teknisi** (engineering / technician
> supervisor) and **Supervisor Cleaning Service** (housekeeping supervisor).

---

## Matrix

| ID | Supervisor Mobile Capability | Existing Backend Domain | Published API / operationId | Status | Actual Gap | Recommended Backend Action | Owning Wave / Domain | Priority |
|---|---|---|---|---|---|---|---|---|
| TMW-01 | My Team — context + ACTIVE members | BE-03C Workforce Profile (`team_id`) + BE-03B Team hierarchy + BE-02F/G Client scope. | `getMobileMyTeam` (`GET /mobile/my-team`, auth-only self-service; `team` + `members`, ids = `teams.id` / `workforce_profiles.id`). | **EXISTING** | None for the context itself. Deliberately no reporting-line data. | `NONE`. | BE-25N + BE-03B/C | — |
| TMW-02 | My Team — task workload | BE-07 task assignments. | `listTeamTasks` (`GET /teams/{teamId}/tasks`), `listWorkforceTasks` (`GET /workforce/{workforceId}/tasks`), `listTaskAssignments`. | **EXISTING** | None — team/workforce ACTIVE task assignment reads are published. | `NONE`. | BE-07 + BE-25C | — |
| TMW-03 | My Team — cleaning workload | BE-11C/D daily cleaning over BE-07 tasks. | `listTeamDailyCleaning`, `listWorkforceDailyCleaning`, `listDailyCleaningAssignments`, `assignDailyCleaning`. | **EXISTING** | None for the cleaning workload read. | `NONE`. | BE-11C/D | — |
| TMW-04 | My Team — **Work Order workload** | BE-08 Work Orders + BE-08E ACTIVE assignments. | Implemented in PART 04: `listTeamWorkOrders` (`GET /work-orders/team`) — session-derived team (`workforce_profiles.team_id`), ACTIVE-assignment relevance (TEAM or team-member WORKFORCE), SQL-enforced BE-02G accessible-Building scope, `work_order.read`, read-only, response reuses the authoritative `WorkOrder` schema. | **EXISTING** | PART 04 implemented the team-scoped Work Order read (runtime `EXTEND_EXISTING` on the BE-08 domain) + published it in OpenAPI. No new domain, no `/mobile/work-orders` facade, no write path. | `NONE`. | BE-08 + BE-08E | — |
| TMW-05 | My Team — workforce KPI / reporting | BE-23G KPI + BE-03I1/I2 reporting read model. | Published in PART 01: `getWorkforceKpi` (`GET /workforce/reports/kpi`, `workforce_kpi.read`), `listWorkforceReporting` / `getWorkforceReporting` (`GET /workforce/reporting[/{id}]`, `workforce.read`) — all `x-building-scoped: true`. | **EXISTING** | PART 01 closed the contract gap (publish only; KPI/reporting services untouched). Headcount / assignments / man-hours / per-team breakdown are now consumable from OpenAPI with BE-02G scope. | `NONE`. | BE-23G + BE-03I2 | — |
| TMW-06 | My Team — supervisor direct reports | BE-03F `workforce_reporting_lines`. | Published in PART 01: `listWorkforceDirectReports` (`GET /workforce/:supervisorId/direct-reports`), `getWorkforceCurrentSupervisor` (`GET /workforce/:workforceId/supervisor`) — `workforce.read`, documented **without** `x-building-scoped` (read path carries no BE-02G gate today; lines are structurally same-Client via the BE-03F write rule). | **EXISTING** | PART 01 closed the contract gap (publish only). `getMobileMyTeam` still does not use reporting lines (unchanged). Residual: the read path has no accessible-scope gate — documented honestly on the operations; optional later runtime hardening (`EXTEND_EXISTING` on BE-03F) is a product decision. | `NONE` (optional later hardening). | BE-03F | — |
| TMW-07 | Team / roster CRUD | BE-03B teams, BE-03C profiles, BE-03E roster. | Unpublished: `/departments/:departmentId/teams`, `/teams/{id}`, `/workforce-profiles*`, `/workforce/{workforceId}/shifts`. | **PARTIAL** (by design) | Generic administration surface deliberately kept off mobile (TC-01/SC-01 rule from CR-BE-MOB-02). No gap for the mobile consumer. | `DO_NOT_IMPLEMENT` for mobile; keep on administration surface. | BE-03B/C/E | — |
| TEC-01 | Technician — task review surface | BE-07 tasks + assignments + execution. | `listTasks`, `getTask`, `startTask`, `completeTask`, `cancelTask`, `assignTask`, `listTaskAssignments`, `updateTaskAssignment`, `listMobileAssignments`, `listWorkforceTasks`, `listTeamTasks`. | **EXISTING** | None. `availableActions` is backend-authoritative on `listMobileAssignments`. | `NONE`. | BE-07 + BE-25C | — |
| TEC-02 | Technician — Work Order review surface | BE-08 Work Order lifecycle. | `listBuildingWorkOrders`, `getWorkOrder`, `createWorkOrder`, `updateWorkOrder`, `updateWorkOrderPriority/Status/Context`, `getWorkOrderContext`, `updateWorkOrderBastRequirement`, `completeWorkOrder`, `getWorkOrderCompletion`, `acknowledge/start/hold/resume/addWorkOrderNote/cancelWorkOrder`, `listWorkOrderActions`, `assignWorkOrder`, `listWorkOrderAssignments`, `getCurrentWorkOrderAssignment`, `updateWorkOrderAssignment`, `getWorkOrderHistory`. | **EXISTING** | None. | `NONE`. | BE-08 + BE-08F/E/J | — |
| ENG-01 | Engineering — Work Order verification / approval | BE-08I over the BE-07 review primitive. | `getWorkOrderVerification`, `submitWorkOrderVerification`, `closeWorkOrderAfterCanonicalBastReadiness` (APPROVED / REJECTED / REWORK_REQUIRED). | **EXISTING** | None. | `NONE`. | BE-08I | — |
| ENG-02 | Engineering — finding verification / approval | BE-09 finding workflow. | `getFindingVerification`, `submitFindingVerification`, `openFindingReview`, `listFindingReviews`, `getCurrentFindingReview`. | **EXISTING** | None. | `NONE`. | BE-09 | — |
| ENG-03 | Engineering — mobile verification composition | BE-25J over BE-07 reviews / BE-09 / BE-08I. | `getMobileVerification` / `submitMobileVerification` (targets CHECKLIST_EXECUTION / FORM_INSTANCE / FINDING / **WORK_ORDER** since PART 05). WORK_ORDER delegates to the BE-08I lifecycle (COMPLETED-only, APPROVED immutable, REWORK_REQUIRED → IN_PROGRESS). | **EXISTING** | PART 05 closed WO-04: WORK_ORDER is a supported /mobile/verification target. No new engine, no duplicate logic, no /mobile/work-order-verification facade; `work_order.read` / `work_order.manage` reused. | `NONE`. | BE-25J + BE-08I | — |
| ENG-04 | Engineering — supervisor records (overview / daily ops / handover / finding) | BE-10A/K/J/H. | `getEngineeringDailyOperations`, `getEngineeringOverview`, `create/list/get/updateEngineeringShiftHandover`, `markEngineeringShiftHandoverReady`, `acknowledgeEngineeringShiftHandover`, `create/list/getEngineeringFinding`. | **EXISTING** | None. | `NONE`. | BE-10A/K/J/H | — |
| ENG-05 | Engineering — report datasets | BE-10I technical report dataset. | Published in PART 03: `getEngineeringReportTechnicalSummary`, `getEngineeringReportInspections`, `getEngineeringReportMeterReadings`, `getEngineeringReportEquipmentLogs`, `getEngineeringReportChecklists`, `getEngineeringReportBreakdowns`, `getEngineeringReportMaintenance`, `getEngineeringReportFindings` — `engineering_report.read`, `x-building-scoped: true` (`buildingId` required + access-asserted). | **EXISTING** | PART 03 closed the contract gap (publish only). The Teknisi supervisor dashboard datasets are now consumable from OpenAPI. | `NONE`. | BE-10I | — |
| ENG-06 | Engineering — corrective-action verification | BE-21J corrective-action verification (a shared BE-07 `reviews` row, target_type CORRECTIVE_ACTION). | Published in PART 03 (new tag `Corrective Action Verification`): `listCorrectiveActionVerifications`, `getCorrectiveActionVerificationContext`, `openCorrectiveActionVerification`, `submitCorrectiveActionVerification`, `getLatestCorrectiveActionVerification`, `listCorrectiveActionVerificationHistory` — `corrective_action_verification.read/manage`, `x-building-scoped: true`. | **EXISTING** | PART 03 closed the contract gap (publish only). No new verification engine; decision vocabulary is the shared review primitive's; finding/rework lifecycle untouched. | `NONE`. | BE-21J + BE-07 reviews | — |
| ENG-07 | Engineering — diagnosis / per-reading review engine | None (by design). | — | **NOT_REQUIRED** | ENG-02/ENG-05 frozen NOT_REQUIRED in CR-BE-MOB-01: a completed reading is a BE-07 form instance reviewed through the published review/verification ops. | `DO_NOT_IMPLEMENT` a diagnosis/per-reading engine. | BE-10/BE-07 | — |
| ENG-08 | Engineering — utility (billing) meter verification | BE-18 (separate billing/tenant authority). | Unpublished: `/utility/abnormal-consumptions/{id}/verification…`, `/utility/aggregations/verification-approval` (ENG-06 in CR-BE-MOB-01). | **PARTIAL** (by design) | BE-18 verification exists and is deliberately unpublished — not part of the Teknisi supervisor field surface; deferred, not invented. | `DO_NOT_IMPLEMENT` for the supervisor mobile field surface; keep BE-18 as its own authority. | BE-18 | — |
| HKW-01 | Housekeeping — team workload (daily cleaning) | BE-11C/D over BE-07 tasks. | `listBuildingDailyCleaning`, `getDailyCleaning`, `listCleaningAreaDailyCleaning`, `assignDailyCleaning`, `listDailyCleaningAssignments`, `listWorkforceDailyCleaning`, `listTeamDailyCleaning`. | **EXISTING** | None for the operational workload (`id` = BE-07 `taskId`). | `NONE`. | BE-11C/D | — |
| HKW-02 | Housekeeping — consumable readiness | BE-11J requirements/readiness + BE-16J item/warehouse bindings (readiness from authoritative stock). | Published in PART 02: `list/create/get/updateConsumableRequirement`, `recordConsumableReadiness`, `listConsumableReadiness` (BE-11J); `listConsumableRequirementBindings`, `createConsumableRequirementBinding`, `list/get/updateHousekeepingConsumableBinding`, `listBuilding/CleaningArea/Client/Warehouse/ItemHousekeepingConsumableBindings` (BE-16J) — `consumable_readiness.read/manage`, all `x-building-scoped: true`. | **EXISTING** | PART 02 closed the contract gap (publish only). READY / LOW / NOT_READY / UNKNOWN is now consumable from OpenAPI, still derived from authoritative BE-16 stock; no stock-usage engine created (HK-06 NOT_REQUIRED). | `NONE`. | BE-11J + BE-16J | — |
| HKW-03 | Housekeeping — complaint bindings | BE-11L complaint binding. | Published in PART 02: `list/create/get/updateHousekeepingComplaintBinding` — `housekeeping_complaint.read/manage`, all `x-building-scoped: true`. | **EXISTING** | PART 02 closed the contract gap (publish only). Workflow stays on the referenced BE-08 / BE-09 / BE-07 authorities. | `NONE`. | BE-11L | — |
| HKW-04 | Housekeeping — report datasets | BE-11M housekeeping report dataset. | Published in PART 02: `getHousekeepingReportSummary`, `getHousekeepingReportCleaning`, `getHousekeepingReportInspections`, `getHousekeepingReportSupervisorInspections`, `getHousekeepingReportFindings`, `getHousekeepingReportConsumables`, `getHousekeepingReportQualityAudits`, `getHousekeepingReportComplaints` — `housekeeping_report.read`, `x-building-scoped: true` (`buildingId` required + access-asserted). | **EXISTING** | PART 02 closed the contract gap (publish only). | `NONE`. | BE-11M | — |
| HKW-05 | Housekeeping — field stock usage / reinspection | None (by design). | — | **NOT_REQUIRED** | HK-04/HK-06 frozen NOT_REQUIRED in CR-BE-MOB-01: usage = BE-16 WO usage/stock-out; reinspection = new checklist start + BE-09 rework. | `DO_NOT_IMPLEMENT`. | BE-16 / BE-07 / BE-09 | — |
| HKI-01 | Housekeeping inspection — toilet | BE-11E binding over BE-07 checklist. | `create/list/get/updateToiletInspectionBinding`, `startToiletInspectionExecution`, `getToiletInspectionExecution`. | **EXISTING** | None; complete/cancel stays on published BE-07 checklist ops. | `NONE`. | BE-11E + BE-07 | — |
| HKI-02 | Housekeeping inspection — public area | BE-11F binding over BE-07 checklist. | `PublicAreaInspection*` equivalents of HKI-01. | **EXISTING** | None. | `NONE`. | BE-11F + BE-07 | — |
| HKI-03 | Housekeeping inspection — supervisor decision | BE-11G over BE-07 reviews. | `create/list/getSupervisorInspection`, `submitSupervisorInspectionDecision` (APPROVED / REJECTED / REWORK_REQUIRED). | **EXISTING** | None. | `NONE`. | BE-11G | — |
| HKI-04 | Housekeeping inspection — quality audit | BE-11K. | `create/list/get/updateQualityAudit`, `completeQualityAudit` (PASS / FAIL / REWORK_REQUIRED). | **EXISTING** | None. | `NONE`. | BE-11K | — |
| FND-01 | Finding — create / read / update | BE-09A. | `createFinding`, `listFindings`, `getFinding`, `updateFinding`. | **EXISTING** | None. | `NONE`. | BE-09 | — |
| FND-02 | Finding — assignment | BE-09. | `assignFinding`, `listFindingAssignments`, `getCurrentFindingAssignment`, `updateFindingAssignment`. | **EXISTING** | None. | `NONE`. | BE-09 | — |
| FND-03 | Finding — state / source / actions / cancel / closure / history | BE-09. | `transitionFindingState`, `getFindingState`, `getFindingSource`, `updateFindingSource`, `getFindingAvailableActions`, `cancelFinding`, `closeFinding`, `getFindingClosure`, `getFindingHistory`. | **EXISTING** | None. | `NONE`. | BE-09 | — |
| FND-04 | Finding — domain bindings (HK / ENG / SEC) | BE-11H / BE-10H / BE-12H over BE-09. | `create/list/getHousekeepingFinding`, `create/list/getEngineeringFinding`, `create/list/getSecurityFinding` — `findingId` is the BE-09 authority. | **EXISTING** | None. | `NONE`. | BE-11H / BE-10H / BE-12H | — |
| RWK-01 | Rework — request / notes / reject / resubmit | BE-09 rework. | `requestFindingRework`, `updateFindingReworkNotes`, `getFindingRework`, `rejectFinding`, `resubmitFinding`. | **EXISTING** | None. | `NONE`. | BE-09 | — |
| RWK-02 | Rework — re-verification | BE-09 verification + BE-08I. | `submitFindingVerification`, `getFindingVerification`, `openFindingReview`, `listFindingReviews`, `getCurrentFindingReview`, `submitWorkOrderVerification`. | **EXISTING** | None. | `NONE`. | BE-09 + BE-08I | — |
| EVD-01 | Evidence — shared engine read (supervisor review) | BE-07 evidence. | `submitEvidence`, `listEvidence`, `getEvidence`, `removeEvidence`, `uploadEvidenceFile`, `downloadEvidenceFile`, `uploadMobileEvidence`, `getMobileEvidence`. | **EXISTING** | None — supervisor can read evidence before deciding. | `NONE`. | BE-07 + BE-25E | — |
| EVD-02 | Evidence — requirements | BE-07 evidence requirements. | `create/list/get/updateEvidenceRequirement`, `listWorkOrderEvidenceRequirements`, `listHousekeepingEvidenceRequirements`. | **EXISTING** | None. | `NONE`. | BE-07 | — |
| EVD-03 | Evidence — Work Order binding | BE-08G. | `listWorkOrderEvidence`, `submitWorkOrderEvidence`, `removeWorkOrderEvidence`. | **EXISTING** | None. | `NONE`. | BE-08G | — |
| EVD-04 | Evidence — Housekeeping binding | BE-11I. | `listHousekeepingEvidence`, `submitHousekeepingEvidence`, `listHousekeepingEvidenceRequirements`. | **EXISTING** | None. | `NONE`. | BE-11I | — |
| SHF-01 | Current Shift — effective context | BE-03E roster + BE-03C profile + BE-02F/G. | `getMobileCurrentShift` (`GET /mobile/current-shift`, auth-only; timezone-aware, overnight-aware; empty `shifts` = not on shift). | **EXISTING** | None. | `NONE`. | BE-25M | — |
| SHF-02 | Current Shift — definition & roster CRUD | BE-03E. | Unpublished: `/buildings/{buildingId}/shifts`, `/shifts/{id}`, `/workforce/{workforceId}/shifts…`. | **PARTIAL** (by design) | SC-01 frozen PARTIAL in CR-BE-MOB-02: generic Shift/roster administration stays off the mobile surface. | `DO_NOT_IMPLEMENT` for mobile. | BE-03E | — |
| SHF-03 | Current Shift — shift context in read models | BE-10A/K. | `getEngineeringDailyOperations` / `getEngineeringOverview` accept `shiftId` context (SC-03). | **EXISTING** | None. | `NONE`. | BE-10A/K | — |
| ISO-01 | Isolation — Client/Building scope on published surface | BE-02F/G. | 185/185 published operations carry `x-building-scoped: true`; `requireBuildingAccess` on nested routes; service-level accessible-id checks; self-service endpoints derive scope from session. | **EXISTING** | None for the published surface. | `NONE`. | BE-02F/G | — |
| ISO-02 | RBAC — supervisor permission codes | BE-01 + `foundation-access.seed.ts`. | 185/185 published operations carry `x-required-permission` (exact seeded codes: `task.*`, `work_order.*`, `finding.*` incl. `review/assign/close`, `checklist.*`, `review.*`, `evidence.*`, `daily_cleaning.*`, `cleaning_assignment.*`, `toilet_inspection.*`, `public_area_inspection.*`, `supervisor_inspection.*`, `quality_audit.*`, `housekeeping_finding.*`, `housekeeping_evidence.*`, `consumable_readiness.*`, `housekeeping_report.read`, `engineering.*`, `engineering_overview.read`, `engineering_finding.*`, `engineering_report.read`, `shift_handover.*`, `workforce.*`, `workforce_kpi.read`, `shift.*`, `team.*`). | **EXISTING** | None for the published surface. | `NONE`. | BE-01 + seeds | — |
| ISO-03 | Mobile feed / verification discriminator | BE-25C / BE-25J enums. | `MOBILE_ASSIGNMENT_TYPES = ['TASK','WORK_ORDER']`; `MOBILE_VERIFICATION_TARGET_TYPES = ['CHECKLIST_EXECUTION','FORM_INSTANCE','FINDING','WORK_ORDER']`. | **PARTIAL** | A housekeeping/patrol task still surfaces as `type=TASK` (optional P2 discriminator). The verification side is fully discriminated (WORK_ORDER added in PART 05). | Optional later `COMPOSE_EXISTING` / `EXTEND_EXISTING` — not required for the audit. | BE-25C / BE-25J | P2 |

---

## Summary counts

| Status | Rows | IDs |
|---|---:|---|
| **EXISTING** | 36 | TMW-01/02/03/**04/05/06**, TEC-01/02, ENG-01/02/03/04/**05/06**, HKW-01/**02/03/04**, HKI-01/02/03/04, FND-01/02/03/04, RWK-01/02, EVD-01/02/03/04, SHF-01/03, ISO-01/02 |
| **PARTIAL** | 4 | TMW-07, ENG-08, SHF-02, ISO-03 — *(TMW-07 + SHF-02 + ENG-08 are PARTIAL **by design**: deliberate exclusions, not gaps; ISO-03 is the deferred optional discriminator)* |
| **MISSING** | 0 | — |
| **NOT_REQUIRED** | 2 | ENG-07, HKW-05 |
| **Total** | **42** | — |

> **PART 01 flipped TMW-05 and TMW-06 (workforce KPI/reporting and direct
> reports) from PARTIAL → EXISTING** (OpenAPI publish only; the only seed
> change is the `workforce.read` catalogue registration that the routes
> already required). **PART 02 flipped HKW-02, HKW-03 and HKW-04
> (housekeeping consumable readiness, complaint bindings and report
> datasets) from PARTIAL → EXISTING** (OpenAPI publish only, 28 existing
> operations; no seed change). **PART 03 flipped ENG-05 and ENG-06
> (engineering report datasets and corrective-action verification) from
> PARTIAL → EXISTING** (OpenAPI publish only, 14 existing operations; no seed
> change — all three permission codes were already seeded). **PART 04
> implemented TMW-04 (team-scoped Work Order read) — runtime
> `EXTEND_EXISTING` on the BE-08 domain + OpenAPI publication — flipping the
> last MISSING row to EXISTING.** **PART 05 closed ENG-03 / WO-04 by adding
> WORK_ORDER as a supported /mobile/verification target (runtime
> `EXTEND_EXISTING` of the BE-25J target enum, delegating to BE-08I) —
> flipping the last deferred runtime-extension row to EXISTING.** The
> PARTIAL-by-design rows (TMW-07 team/roster CRUD, SHF-02 shift CRUD, ENG-08
> BE-18 utility verification) are deliberate exclusions, not gaps; ISO-03
> remains the single deferred optional discriminator. **No publish-first
> row, no MISSING row, and no deferred runtime extension remains (other
> than the by-design rows).**

---

## Capability-level rollup (governance §8)

| # | Capability | Status | Driving rows |
|---|---|---|---|
| 1 | My Team operational workload/status | **EXISTING** | TMW-01/02/03/04/05/06 EXISTING (04 implemented by PART 04; 05/06 flipped by PART 01); TMW-07 PARTIAL by design |
| 2 | Technician task/work-order review | **EXISTING** | TEC-01/02 |
| 3 | Engineering verification/approval | **EXISTING** | ENG-01/02/03/04 EXISTING (03 closed by PART 05 — WORK_ORDER target); ENG-05/06 flipped by PART 03; ENG-08 by design |
| 4 | Housekeeping team workload/status | **EXISTING** | HKW-01/02/03/04 EXISTING (02/03/04 flipped by PART 02); HKW-05 NOT_REQUIRED |
| 5 | Housekeeping inspection | **EXISTING** | HKI-01…04 |
| 6 | Finding creation/read/update | **EXISTING** | FND-01…04 |
| 7 | Rework request and re-verification | **EXISTING** | RWK-01/02 |
| 8 | Evidence access required by supervisor review | **EXISTING** | EVD-01…04 |
| 9 | Current Shift integration | **EXISTING** | SHF-01/03 (+ SHF-02 by design) |
| 10 | Client/Building isolation and RBAC | **EXISTING** | ISO-01/02 (+ ISO-03 optional) |

---

## Recommended small PART breakdown (from governance §9)

| PART | Title | Class | Reuse |
|---|---|---|---|
| 01 | Team workload & status contract publish (KPI, reporting, direct-reports) | `PUBLISH_OPENAPI` | workforce-kpi, workforce-reporting, workforce-reporting-lines |
| 02 | Housekeeping consumable readiness + complaints + report datasets publish | `PUBLISH_OPENAPI` | consumable-readiness, inventory-housekeeping-consumable-bindings, housekeeping-complaints, housekeeping-reports |
| 03 | Engineering report + corrective-action verification contract publish | `PUBLISH_OPENAPI` | engineering-reports, corrective-action-verifications |
| 04 | Optional team-scoped Work Order read | `EXTEND_EXISTING` | work-orders (BE-08) |
| 05 | Optional `WORK_ORDER` target on `/mobile/verification` (WO-04) | `EXTEND_EXISTING` | mobile-verification (BE-25J) |
| 06 | Cross-contract regression & supervisor handoff | — | CR suites |

Publish-first PARTs 01–03 are independent and change no behaviour; PART 04/05
are runtime extensions requiring a product decision; PART 06 is last.

---

## PART 01 delta — Team workload & status contract publish

> **Scope freeze:** START GOVERNANCE rows are frozen except the two rows this
> PART legitimately flips. No PART 02–06 item was implemented.

| ID | Status before | Status after | Change this PART |
|---|---|---|---|
| TMW-05 | **PARTIAL** | **EXISTING** | Published `getWorkforceKpi`, `listWorkforceReporting`, `getWorkforceReporting` (BE-23G + BE-03I2, `workforce_kpi.read` / `workforce.read`, `x-building-scoped: true`). |
| TMW-06 | **PARTIAL** | **EXISTING** | Published `listWorkforceDirectReports`, `getWorkforceCurrentSupervisor` (BE-03F, `workforce.read`) — documented **without** `x-building-scoped` because the read path carries no BE-02G gate (honest, not claimed); optional later hardening noted. |

### PART 01 delta summary

* **OpenAPI:** 5 paths / 5 operations added under new tag `Workforce`
  (447 → 452 paths, 597 → 602 operations); 2 parameters
  (`SupervisorIdPathParam`, `WorkforceReportingIdPath`) and 8 schemas
  (`WorkforceKpi*`, `CurrentSupervisor`, `DirectReport`,
  `WorkforceReportingRecord`) added; 642 → 650 schemas.
* **Seed (catalogue only):** `workforce.read` registered in
  `FOUNDATION_PERMISSIONS` — the routes always enforced it but it was never
  seeded (same defect class as the vendor_invoice codes); required so the
  documented `x-required-permission` is a real seeded code. No RBAC semantics
  changed for any published operation; no new grant beyond the PLATFORM_ADMIN
  bootstrap role that holds every foundation code.
* **Runtime:** no endpoint, service, controller, migration, or domain change.
* **Test:** new `tests/mobile-team-workload-contract.test.ts` (7 subtests,
  documentation-only) pins the exact 5-op surface, documented ⊆ registered,
  scope exactly as enforced, seeded permissions, bearer + 401/403, no mobile
  facade, and live 401-never-404 probes.

---

## PART 02 delta — Housekeeping supervisor supporting contract publish

> **Scope freeze:** START GOVERNANCE and PART 01 rows are frozen except the
> three rows this PART legitimately flips. No PART 03–06 item was implemented.

| ID | Status before | Status after | Change this PART |
|---|---|---|---|
| HKW-02 | **PARTIAL** | **EXISTING** | Published 16 existing BE-11J + BE-16J operations (consumable requirements/readiness + consumable bindings, `consumable_readiness.read/manage`, `x-building-scoped: true`). |
| HKW-03 | **PARTIAL** | **EXISTING** | Published 4 existing BE-11L operations (`housekeeping_complaint.read/manage`, `x-building-scoped: true`). |
| HKW-04 | **PARTIAL** | **EXISTING** | Published 8 existing BE-11M report-dataset operations (`housekeeping_report.read`, `x-building-scoped: true`). |

### PART 02 delta summary

* **OpenAPI:** 21 paths / 28 operations added under the existing
  `Housekeeping` tag (452 → 474 paths, 602 → 630 operations); 5 parameters
  (`ConsumableRequirementIdPath`, `HkConsumableRequirementIdPath`,
  `HkConsumableBindingIdPath`, `HousekeepingComplaintBindingIdPath`,
  `HkBindingCleaningAreaIdPath`) and 24 schemas (BE-11J / BE-16J / BE-11L
  DTOs + 8 BE-11M report shapes) added; 650 → 674 schemas, 113 → 118
  parameters.
* **Regression guard:** `tests/mobile-cr-regression-contract.test.ts`
  `PUBLISHED_TAGS.Housekeeping` reconciled 34 → 62 (only the Housekeeping
  size; the other frozen tag sizes are unchanged).
* **Seed / runtime:** no change — no new permission (all three codes were
  already seeded), no endpoint/service/controller/migration/domain change.
* **Test:** new `tests/mobile-housekeeping-support-contract.test.ts`
  (6 subtests, documentation-only) pins the exact 28-op surface, documented
  ⊆ registered, exact seeded permissions, `x-building-scoped: true` on every
  op, bearer + 401/403, no `/mobile/housekeeping` facade, no duplicate
  operationId, and live 401-never-404 probes (25 samples).

---

## PART 03 delta — Engineering & corrective-action verification contract publish

> **Scope freeze:** START GOVERNANCE and PART 01/02 rows are frozen except the
> two rows this PART legitimately flips. No PART 04–06 item was implemented.

| ID | Status before | Status after | Change this PART |
|---|---|---|---|
| ENG-05 | **PARTIAL** | **EXISTING** | Published 8 existing BE-10I engineering report datasets under `Engineering` (`engineering_report.read`, `x-building-scoped: true`). |
| ENG-06 | **PARTIAL** | **EXISTING** | Published 6 existing BE-21J corrective-action verification operations under the new `Corrective Action Verification` tag (`corrective_action_verification.read/manage`, `x-building-scoped: true`). |

### PART 03 delta summary

* **OpenAPI:** 13 paths / 14 operations added (8 `Engineering` + 6
  `Corrective Action Verification`); 474 → 487 paths, 630 → 644 operations;
  1 parameter (`CorrectiveActionIdPath`) and 14 schemas (BE-10I summary +
  7 report rows, BE-21J verification surface) added; 674 → 688 schemas,
  118 → 119 parameters. New top-level tag `Corrective Action Verification`
  declared.
* **Regression guard:** `tests/mobile-cr-regression-contract.test.ts`
  `PUBLISHED_TAGS.Engineering` reconciled 54 → 62 (only the Engineering size;
  the other frozen tag sizes are unchanged; the new tag is not pinned there).
* **Seed / runtime:** no change — no new permission (all three codes were
  already seeded), no endpoint/service/controller/migration/domain change;
  `/mobile/verification` target types unchanged.
* **Test:** new `tests/mobile-engineering-support-contract.test.ts`
  (6 subtests, documentation-only) pins the exact 14-op surface, documented
  ⊆ registered, exact seeded permissions, `x-building-scoped: true` on every
  op, `/mobile/verification` enum unchanged, no `/mobile/engineering`
  facade, no duplicate operationId, and live 401-never-404 probes
  (14 samples).

---

## PART 04 delta — Team-scoped Work Order read

> **Scope freeze:** START GOVERNANCE and PART 01–03 rows are frozen except the
> one row this PART legitimately flips. No PART 05–06 item was implemented.

| ID | Status before | Status after | Change this PART |
|---|---|---|---|
| TMW-04 | **MISSING** | **EXISTING** | Implemented `GET /work-orders/team` (`listTeamWorkOrders`) — runtime `EXTEND_EXISTING` on the BE-08 work-orders domain (repository `listByTeamAssignments` + service `listTeamWorkOrders` + controller + route) and published in OpenAPI. |

### PART 04 delta summary

* **Runtime (read-only extension):** `src/modules/work-orders/` —
  `work-order.repository.ts` (+`listByTeamAssignments`), `work-order.service.ts`
  (+`listTeamWorkOrders`, +`contextAccessService` import), `work-order.controller.ts`
  (+`listTeamWorkOrdersHandler`), `work-order.routes.ts` (+`GET /work-orders/team`
  registered before `/work-orders/:id`). No write path, no lifecycle change, no
  migration, no new domain, no `/mobile/work-orders` facade.
* **Team-scope derivation:** session → linked ACTIVE `workforce_profiles.team_id`
  (same authority as `getMobileMyTeam`); relevance = ACTIVE BE-08E assignment to
  the TEAM or to an ACTIVE team member; BE-02G accessible Buildings enforced in
  SQL. No caller-supplied `teamId` / `workforceId` / `buildingId` parameter.
* **OpenAPI:** 1 path / 1 operation (`listTeamWorkOrders`, `tags: [Work Orders]`,
  `work_order.read`, `x-building-scoped: true`, optional status/workType/workRequestId
  filters, response reuses `WorkOrder[]`). 487 → 488 paths, 644 → 645 operations.
  No new schema/parameter/tag.
* **Tests:** `tests/mobile-team-work-orders-contract.test.ts` (7 subtests,
  documentation-only, ✅) + `tests/mobile-team-work-orders.test.ts`
  (4 subtests, DB-backed — ⚠️ skip without local PostgreSQL; covers team/member
  inclusion, other-team/outsider exclusion, no-profile → empty, and
  non-accessible-Building exclusion).

---

## PART 05 delta — Work Order mobile verification target

> **Scope freeze:** START GOVERNANCE and PART 01–04 rows are frozen except the
> one row this PART legitimately flips. No PART 06 item was implemented.

| ID | Status before | Status after | Change this PART |
|---|---|---|---|
| ENG-03 / WO-04 | **PARTIAL** | **EXISTING** | Added `WORK_ORDER` to `MOBILE_VERIFICATION_TARGET_TYPES` (BE-25J) — the existing `GET/POST /mobile/verification/:targetType/:targetId` route now dispatches WORK_ORDER, delegating to the BE-08I verification lifecycle (`getWorkOrderVerificationState` / `submitWorkOrderVerification`). |

### PART 05 delta summary

* **Runtime (read + write, EXTEND_EXISTING):**
  `src/modules/mobile-verification/mobile-verification.types.ts`
  (+`WORK_ORDER` target, +`workOrder` resource reference) and
  `mobile-verification.service.ts` (+`buildWorkOrderContract`, WORK_ORDER
  branches in `getMobileVerification` / `submitMobileVerification`,
  `READ_PERMISSION.WORK_ORDER = 'work_order.read'`,
  `WRITE_PERMISSION.WORK_ORDER = 'work_order.manage'`). No new route, no new
  engine, no duplicate verification logic, no `/mobile/work-order-verification`
  facade, no migration, no lifecycle-semantics change.
* **Isolation / RBAC:** Work Order resolved by authoritative `work_orders.id`
  (unknown → 404); `contextAccessService.assertBuildingAccess` on its Building
  (inaccessible → 403); existing `work_order.read` / `work_order.manage`
  permissions reused (no new code).
* **OpenAPI:** `VerificationTargetTypeParam` + `MobileVerification.targetType`
  enums extended to include WORK_ORDER; `MobileVerificationResource` gains the
  `workOrder` reference; GET/POST descriptions updated. 488 paths / 645
  operations unchanged (no new path/schema/parameter/tag).
* **Regression guards reconciled:** `tests/mobile-engineering-support-contract.test.ts`
  and `tests/mobile-material-context-contract.test.ts` now pin the documented
  enum == the implemented `MOBILE_VERIFICATION_TARGET_TYPES` (WORK_ORDER
  included) instead of freezing WO-04 as not-advertised.
* **Tests:** `tests/mobile-work-order-verification-target-contract.test.ts`
  (6 subtests, documentation-only, ✅ — enum parity, RBAC, no facade, no
  duplicate operationId, authoritative workOrder reference, shared decision
  vocabulary, 401-never-404) + `tests/mobile-work-order-verification-target.test.ts`
  (7 subtests, DB-backed — ⚠️ skip without local PostgreSQL; covers COMPLETED →
  PENDING + SUBMIT_DECISION, APPROVED immutable, REWORK_REQUIRED → IN_PROGRESS,
  non-COMPLETED → NOT_REVIEWABLE + invalid-state 400, unknown id → 404,
  non-accessible → 403, and regression of the three original target types).

---

## PART 06 delta — Cross-contract regression & supervisor handoff

> **Scope freeze:** the PART 01–05 rows are final — PART 06 changes **no
> row** (validation + handoff only). No new endpoint, no new domain, no
> duplicate mobile facade, no migration, no expansion of deferred/by-design
> items.

### PART 06 delta summary

* **Regression:** new `tests/mobile-supervisor-regression-contract.test.ts`
  (15 subtests, documentation-only, ✅) re-validates the complete supervisor
  contract across CR-BE-MOB-01/02/03: OpenAPI/runtime parity (645/645
  registered, unique operationIds, all `$ref`s resolve), no duplicate mobile
  domain facade, RBAC metadata (seeded codes) + Building-scope metadata
  (boolean flags), Teknisi + Cleaning Service authority boundaries, team/
  member scope, accessible-Building scope, authoritative IDs, and the six
  lifecycle authorities (Work Order, Finding/Rework, Engineering
  verification, Housekeeping inspection, Security handover, WORK_ORDER
  mobile verification).
* **Cross-CR result:** 22 DB-free suites — **195 pass / 20 DB skips /
  0 fail**; all CR-BE-MOB-01/02/03 frozen guards hold.
* **Handoff:** [`docs/api/CR_BE_MOB_03_SUPERVISOR_HANDOFF.md`](./api/CR_BE_MOB_03_SUPERVISOR_HANDOFF.md)
  — per-role binding guide (Supervisor Teknisi / Supervisor Cleaning
  Service), WORK_ORDER mobile verification contract shape, must-not-do
  boundaries, honest validation status.
* **Matrix status unchanged:** **36 EXISTING · 4 PARTIAL · 0 MISSING ·
  2 NOT_REQUIRED** (42 rows) — final.

STOP.

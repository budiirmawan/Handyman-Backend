# CR-BE-MOB-01 — Mobile Integration Handoff

> **Status:** FINAL REVIEW complete — PART 01–08 done, no defects found.
> **Authoritative machine-readable contract:** `docs/api/openapi.yaml`.
> When this document and the spec disagree, **the backend router and
> `openapi.yaml` win.**
> **Companions:** [`CR-BE-MOB-01-GOVERNANCE.md`](../CR-BE-MOB-01-GOVERNANCE.md)
> (narrative + per-PART record) · [`CR-BE-MOB-01-GAP-MATRIX.md`](../CR-BE-MOB-01-GAP-MATRIX.md)
> (41-row classification) · [`mobile-integration-handoff.md`](./mobile-integration-handoff.md)
> (the earlier CR-BE-MOB-CONTRACT-01 core handoff — auth, task, work order,
> checklist, evidence, finding, sync envelope; still valid and not restated here).
> **Date:** 2026-08-19

This CR published **137 previously-unpublished operations** for the mobile
operational surface and froze three boundaries. It added **no** new domain,
table, migration or mobile-specific API. The single runtime change is the
PART 06 sync resource-kind extension.

---

## 1. What this CR delivered

| PART | Delivered | Size |
|---|---|---|
| 01 | Housekeeping operational contract (tag `Housekeeping`) | 34 operations |
| 02 | Security patrol / checkpoint / field-report contract (tag `Security`) | 41 operations |
| 03 | Engineering field / reading contract (tag `Engineering`) | 54 operations |
| 04 | Work Order material context reference reads (tag `Inventory Master`) | 8 operations |
| 05 | QR operational-context boundary (annotation only) | 0 new |
| 06 | Offline sync resource kinds `PATROL_EXECUTION`, `PATROL_POINT_VISIT`, `METER_READING` | 3 kinds |
| 07 | Push delivery boundary (annotation only) | 0 new |
| 08 | Cross-contract regression + this handoff | 0 new |

OpenAPI is now **442 paths / 590 operations / 631 schemas**.

---

## 2. Ready for mobile integration (bind now)

All of the following are implemented, published, Building-scoped and
permission-gated. Bind by `operationId`.

| Area | Entry points | Notes for the client |
|---|---|---|
| **Housekeeping** | `listBuildingDailyCleaning`, `getDailyCleaning`, `assignDailyCleaning`, toilet/public-area `…Binding*` + `start…Execution`, `submitSupervisorInspectionDecision`, `completeQualityAudit`, `createHousekeepingFinding`, `submitHousekeepingEvidence` | Daily cleaning `id` **is** the BE-07 `taskId`; execute with `startTask` / `completeTask` / `cancelTask` |
| **Security patrol** | `listBuildingPatrolExecutions`, `getPatrolExecution`, `startPatrolExecution`, `completePatrolExecution` | Patrol execution `id` **is** the BE-07 `taskId`. Use the patrol complete, **not** `completeTask` — it applies checkpoint rules |
| **Checkpoints** | `listPatrolRoutePoints`, `recordPatrolPointVisit`, `listPatrolPointVisits`, `updatePatrolPointVisit` | Confirm by canonical `pointId`. **Not** a QR scan (see §4) |
| **Security field reporting** | `createSecurityFinding`, `createOperationalIncident`, `createIncident`, `getSecurityDailyActivity` | Patrol/checklist issue → security finding; standalone event → operational incident. No third path |
| **Engineering readings** | inspection / log-sheet / engineering-checklist `…Binding*` + `start…Execution` + `get…Context`; `startMeterReadingExecution` → `submitMeterReading` → `getMeterReadingContext` | Every execution id is a BE-07 checklist execution or form instance. `submitMeterReading` takes `{ value, notes? }` only — UOM and range are backend-owned |
| **PM / corrective** | `create/list/getMaintenanceBinding`, `linkMaintenanceSchedule|Task|WorkOrder`, `createBreakdown`, `linkBreakdownCorrectiveWorkOrder` | Bindings give context only. Field execution is the published BE-08 Work Order actions + BE-07 task ops |
| **Supervisor (engineering)** | `getEngineeringDailyOperations` (`date` required), `getEngineeringOverview`, shift handover `create/list/get/update/ready/acknowledge` | `availableActions` appears on FINDING rows only |
| **WO material context** | `listClientInventoryItems`, `getInventoryItem`, `listBuildingWarehouses`, `getWarehouse`, `listAssetSpareParts` | Reference data only — no stock, no price |
| **WO material usage** | `recordWorkOrderMaterialUsage`, `listWorkOrderMaterialUsages`, `getWorkOrderMaterialCostSummary`, `listWarehouseStockBalances` | Issued quantity = `WorkOrderMaterialUsage.quantity`; approved = `MaterialRequest.approvedQuantity`; planned = `AssetSparePart.requiredQuantity`. **Three different things** |
| **WO verification** | `getWorkOrderVerification`, `submitWorkOrderVerification` | The supervisor path for Work Orders (`/mobile/verification` does **not** accept `WORK_ORDER`) |
| **Finding workflow** | published BE-09 operations keyed by `findingId` | Domain finding links (`SecurityFinding.id`, `EngineeringFinding.id`, `HousekeepingFinding.id`) are **link ids**, never workflow ids |
| **Evidence** | `submitEvidence` / `listEvidence` / evidence file API, `submitHousekeepingEvidence` | Attach to the returned execution id (`CHECKLIST_EXECUTION` / `FORM_INSTANCE`). No engineering/security-specific evidence route exists — none is needed |
| **QR (asset)** | `resolveMobileQr`, `resolveAssetByIdentifier` | ASSET only — see §4 |
| **Offline sync** | `processSyncBatch` — 7 kinds | See §3 |
| **Notifications** | `listNotifications`, `markNotificationRead`, `listNotificationHistory` | The IN_APP inbox is the delivery path today — see §5 |

**Cross-cutting rules (unchanged, enforced):** opaque bearer session; every
published operation records `x-required-permission` (a real seeded code) and
`x-building-scoped: true`; cross-Building access → `403
BUILDING_ACCESS_DENIED`; list operations are constrained to the caller's
accessible Buildings; envelope is `{success, data, meta}` / `{success, error}`.

---

## 3. Offline sync — exactly what is syncable

`POST /mobile/sync`, 1–100 operations, each keyed by a client `operationId`
(idempotency) and an **authoritative** `resourceId`.

| resourceType | Operations | resourceId |
|---|---|---|
| `TASK_EXECUTION` | START / COMPLETE / CANCEL | `taskId` |
| `CHECKLIST_RESPONSES` | SAVE | checklist execution id |
| `EVIDENCE_SUBMISSION` | SUBMIT | execution id (metadata only) |
| `TASK_ASSIGNMENT` | UPDATE | `taskId` |
| `PATROL_EXECUTION` | START / COMPLETE | patrol execution id (= `taskId`) |
| `PATROL_POINT_VISIT` | SUBMIT | patrol execution id + `data.patrolRoutePointId` |
| `METER_READING` | SUBMIT | BE-07 form instance id |

**Not syncable — keep local, never queue as backend writes:**
`WORK_ORDER_ACTION`, `WORK_ORDER_MATERIAL_USAGE`, `INCIDENT`,
`SECURITY_FINDING`, `SUPERVISOR_DECISION`, `EVIDENCE_BYTES`. Reasons and the
online operation to use instead are published in
`x-sync-unsupported-resource-types` on `processSyncBatch`.

Conflicts: send `data.baseVersion` (the `updatedAt` you last saw); a stale
value returns `SYNC_CONFLICT` with the current state and a reload endpoint —
the write does **not** happen. A replayed `operationId` returns the original
stored result. A failed write needs a **new** `operationId`.

---

## 4. QR — ASSET only

The scanned payload is the **opaque** BE-05H `identifier_value`; the registry
is asset-scoped, so `resolveMobileQr` can only ever return `targetType: ASSET`.
Scanning requires a session + `asset_identifier.read`; there is no anonymous
resolution and no GPS/geofencing.

| Context | Status | Use instead |
|---|---|---|
| Location (floor/area/room/space) | **MISSING** | `getBuildingHierarchy`, `getFloor`, `getArea`, `getRoom`, `getSpace` |
| Functional location | **MISSING** | `getFunctionalLocation`, `getFunctionalLocationContext` |
| Checkpoint | **MISSING** | `listPatrolRoutePoints` + `recordPatrolPointVisit` by `pointId` |
| Work Order | **MISSING** | `listMobileAssignments`, `getWorkOrder` |

Do not encode a canonical UUID in a QR and call it a scan resolution, and do
not map any of the above onto ASSET.

---

## 5. Push — registration is not delivery

| Stage | Status |
|---|---|
| 1. Token registration (BE-25L) | **EXISTING** — `registerPushToken` / `listPushTokens` / `deactivatePushToken` |
| 2. Notification creation (BE-26) | **EXISTING** — IN_APP records |
| 3. Delivery attempt | **PARTIAL** — IN_APP / EMAIL / WHATSAPP only; **PUSH missing** |
| 4. Provider delivery | **MISSING** — no adapter, no vendor, no fan-out |

A successful token registration must **never** be shown to the user as "push
enabled". Until a future CR adds a push delivery table + adapter, mobile
notification UX must be driven by the **IN_APP inbox** (`listNotifications`,
`markNotificationRead`) — and a locally raised banner must never be reported
as backend delivery.

---

## 6. Final capability matrix (41 rows)

| Status | Rows | Meaning for mobile |
|---|---:|---|
| **EXISTING** | 21 | Bind now |
| **PARTIAL** | 6 | Usable with a documented limit |
| **MISSING** | 7 | Needs a future backend CR — do not simulate |
| **NOT_REQUIRED** | 7 | Deliberately not a backend capability |

### 6.1 Ready for mobile integration (EXISTING)

`HK-01` cleaning execution · `HK-02` inspection lifecycle · `HK-03` pass/fail
verification · `HK-07` HK finding · `HK-08` rework · `HK-09` HK evidence ·
`SEC-01` patrol execution · `SEC-02` checkpoint confirmation · `SEC-03` patrol
completion · `SEC-05` incident / field reporting · `ENG-01` PM/CM execution ·
`ENG-03` technical readings · `WO-01` material usage · `WO-02` item / warehouse
context · `WO-03` WO supervisor verification · `QR-01` asset QR · `SYN-01`
sync kinds · `SYN-02` authoritative sync ids · `SYN-03` sync conflict/retry ·
`NTF-01` push token registration · `NTF-02` in-app inbox.

### 6.2 Usable with a documented limit (PARTIAL)

| Row | Limit |
|---|---|
| `HK-05` consumable readiness | BE-11J/BE-16J routes exist, unpublished |
| `ENG-04` supervisor review | Authority published; `WORK_ORDER` not a `/mobile/verification` target |
| `ENG-05` per-reading review | Reviewed as a form/checklist; no per-reading review API (by design) |
| `ENG-06` utility (billing) meter capture | BE-18 exists, deliberately unpublished — separate authority from BE-10C |
| `WO-05` material master writes | Admin surface, deliberately unpublished |
| `SYN-04` sync kinds beyond the seven | Six candidates documented as unsupported with reasons |

### 6.3 Requires a future backend CR (MISSING)

| Row | What is missing | Precondition |
|---|---|---|
| `QR-02` location QR | Location identifier registry | Payload convention → identifier authority → extend `MOBILE_QR_TARGET_TYPES` |
| `QR-03` functional-location QR | FL identifier registry | Same |
| `QR-04` checkpoint QR | Identifiers on `patrol_route_points` | Same |
| `QR-05` Work Order scan | WO identifier registry / number lookup | Same |
| `WO-04` `WORK_ORDER` on `/mobile/verification` | A new target type (runtime change) | A PART allowed to change runtime; must not alter BE-08I rules |
| `NTF-03` push delivery attempt | Delivery table + migration + PUSH history channel | CR allowed to add schema |
| `NTF-04` push provider integration | Adapter + vendor transport + token fan-out | After NTF-03 |

### 6.4 Intentionally not required (NOT_REQUIRED)

`HK-04` reinspection domain · `HK-06` HK stock-usage engine · `SEC-04`
occurrence domain · `ENG-02` diagnosis / test-result domain · `QR-06` GPS /
geofenced scan · `SYN-05` offline evidence-byte queue · `NTF-05`
client-simulated push. **Mobile must not implement a backend-shaped substitute
for any of these.**

---

## 7. Verification status at handoff

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| CR contract suites (10 files) | **PASS — 109/109** (cross-CR regression 12, housekeeping 8, security 10, engineering 11, material context 15, QR boundary 12, sync kinds 16, push boundary 14, completeness 5, openapi-contract 6) |
| Non-DB suite sweep (no PostgreSQL) | **PASS** — 127 files, 390 assertions, 0 failures |
| DB-backed suites that self-skip without PostgreSQL | 158 files |
| DB-backed suites that fail without PostgreSQL | 25 files / 257 subtests — verified **identical** on the pre-CR baseline `d02c30e`, so none is a CR regression |
| **PART 06 runtime path with a real database** | **PASS — `mobile-sync-contract` 8/8** against embedded PostgreSQL 18.4 (1/7 without a DB) |
| OpenAPI ↔ router | **PASS** — 0 documented operations unregistered |
| 137 published operations: permission + Building scope | **PASS** — 137/137, all permissions seeded |
| FINAL REVIEW defects | **none found, none fixed** |

## 8. Known environment limitation (not hidden)

These 25 suites need PostgreSQL and fail (rather than skip) without it. Counts
below are `pass/fail` and are **byte-identical before and after this CR**:

`email-adapter` 7/7 · `mobile-app-version` 2/7 · `mobile-assignment-contract`
0/13 · `mobile-checklist-contract` 0/13 · `mobile-contract` 1/11 ·
`mobile-effective-context` 0/7 · `mobile-error-contract` 6/5 ·
`mobile-evidence-contract` 0/15 · `mobile-observability` 4/5 ·
`mobile-push-token` 1/9 · `mobile-qr-resolution` 0/8 · `mobile-sync-conflict`
0/9 · `mobile-sync-contract` 1/7 · `mobile-sync-idempotency` 0/8 ·
`mobile-verification-contract` 0/15 · `notification-delivery` 2/7 ·
`notification-escalations` 0/15 · `notification-history` 1/9 ·
`notification-reminders` 0/15 · `notification-secure-links` 1/14 ·
`notification-subscriptions` 1/12 · `notification-templates` 3/11 ·
`notification` 3/12 · `recipient-resolution` 2/15 · `whatsapp-adapter` 8/8.

### 8.1 What FINAL REVIEW managed to run with a database

An embedded PostgreSQL 18.4 was started from the repo's own
`embedded-postgres` devDependency and DB-backed tests were executed until the
sandbox recycled the process:

- ✅ **`mobile-sync-contract` 8 pass / 0 fail** — the PART 06 sync dispatcher
  (`PATROL_EXECUTION`, `PATROL_POINT_VISIT`, `METER_READING`), i.e. the CR's
  only new executable path, exercised against a real database.
- ⚠️ Full sweep **incomplete: 234 of 310 files**. Nine files reported failures
  and were **not** baseline-compared: `asset-certifications`,
  `corrective-action-verifications`, `document-control`,
  `engineering-checklist-bindings`, `engineering-findings`,
  `engineering-overview`, `engineering-reports`, `incident-closure`,
  `log-sheet-bindings`. **None of them is in this CR's changed-file set** (the
  CR's `src/` diff is confined to `mobile-sync/` plus one comment), so a
  CR-introduced cause is implausible — but this is not proven here. Check the
  PostgreSQL version (18.4 vs the project target) and shared-DB state across a
  sequential sweep first.

### 8.2 Release validation prerequisites

1. Full `npm test` against a project-standard `asentra_test` PostgreSQL.
2. Baseline-compare the nine files in §8.1 against `d02c30e`.
3. Confirm the remaining DB-backed mobile suites; only the sync suites
   exercise CR runtime code, and `mobile-sync-contract` already passed.

No DB result in this document is inferred or fabricated: each is either an
observed run or explicitly marked as not run.

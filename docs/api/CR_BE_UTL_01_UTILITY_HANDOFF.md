# CR-BE-UTL-01 — Utility API and Integration Handoff

**Contract checkpoint:** PART 16 (Building operational summary read model)
**API prefix:** `/api/v1`
**OpenAPI:** [`openapi.yaml`](./openapi.yaml)

## 1. Authority and boundaries

The backend remains authoritative for validation, lifecycle, scope, lineage,
calculation, approval eligibility and persistence. Clients must not recompute
consumption, tariff selection, charge amounts, reconciliation, IKE, IKA,
available approval actions, or billing eligibility.

Two independent chains reuse the same Meter/Reading/Consumption facts:

```text
Tenant
Meter → Reading → Evidence → Consumption → Tariff → Calculation
      → Tenant Approval → Utility Bill → invoice-ready projection

Building
Meter → Reading → Consumption → Building reconciliation → IKE / IKA
```

Building reconciliation has no Tenant Approval, Utility Bill, invoice,
payment or accounting side effect. The invoice-ready response is a projection,
not an invoice engine.

## 2. Endpoint inventory

All routes below already exist. PART 13 adds no route or workflow.

### 2.1 Meter master, purpose, type and hierarchy

| Surface | Existing endpoints | Permission / scope |
|---|---|---|
| Meter | `POST/GET /buildings/{buildingId}/utility-meters`; `GET/PATCH /utility/meters/{id}`; `PATCH /utility/meters/{id}/status`; `GET /clients/{clientId}/utility-meters` | `utility_meter.manage/read`; Building or accessible-Client scope |
| Purpose | `purpose` on Meter: `TENANT`, `BUILDING`, `COMMON_AREA`, `ENERGY_SOURCE` | Same Meter authority |
| Utility type/UOM | `POST/GET /clients/{clientId}/utility-type-configurations`; `GET/PATCH /utility/type-configurations/{id}`; status and UOM binding commands | `utility_meter.manage/read`; accessible Client |
| Main/sub hierarchy | `POST/GET /utility/meters/{id}/sub-meters`; `GET /utility/meters/{id}/main-meter`; `GET /utility/meters/{id}/main-meter-history`; `GET/PATCH /utility/meter-hierarchies/{id}`; `PATCH .../{id}/end` | `utility_meter.manage/read`; both meters resolved to Building context |
| Tenant assignment | `POST/GET /utility/meters/{id}/tenant-assignments`; `GET /utility/meters/{id}/tenant`; Tenant/Space lists; assignment `GET/PATCH/end` | `utility_meter.manage/read`; assignment is history, not a second Meter |

### 2.2 Reading operation and evidence

| Surface | Existing endpoints | Lineage |
|---|---|---|
| Engineering reading definition/execution | `/assets/{assetId}/meter-reading-bindings`, `/buildings/{buildingId}/engineering/meter-reading-bindings`, `/engineering/meter-reading-bindings/{id}`, `POST .../{id}/start`, `PUT /engineering/meter-reading-executions/{id}/reading`, `GET .../{id}` | BE-10C Asset/Form execution. Already documented in OpenAPI. |
| Reading Due | Meter/Building/Client lists; detail; `POST .../complete`; `POST .../cancel` | Optional `scheduleDefinitionId` / `generatedTaskId` reuse shared schedules/tasks. `meterReadingId` links completion without copying a value. |
| Utility reading | `POST/GET /utility/meters/{id}/readings`; `GET .../readings/latest`; Building/Tenant lists; `GET /utility/meter-readings/{id}` | Utility reading carries `meterId`, and optional `meterReadingBindingId` + `formInstanceId` back to BE-10C. |
| Evidence | Reading requirements, evidence list/submit, evidence validation; global evidence filter/detail/soft-remove | Shared BE-07 Evidence rows carry `meterReadingId`; PHOTO remains the authoritative image. |
| OCR candidate | Create from PHOTO evidence; candidate detail; explicit accept/reject | Candidate is optional assistance. Acceptance links an equal existing Reading or invokes the existing validated Reading workflow; rejection preserves reason. |

**Reading Cycle / Reading Due:** `schedule_definitions` now admits
`targetType = UTILITY_METER`; shared recurrence/task generation remains the
scheduler. Utility Reading Due stores only the expected period/due lifecycle
and optional shared schedule/task references. `OVERDUE` is projected when a
stored `DUE` item passes `dueAt`; no parallel recurrence engine exists.

**PHOTO/OCR:** OCR output is a candidate attached to an ACTIVE PHOTO evidence
row. `PENDING_REVIEW → ACCEPTED / REJECTED` is human-controlled and terminal.
PHOTO evidence is never replaced. Manual readings remain fully supported.

### 2.3 Consumption through billing

| Surface | Existing endpoints | Authority |
|---|---|---|
| Consumption | Meter create/history/latest; Building/Tenant lists; detail | References opening and closing Reading IDs; append-only delta |
| Tariff | `POST/GET /buildings/{buildingId}/utility-tariffs` | Effective-dated Building Electricity/Water rate; overlapping ACTIVE windows rejected |
| Calculation | Consumption calculate/history; calculation detail/recalculate/finalize; Meter/Building/Tenant lists; legacy calculation-basis configuration | Snapshot of quantity, UOM, tariff/rate/currency and amount |
| Tenant approval | Existing `/tenant-approvals` create/pending/detail/actions/approve/reject plus `GET /utility/calculations/{id}/tenant-approvals` | Exact FINALIZED TENANT calculation snapshot; assigned approver only |
| Utility Bill | `POST /tenant-companies/{tenantCompanyId}/utility-bills`; list/detail/update | Latest approval must be APPROVED; immutable charge snapshot; one bill per calculation |
| Invoice-ready | `GET /utility-bills/{id}/invoice-ready` | Read-only charge-line projection; no invoice number, tax, AR, payment, receipt or journal |

### 2.4 Building reconciliation and performance

| Surface | Existing endpoints |
|---|---|
| Reconciliation create/list | `POST/GET /buildings/{buildingId}/utility-reconciliations` |
| Reconciliation detail | `GET /utility/reconciliations/{id}` |

The response exposes Client, Building, utility type, exact period, source /
Tenant / common-area consumption IDs and quantities, unallocated quantity,
reconciliation percentage, applicable Space area snapshot, `IKE` or `IKA`,
performance value, `performanceUom` (`kWh/m²` or `m³/m²`), calculation actor
and timestamp. ACTUAL-reading-derived consumption is included; ESTIMATED
reading consumption is excluded. Negative unallocated quantity and percentages
above 100 are valid discrepancy facts and are never forced to balance.

### 2.5 Operational exception review

| Surface | Existing endpoints |
|---|---|
| Create/list | `POST/GET /utility/exceptions` |
| Detail | `GET /utility/exceptions/{id}` |
| Review lifecycle | `POST .../{id}/start-review`, `POST .../{id}/resolve`, `POST .../{id}/cancel` |

Exceptions reference, rather than copy, existing Meter, Reading, Reading Due,
Consumption, abnormal-consumption, OCR-candidate and reconciliation records.
The backend derives Client, Building and utility type from those references and
rejects mixed-Building context. Lifecycle is `OPEN → UNDER_REVIEW → RESOLVED`,
with terminal `CANCELLED`. Review/resolution/cancellation actors, notes and
timestamps are retained. One active exception per source and exception type
prevents duplicate operational queues; resolved/cancelled history remains.
Creating or resolving an exception never changes reconciliation values or the
Tenant billing chain.

### 2.6 Building operational summary

`GET /buildings/{buildingId}/utility-summary?periodStart=...&periodEnd=...`
is a read-only `management_read_model.read` projection for one explicitly
accessible Building and exact reporting period. It returns persisted
Electricity/Water reconciliation snapshots (including IKE/IKA and UOMs),
current active Meter counts by purpose, Reading Due lifecycle counts for the
period, existing exception counts by type/severity/status, and operational
billing-readiness counts. `calculationsAwaitingApproval` includes FINALIZED
TENANT calculations with no approval or any PENDING approval; when no review
is pending, approved/rejected use the latest updated terminal binding.
`invoiceReadyUtilityBills`
uses the same non-cancelled complete-snapshot predicate as the invoice-ready
projection. The endpoint performs no writes and does not recalculate any
reconciliation, tariff, calculation, approval or bill snapshot.

## 3. Trace identifiers

| From | Reference to next/previous authority |
|---|---|
| Meter reading due/execution | Utility Due `id`, `meterId`, optional shared `scheduleDefinitionId` / `generatedTaskId`, completed `meterReadingId` |
| Utility Reading | `meterId`, optional `meterReadingBindingId`, `formInstanceId`; linked from completed Reading Due |
| Evidence | `meterReadingId`, optional `evidenceRequirementId` |
| OCR candidate | `evidenceId`, `meterId`, terminal `acceptedReadingId`, verifier and timestamp |
| Consumption | `meterId`, `previousReadingId`, `currentReadingId`, historical Tenant assignment/company IDs |
| Calculation | `consumptionId`, `meterId`, `tariffId`, `calculationBasisId`, historical Tenant IDs |
| Approval | `utilityCalculationId`, immutable Meter/Space/Tenant/tariff snapshot, approver and decision facts |
| Utility Bill | `calculationId`, `approvalId`, `consumptionId`, historical Tenant/Space/Meter snapshot |
| Invoice-ready | `utilityBillId`, `sourceCalculationId` |
| Reconciliation | arrays of source/Tenant/common-area Consumption IDs |
| Operational exception | nullable references to Meter/Reading/Due/Consumption/abnormality/OCR/reconciliation plus immutable review history |

Values are copied only where an immutable historical snapshot is required.
Identity and hierarchy remain references to their authoritative records.

## 4. Security contract

- All surfaces use the existing opaque bearer session.
- Utility Meter, Reading, Evidence, Consumption, Tariff, Calculation and
  reconciliation use `utility_meter.read/manage`.
- Utility Bills use `utility_bill.read/manage`.
- Tenant approvals reuse `tenant_company.read/manage` and the assigned
  `approverUserId`; no new authorization model exists.
- Client access is derived from explicit accessible Buildings. Building lists
  are SQL-scoped; record routes resolve their authoritative Building before
  access is granted. Cross-Building aggregation is forbidden.
- Tenant IDs accepted by requests are checked against historical Meter /
  Consumption / Calculation context; they never override it.
- **Tenant PIC boundary:** current Utility approval/billing routes are
  management/assigned-approver APIs, not Tenant-PIC self-service APIs. A
  Tenant PIC link alone does not grant `utility_meter.*`, `utility_bill.*` or
  approval authority. Future Tenant UI must use a separately governed
  self-service publication rather than treating Tenant Company IDs as access.

Expected authorization errors are `AUTHENTICATION_REQUIRED` / session errors
(401), `PERMISSION_DENIED` (403 RBAC), and `BUILDING_ACCESS_DENIED` (403 scope).

## 5. Stable Utility errors

| Area | Important codes |
|---|---|
| Meter / Reading | `UTILITY_METER_NOT_FOUND`, `UTILITY_METER_READING_NOT_FOUND`, `UTILITY_METER_READING_ALREADY_EXISTS`, `UTILITY_METER_READING_IMMUTABLE` |
| Reading Due / OCR | `UTILITY_READING_DUE_NOT_FOUND`, `..._SCHEDULE_INVALID`, `..._TRANSITION_INVALID`, `..._READING_MISMATCH`, `UTILITY_OCR_EVIDENCE_INVALID`, `..._DECISION_FINAL`, `..._READING_MISMATCH` |
| Operational exceptions | `UTILITY_EXCEPTION_NOT_FOUND`, `..._REFERENCE_INVALID`, `..._ALREADY_OPEN`, `..._TRANSITION_INVALID` |
| Continuity / Consumption | `UTILITY_METER_CONSUMPTION_READING_INVALID`, `..._PERIOD_INVALID`, `..._NEGATIVE`, `..._UOM_MISMATCH`, `..._TENANT_MISMATCH`, `..._ALREADY_EXISTS` |
| Tariff / Calculation | `UTILITY_TARIFF_NOT_FOUND`, `UTILITY_TARIFF_INVALID`, `UTILITY_TARIFF_PERIOD_OVERLAP`, `UTILITY_CALCULATION_ALREADY_EXISTS`, `..._ALREADY_FINALIZED`, `..._NOT_RECALCULABLE` |
| Approval | `TENANT_APPROVAL_CONTEXT_MISMATCH`, `TENANT_APPROVAL_ALREADY_PENDING`, `TENANT_APPROVAL_UNAUTHORIZED_APPROVER`, `TENANT_APPROVAL_ALREADY_DECIDED`, `TENANT_APPROVAL_ACTION_NOT_ALLOWED` |
| Billing | `UTILITY_BILL_APPROVAL_REQUIRED`, `UTILITY_BILL_APPROVAL_REJECTED`, `UTILITY_BILL_ALREADY_EXISTS`, `UTILITY_BILL_CONTEXT_INVALID`, `UTILITY_BILL_STATUS_TRANSITION_INVALID` |
| Reconciliation | `BUILDING_UTILITY_RECONCILIATION_NO_SOURCE`, `..._UOM_MISMATCH`, `..._AREA_MISSING`, `..._ALREADY_EXISTS`, `..._NOT_FOUND` |

All use the shared `ErrorEnvelope`; field validation uses `VALIDATION_ERROR`.
Clients should branch on `error.code`, never message text.

## 6. Consumer readiness

- **Engineering reading UI:** binding/execution context plus Utility Reading
  linkage, ACTUAL/ESTIMATED enum, latest/history and continuity errors.
- **PHOTO/OCR workflow:** shared evidence remains the image authority; OCR
  candidate confidence, explicit accept/reject, verifier and accepted Reading
  linkage are published. Manual entry remains independent.
- **Tenant approval UI:** exact calculation snapshot, status, assigned
  approver, decision notes/timestamp and existing available-actions route.
- **Utility billing UI:** approval-gated bill snapshot and invoice-ready line.
- **BM monitoring:** Building-scoped Meter, Reading, Consumption, tariff and
  reconciliation lists.
- **Owner analytics:** immutable reconciliation, discrepancy, IKE and IKA
  outputs with source IDs, area and result UOM.
- **Operational review:** Building-scoped exception queues with source lineage,
  severity, reviewer, notes, resolution and terminal cancellation history.
- **BM/Owner summary:** exact-period persisted reconciliation plus current
  Meter, Reading Due, exception and billing-readiness operational counts.

No frontend or mobile implementation is part of this checkpoint.

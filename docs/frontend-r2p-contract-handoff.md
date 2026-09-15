# CR-BE-R2P-CONTRACT-01 — Authoritative Backend R2P Contract Handoff

**Consumer:** `CR-FE-R2P-01`

**Repository:** Asentra Backend only

**Branch inspected:** `arena/01a01726-asentra-backend`

**Baseline inspected:** `4c8446324aa4a7cb0964443088cada82ae18e741`

**Inspection date:** 2026-08-19

**PART 01 completion date:** 2026-08-19

**PART 02 completion date:** 2026-08-19

**PART 03 completion date:** 2026-08-19

**PART 04 completion date:** 2026-08-19

**PART 05 completion date:** 2026-08-19

**PART 06 completion date:** 2026-08-19

**PART 07 completion date:** 2026-08-19

**Change type:** Final authoritative backend R2P consumption contract. PART 07 adds caller-specific Vendor Invoice actions and a concise endpoint/status/action guide so frontend can render backend state and invoke commands without reproducing lifecycle, matching, verification, payment-readiness, or trace rules.

This inventory reports the current implementation, not an intended future design. Evidence was taken from registered routes, controllers, validation, public types, services, repositories, migrations, focused tests, and `docs/api/openapi.yaml`. When OpenAPI and runtime differ, the runtime behavior is reported and the drift is called out explicitly.

Classification:

- **IMPLEMENTED** — registered and backed by a current runtime contract.
- **PARTIALLY IMPLEMENTED** — useful runtime contract exists, but a requested element or publication artifact is absent/inconsistent.
- **NOT IMPLEMENTED** — no current backend authority exists.

All paths below are relative to the default `/api/v1` prefix.

---

## Executive package status

| Package | Status | Frontend conclusion |
|---|---|---|
| **F — Cross-Cutting** | **PARTIALLY IMPLEMENTED** | Prefix, envelopes, RBAC, Building isolation, stable errors, and caller-specific PO/SPK/Vendor Invoice/payment actions exist. Vendor-principal scope and a binding action resolver remain intentionally absent. |
| **A — Purchase Order** | **IMPLEMENTED** | PO lifecycle, issue-readiness, caller-specific actions, DRAFT-only line mutations, compact DELETE result, permissions, isolation, and OpenAPI are aligned. |
| **B — SPK / Work Contract** | **IMPLEMENTED** | SPK CRUD/lifecycle, caller-specific actions, and the existing Work Order procurement-binding extension are registered, scoped, permissioned, and published in OpenAPI. |
| **C — Vendor Invoice** | **IMPLEMENTED for frontend R2P** | Immutable linkage, matching/verification, PATCH, caller-specific FINALIZE/CANCEL/VERIFY/RECORD_PAYMENT actions, errors, and OpenAPI are implemented. |
| **D — Settlement readiness** | **IMPLEMENTED as payment eligibility** | Canonical READY/NOT_READY/SETTLED projection and payment-command enforcement reuse existing invoice/payment fields. No settlement entity, accounting lifecycle, or new ledger exists. |
| **E — R2P Traceability** | **IMPLEMENTED for Vendor Invoice** | Existing `/vendor-invoices/{id}/trace` now returns typed documents, source/target relationships, matching, verification, payment, and readiness projections. No persisted or generic enterprise document graph was added. |

---

# 1. Package F — Cross-Cutting

## 1.1 Contract classification

| Item | Status | Actual contract |
|---|---|---|
| API prefix/version | **IMPLEMENTED** | `API_PREFIX`, default `/api/v1`; mounted by `app.use(config.apiPrefix, createApiRouter())`. OpenAPI server URL is `/api/v1`. |
| Success envelope | **IMPLEMENTED** | `{ success: true, data: T, meta: Record<string, unknown> }`; `meta` defaults to `{}`. |
| Error envelope | **IMPLEMENTED** | `{ success: false, error: { code, message, details?, category?, retryable?, requestId?, resource?, conflict? } }`. |
| Authentication | **IMPLEMENTED** | Opaque session token in `Authorization: Bearer <token>`. Every endpoint in Packages A–E is protected. |
| Building isolation | **IMPLEMENTED for R2P** | Reads/commands resolve the record Building and call `assertBuildingAccess`; list queries receive the caller's accessible Building IDs. Explicit `buildingId` filters are also checked. |
| Client isolation | **IMPLEMENTED for R2P records** | Client is derived from an authoritative parent (readiness, PO, Work Order, or Vendor), and cross-Client references are rejected. Client is not a free caller override on PO/SPK/invoice chains. |
| Vendor data consistency | **IMPLEMENTED** | PO vendor derives from readiness; SPK vendor derives from PO; binding vendor derives from SPK; invoice vendor comes from the path and is checked against Building/PO/SPK references. |
| Vendor-principal scope | **NOT IMPLEMENTED** | There is no authenticated-user-to-Vendor principal constraint on these routes. A user with permission and Building access can operate on any valid Vendor in that Building. |
| Permission keys | **IMPLEMENTED** | Default-deny `requirePermission(code)` middleware; exact R2P keys are below. PART 01 publishes exact documented A–D operation keys through OpenAPI `x-required-permission`. |
| `availableActions` convention | **PARTIALLY IMPLEMENTED** | PO, SPK, Vendor Invoice, procurement approval, and payment readiness expose typed caller-specific actions. Binding actions remain absent because target-dependent commands have no single authoritative no-input resolver. |
| Error codes | **PARTIALLY IMPLEMENTED as a published contract** | Runtime codes are stable in `ERROR_CODES`; OpenAPI now documents both permission and Building-scope 403 examples. Most domain codes remain descriptions rather than endpoint-specific enums. |

## 1.2 Shared response and error behavior

Success:

```ts
type ApiSuccess<T> = {
  success: true;
  data: T;
  meta: Record<string, unknown>;
};
```

Error:

```ts
type ApiError = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown[];
    category?: 'VALIDATION' | 'BAD_REQUEST' | 'UNAUTHORIZED' |
      'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'SERVER';
    retryable?: boolean;
    requestId?: string;
    resource?: { type: string; id: string };
    conflict?: unknown;
  };
};
```

`X-Request-ID` is returned and included as `error.requestId` on errors. Common reachable codes for all protected R2P endpoints are:

| HTTP | Code |
|---:|---|
| 400 | `VALIDATION_ERROR` (and `BAD_REQUEST` for malformed JSON/body infrastructure) |
| 401 | `AUTHENTICATION_REQUIRED`, `INVALID_SESSION`, `SESSION_EXPIRED` as applicable to auth middleware |
| 403 | `PERMISSION_DENIED`, `BUILDING_ACCESS_DENIED` |
| 500 | `INTERNAL_SERVER_ERROR` for unhandled failures |

## 1.3 Permission map

| Surface | Read | Manage/command |
|---|---|---|
| Purchase Order and PO Lines | `purchase_order.read` | `purchase_order.manage` |
| SPK / Work Contract | `work_contract.read` | `work_contract.manage` |
| Work Order procurement binding | `wo_procurement.read` | `wo_procurement.manage` |
| Vendor Invoice, matching, trace, readiness | `vendor_invoice.read` | `vendor_invoice.manage` |
| Document/versions/supporting/handover/sign-off | `document.read` | `document.manage`; archive/restore uses `document.archive` |
| Canonical BAST decision | `document.read` | create/submit uses `document.manage`; accept/reject uses `bast.accept` |

These permissions are present in `src/database/seeds/foundation-access.seed.ts` (Document/BAST also have migration provisioning).

Vendor/principal review result: **BLOCKED — no implementation added.** `VendorPic` is explicitly contact data and “NOT an identity”; External Workforce affiliation may exist without a User and explicitly grants no Role, Permission, or Building access. No authoritative User→Vendor principal resolver exists in auth/context-access. Reusing either model would invent security semantics, so current R2P authorization remains bearer session + exact RBAC permission + explicit ACTIVE Building assignment + record-chain Vendor consistency.

## 1.4 Cross-cutting sources / OpenAPI

- Runtime: `src/app.ts`, `src/config/env.ts`, `src/routes/index.ts`
- Envelopes/errors: `src/shared/api-response.ts`, `src/shared/errors.ts`, `src/middleware/error-handler.ts`
- Auth/RBAC: `src/modules/auth/authentication.middleware.ts`, `src/modules/auth/rbac.middleware.ts`
- Isolation: `src/modules/context-access/context-access.service.ts`
- OpenAPI: `docs/api/openapi.yaml` → `servers`, `bearerAuth`, `SuccessEnvelope`, `ErrorEnvelope`, reusable responses; PART 01 adds `x-required-permission` and `x-building-scoped` on documented Package A–D operations

---

# 2. Package A — Purchase Order

## 2.1 Item classification

| Item | Status | Notes |
|---|---|---|
| Endpoints | **IMPLEMENTED** | Header, lines, issue readiness, issue, cancel, list/get/update/remove are registered. |
| Request/response DTOs | **IMPLEMENTED** | Runtime and OpenAPI include the compact PO Line removal acknowledgement. |
| PO/PO-line schemas | **IMPLEMENTED** | Header and commercial line persistence with immutable scope/request links. |
| Statuses | **IMPLEMENTED** | `DRAFT`, `ISSUED`, `CANCELLED`. |
| Lifecycle/actions | **IMPLEMENTED** | `DRAFT→ISSUED` when ready or `DRAFT→CANCELLED`; ISSUED and CANCELLED have no outgoing API transition. Actions and issue-readiness mirror these rules. |
| Permissions | **IMPLEMENTED** | `purchase_order.read`, `purchase_order.manage`. |
| Errors | **IMPLEMENTED** | Exact reachable domain codes listed below. |
| OpenAPI | **IMPLEMENTED** | Paths, action/lifecycle descriptions, DELETE result, status, and error responses match runtime. |

## 2.2 Endpoints

| Method + path | Request DTO | Response `data` | Permission | OpenAPI operationId |
|---|---|---|---|---|
| `POST /purchase-orders` | `CreatePurchaseOrderRequest` | `PurchaseOrder` (201) | `purchase_order.manage` | `createPurchaseOrder` |
| `GET /purchase-orders` | Query: `vendorId`, `buildingId`, `purchaseRequestId`, `serviceRequestId`, `status`, `poDateFrom`, `poDateTo` | `PurchaseOrder[]` | `purchase_order.read` | `listPurchaseOrders` |
| `GET /purchase-orders/{id}` | UUID path | `PurchaseOrder` | `purchase_order.read` | `getPurchaseOrder` |
| `GET /purchase-orders/{id}/available-actions` | UUID path | `PurchaseOrderAvailableActions` | `purchase_order.read` | `getPurchaseOrderAvailableActions` |
| `PATCH /purchase-orders/{id}` | `UpdatePurchaseOrderRequest` | `PurchaseOrder` | `purchase_order.manage` | `updatePurchaseOrder` |
| `POST /purchase-orders/{id}/cancel` | no body contract | `PurchaseOrder` | `purchase_order.manage` | `cancelPurchaseOrder` |
| `GET /purchase-orders/{id}/issue-readiness` | UUID path | `PurchaseOrderIssueReadiness` | `purchase_order.read` | `getPurchaseOrderIssueReadiness` |
| `POST /purchase-orders/{id}/issue` | optional `IssuePurchaseOrderRequest` | `PurchaseOrder` | `purchase_order.manage` | `issuePurchaseOrder` |
| `POST /purchase-orders/{id}/lines` | `AddPurchaseOrderLineRequest` | `PurchaseOrderLine` (201) | `purchase_order.manage` | `addPurchaseOrderLine` |
| `GET /purchase-orders/{id}/lines` | UUID path | `PurchaseOrderLine[]` | `purchase_order.read` | `listPurchaseOrderLines` |
| `GET /purchase-order-lines/{lineId}` | UUID path | `PurchaseOrderLine` | `purchase_order.read` | `getPurchaseOrderLine` |
| `PATCH /purchase-order-lines/{lineId}` | `UpdatePurchaseOrderLineRequest` | `PurchaseOrderLine` | `purchase_order.manage` | `updatePurchaseOrderLine` |
| `DELETE /purchase-order-lines/{lineId}` | UUID path | `RemovePurchaseOrderLineResult` | `purchase_order.manage` | `removePurchaseOrderLine` |

## 2.3 Exact DTOs

### Requests

- `CreatePurchaseOrderRequest`
  - required: `poReadinessId: UUID`, `poNumber: string`, `poDate: date`, `currency`
  - optional/nullable: `vendorReference`, `requiredDate`, `notes`
  - `poReadinessId` is the only context input; `clientId`, `buildingId`, `vendorId`, request references, and status are derived and rejected if supplied.
- `UpdatePurchaseOrderRequest` (DRAFT only; at least one): `poDate?`, `currency?`, `vendorReference?`, `requiredDate?`, `notes?`.
- `IssuePurchaseOrderRequest`: `{ notes?: string }`; all readiness/status/provenance fields are backend-derived.
- `AddPurchaseOrderLineRequest`
  - required: `requestLineType`, `requestLineId: UUID`, `unitPrice: number >= 0`
  - optional: `description`, `notes`
  - quantity/item/UOM/line number/line amount and concrete request IDs are rejected if supplied.
- `UpdatePurchaseOrderLineRequest` (DRAFT parent only; at least one): `unitPrice?`, `description?`, `notes?`.

### Responses

`PurchaseOrder`:

```text
id, clientId, buildingId, poNumber, poDate, vendorId,
requestType, purchaseRequestId?, serviceRequestId?, poReadinessId,
currency, status, vendorReference?, requiredDate?, notes?,
createdByUserId, issuedAt?, issuedByUserId?,
cancelledAt?, cancelledByUserId?, createdAt, updatedAt
```

`PurchaseOrderLine`:

```text
id, purchaseOrderId, clientId, buildingId, lineNumber,
requestLineType, materialRequestId?, serviceRequestId?, itemId?, uomId?,
description, quantitySnapshot?, unitPrice, lineAmount, notes?,
createdByUserId, createdAt, updatedAt
```

`quantitySnapshot` is a frozen backend-derived copy of the Material Request's `approvedQuantity ?? quantity`; it is `null` for Service Request lines. `lineAmount` is derived as `quantitySnapshot × unitPrice`, or `unitPrice` for service lines. Neither is a fulfillment/receiving ledger.

`RemovePurchaseOrderLineResult`:

```text
{ removed: true, purchaseOrderId: UUID, lineNumber: integer >= 1 }
```

The endpoint returns HTTP 200, deletes only while the parent is DRAFT, releases the originating request line for a future live commitment, and records the surviving removal operational event.

`PurchaseOrderIssueReadiness`:

```text
purchaseOrderId, status, issuable, poReadiness?, lineCount,
blockers[], availableActions[], evaluatedAt
```

## 2.4 Enums, lifecycle, and actions

- `PurchaseOrderStatus`: `DRAFT | ISSUED | CANCELLED`
- `PurchaseOrderRequestType`: `PURCHASE_REQUEST | SERVICE_REQUEST`
- `PurchaseOrderLineRequestType`: `MATERIAL_REQUEST | SERVICE_REQUEST`
- Currency: `IDR | USD | SGD | MYR | AUD | EUR | GBP | JPY | CNY`
- Issue blockers:
  - `PO_NOT_DRAFT`
  - `PO_READINESS_INVALID`
  - `PO_READINESS_NOT_READY`
  - `NO_PURCHASE_ORDER_LINES`
  - `REQUEST_LINKAGE_INVALID`
  - `REQUEST_LINE_INVALID`
  - `VENDOR_NOT_COMMITTABLE`
  - `SCOPE_INCONSISTENT`

Actual command lifecycle:

```text
DRAFT --issue (readiness passes)--> ISSUED
DRAFT --cancel--> CANCELLED
ISSUED: terminal for current API commands; cancel returns 400 PURCHASE_ORDER_CANCEL_NOT_ALLOWED
CANCELLED: terminal; issue returns 409 and cancel returns 400
```

PART 01 action contract:

```text
PurchaseOrderAction = ISSUE | CANCEL
PurchaseOrderAvailableActions = {
  purchaseOrderId, state, availableActions: PurchaseOrderAction[]
}
```

- `GET /purchase-orders/{id}/available-actions` requires `purchase_order.read` and Building access.
- Actions are returned only when the caller also has `purchase_order.manage`.
- DRAFT + issuable → `['ISSUE', 'CANCEL']`; DRAFT + not issuable → `['CANCEL']`; ISSUED/CANCELLED → `[]`.
- `PurchaseOrderIssueReadiness.availableActions` is now `['ISSUE']` only when issuable **and** the caller can manage; read-only callers receive `[]` while still seeing the readiness facts.
- No UPDATE/line pseudo-actions were invented.
- The database constraint can preserve issuance stamps on historical/imported issued-cancelled rows. That storage compatibility is not exposed as an API transition.
- POST/PATCH/DELETE PO Line mutations all resolve the parent and return `PURCHASE_ORDER_LINE_NOT_DRAFT` unless it is DRAFT. MR/SR remains the sole quantity authority; PART 02 adds no quantity ledger.

## 2.5 Isolation and vendor behavior

- Create resolves Client, Building, Vendor, and request from a `READY` PO Readiness record, then checks caller Building access and an ACTIVE Vendor/Building relationship.
- By-id and line operations assert access to the record Building.
- Lists are repository-scoped to accessible Building IDs.
- Request lines must belong to the PO request, Client, and Building; a request line cannot be committed on another live PO.

## 2.6 Exact domain errors

| HTTP | Codes |
|---:|---|
| 400 | `PURCHASE_ORDER_READINESS_INVALID`, `PURCHASE_ORDER_VENDOR_INVALID`, `PURCHASE_ORDER_NOT_DRAFT`, `PURCHASE_ORDER_CANCEL_NOT_ALLOWED`, `PURCHASE_ORDER_CONTEXT_INVALID`, `PURCHASE_ORDER_LINE_REQUEST_INVALID`, `PURCHASE_ORDER_LINE_REQUEST_MISMATCH`, `PURCHASE_ORDER_LINE_NOT_DRAFT`, `PURCHASE_ORDER_LINE_PRICE_INVALID`, `PURCHASE_ORDER_LINE_UOM_INCOMPATIBLE` |
| 404 | `PURCHASE_ORDER_NOT_FOUND`, `PURCHASE_ORDER_LINE_NOT_FOUND` |
| 409 | `PURCHASE_ORDER_NUMBER_ALREADY_EXISTS`, `PURCHASE_ORDER_READINESS_NOT_READY`, `PURCHASE_ORDER_READINESS_ALREADY_COMMITTED`, `PURCHASE_ORDER_LINE_DUPLICATE`, `PURCHASE_ORDER_NOT_ISSUABLE_STATE`, `PURCHASE_ORDER_NO_LINES`, `PURCHASE_ORDER_NOT_ISSUABLE` |

For `PURCHASE_ORDER_NOT_ISSUABLE`, blockers are returned in `error.details[].message`.

## 2.7 Sources / OpenAPI alignment

- Runtime: `src/modules/purchase-orders/*`
- Persistence: migrations `0269`–`0271` and PO repositories
- Tests: `tests/purchase-orders.test.ts`, `tests/purchase-order-lines.test.ts`, `tests/purchase-order-issuance.test.ts`, `tests/purchase-order-readiness.test.ts`
- OpenAPI paths: `/purchase-orders*`, `/purchase-order-lines/{lineId}`
- OpenAPI schemas: `PurchaseOrder*`, `PurchaseOrderLine*`, `PurchaseOrderIssueReadiness`, `RemovePurchaseOrderLineResult`
- **Resolved A-01:** DELETE line now publishes its actual compact acknowledgement and exact 400/404 codes.
- **Resolved A-02:** transition helper, service/repository behavior, actions, tests, and OpenAPI all define cancellation as DRAFT-only.

---

# 3. Package B — SPK / Work Contract

## 3.1 Item classification

| Item | Status | Notes |
|---|---|---|
| Endpoints/DTOs/status/lifecycle | **IMPLEMENTED** | Full SPK header and deterministic lifecycle exist. |
| Work Order binding | **IMPLEMENTED** | The existing BE-17H binding is extended; no duplicate SPK↔WO domain. |
| Permissions/errors/isolation | **IMPLEMENTED** | Exact contracts below. |
| `availableActions` | **IMPLEMENTED for SPK** | PART 01 adds a caller-specific, Building-scoped read using existing lifecycle commands and permissions only. |
| OpenAPI | **IMPLEMENTED** | All listed SPK and binding paths/schemas are present. |

## 3.2 SPK endpoints

| Method + path | Request DTO | Response `data` | Permission | OpenAPI operationId |
|---|---|---|---|---|
| `POST /work-contracts` | `CreateWorkContractRequest` | `WorkContract` (201) | `work_contract.manage` | `createWorkContract` |
| `GET /work-contracts` | Query: `purchaseOrderId`, `vendorId`, `buildingId`, `status`, `spkDateFrom`, `spkDateTo` | `WorkContract[]` | `work_contract.read` | `listWorkContracts` |
| `GET /work-contracts/{id}` | UUID path | `WorkContract` | `work_contract.read` | `getWorkContract` |
| `GET /work-contracts/{id}/available-actions` | UUID path | `WorkContractAvailableActions` | `work_contract.read` | `getWorkContractAvailableActions` |
| `PATCH /work-contracts/{id}` | `UpdateWorkContractRequest` | `WorkContract` | `work_contract.manage` | `updateWorkContract` |
| `POST /work-contracts/{id}/activate` | no body contract | `WorkContract` | `work_contract.manage` | `activateWorkContract` |
| `POST /work-contracts/{id}/complete` | no body contract | `WorkContract` | `work_contract.manage` | `completeWorkContract` |
| `POST /work-contracts/{id}/cancel` | no body contract | `WorkContract` | `work_contract.manage` | `cancelWorkContract` |

`CreateWorkContractRequest`:

```text
required: purchaseOrderId, spkNumber, spkDate, title
optional/nullable: scopeDescription, startDate, endDate, notes
```

`purchaseOrderId` is the only context input. The PO must be `ISSUED`; Client, Building, and Vendor are inherited. `endDate >= startDate` when both are set.

`UpdateWorkContractRequest` (DRAFT only; at least one):

```text
spkDate?, title?, scopeDescription?, startDate?, endDate?, notes?
```

Identity, PO link, inherited scope, status, and lifecycle provenance are immutable.

`WorkContract`:

```text
id, clientId, buildingId, vendorId, purchaseOrderId,
spkNumber, spkDate, title, scopeDescription?, startDate?, endDate?, notes?,
status, createdByUserId,
activatedAt?, activatedByUserId?, completedAt?, completedByUserId?,
cancelledAt?, cancelledByUserId?, createdAt, updatedAt
```

Lifecycle:

```text
DRAFT -> ACTIVE -> COMPLETED
DRAFT -> CANCELLED
ACTIVE -> CANCELLED
COMPLETED and CANCELLED are terminal
```

`WorkContractStatus`: `DRAFT | ACTIVE | COMPLETED | CANCELLED`.

PART 01 action contract:

```text
WorkContractAction = ACTIVATE | COMPLETE | CANCEL
WorkContractAvailableActions = {
  workContractId, state, availableActions: WorkContractAction[]
}
```

- The action endpoint requires `work_contract.read` and Building access; actions require the caller's existing `work_contract.manage` permission.
- DRAFT → `ACTIVATE` only when the command's existing Vendor-usability precondition passes, plus `CANCEL`.
- ACTIVE → `['COMPLETE', 'CANCEL']`; COMPLETED/CANCELLED → `[]`.
- An empty list is authoritative; no transition or permission was added.

## 3.3 Work Order binding endpoints and DTO

| Method + path | Request DTO | Response `data` | Permission | OpenAPI operationId |
|---|---|---|---|---|
| `POST /work-order-procurement-bindings` | `CreateWorkOrderProcurementBindingRequest` | `WorkOrderProcurementBinding` (201) | `wo_procurement.manage` | `createWorkOrderProcurementBinding` |
| `GET /work-order-procurement-bindings/{id}` | UUID path | `WorkOrderProcurementBinding` | `wo_procurement.read` | `getWorkOrderProcurementBinding` |
| `POST /work-order-procurement-bindings/{id}/resolve-readiness` | no body | `WorkOrderProcurementBinding` | `wo_procurement.manage` | `resolveWorkOrderProcurementReadiness` |
| `POST /work-order-procurement-bindings/{id}/link-receiving` | `{ receivingId: UUID }` | `WorkOrderProcurementBinding` | `wo_procurement.manage` | `linkReceivingToWorkOrderProcurementBinding` |
| `POST /work-order-procurement-bindings/{id}/bind-work-contract` | `{ workContractId: UUID }` | `WorkOrderProcurementBinding` | `wo_procurement.manage` | `bindWorkContractToProcurementBinding` |
| `GET /work-orders/{workOrderId}/procurement-bindings` | UUID path | `WorkOrderProcurementBinding[]` | `wo_procurement.read` | `listWorkOrderProcurementBindings` |

Create request:

```text
required: workOrderId, purchaseRequestId
optional/nullable: materialRequestId, serviceRequestId, workContractId
optional: notes
```

If supplied, `workContractId` is the only SPK-chain input. PO, Vendor, Client, and Building are derived. Binding requires an `ACTIVE` SPK, its PO still `ISSUED`, same Client/Building as the Work Order, and an ACTIVE Work Order Vendor assignment matching the SPK Vendor. One binding exists per Work Order and an existing SPK link cannot be silently replaced.

`WorkOrderProcurementBinding`:

```text
id, clientId, buildingId, workOrderId, purchaseRequestId,
materialRequestId?, serviceRequestId?, receivingId?,
workContractId?, purchaseOrderId?, vendorId?, procurementStatus, notes?,
createdByUserId, createdAt, updatedAt,
workOrder?, purchaseRequest?, materialRequest?, serviceRequest?, receiving?,
workContract? { id, spkNumber, title, status },
purchaseOrder? { id, poNumber, status }
```

`WOProcurementStatus`: `BOUND | READY | RECEIVED`.

## 3.4 Exact domain errors

SPK:

| HTTP | Codes |
|---:|---|
| 400 | `WORK_CONTRACT_PURCHASE_ORDER_INVALID`, `WORK_CONTRACT_NOT_DRAFT`, `WORK_CONTRACT_VENDOR_INVALID`, `WORK_CONTRACT_CONTEXT_INVALID` |
| 404 | `WORK_CONTRACT_NOT_FOUND` |
| 409 | `WORK_CONTRACT_NUMBER_ALREADY_EXISTS`, `WORK_CONTRACT_PURCHASE_ORDER_NOT_ISSUED`, `WORK_CONTRACT_ALREADY_EXISTS_FOR_PO`, `WORK_CONTRACT_TRANSITION_INVALID` |

Binding:

| HTTP | Codes |
|---:|---|
| 400 | `WO_PROCUREMENT_REQUEST_INVALID`, `WO_PROCUREMENT_BUILDING_MISMATCH`, `WO_PROCUREMENT_RECEIVING_INVALID`, `WO_PROCUREMENT_RECEIVING_MISMATCH`, `WO_PROCUREMENT_WORK_CONTRACT_INVALID`, `WO_PROCUREMENT_VENDOR_MISMATCH` |
| 404 | `WO_PROCUREMENT_NOT_FOUND` |
| 409 | `WO_PROCUREMENT_ALREADY_BOUND`, `WO_PROCUREMENT_WORK_CONTRACT_NOT_ACTIVE`, `WO_PROCUREMENT_PURCHASE_ORDER_NOT_ISSUED`, `WO_PROCUREMENT_WORK_CONTRACT_ALREADY_BOUND` |

## 3.5 Sources

- SPK: `src/modules/work-contracts/*`
- Binding: `src/modules/work-order-procurement-bindings/*`
- Related authority: `src/modules/work-orders/*`, `src/modules/vendor-assignments/*`
- Tests: `tests/work-contracts.test.ts`, `tests/wo-procurement-spk-binding.test.ts`
- OpenAPI paths/schemas: `/work-contracts*`, `/work-order-procurement-bindings*`, `/work-orders/{workOrderId}/procurement-bindings`; `WorkContract*`, `WorkOrderProcurementBinding`, `WOProcurementStatus`

---

# 4. Package C — Vendor Invoice Enhancement

## 4.1 Item classification

| Item | Status | Notes |
|---|---|---|
| PO/SPK references | **IMPLEMENTED** | Nullable creation-time links, immutable PATCH behavior, filters, required nullable response fields, trace fields, service eligibility gates, and DB composite scope FKs exist. |
| Verification | **IMPLEMENTED** | FINALIZED verification consumes the canonical result: MATCHED→VERIFIED, MISMATCH→DISCREPANCY, NOT_READY→409 without mutation. |
| Matching diagnostics | **IMPLEMENTED** | One read-only result covers Vendor, PO/SPK, committed amount/currency, MR/SR receiving, Work/Vendor Work, completion/service, and BAST evidence. |
| Bounded three-way match | **IMPLEMENTED** | Linked invoices compare Invoice↔PO/PO Lines↔authoritative MR/SR Receiving/evidence without creating invoice-line quantity or another ledger. |
| `availableActions` / eligibility | **IMPLEMENTED** | Dedicated caller-specific projection exposes existing FINALIZE/CANCEL/VERIFY/RECORD_PAYMENT commands; matching/readiness fields explain eligibility. |
| Errors | **IMPLEMENTED** | Linkage errors plus deterministic NOT_READY verification rejection are published. |
| OpenAPI | **IMPLEMENTED for existing invoice routes** | Existing PATCH is now published; create/read/linkage eligibility and errors match runtime. |

## 4.2 Endpoints

| Method + path | Request DTO | Response `data` | Permission | OpenAPI operationId |
|---|---|---|---|---|
| `POST /vendors/{vendorId}/invoices` | `CreateVendorInvoiceRequest` | `VendorInvoice` (201) | `vendor_invoice.manage` | `createVendorInvoice` |
| `GET /vendor-invoices` | Query: `vendorId`, `buildingId`, `workOrderId`, `purchaseOrderId`, `workContractId`, `status`, `invoiceDateFrom`, `invoiceDateTo` | `VendorInvoice[]` | `vendor_invoice.read` | `listVendorInvoices` |
| `GET /vendor-invoices/{id}` | UUID path | `VendorInvoice` | `vendor_invoice.read` | `getVendorInvoice` |
| `GET /vendor-invoices/{id}/available-actions` | UUID path | `VendorInvoiceAvailableActions` | `vendor_invoice.read` | `getVendorInvoiceAvailableActions` |
| `PATCH /vendor-invoices/{id}` | `UpdateVendorInvoiceRequest` | `VendorInvoice` | `vendor_invoice.manage` | `updateVendorInvoice` |
| `POST /vendor-invoices/{id}/finalize` | no body | `VendorInvoice` | `vendor_invoice.manage` | `finalizeVendorInvoice` |
| `POST /vendor-invoices/{id}/cancel` | no body | `VendorInvoice` | `vendor_invoice.manage` | `cancelVendorInvoice` |
| `POST /vendor-invoices/{id}/verify` | `{ notes?: string }` | `VendorInvoiceVerifyResult` | `vendor_invoice.manage` | `verifyVendorInvoice` |
| `GET /vendor-invoices/{id}/matching` | UUID path | `InvoiceMatchingResult` | `vendor_invoice.read` | `getVendorInvoiceMatching` |
| `GET /vendor-invoices/{id}/consistency` | UUID path | `VendorConsistencyResult` | `vendor_invoice.read` | `getVendorInvoiceConsistency` |
| `GET /vendor-invoices/{id}/trace` | UUID path | `VendorInvoiceTrace` | `vendor_invoice.read` | `getVendorInvoiceTrace` |
| `POST /vendor-invoices/{id}/payment` | `RecordVendorPaymentRequest` | `VendorInvoice` | `vendor_invoice.manage` | `recordVendorPayment` |
| `GET /vendor-invoices/{id}/settlement-readiness` | UUID path | `VendorSettlementReadinessResult` | `vendor_invoice.read` | `getVendorInvoiceSettlementReadiness` |

## 4.3 Invoice DTOs, enums, and lifecycle

`CreateVendorInvoiceRequest`:

```text
required: buildingId, invoiceNumber, invoiceDate, receivedDate,
          currency, invoiceAmount
optional UUIDs: vendorWorkId, workOrderId, completionReportId,
                serviceReportId, bastDocumentId, purchaseOrderId, workContractId
optional/nullable strings: vendorReference, notes
```

`vendorId` comes from the route; `clientId` derives from that Vendor. Optional Work Order, Vendor Work, report, and BAST references must share that Vendor/Client/Building and their actual Work Order/Vendor Work relationship. `workContractId` requires `purchaseOrderId`. All linkage is immutable after creation.

`UpdateVendorInvoiceRequest` / runtime `UpdateVendorInvoiceInput` (DRAFT only; at least one):

```text
invoiceDate?, receivedDate?, currency?, invoiceAmount?, vendorReference?, notes?
```

`VendorInvoice`:

```text
id, clientId, buildingId, vendorId, invoiceNumber, invoiceDate, receivedDate,
currency, invoiceAmount, status, vendorReference?,
vendorWorkId?, workOrderId?, completionReportId?, serviceReportId?,
bastDocumentId?, purchaseOrderId?, workContractId?, notes?, createdByUserId,
verificationStatus, verifiedByUserId?, verifiedAt?, verificationNotes?,
discrepancyCodes[], paymentStatus, paidAmount, outstandingAmount,
lastPaymentDate?, finalizedAt?, finalizedByUserId?,
cancelledAt?, cancelledByUserId?, createdAt, updatedAt
```

Enums/lifecycle:

- Invoice status: `DRAFT | FINALIZED | CANCELLED`
- Actual lifecycle: `DRAFT→FINALIZED`; `DRAFT|FINALIZED→CANCELLED`; `CANCELLED` terminal.
- Verification: `PENDING | VERIFIED | DISCREPANCY`
  - only a FINALIZED invoice can verify;
  - all checks pass → `VERIFIED`;
  - any check fails → `DISCREPANCY` plus codes;
  - VERIFIED verify is idempotent; DISCREPANCY can be re-evaluated.
- Payment: `UNPAID | PARTIALLY_PAID | PAID` (see Package D).
- Currency: `IDR | USD | SGD | MYR | AUD | EUR | GBP | JPY | CNY`.

Caller-specific action contract:

```text
VendorInvoiceAction = FINALIZE | CANCEL | VERIFY | RECORD_PAYMENT
VendorInvoiceAvailableActions = {
  vendorInvoiceId, state, verificationStatus,
  matchingStatus, settlementReadiness, availableActions
}
```

- DRAFT → `FINALIZE`, `CANCEL`.
- FINALIZED + MATCHED/MISMATCH requiring a decision → `CANCEL`, `VERIFY`.
- FINALIZED + VERIFIED + READY → `CANCEL`, `RECORD_PAYMENT`.
- FINALIZED + NOT_READY → `CANCEL` only.
- SETTLED FINALIZED invoice → `CANCEL` only because the existing cancel command remains executable; no payment action.
- CANCELLED or caller without `vendor_invoice.manage` → `[]`.

## 4.4 PO/SPK reference rules

- `purchaseOrderId` remains optional for backward compatibility. If present, the PO must exist, be `ISSUED`, and match invoice Vendor, Client, and Building.
- `workContractId` is optional but cannot exist without `purchaseOrderId`. It must exist, belong to that PO, match invoice Vendor/Client/Building, and be `ACTIVE` or `COMPLETED`.
- `DRAFT` and `CANCELLED` SPKs are rejected with 409 `VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE`; DRAFT/CANCELLED POs are rejected with 409 `VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED`.
- Linkage is set only at creation and is immutable through PATCH. Create and read responses always expose nullable `purchaseOrderId` and `workContractId`.
- Database migration `0274` adds composite FKs that make PO/SPK scope and SPK→PO mismatches unrepresentable. Lifecycle status remains owned by PO/SPK and is checked by the service rather than duplicated.
- `GET /vendor-invoices?purchaseOrderId=...&workContractId=...` provides reverse filtering.
- Unlinked legacy/new invoices remain supported; no mandatory PO backfill or duplicate procurement truth was introduced.

## 4.5 Canonical matching and verification contract

`GET /vendor-invoices/{id}/matching` returns the single `InvoiceMatchingResult` consumed by `POST /vendor-invoices/{id}/verify`:

```text
invoiceId
status: MATCHED | MISMATCH | NOT_READY
verificationEligible: boolean
vendorMatch
purchaseOrderMatch
workContractMatch
amountMatch
receivingMatch
workOrderMatch
vendorWorkMatch
completionMatch
serviceMatch
bastMatch
allMatched
mismatchCodes[]
notReadyCodes[]
discrepancyCodes[]
evaluatedAt
```

Each check is:

```text
{ check, applicable, status, matched, discrepancy }
```

`matched`/`allMatched` remain compatibility conveniences and are true exactly for `MATCHED`. `MISMATCH` takes precedence if mismatch and not-ready reasons coexist.

Authoritative inputs:

1. Invoice Vendor and ACTIVE Vendor/Building relationship.
2. Immutable PO reference: existence, ISSUED status, Client/Building/Vendor scope.
3. Optional immutable SPK reference: PO ownership, scope/Vendor, ACTIVE/COMPLETED status.
4. Invoice amount/currency versus the sum of existing PO Line `lineAmount` values.
5. Material PO Lines: current MR authoritative `approvedQuantity ?? quantity` versus cumulative valid Receiving quantity.
6. Service PO Lines: same-Vendor service Receiving must be FINALIZED.
7. Existing Work Order, Vendor Work, Completion Report, Service Report, and canonical BAST references, including their Vendor/Client/Building and Work Order/Vendor Work relationships.
8. If the linked Work Order requires BAST but none is available, matching returns NOT_READY; it never fabricates BAST data.

No quantity is persisted by matching. `quantitySnapshot` remains a frozen commercial snapshot, while MR and Receiving remain the fulfillment quantity authorities. Legacy/unlinked invoices retain their existing operational-evidence verification path with PO/SPK/Receiving checks marked `applicable: false`.

Status behavior:

- **MATCHED** — every applicable check passed; `verificationEligible: true`.
- **MISMATCH** — a deterministic contradiction exists, such as Vendor/scope/reference/currency/amount mismatch. Verification persists `DISCREPANCY` and returns the canonical result.
- **NOT_READY** — required receiving/completion/service/BAST evidence is incomplete. Verification returns 409 `VENDOR_INVOICE_MATCHING_NOT_READY`, includes reasons in `error.details`, and leaves verification state unchanged.

Representative reasons include:

```text
PURCHASE_ORDER_NOT_FOUND / PURCHASE_ORDER_NOT_ISSUED
PURCHASE_ORDER_SCOPE_MISMATCH / PURCHASE_ORDER_VENDOR_MISMATCH
WORK_CONTRACT_* mismatch/not-eligible reasons
CURRENCY_MISMATCH / INVOICE_PO_AMOUNT_MISMATCH
PURCHASE_ORDER_LINES_NOT_FOUND
MATERIAL_REQUEST_NOT_FOUND
MATERIAL_RECEIVING_NOT_COMPLETE / MATERIAL_RECEIVING_OVER_APPROVED
SERVICE_RECEIVING_NOT_FINALIZED
COMPLETION_REPORT_NOT_FOUND / COMPLETION_REPORT_NOT_SUBMITTED
SERVICE_REPORT_NOT_FOUND / SERVICE_REPORT_NOT_FINALIZED
BAST_NOT_FOUND / BAST_REQUIRED_NOT_AVAILABLE / BAST_NOT_ACCEPTED
AMOUNT_INVALID
```

## 4.6 Exact reachable domain errors

| HTTP | Codes |
|---:|---|
| 400 | `VENDOR_INVOICE_VENDOR_INVALID`, `VENDOR_INVOICE_NOT_DRAFT`, `VENDOR_INVOICE_FINALIZED_PROTECTED`, `VENDOR_INVOICE_CANCEL_NOT_ALLOWED`, `VENDOR_INVOICE_CONTEXT_INVALID`, `VENDOR_INVOICE_PURCHASE_ORDER_INVALID`, `VENDOR_INVOICE_WORK_CONTRACT_INVALID`, `VENDOR_INVOICE_WORK_CONTRACT_PO_MISMATCH`, `VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH`, `VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH`, `VENDOR_INVOICE_NOT_FINALIZED`, `VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT`, `VENDOR_INVOICE_PAYMENT_NOT_ALLOWED`; create can also expose `VENDOR_INACTIVE`, while request validation uses `VALIDATION_ERROR` |
| 404 | `VENDOR_INVOICE_NOT_FOUND`; create can expose `VENDOR_NOT_FOUND` |
| 409 | `VENDOR_INVOICE_NUMBER_ALREADY_EXISTS`, `VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED`, `VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE`, `VENDOR_INVOICE_MATCHING_NOT_READY`, `VENDOR_INVOICE_PAYMENT_NOT_READY` |
| 422 | `VENDOR_INVOICE_OVERPAYMENT` |

Linkage error mapping: unknown PO → 400 `VENDOR_INVOICE_PURCHASE_ORDER_INVALID`; unknown SPK → 400 `VENDOR_INVOICE_WORK_CONTRACT_INVALID`; SPK without/mismatched PO → 400 validation or `VENDOR_INVOICE_WORK_CONTRACT_PO_MISMATCH`; Vendor mismatch → 400 `VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH`; Client/Building mismatch → 400 `VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH`; ineligible PO/SPK state → the 409 codes above.

Verification discrepancy is a successful `200` result with persisted `DISCREPANCY`, not a `VENDOR_INVOICE_DISCREPANCY` error. Invalid HTTP payment amounts are rejected as `VALIDATION_ERROR`; `VENDOR_INVOICE_PAYMENT_AMOUNT_INVALID` is only the service-level defensive guard. `VENDOR_INVOICE_ALREADY_VERIFIED`, `VENDOR_INVOICE_DISCREPANCY`, `VENDOR_INVOICE_VENDOR_CONSISTENCY_FAILED`, and `VENDOR_INVOICE_BAST_HARD_GATE_FAILED` are declared but not emitted by the current service.

## 4.7 Sources / OpenAPI alignment

- Runtime: `src/modules/vendor-invoices/*`
- PO/SPK linkage migration: `src/database/migrations/0274_add_vendor_invoice_procurement_linkage.ts`
- Tests: `tests/vendor-invoices.test.ts`, `tests/vendor-invoice-verification.test.ts`, `tests/vendor-invoice-consistency.test.ts`, `tests/vendor-invoice-procurement-linkage.test.ts`
- OpenAPI: `/vendors/{vendorId}/invoices`, `/vendor-invoices*`; schemas `VendorInvoice`, create/update requests, eligible-state enums, `VendorInvoiceMatchingStatus`, `VendorInvoiceMatchingReason`, `InvoiceMatchingResult`, `VendorInvoiceVerifyResult`, `VendorConsistencyResult`, `VendorInvoiceTrace`
- **Resolved C-01:** the existing PATCH path and DRAFT-only update DTO are published.
- **Resolved C-02:** one bounded Invoice↔PO/PO Lines↔MR/SR Receiving/evidence matching result is implemented and consumed by verification.
- **Resolved C-03:** optional SPK linkage enforces ACTIVE/COMPLETED eligibility.
- **Resolved C-04:** caller-specific Vendor Invoice lifecycle, verification, and payment actions are published without adding a settlement entity or parallel lifecycle.

---

# 5. Package D — Vendor Invoice payment readiness

## 5.1 Item classification

| Item | Status | Actual contract |
|---|---|---|
| Canonical readiness | **IMPLEMENTED** | `GET /vendor-invoices/{id}/settlement-readiness` returns READY / NOT_READY / SETTLED. |
| Payment integration | **IMPLEMENTED** | `POST /vendor-invoices/{id}/payment` consumes the same readiness authority before mutation. |
| SETTLED derivation | **IMPLEMENTED** | Derived from existing `paymentStatus=PAID`, `paidAmount=invoiceAmount`, and zero generated outstanding amount. |
| Financial authority | **IMPLEMENTED / unchanged** | Existing invoice amount, cumulative paid amount, generated outstanding amount, payment status, currency, and last payment date remain authoritative. |
| Settlement entity/accounting lifecycle | **NOT IMPLEMENTED by design** | No settlement row, journal, GL, tax, bank, gateway, or parallel payment ledger. |
| Action | **IMPLEMENTED** | Readiness advertises `RECORD_PAYMENT` only when READY; it maps to the existing payment endpoint. |

## 5.2 Canonical readiness DTO

`VendorSettlementReadinessResult`:

```text
invoiceId
readiness: READY | NOT_READY | SETTLED
invoiceStatus
verificationStatus
matchingStatus
paymentStatus
currency
invoiceAmount
paidAmount
outstandingAmount
reasons[]
blockers[]                 // deprecated alias of reasons
matchingReasons[]
consistencyReasons[]
availableActions[]         // RECORD_PAYMENT only when READY
evaluatedAt
```

Readiness inputs are all existing authorities: invoice lifecycle and verification, PART 04 canonical matching, Vendor/scope consistency, supported currency, invoice amount, and persisted/generated payment fields.

## 5.3 Status behavior

- **READY** — invoice is FINALIZED and VERIFIED; canonical matching is MATCHED; Vendor/Client/Building consistency holds; amount/currency are valid; payment state is coherent UNPAID or PARTIALLY_PAID with positive outstanding amount.
- **NOT_READY** — one or more deterministic reasons exist. No payment action is advertised.
- **SETTLED** — derived only when existing payment state is PAID, cumulative paid amount equals invoice amount, and generated outstanding amount is zero. No duplicate settled flag is stored.

Reasons:

```text
INVOICE_NOT_FINALIZED
INVOICE_CANCELLED
INVOICE_NOT_VERIFIED
MATCHING_NOT_READY
MATCHING_MISMATCH
SCOPE_MISMATCH
INVALID_INVOICE_AMOUNT
INVALID_CURRENCY
INVALID_PAYMENT_STATE
```

PART 04 matching reasons remain separately available in `matchingReasons` rather than being redefined as settlement reasons.

## 5.4 Payment command integration

`POST /vendor-invoices/{id}/payment` locks the existing invoice row, checks Building access, evaluates the same canonical readiness, and then applies the existing guarded cumulative payment update.

- READY → existing positive amount/overpayment checks and payment transaction proceed.
- NOT_READY because invoice is unverified → existing 400 `VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT`.
- NOT_READY because lifecycle disallows payment → existing 400 `VENDOR_INVOICE_PAYMENT_NOT_ALLOWED`.
- Other NOT_READY reasons → 409 `VENDOR_INVOICE_PAYMENT_NOT_READY` with readiness reasons in `error.details`.
- SETTLED/duplicate full payment → existing 422 `VENDOR_INVOICE_OVERPAYMENT`.

Partial payments remain supported: PARTIALLY_PAID with positive outstanding amount remains READY. Row locking and the guarded SQL cumulative cap continue to serialize concurrent payments and prevent duplicate/overpayment decisions.

## 5.5 Financial fields and boundaries

- `invoiceAmount` — existing `NUMERIC(18,2)` invoice authority.
- `paidAmount` — existing cumulative payment authority.
- `outstandingAmount` — existing PostgreSQL generated value `invoiceAmount - paidAmount`.
- `paymentStatus` — existing `UNPAID | PARTIALLY_PAID | PAID`.
- `lastPaymentDate` — existing latest supplied payment date.

No payment transaction/list DTO, settlement ID, accounting entry, bank reference, tax calculation, or new financial formula is introduced.

Sources/OpenAPI:

- `src/modules/vendor-invoices/vendor-invoice.types.ts`
- `src/modules/vendor-invoices/vendor-invoice.service.ts`
- `src/modules/vendor-invoices/vendor-invoice.repository.ts`
- `src/database/migrations/0263_add_vendor_invoice_payment_status.ts`
- `tests/vendor-invoice-settlement-readiness.test.ts`
- `tests/vendor-invoice-payment.test.ts`
- OpenAPI schemas: `VendorSettlementReadinessStatus`, `VendorSettlementReason`, `VendorSettlementAction`, `VendorSettlementReadinessResult`

---

# 6. Package E — R2P traceability

## 6.1 Item classification

| Item | Status | Actual contract |
|---|---|---|
| Canonical Vendor Invoice R2P trace | **IMPLEMENTED** | Existing `GET /vendor-invoices/{id}/trace` returns typed documents, source/target relationships and current projections. |
| Trace document/relationship enums | **IMPLEMENTED** | Finite R2P-specific enums are published; unavailable numbers/statuses remain null. |
| Persistence graph | **NOT IMPLEMENTED by design** | Trace is rebuilt from existing FKs on every read; no graph/link table exists. |
| Optional material/service/SPK/BAST paths | **IMPLEMENTED** | Only records actually connected to the invoice chain are returned. |
| Generic Document DTO | **IMPLEMENTED separately** | Shared Document foundation remains unchanged and is not repurposed as an R2P graph. |
| Generic enterprise document navigation | **NOT IMPLEMENTED** | PART 06 is Vendor-Invoice-focused, not a generic document-management API. |
| OpenAPI | **IMPLEMENTED for R2P trace** | Trace DTO, enums, route, security and errors are published; unrelated generic Document routes remain outside this contract. |

## 6.2 Registered adjacent document contracts

| Routes | Response DTO | Permission | OpenAPI |
|---|---|---|---|
| `POST/GET /documents`; `GET/PATCH /documents/{id}`; `POST /documents/{id}/archive`; `POST /documents/{id}/restore` | `PublicDocument` / arrays | `document.read/manage/archive` | absent |
| `POST/GET /documents/{documentId}/versions`; `GET .../latest`; `GET .../{versionNumber}`; `GET /document-versions/{versionId}` | `PublicDocumentVersion` / arrays | `document.read/manage` | absent |
| `POST/GET /supporting-documents`; `GET /supporting-documents/{id}` | `PublicSupportingDocument` / arrays | `document.read/manage` | absent |
| `POST/GET /handover-documents`; `GET /handover-documents/{id}` | `PublicHandoverDocument` / arrays | `document.read/manage` | absent |
| `POST/GET /acceptance-sign-offs`; `GET /acceptance-sign-offs/{id}` | `PublicAcceptanceSignOff` / arrays | `document.read/manage` | absent |
| `POST/GET /bast-documents`; `GET /bast-documents/{id}`; submit/resubmit/decisions/reconciliation | `BastDocument` and lifecycle DTOs | `document.read/manage`, `bast.accept` | present |

`PublicDocument`:

```text
id, clientId, buildingId?, documentNumber, documentType,
contextType, sourceType?, sourceId?, title, description?, fileReference?,
status, expiryDate?, archivedAt?, archivedByUserId?, archiveReason?,
statusBeforeArchive?, createdByUserId, createdAt, updatedAt
```

`PublicSupportingDocument` is the closest current link DTO:

```text
id, documentId, parentType, parentId, clientId, buildingId?, contextType,
createdByUserId, createdAt, updatedAt, document: PublicDocument
```

Its exact `parentType` enum is:

```text
WORK_COMPLETION | BAST | HANDOVER | SIGN_OFF |
TENANT_COMPANY | VENDOR | DOCUMENT
```

It does **not** include `PURCHASE_ORDER`, `WORK_CONTRACT`, `WORK_ORDER`, or `VENDOR_INVOICE`.

Other exact enums:

- `DocumentStatus`: `DRAFT | ACTIVE | INACTIVE | ARCHIVED`
- `DocumentContextType`: `INTERNAL | TENANT | VENDOR`
- `DocumentSourceType`: `TENANT_COMPANY | VENDOR | INTERNAL`
- `HandoverStatus`: `DRAFT | HANDED_OVER`
- `SignOffDecision`: `ACCEPTED | REJECTED`
- `BastStatus`: `DRAFT | SUBMITTED | ACCEPTED | REJECTED`
- `documentType`: free string; no supported-type enum.

## 6.3 Canonical Vendor Invoice R2P trace

Endpoint:

```text
GET /api/v1/vendor-invoices/{id}/trace
permission: vendor_invoice.read
scope: invoice Building
response: VendorInvoiceTrace
```

The existing endpoint was expanded rather than creating a parallel `/r2p-trace` route. Existing flat compatibility fields remain, plus:

```text
documents[] {
  documentType,
  documentId,
  documentNumber?,
  status?
}
relationships[] {
  relationship,
  sourceDocumentType,
  sourceDocumentId,
  targetDocumentType,
  targetDocumentId
}
matching: InvoiceMatchingResult
settlementReadiness: VendorSettlementReadinessResult
generatedAt
```

Supported trace document types:

```text
PURCHASE_REQUEST | MATERIAL_REQUEST | SERVICE_REQUEST |
PROCUREMENT_APPROVAL | PURCHASE_ORDER | PURCHASE_ORDER_LINE |
WORK_CONTRACT | RECEIVING | WORK_ORDER | VENDOR_WORK |
COMPLETION_REPORT | SERVICE_REPORT | BAST | VENDOR_INVOICE |
INVOICE_MATCHING | INVOICE_VERIFICATION | PAYMENT_STATE |
SETTLEMENT_READINESS
```

Relationships are derived only from current identifiers/FKs: `SOURCE_OF`, `APPROVED_BY`, `COMMITTED_BY_LINE`, `BELONGS_TO`, `MANDATES`, `RECEIVED_AS`, `BOUND_TO`, `EXECUTED_AS`, `REPORTED_BY`, `ACCEPTED_BY`, `INVOICED_BY`, and `PROJECTS`.

Material path can include Purchase Request → Material Request → Approval → PO Line → PO → optional SPK → material Receiving → Invoice. Service path can include Purchase Request → Service Request → Approval → PO Line → PO → service Receiving → Invoice. Work Order/Vendor Work/report/BAST paths appear only from their existing invoice or binding references.

Matching, verification, payment and settlement-readiness nodes use the Vendor Invoice id because they are projections of that existing authority, not fabricated persisted documents. Partial/no payment uses `PAYMENT_STATE` status `PARTIALLY_PAID`/`UNPAID`; full payment uses `PAID` and settlement projection `SETTLED`.

A legacy unlinked invoice returns only its real invoice/operational references and projection nodes—no PO, SPK, request, line or Receiving node is fabricated. Missing optional SPK, report, Receiving, Work, or BAST records are omitted.

Additional reverse-filter reads remain available:

- `GET /vendor-invoices?purchaseOrderId=...&workContractId=...`
- `GET /work-contracts?purchaseOrderId=...`
- `GET /work-orders/{workOrderId}/procurement-bindings`
- `GET /purchase-orders/{id}/lines`

## 6.4 Errors, isolation, and known defect

The trace endpoint returns `VENDOR_INVOICE_NOT_FOUND` for an unknown invoice, `PERMISSION_DENIED` without `vendor_invoice.read`, and `BUILDING_ACCESS_DENIED` outside the invoice Building. Every secondary read is constrained to the root invoice Client/Building/Vendor chain before inclusion.

Document-family services apply Building access (and derive accessible Client scope through Building assignments for Client-only documents). Core link/document error codes include:

- Document: `DOCUMENT_NOT_FOUND`, `DOCUMENT_NUMBER_ALREADY_EXISTS`, `DOCUMENT_CONTEXT_INVALID`, `DOCUMENT_BUILDING_MISMATCH`, `DOCUMENT_SOURCE_NOT_FOUND`, `DOCUMENT_SOURCE_CLIENT_MISMATCH`, `DOCUMENT_UPDATE_NOT_ALLOWED`, `DOCUMENT_ALREADY_ARCHIVED`, `DOCUMENT_NOT_ARCHIVED`, `DOCUMENT_RESTORE_NOT_ALLOWED`
- Supporting links: `SUPPORTING_DOCUMENT_NOT_FOUND`, `SUPPORTING_DOCUMENT_PARENT_NOT_FOUND`, `SUPPORTING_DOCUMENT_CONTEXT_MISMATCH`, `SUPPORTING_DOCUMENT_BUILDING_MISMATCH`, `SUPPORTING_DOCUMENT_INVALID_PARENT`
- BAST: `BAST_NOT_FOUND`, `BAST_BUILDING_MISMATCH`, `BAST_NUMBER_ALREADY_EXISTS`, `BAST_ALREADY_EXISTS`, `BAST_INVALID_TRANSITION`, `BAST_NOT_READY`, `BAST_RECONCILIATION_REQUIRED`

**Known runtime blocker:** `docs/known-issues.md` records open `KI-002`: canonical BAST creation fails because the shared `documents.document_number` NOT NULL value is not supplied by that path. The BAST contract is registered/published, but creation is not currently reliable; frontend must not treat BAST create as unblocked.

Sources:

- `src/modules/documents/*`
- `src/modules/document-versions/*`
- `src/modules/supporting-documents/*`
- `src/modules/handover-documents/*`
- `src/modules/acceptance-sign-offs/*`
- `src/modules/bast-documents/*`
- R2P trace runtime: `src/modules/vendor-invoices/vendor-invoice.service.ts`, `vendor-invoice.types.ts`
- OpenAPI: `/vendor-invoices/{id}/trace`, `R2PTraceDocument*`, `R2PTraceRelationship*`, `VendorInvoiceTrace`; generic document-management routes remain separate

---

# 7. Missing backend contracts

These are current gaps, not inferred future designs:

| ID | Missing/inconsistent contract | Classification | Frontend impact |
|---|---|---|---|
| `F-01` | Work Order procurement-binding action projection | **NOT IMPLEMENTED by design** | `LINK_RECEIVING`/`BIND_WORK_CONTRACT` depend on caller-selected target IDs; no no-input authoritative action resolver exists, so frontend uses commands only in their owning workflows. |
| `F-03` | Vendor-principal isolation | **NOT IMPLEMENTED** | Current authorization is permission + Building scope, not “this authenticated Vendor only.” |
| `D-01` | Settlement entity/accounting lifecycle | **NOT IMPLEMENTED by design** | SETTLED is derived from existing payment state; no parallel settlement row or command is needed. |
| `D-03` | Payment transaction list/receipt contract for vendor AP | **NOT IMPLEMENTED** | Existing cumulative payment mutation, row lock, history, event, and duplicate protection remain; there is no separate payment resource. |
| `E-04` | Generic document routes/schemas in OpenAPI | **NOT IMPLEMENTED in spec** | Runtime-only routes are unsuitable for generated clients. |
| `E-05` | Reliable canonical BAST creation (`KI-002`) | **BROKEN IMPLEMENTATION** | BAST creation is blocked despite a registered contract. |

Also superseded by current code: older audit/review text that states “no Purchase Order” or “no SPK” predates the current R2P implementation and must not be used by `CR-FE-R2P-01` as current authority.

---

# 8. Exact frontend-unblocking artifacts

Available now:

1. **This handoff:** `docs/frontend-r2p-contract-handoff.md` — human-readable current inventory and gap ledger.
2. **Machine-readable implemented contract:** `docs/api/openapi.yaml` for:
   - Purchase Orders and PO Lines;
   - Work Contracts/SPK;
   - Work Order procurement binding;
   - Vendor Invoice create/read/finalize/cancel/verify/matching/payment/readiness/consistency/trace;
   - canonical BAST.
3. **Runtime DTO source of truth where OpenAPI is missing/drifting:**
   - `src/modules/purchase-orders/*.types.ts`
   - `src/modules/work-contracts/work-contract.types.ts`
   - `src/modules/work-order-procurement-bindings/work-order-procurement-binding.types.ts`
   - `src/modules/vendor-invoices/vendor-invoice.types.ts`
   - document-family `*.types.ts` files listed in Package E.
4. **Contract verification evidence:**
   - `tests/r2p-openapi-contract.test.ts`
   - focused Package A–D tests listed above.

Not available and therefore not frontend-unblocking:

- a generated SDK/client;
- OpenAPI for generic Document/Supporting/Handover/Sign-Off routes;
- a settle command;
- a generic enterprise-wide document graph outside the focused Vendor Invoice trace;
- reliable BAST creation while `KI-002` remains open.

## Frontend R2P consumption guide

| Stage | Authoritative read | Authoritative state/reasons | Authoritative actions/command |
|---|---|---|---|
| Request / approval / PO readiness | procurement request endpoints; `/procurement-approvals/{id}/available-actions`; `/po-readiness` reads | request/approval status and `READY|NOT_READY|BLOCKED` readiness checks | approval actions from backend; create PO only after backend READY |
| Purchase Order | `/purchase-orders/{id}`, `/issue-readiness`, `/available-actions` | `DRAFT|ISSUED|CANCELLED`; issue blockers | `ISSUE`, `CANCEL`; invoke existing issue/cancel commands only when returned |
| PO Lines | `/purchase-orders/{id}/lines` | parent PO state; MR/SR remains quantity authority | mutate lines only through DRAFT-parent endpoints; no inferred quantity math |
| SPK | `/work-contracts/{id}`, `/available-actions` | `DRAFT|ACTIVE|COMPLETED|CANCELLED` | `ACTIVATE`, `COMPLETE`, `CANCEL` only when returned |
| Receiving/evidence | request Receiving endpoints; completion/service/BAST reads | Receiving/report/BAST owning statuses | no R2P aggregate action inference |
| Vendor Invoice | `/vendor-invoices/{id}`, `/available-actions` | invoice, verification, matching and readiness fields | `FINALIZE`, `CANCEL`, `VERIFY`, `RECORD_PAYMENT` only when returned |
| Matching | `/vendor-invoices/{id}/matching` | `MATCHED|MISMATCH|NOT_READY`, mismatch/not-ready reasons | no command inferred; VERIFY comes from invoice actions |
| Verification | Vendor Invoice + verify result | `PENDING|VERIFIED|DISCREPANCY`; NOT_READY is 409 | invoke verify only when `VERIFY` is returned |
| Payment readiness | `/vendor-invoices/{id}/settlement-readiness` | `READY|NOT_READY|SETTLED`, reasons and matching reasons | `RECORD_PAYMENT` only when READY |
| Payment | Vendor Invoice payment fields | `UNPAID|PARTIALLY_PAID|PAID`, paid/outstanding amounts | existing `/payment` command only |
| Trace | `/vendor-invoices/{id}/trace` | typed documents/relationships plus matching/readiness projections | navigation only; no workflow authority |

Frontend consumption rules:

- use response envelopes exactly; branch on stable `error.code` and structured `details`, never parse human messages;
- render `NOT_READY` from readiness reasons and `MISMATCH` from `mismatchCodes`; do not collapse them into a client-calculated status;
- scope all user-visible R2P reads to backend results—never broaden by Client/Vendor locally;
- use the PO/SPK available-actions endpoints; an empty list is authoritative;
- treat only the published upper-case tokens as actions: PO `ISSUE|CANCEL`, SPK `ACTIVATE|COMPLETE|CANCEL`, and Vendor Invoice `FINALIZE|CANCEL|VERIFY|RECORD_PAYMENT`; map each only to its documented existing command;
- treat an empty `availableActions` array as authoritative; do not derive commands from statuses;
- submit optional PO/SPK invoice linkage to the backend gate: only ISSUED PO and ACTIVE/COMPLETED SPK states are eligible;
- treat `purchaseOrderId` and `workContractId` as immutable nullable response fields;
- invoke the existing payment endpoint only when readiness advertises `RECORD_PAYMENT`;
- consume `InvoiceMatchingResult.status` and `verificationEligible`; never calculate PO amount, MR/SR receiving, completion, or BAST readiness in frontend;
- use `GET /vendor-invoices/{id}/trace` documents/relationships for R2P navigation; never synthesize missing optional nodes or a client-side document graph;
- treat linkage fields as nullable IDs, not URLs or embedded linked documents.

---

# 9. PART 01–07 completion and remaining recommended work

Completed by CR-BE-R2P-CONTRACT-01 PART 01:

- established the existing platform action shape for PO/SPK: resource ID + `state` + typed upper-case `availableActions`;
- mapped actions only to existing permissioned commands and filtered them by caller manage permission and command preconditions;
- published exact permission and Building-scope metadata for documented Package A–D operations;
- normalized reusable 403 documentation for `PERMISSION_DENIED` and `BUILDING_ACCESS_DENIED`;
- confirmed Vendor PIC/external workforce foundations do not provide an authenticated Vendor principal and left that gap BLOCKED.

Completed by CR-BE-R2P-CONTRACT-01 PART 02:

- confirmed DRAFT may ISSUE only when issue-readiness passes and may CANCEL without adding another gate;
- confirmed ISSUED and CANCELLED are terminal for current API commands and aligned the transition helper/OpenAPI/tests;
- kept `availableActions` derived from those exact commands;
- published the actual compact PO Line DELETE acknowledgement and exact errors;
- retained the existing DRAFT-only line mutation and MR/SR quantity authority.

Completed by CR-BE-R2P-CONTRACT-01 PART 03:

- retained the existing optional invoice→ISSUED PO→optional SPK identifiers and DB scope FKs;
- enforced ACTIVE/COMPLETED eligibility for optional SPK linkage with a deterministic 409 error;
- preserved PO `ISSUED` eligibility and added explicit lifecycle/error contract coverage;
- kept PO/SPK references immutable and required-as-nullable on Vendor Invoice responses;
- published the existing DRAFT-only Vendor Invoice PATCH path and DTO;
- added no available action, matching, settlement, payment, quantity, or accounting authority.

Completed by CR-BE-R2P-CONTRACT-01 PART 04:

- replaced parallel boolean inference with one canonical MATCHED/MISMATCH/NOT_READY result while retaining compatibility fields;
- added conditional PO/SPK, committed amount/currency, MR/SR receiving, and existing completion/BAST checks;
- made verification consume that exact result and reject NOT_READY without mutation;
- preserved unlinked legacy verification, immutable linkage, payment behavior, and MR/SR quantity authority;
- isolated missing required BAST as NOT_READY, including when KI-002 prevents reliable BAST creation;
- published matching statuses, reasons, checks, verification outcomes, and 409 error in OpenAPI.

Completed by CR-BE-R2P-CONTRACT-01 PART 05:

- replaced READY/NOT_READY/BLOCKED with canonical READY/NOT_READY/SETTLED payment eligibility;
- derived SETTLED from existing PAID/paidAmount/generated outstandingAmount authority;
- made the existing payment command consume the same readiness evaluator;
- preserved partial payment, row locking, cumulative cap, duplicate-full-payment rejection, history, and event behavior;
- replaced non-executable lower-case `settle` with `RECORD_PAYMENT`, mapped to the existing endpoint;
- added no settlement row, payment ledger, accounting, tax, bank, or gateway behavior.

Completed by CR-BE-R2P-CONTRACT-01 PART 06:

- expanded the existing Vendor Invoice trace endpoint instead of adding a parallel route;
- added typed R2P documents and source/target relationships derived from existing FKs;
- covered material and service request/approval/PO Line/Receiving paths plus optional SPK, Work, report, and BAST nodes;
- embedded current matching, verification, payment, and settlement-readiness projections;
- preserved flat compatibility fields, Building isolation, legacy unlinked behavior, and missing optional paths;
- added no graph table, workflow, lifecycle, accounting, payment, or BAST mutation.

Completed by CR-BE-R2P-CONTRACT-01 PART 07:

- added caller- and permission-specific Vendor Invoice FINALIZE/CANCEL/VERIFY/RECORD_PAYMENT actions;
- made action visibility consume existing lifecycle, matching, verification and payment-readiness authorities;
- kept empty actions authoritative for read-only callers, NOT_READY states and terminal invoices;
- published all supported R2P action/readiness/trace contracts and exact permissions in OpenAPI;
- added the concise frontend endpoint/status/action/error consumption guide above;
- added no frontend, workflow engine, binding action inference, or business lifecycle.

Remaining work, subject to its own authorized scope:

1. **Contract publication alignment**
   - add tests comparing remaining registered R2P routes and success DTOs not yet pinned.

2. **BAST defect repair**
   - resolve `KI-002` in a BAST-scoped change and rerun the three documented BAST suites before exposing BAST create to frontend.

3. **Vendor-principal scope, only if CR-FE is a Vendor portal**
   - first govern the authenticated Vendor identity source and then constrain reads/commands to it; current Building + permission scope must not be presented as vendor-self scope.

---

## Verification performed

START GOVERNANCE inspected registered routes/controllers/types/validation/services/repositories/migrations for Packages A–E and parsed the relevant OpenAPI paths/schemas.

PART 01 validation:

- `npx tsc --noEmit` — passed.
- `tests/openapi-contract.test.ts` + `tests/r2p-openapi-contract.test.ts` — **20 passed, 0 failed**.
- `tests/purchase-order-issuance.test.ts` + `tests/work-contracts.test.ts` against isolated PostgreSQL — **44 passed, 0 failed, 0 skipped**.
- PO header/line, Work Order SPK binding, Vendor Invoice PO/SPK linkage, and general Building-isolation regression suites against isolated PostgreSQL — **85 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

PART 02 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **22 passed, 0 failed**.
- PO lifecycle, issuance, line, readiness, available-actions, procurement approval, Work Order procurement binding, and Building-isolation regressions against isolated PostgreSQL — **127 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

PART 03 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **23 passed, 0 failed**.
- Vendor Invoice CRUD/linkage/verification/payment, PO/SPK lifecycle, procurement binding/approval, and Building-isolation regressions against isolated PostgreSQL — **182 passed, 0 failed, 0 skipped**.
- Additional out-of-scope consistency/settlement diagnostic suites remained non-green due to existing consistency/readiness assertions and open `KI-002`; PART 03 did not modify those domains.
- `git diff --check` — passed.

PART 04 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **24 passed, 0 failed**.
- Canonical matching/linkage/verification suites against isolated PostgreSQL — **44 passed, 0 failed, 0 skipped**.
- Payment, PO issuance/lines, MR approved-quantity, Receiving binding, SPK lifecycle, and Building-isolation regressions against isolated PostgreSQL — **126 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

PART 05 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **25 passed, 0 failed**.
- Canonical settlement-readiness and payment suites against isolated PostgreSQL — **47 passed, 0 failed, 0 skipped**.
- Current matching/verification/linkage regressions — **44 passed, 0 failed, 0 skipped**.
- PO/SPK lifecycle and Building-isolation regressions — **60 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

PART 06 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **26 passed, 0 failed**.
- Material/service/legacy/SPK/BAST trace plus settlement projection suites — **41 passed, 0 failed, 0 skipped**.
- Existing PART 01–05 matching, verification, payment, PO/SPK lifecycle and Building-isolation regressions — **152 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

PART 07 validation:

- `npx tsc --noEmit` — passed.
- OpenAPI and R2P contract suites — **27 passed, 0 failed**.
- Permission-aware Vendor Invoice/PO/SPK action, readiness, matching, payment, trace and Building-isolation regressions — **154 passed, 0 failed, 0 skipped**.
- `git diff --check` — passed.

FINAL REVIEW validation:

- `npm run typecheck` — passed.
- OpenAPI foundation, material-chain, and R2P contract suites — **37 passed, 0 failed, 0 skipped**.
- End-to-end Request/approval, PO/readiness/lines, SPK/binding, material/service Receiving, Work/Vendor Work/report/BAST, Vendor Invoice linkage/matching/verification/readiness/payment/trace/action, permission, legacy, and Client/Building-isolation regression set against isolated PostgreSQL — **504 passed, 0 failed, 0 skipped**.
- Canonical BAST foundation/lifecycle/legacy compatibility and Work Order BAST closure are included in that passing set. R2P BAST matching tests use explicit valid document fixtures and do not alter the open `KI-002` production create path.
- `git diff --check` — passed.

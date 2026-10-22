# CR-HM-FIELD-AUTHORITY-01 — Cross-Persona Mobile & Operations API Handoff

- **Repository**: `budiirmawan/Handyman-Backend`
- **Base URL Prefix**: `/api/v1`
- **Authentication**: All endpoints require `Authorization: Bearer <accessToken>`.
- **Standard Envelope**:
  - Success: `{ "success": true, "data": { ... }, "meta": { "requestId": "..." } }`
  - Error: `{ "success": false, "error": { "code": "...", "message": "...", "details": [] }, "meta": { "requestId": "..." } }`

---

## 1. P0-A — Assigned Worker Read Authority

Scoped read endpoints for assigned `PIC_PEKERJAAN` (Crew Lead) and `INSPECTOR` personas without requiring privileged `tenant_company.read` RBAC permissions, while enforcing a strict commercial firewall (no internal cost basis, margin %, reference rate, BM fee rules, commercial agreement IDs, or customer invoice/ledger balances).

### 1.1 Read Assigned Execution Scope Detail
- **Endpoint**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId`
- **Authorized Personas**:
  - Assigned `PIC_PEKERJAAN` (active crew lead for `:executionScopeId`)
  - Assigned `INSPECTOR` (inspector with `CONFIRMED`, `IN_PROGRESS`, or `COMPLETED` inspection appointment on the parent `handymanRequestId`)
- **Forbidden (`403`)**:
  - Unassigned worker or helper in the same building (`HANDYMAN_FIELD_READ_FORBIDDEN`)
  - Cross-building / cross-tenant user (`BUILDING_ACCESS_DENIED`)
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "data": {
    "viewerRole": "PIC_PEKERJAAN",
    "executionScope": {
      "id": "uuid",
      "clientId": "uuid",
      "tenantCompanyId": "uuid",
      "buildingId": "uuid",
      "handymanRequestId": "uuid",
      "quotationId": "uuid",
      "approvedQuotationVersionId": "uuid",
      "approvalDecisionId": "uuid",
      "status": "IN_PROGRESS",
      "authorizedAt": "2026-10-14T00:00:00.000Z"
    },
    "request": {
      "id": "uuid",
      "requestCode": "HM-REQ-001",
      "title": "Fix leaking pantry pipe",
      "description": "Water dripping under sink",
      "requestedWorkCategory": "PLUMBING",
      "priority": "HIGH",
      "status": "IN_EXECUTION",
      "locationDescription": "Floor 12 Pantry"
    },
    "activeAssignment": {
      "assignmentId": "uuid",
      "crewId": "uuid",
      "crewCode": "CRW-01",
      "crewName": "Crew Alpha",
      "providerContextId": "uuid",
      "assignmentSeq": 1,
      "status": "ACTIVE",
      "assignedAt": "2026-10-14T00:00:00.000Z",
      "isViewerCrewLead": true
    },
    "arrivalVerification": {
      "id": "uuid",
      "method": "QR",
      "verifiedAt": "2026-10-14T01:00:00.000Z"
    },
    "workSessions": [
      {
        "id": "uuid",
        "assignmentId": "uuid",
        "leadWorkerId": "uuid",
        "leadUserId": "uuid",
        "status": "IN_PROGRESS",
        "checkedInAt": "2026-10-14T01:05:00.000Z",
        "startedWorkAt": "2026-10-14T01:10:00.000Z",
        "completedAt": null,
        "checkedOutAt": null
      }
    ]
  }
}
```

### 1.2 Read Assigned Service Request / Inspection Detail
- **Endpoint**: `GET /api/v1/handyman/field/requests/:handymanRequestId`
- **Authorized Personas**: Assigned `PIC_PEKERJAAN` or Assigned `INSPECTOR`
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "data": {
    "viewerRole": "INSPECTOR",
    "request": {
      "id": "uuid",
      "clientId": "uuid",
      "tenantCompanyId": "uuid",
      "propertyId": "uuid",
      "buildingId": "uuid",
      "requestCode": "HM-REQ-001",
      "title": "Fix leaking pantry pipe",
      "description": "Water dripping under sink",
      "requestedWorkCategory": "PLUMBING",
      "priority": "HIGH",
      "status": "INSPECTED"
    },
    "inspectionVisits": [
      {
        "id": "uuid",
        "kind": "INSPECTION",
        "state": "IN_PROGRESS",
        "resourceType": "INSPECTOR_USER",
        "resourceId": "uuid",
        "scheduledStart": "2026-10-14T01:00:00.000Z",
        "scheduledEnd": "2026-10-14T02:00:00.000Z"
      }
    ],
    "diagnosis": {
      "id": "uuid",
      "rootCauseCategory": "WEAR_AND_TEAR",
      "technicalSummary": "Corroded elbow joint",
      "recommendedAction": "Replace brass elbow and seal"
    },
    "executionScope": {
      "id": "uuid",
      "quotationId": "uuid",
      "approvedQuotationVersionId": "uuid",
      "status": "IN_PROGRESS",
      "authorizedAt": "2026-10-14T02:30:00.000Z"
    }
  }
}
```

### 1.3 Read Approved Quotation & Original Execution-Scope Snapshot (Commercial-Sanitized)
- **Endpoint**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/quotation-snapshot`
- **Authorized Personas**: Assigned `PIC_PEKERJAAN` or Assigned `INSPECTOR`
- **Response (`200 OK`)**: Returns immutable original approved scope lines (`id`, `lineNumber`, `lineType`, `sourceItemId`, `description`, `quantity`, `uomId`, `uomCode`, `uomName`, `uomSymbol`) with all pricing/margin/subtotal columns stripped.

### 1.4 Read Assigned Execution Scope Operational Material Lines
- **Endpoint**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/materials`
- **Authorized Personas**: Assigned `PIC_PEKERJAAN` or Assigned `INSPECTOR`
- **Response (`200 OK`)**: Returns physical material execution lines (`id`, `sourceQuotationLineId`, `sourceItemId`, `description`, `uomId`, `uomCode`, `estimatedQuantity`, `approvedQuantity`, `issuedQuantity`, `purchasedQuantity`, `usedQuantity`, `returnedQuantity`, `status`, `supplierReference`).

---

## 2. P0-B — Pekerjaan Tambah / Kurang (ADD / REDUCE)

Governed lifecycle:
`FIELD_FINDING → PROPOSAL → OPERATIONS_REVIEW → REVISED_QUOTATION → TENANT_DECISION → AUTHORIZED_SCOPE → EXECUTION → QC → FINAL_CHARGE_ELIGIBILITY`

### 2.1 List Variations & Effective Scope Summary
- **Endpoint**: `GET /api/v1/handyman/execution-scopes/:executionScopeId/variations`
- **Alias (Mobile Field)**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/variations`
- **Authorized Personas**: Assigned `PIC_PEKERJAAN`, Assigned `INSPECTOR`, or Operations/Customer Care (`tenant_company.read` / `tenant_company.manage`). Note: commercial fields (`quotedUnitAmount`, `quotedTotalDelta`, `currency`) are stripped when read by `PIC_PEKERJAAN` or `INSPECTOR`.
- **Response (`200 OK`)**:
```json
{
  "success": true,
  "data": {
    "viewerRole": "PIC_PEKERJAAN",
    "originalApprovedLines": [
      {
        "id": "uuid",
        "lineNumber": 1,
        "lineType": "LABOR",
        "description": "Pipe replacement labor",
        "originalApprovedQuantity": "4.000",
        "authorizedAddedQuantity": "0.000",
        "authorizedReducedQuantity": "1.000",
        "effectiveAuthorizedQuantity": "3.000",
        "uomId": "uuid",
        "uomCode": "HR"
      }
    ],
    "authorizedAddVariations": [],
    "variations": [
      {
        "id": "uuid",
        "executionScopeId": "uuid",
        "variationType": "REDUCE",
        "lineType": "LABOR",
        "targetQuotationLineId": "uuid",
        "revisedQuotationVersionId": "uuid",
        "title": "Reduce 1 hr labor",
        "description": "Ceiling access panel already open",
        "technicalFinding": "No demolition needed",
        "quantity": "1.000",
        "uomId": "uuid",
        "status": "AUTHORIZED_SCOPE",
        "tenantDecisionOutcome": "APPROVED",
        "qcOutcome": null,
        "finalChargeEligible": false,
        "invoiced": false,
        "originActorUserId": "uuid",
        "originActorRole": "PIC_PEKERJAAN",
        "latestEvidenceReference": "hm-ev://uuid",
        "version": 5
      }
    ]
  }
}
```

### 2.2 Read Single Variation & Audit Event Trail
- **Endpoint**: `GET /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId`
- **Alias (Mobile Field)**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/variations/:variationId`

### 2.3 Inspector Submits Technical Finding (`FIELD_FINDING`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/findings`
- **Alias**: `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/variations/findings`
- **Authorized Persona**: Assigned `INSPECTOR` or assigned `PIC_PEKERJAAN` (unassigned actors are rejected with `403 HANDYMAN_VARIATION_ROLE_FORBIDDEN`).
- **Payload**:
```json
{
  "variationType": "ADD",
  "lineType": "MATERIAL",
  "targetQuotationLineId": null,
  "title": "Hidden valve corrosion",
  "description": "Recommend adding 2 brass shutoff valves",
  "technicalFinding": "Sub-wall isolation valves seized",
  "quantity": 2,
  "uomId": "uuid",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Inspector finding photo attached",
  "idempotencyKey": "var-find-001"
}
```

### 2.4 PIC Pekerjaan Submits Proposal (`PROPOSAL`)
- **Direct Proposal Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/proposals` (or `/handyman/field/...`)
- **Promote Finding to Proposal Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/propose` (or `/handyman/field/...`)
- **Authorized Persona**: Assigned `PIC_PEKERJAAN` only (`INSPECTOR` is rejected with `403 HANDYMAN_VARIATION_ROLE_FORBIDDEN`).
- **Direct Proposal Payload**: Same as 2.3 (for `REDUCE`, `targetQuotationLineId` is required and `quantity` cannot exceed remaining approved line quantity).
- **Promote Finding Payload**:
```json
{
  "description": "PIC confirms 2 brass valves needed",
  "quantity": 2,
  "evidenceReference": "hm-ev://uuid",
  "notes": "Ready for ops review",
  "expectedVersion": 1,
  "idempotencyKey": "var-prop-001"
}
```

### 2.5 Operations Reviews Variation (`OPERATIONS_REVIEW`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/operations-review`
- **Authorized Persona**: Operations (`tenant_company.manage`)
- **Payload**: `{ "evidenceReference": "hm-ev://uuid", "notes": "Reviewed scope impact", "expectedVersion": 1, "idempotencyKey": "var-ops-001" }`

### 2.6 Operations Issues Revised Quotation (`REVISED_QUOTATION`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/revised-quotation`
- **Authorized Persona**: Operations (`tenant_company.manage`)
- **Commercial Invariant**: `revisedQuotationVersionId` is **required**, must belong to the same quotation thread with `version_number > originalVersionNumber`, must be in `ISSUED` or `APPROVED` status, cannot reuse `approvedQuotationVersionId` (`409 HANDYMAN_VARIATION_ILLEGAL_TRANSITION`), and its `handyman_quotation_lines` total delta must reconcile with the variation's `quotedTotalDelta`.
- **Payload**:
```json
{
  "revisedQuotationVersionId": "uuid",
  "quotedUnitAmount": 150000,
  "currency": "IDR",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Issued revised quotation v2",
  "expectedVersion": 2,
  "idempotencyKey": "var-revq-001"
}
```

### 2.7 Tenant Records Decision (`TENANT_DECISION`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/tenant-decision`
- **Authorized Persona**: Authorized `TENANT_PIC` for the Work Order's `tenantCompanyId` only. Operations Managers, PIC Pekerjaan, and Inspectors are strictly rejected (`403 HANDYMAN_VARIATION_TENANT_IMPERSONATION_FORBIDDEN`).
- **Payload**:
```json
{
  "decision": "APPROVED",
  "revisedQuotationVersionId": "uuid",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Approved by tenant PIC",
  "expectedVersion": 3,
  "idempotencyKey": "var-tdec-001"
}
```
- **Outcome**:
  - Verifies that the variation is bound to a distinct, valid revised quotation version (`revisedQuotationVersionId !== approvedQuotationVersionId`) before recording `TENANT_DECISION`, after which `/authorize-scope` transitions `APPROVED` variations to `AUTHORIZED_SCOPE`.
  - If `decision === "REJECTED"`, status remains `TENANT_DECISION` with `tenantDecisionOutcome: "REJECTED"` (terminal; cannot be authorized or executed).

### 2.8 PIC Pekerjaan Records Execution of Authorized Variation (`EXECUTION`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/execution`
- **Alias**: `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/variations/:variationId/execution`
- **Authorized Persona**: Assigned `PIC_PEKERJAAN`
- **Payload**: `{ "evidenceReference": "hm-ev://uuid", "notes": "Installed 2 valves", "expectedVersion": 4, "idempotencyKey": "var-exec-001" }`

### 2.9 Supervisor / Operations Records QC Verification (`QC`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/qc`
- **Alias**: `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/variations/:variationId/qc`
- **Authorized Persona**: Authorized Supervisor / Operations (`tenant_company.manage`) only. Field `INSPECTOR` technical inspection authority and `PIC_PEKERJAAN` execution authority cannot bypass Supervisor QC authority (`403 HANDYMAN_VARIATION_ROLE_FORBIDDEN`).
- **Authoritative QC Linkage**: `qcRunId` is **required** and verified against `handyman_qc_runs` (`status === qcOutcome`, `FINISH` event recorded for `PASSED`, no `DEFECT`/`NOT_CHECKED` items, and zero unverified `handyman_defect_records` on the execution scope). Variation QC cannot substitute for an authoritative QC artifact without explicit verified linkage.
- **Payload**: `{ "qcOutcome": "PASSED", "qcRunId": "uuid", "evidenceReference": "hm-ev://uuid", "notes": "Pressure tested OK", "expectedVersion": 5, "idempotencyKey": "var-qc-001" }`

### 2.10 Operations Marks Final Charge Eligibility (`FINAL_CHARGE_ELIGIBILITY`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/variations/:variationId/final-charge-eligibility`
- **Authorized Persona**: Operations (`tenant_company.manage`)
- **Payload**: `{ "qcRunId": "uuid", "bastId": "uuid", "evidenceReference": "hm-ev://uuid", "notes": "Eligible for final settlement", "expectedVersion": 6, "idempotencyKey": "var-fce-001" }`
- **Admission & Financial Guards**:
  1. Verifies authoritative `handyman_qc_runs` (`PASSED` + `FINISH` event) and zero unverified `handyman_defect_records` or open/failed QC runs on the execution scope.
  2. Verifies operational closure: no active/in-progress `handyman_work_sessions` (`CHECKED_IN`, `IN_PROGRESS`, `PAUSED`, `MATERIAL_RUN`).
  3. Verifies an authoritative `ACCEPTED` BAST in `handyman_bast_documents` with customer acceptance sign-off in `handyman_bast_sign_offs`.
  4. Verifies original scope / variation charge reconciliation and that no other authorized variation on the execution scope remains incomplete or failed QC.
  5. Verifies duplicate invoice / post-finalization protection: fails closed (`409 HANDYMAN_VARIATION_ILLEGAL_TRANSITION`) if a `FINALIZED` invoice already exists in `tenant_invoices` for the execution scope, and keeps `invoiced: false` (never auto-adds to an invoice).

---

## 3. P0-C — Material & Purchasing Lifecycle

Governed lifecycle:
`REQUEST → APPROVAL → ISSUED | PURCHASED → USAGE → RETURN → RECONCILIATION`

Preserves 4-way separation between:
1. Operational material movement (`requestedQuantity`, `approvedQuantity`, `issuedQuantity`, `purchasedQuantity`, `usedQuantity`, `returnedQuantity`)
2. Actual supplier purchasing expense (`supplierName`, `purchaseReference`, `actualUnitPrice`, `actualTotalExpenseAmount`, `netUsedExpenseAmount`, `currency`, `purchaseDate`, `expenditureReference`, `receiptEvidenceReference`)
3. Worker advance / reimbursement payable (`fundingSource`, `cashAdvanceReference`, `reimbursementPayableAmount`, `reimbursementPayeeUserId`, `reimbursementStatus`)
4. Tenant invoice charge eligibility (`tenantChargeEligible`, `tenantChargeEligibleQty`, `tenantInvoiced: false`)

### 3.1 List Material Purchasing Records & Ledger Summary
- **Endpoint**: `GET /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases`
- **Alias (Mobile Field)**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases`
- **Authorized Personas**: Assigned `PIC_PEKERJAAN` (sees operational + own purchasing/reimbursement details), Assigned `INSPECTOR` (sees operational movement quantities only; all price/expense/reimbursement fields are `null`), or Operations (`tenant_company.read` / `tenant_company.manage`).

### 3.2 Read Single Material Purchase Record & Audit Event Trail
- **Endpoint**: `GET /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId`
- **Alias (Mobile Field)**: `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases/:recordId`

### 3.3 PIC Pekerjaan Requests Material (`REQUEST`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/requests` (or `/handyman/field/...`)
- **Authorized Persona**: Assigned `PIC_PEKERJAAN`
- **Payload**:
```json
{
  "materialExecutionLineId": "uuid",
  "sourceItemId": null,
  "itemName": "Brass Ball Valve 1/2 inch",
  "uomId": "uuid",
  "uomCode": "PCS",
  "requestedQuantity": 4,
  "fundingSource": "REIMBURSEMENT",
  "currency": "IDR",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Urgent replacement valves",
  "idempotencyKey": "mat-req-001"
}
```
- **Allowed `fundingSource` values**: `'PETTY_CASH' | 'CASH_ADVANCE' | 'REIMBURSEMENT' | 'COMPANY_DIRECT' | 'WAREHOUSE_STOCK'`

### 3.4 Operations Approves Material Request (`APPROVAL`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/approve`
- **Authorized Persona**: Operations (`tenant_company.manage`)
- **Payload**:
```json
{
  "approvedQuantity": 4,
  "approvedMaxUnitPrice": 90000,
  "approvalReference": "APR-MAT-2026-001",
  "cashAdvanceReference": null,
  "evidenceReference": "hm-ev://uuid",
  "notes": "Approved for local supplier purchase",
  "expectedVersion": 1,
  "idempotencyKey": "mat-apr-001"
}
```

### 3.5 Operations Issues Warehouse Stock (`ISSUED`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/issue`
- **Authorized Persona**: Assigned `PIC_PEKERJAAN` or Operations (`tenant_company.manage`)
- **Payload**: `{ "issuedQuantity": 4, "evidenceReference": "hm-ev://uuid", "notes": "Issued from central store", "expectedVersion": 2, "idempotencyKey": "mat-iss-001" }`

### 3.6 PIC Pekerjaan / Operations Records Supplier Purchase (`PURCHASED`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/purchase` (or `/handyman/field/...`)
- **Authorized Persona**: Assigned `PIC_PEKERJAAN` or Operations (`tenant_company.manage`)
- **Payload**:
```json
{
  "purchasedQuantity": 4,
  "actualUnitPrice": 85000,
  "currency": "IDR",
  "supplierName": "Toko Besi Sentosa",
  "supplierReference": "SUP-TBS-01",
  "purchaseReference": "INV-TBS-2026-889",
  "purchaseDate": "2026-10-14T03:00:00.000Z",
  "expenditureReference": "EXP-2026-004",
  "cashAdvanceReference": null,
  "receiptEvidenceReference": "hm-ev://uuid",
  "notes": "Purchased 4 brass valves with official receipt",
  "expectedVersion": 2,
  "idempotencyKey": "mat-pur-001"
}
```

### 3.7 PIC Pekerjaan Records Actual Material Usage (`USAGE`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/usage` (or `/handyman/field/...`)
- **Authorized Persona**: Assigned `PIC_PEKERJAAN`
- **Payload**: `{ "usedQuantity": 3, "evidenceReference": "hm-ev://uuid", "notes": "Installed 3 valves on floor 12", "expectedVersion": 3, "idempotencyKey": "mat-use-001" }`

### 3.8 PIC Pekerjaan / Operations Records Unused Material Return (`RETURN`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/return` (or `/handyman/field/...`)
- **Authorized Persona**: Assigned `PIC_PEKERJAAN` or Operations (`tenant_company.manage`)
- **Payload**:
```json
{
  "returnedQuantity": 1,
  "returnDestination": "WAREHOUSE",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Returned 1 unused valve to building store",
  "expectedVersion": 4,
  "idempotencyKey": "mat-ret-001"
}
```
- **Allowed `returnDestination` values**: `'WAREHOUSE' | 'SUPPLIER_RETURN' | 'COMPANY_CUSTODY'`

### 3.9 Operations Reconciles Material & Purchasing Ledger (`RECONCILIATION`)
- **Endpoint**: `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:recordId/reconcile`
- **Authorized Persona**: Operations (`tenant_company.manage`)
- **Guard**: Requires `usedQuantity + returnedQuantity === issuedQuantity + purchasedQuantity`.
- **Payload**:
```json
{
  "tenantChargeEligible": true,
  "expenditureReference": "EXP-FIN-2026-004",
  "evidenceReference": "hm-ev://uuid",
  "notes": "Reconciled receipt and warehouse return",
  "expectedVersion": 5,
  "idempotencyKey": "mat-rec-001"
}
```

---

## 4. P0-D — Genuine Binary Field Evidence Upload

Enforces real binary byte upload, magic-byte content signature validation (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`, max `15 MB`), SHA-256 digest calculation, storage verification, and safe attachment reference generation (`hm-ev://<evidenceId>`). Metadata-only records without verified bytes in storage are rejected (`400` / `409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED`).

### 4.1 Flow A — Direct Multipart Binary Upload
- **Endpoints**:
  - `POST /api/v1/handyman/field/evidence/upload`
  - `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/evidence/upload`
  - `POST /api/v1/handyman/field/requests/:handymanRequestId/evidence/upload`
- **Content-Type**: `multipart/form-data`
- **Form Fields**:
  - `file` (required binary file part)
  - `purpose` (required): `'VARIATION_FINDING' | 'MATERIAL_RECEIPT' | 'INSPECTION_EVIDENCE' | 'BEFORE_AFTER_WORK' | 'QC_EVIDENCE'`
  - `idempotencyKey` (required string, 1..128 chars)
  - `executionScopeId` (UUID, optional if passed in URL)
  - `handymanRequestId` (UUID, optional if passed in URL or derived from `executionScopeId`)
  - `variationId` (UUID, optional — automatically binds `latest_evidence_reference` on `handyman_scope_variations`)
  - `materialPurchaseRecordId` (UUID, optional — automatically binds `receipt_evidence_reference` and `latest_evidence_reference` on `handyman_material_purchase_records`)
  - `mimeType` (optional override; validated against actual binary magic bytes)
  - `originalFileName` (optional string)
  - `notes` (optional string)
- **Response (`201 Created` or `200 OK` on idempotent replay)**:
```json
{
  "success": true,
  "data": {
    "replayed": false,
    "evidence": {
      "id": "uuid",
      "clientId": "uuid",
      "tenantCompanyId": "uuid",
      "buildingId": "uuid",
      "handymanRequestId": "uuid",
      "executionScopeId": "uuid",
      "variationId": null,
      "materialPurchaseRecordId": "uuid",
      "purpose": "MATERIAL_RECEIPT",
      "uploadStatus": "VERIFIED",
      "uploadCompleted": true,
      "originalFileName": "supplier-receipt.jpg",
      "mimeType": "image/jpeg",
      "declaredByteSize": 18432,
      "verifiedByteSize": 18432,
      "sha256Checksum": "64-hex-sha256",
      "attachmentReference": "hm-ev://uuid",
      "downloadPath": "/api/v1/handyman/field/evidence/uuid/content",
      "uploadedByUserId": "uuid",
      "uploadedByRole": "PIC_PEKERJAAN",
      "verifiedAt": "2026-10-14T03:05:00.000Z"
    }
  }
}
```

### 4.2 Flow B — Presigned / Staged Upload Intent + Binary PUT + Confirm
1. **Create Intent**: `POST /api/v1/handyman/field/evidence/presign`
   - JSON Body: `{ "executionScopeId": "uuid", "variationId": "uuid", "purpose": "VARIATION_FINDING", "originalFileName": "photo.png", "mimeType": "image/png", "declaredByteSize": 4096, "idempotencyKey": "ev-pre-001" }`
   - Returns `uploadStatus: "PENDING_BYTES"`, `uploadCompleted: false`, `attachmentReference: null`, `uploadUrl`, and `confirmUrl`.
2. **Stream Binary Bytes**: `PUT /api/v1/handyman/field/evidence/:evidenceId/bytes`
   - Raw binary body (`Content-Type: image/png`, etc.). Validates magic signature, computes SHA-256, writes to storage, and transitions status to `STAGED_BYTES`.
3. **Confirm Upload**: `POST /api/v1/handyman/field/evidence/:evidenceId/confirm`
   - Verifies stored binary bytes and SHA-256 digest exist in storage. Transitions to `VERIFIED` (`uploadCompleted: true`, `attachmentReference: "hm-ev://<id>"`). Calling `/confirm` before uploading bytes fails with `409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED`.

### 4.3 Read Evidence Metadata & Stream Verified Content
- **Metadata**: `GET /api/v1/handyman/field/evidence/:evidenceId`
- **Binary Download / Preview**: `GET /api/v1/handyman/field/evidence/:evidenceId/content` (returns raw binary stream with `Content-Type`, `Content-Length`, `X-Content-SHA256`, and `Content-Disposition` headers).

---

## 5. P1 — Worker Profile Projection

Read-only projection of authoritative worker profile facts without fabricating unmodeled attributes.

### 5.1 Read Authenticated Worker's Own Profile
- **Endpoint**: `GET /api/v1/handyman/field/me/profile`
- **Authorized Persona**: Any authenticated Handyman field worker (`PIC_PEKERJAAN`, `CREW_MEMBER`, `INSPECTOR`) with an active `workforce_profiles` + `handyman_worker_contexts` record in their accessible client scope.

### 5.2 Read Worker Profile by Worker Context ID
- **Endpoint**: `GET /api/v1/handyman/field/workers/:workerContextId/profile`
- **Authorized Personas**:
  - The worker themselves (`userId === worker.userId`)
  - The active designated Crew Lead (`PIC_PEKERJAAN`) of a crew in which `:workerContextId` is an active member
  - Operations / Customer Care (`tenant_company.read` or `tenant_company.manage`) within the same client scope
- **Forbidden (`403`)**:
  - Non-lead helpers or unrelated workers (`HANDYMAN_WORKER_PROFILE_FORBIDDEN`)
  - Cross-tenant callers (`BUILDING_ACCESS_DENIED`)

### 5.3 Response Shape (`200 OK`) & Unmodeled Attribute Disclosure
```json
{
  "success": true,
  "data": {
    "profile": {
      "workerIdentity": {
        "userId": "uuid",
        "workforceProfileId": "uuid",
        "workerContextId": "uuid",
        "workerCode": "WKR-PIC-01",
        "employeeCode": "EMP-PIC-001",
        "fullName": "Budi Santoso",
        "email": "budi.pic@example.com",
        "phone": "+628111000111",
        "workforceType": "EXTERNAL",
        "employmentType": "VENDOR",
        "workerStatus": "ACTIVE"
      },
      "providerAssociation": {
        "clientId": "uuid",
        "providerContextId": "uuid",
        "providerCode": "PROV-KTM-01",
        "providerStatus": "ACTIVE",
        "vendorId": "uuid",
        "vendorStatus": "ACTIVE",
        "organizationId": "uuid",
        "organizationCode": "ORG-KARYA",
        "organizationName": "PT Karya Teknik Mandiri",
        "bindingStatus": "ACTIVE",
        "bindingEffectiveFrom": "2025-06-01T00:00:00.000Z",
        "bindingEffectiveUntil": null
      },
      "roleAndAssignmentContext": {
        "authorizedRoles": ["PIC_PEKERJAAN", "CREW_MEMBER"],
        "crewMemberships": [
          {
            "crewId": "uuid",
            "crewCode": "CRW-ALPHA",
            "crewName": "Crew Alpha Plumbing & MEP",
            "buildingId": "uuid",
            "crewStatus": "ACTIVE",
            "membershipStatus": "ACTIVE",
            "isCrewLead": true,
            "joinedAt": "2026-01-01T00:00:00.000Z"
          }
        ],
        "buildingAssignments": [
          {
            "buildingId": "uuid",
            "buildingCode": "BLD-A",
            "buildingName": "Tower Alpha",
            "propertyId": "uuid",
            "assignmentRole": "HANDYMAN_LEAD",
            "isPrimary": true,
            "status": "ACTIVE",
            "effectiveFrom": null,
            "effectiveUntil": null
          }
        ]
      },
      "skillsAndCategories": {
        "serviceCategories": ["TECHNICAL"],
        "effectiveSkills": [
          {
            "skillId": "uuid",
            "code": "SKL-PLUMB-01",
            "name": "Commercial Plumbing & Piping",
            "category": "TECHNICAL",
            "proficiencyLevel": "EXPERT",
            "validFrom": "2025-01-01T00:00:00.000Z",
            "validUntil": "2028-12-31T23:59:59.000Z"
          }
        ]
      },
      "certificationsAndExpiry": {
        "individualCertificateNumberModeled": false,
        "skillValidityWindows": [
          {
            "skillId": "uuid",
            "skillCode": "SKL-PLUMB-01",
            "skillName": "Commercial Plumbing & Piping",
            "proficiencyLevel": "EXPERT",
            "validFrom": "2025-01-01T00:00:00.000Z",
            "expiresAt": "2028-12-31T23:59:59.000Z",
            "isExpired": false
          }
        ],
        "providerLicensesAndCertifications": [
          {
            "id": "uuid",
            "recordType": "CERTIFICATION",
            "name": "IUJK & K3 Mep Contractor License",
            "number": "LIC-K3-2026-009",
            "issuingAuthority": "Kemnaker RI",
            "issueDate": "2025-01-01T00:00:00.000Z",
            "expiryDate": "2028-01-01T00:00:00.000Z",
            "status": "ACTIVE"
          }
        ]
      },
      "workHistorySummary": {
        "assignedExecutionScopesCount": 1,
        "activeWorkSessionsCount": 1,
        "completedWorkSessionsCount": 1,
        "activeInspectionsCount": 0,
        "completedInspectionsCount": 0,
        "recentWorkOrders": [
          {
            "executionScopeId": "uuid",
            "handymanRequestId": "uuid",
            "requestCode": "HM-REQ-2026-101",
            "title": "Replace pantry pressure valve",
            "buildingId": "uuid",
            "scopeStatus": "IN_PROGRESS",
            "assignmentStatus": "ACTIVE",
            "roleInJob": "PIC_PEKERJAAN",
            "assignedAt": "2026-10-14T00:00:00.000Z"
          }
        ]
      }
    }
  }
}
```
- **Note on Modeled vs Unmodeled Profile Attributes**:
  - Individual skill validity windows (`validFrom`, `validUntil` / `expiresAt`, `proficiencyLevel`) are projected from `workforce_skill_assignments` + `skills` (client-scoped through `skills.client_id`).
  - Employer/provider licenses & certifications (`recordType`, `name`, `number`, `issuingAuthority`, `issueDate`, `expiryDate`, `status`) are projected from `vendor_licenses_certifications`. They are OPTIONAL: a worker (or provider) without certificates still returns `200` with an empty array.
  - Individual per-worker certificate serial numbers and star ratings are not separately modeled in the database schema (`individualCertificateNumberModeled: false`) and are never fabricated.
- **CR-HM-WORKER-PROFILE-FIX-01 — schema-fidelity notes (response shape UNCHANGED)**:
  - `workerCode` = `vendor_workforce_bindings.vendor_personnel_code` of the current vendor binding, falling back to `workforce_profiles.employee_code`. No `worker_code` column exists on `handyman_worker_contexts`.
  - `providerCode` = `vendors.vendor_code`. No `provider_code` column exists on `handyman_provider_contexts`.
  - `email` / `phone` = `users.email` / `users.whatsapp_phone` of the linked login identity (both nullable; `workforce_profiles` models no contact columns).
  - `employmentType` is derived from `workforce_profiles.workforce_type` (`EXTERNAL` → `VENDOR`, `OUTSOURCED` → `OUTSOURCED`, `CONTRACT` → `CONTRACT`, else `INTERNAL`).
  - `crewMemberships[].buildingId` is always `null`: Handyman crews are provider-scoped, not building-scoped. `crewMemberships[].joinedAt` is the membership creation instant.
  - `buildingAssignments[]`: `propertyId` is resolved through the building; `assignmentRole` is the constant placement category `HANDYMAN`; `isPrimary` is derived from the earliest ACTIVE placement (a workforce building placement stores no role/primary/assigned-at columns).
  - `recentWorkOrders[].requestCode` is derived from `handyman_service_requests.origin_reference` (falling back to a deterministic `HM-<id-prefix>` handle) and `title` from `description`; the request table models neither a code nor a title column. Recent work orders remain strictly non-commercial.
  - An authenticated actor with no Handyman worker context (including `PLATFORM_ADMIN`) receives `404 HANDYMAN_WORKER_PROFILE_NOT_FOUND` — never `500`, and no profile is fabricated.


---

## 6. CR-HM-FIELD-EVIDENCE-HARDEN-01 — Evidence Contract Hardening

### 6.1 Mandatory verified evidence (P0-A)
- Every Variation and Material Purchasing command that accepts `evidenceReference` / `receiptEvidenceReference` requires a managed `hm-ev://<evidenceId>` reference to a **VERIFIED** field-evidence upload.
- The referenced upload must belong to the same client, building, handyman request and (when set) execution scope; its stored bytes are re-read and must match the recorded SHA-256 and verified byte size on every bind.
- Arbitrary strings, URLs and legacy schemes (e.g. `ev://...`, `tenant-consent://...`) are rejected with `400 HANDYMAN_EVIDENCE_REFERENCE_UNVERIFIED`. Unverified/metadata-only uploads are rejected with `409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED`; unknown references `404`; cross-tenant/scope references `403`.
- There is no legacy free-text evidence authority: no non-managed reference is accepted as evidence on any of these commands.

### 6.2 Immutable VERIFIED uploads (P0-B)
- Once an upload is `VERIFIED`, re-uploading bytes (`PUT /handyman/field/evidence/:evidenceId/bytes`) with identical SHA-256/size is a safe idempotent no-op; conflicting bytes are rejected with `409 HANDYMAN_EVIDENCE_UPLOAD_IMMUTABLE` and the finalized bytes, SHA-256 and verified size are preserved.

### 6.3 Versioned, audited binding (P0-C)
- Uploading bytes with `variationId` / `materialPurchaseRecordId` (direct upload or staged confirm) binds the verified reference inside the same transaction: the owning aggregate `version` is incremented and an append-only `handyman_field_evidence.bound_to_variation` / `handyman_field_evidence.bound_to_material_purchase` operational event is recorded. Re-binding the identical reference is a no-op. There is no separate/competing evidence authority.

### 6.4 Storage readiness on Railway (P0-D)
- The only storage driver is local disk (`EVIDENCE_STORAGE_DRIVER=local`, `EVIDENCE_STORAGE_DIR`, default `.data/evidence`; image pins `/app/.data/evidence`).
- **Railway's container filesystem is ephemeral**: evidence is durable only if a Railway Volume is mounted at `EVIDENCE_STORAGE_DIR`. Without a volume, verified evidence bytes are lost on redeploy/restart and binds will then fail integrity checks (`409 HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED`) rather than silently succeeding.
- Boot fails fast via `verifyEvidenceStorageReady()` when the directory cannot be created/written (missing mount, wrong ownership/permissions). Runtime read-after-write + SHA-256 health is available via `checkEvidenceStorageHealth()`. Across a restart with a persistent volume, previously verified bytes remain readable and checksum-valid.

### 6.5 Remaining gaps (not implemented in this CR)
- Work Order evidence list endpoint for a whole work order/request (today evidence is read per record via `GET /handyman/field/evidence/:evidenceId` and `/content`).
- Evidence-record compatibility with the generic `/evidence` module records (field-evidence uploads are a separate managed namespace, `hm-ev://`).
- Material UOM catalog endpoint for mobile (commands accept an existing `uomId`/`uomCode`; no handyman-scoped UOM list is exposed here).
- Cross-persona frontend handoffs beyond this document (Handyman-Mobile PR #9 consumption, operations web) remain with the respective frontend teams.

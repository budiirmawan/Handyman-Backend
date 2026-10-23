# CR-HM-FIELD-EXPENSE-HELPER-01 — PART 01: Foto Nota & Reimbursement Petugas (Mobile, Operations & Finance API Handoff)

## 1. Architectural Governance & Non-Duplication

`CR-HM-FIELD-EXPENSE-HELPER-01` PART 01 extends the authoritative `handyman-material-purchasing` (`0436` + `0470`) and `handyman-field-evidence` (`0437`) modules without introducing a duplicate material purchase ledger or parallel payment authority:

1. **Operational lifecycle preserved**: `handyman_material_purchase_records.status` remains `REQUEST → APPROVAL → ISSUED | PURCHASED → USAGE → RETURN → RECONCILIATION`, keeping `handyman-dispatch`, `handyman-final-close`, and `handyman-operations-commercial-inbox` 100% compatible.
2. **Canonical Work Order binding**: Every material purchase record binds `work_order_id` (`workOrderId`) from its authoritative Execution Scope. Optional client-supplied `workOrderId` values on request or purchase recording are validated against `scope.work_order_id`; mismatches fail with `409 HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM`.
3. **Private receipt binary storage**: Receipt photos/PDFs (`foto nota`) live exclusively in private storage (`createEvidenceStorage`, outside any public static path) uploaded via `POST /api/v1/handyman/field/evidence/upload` (or staged presign/put/confirm) with `purpose = "MATERIAL_RECEIPT"`. Only authenticated authorized actors (assigned Crew Lead, Building-scoped Operations with `tenant_company.read`, and Building-scoped Finance with `handyman.finance.read` for `MATERIAL_RECEIPT`) can read metadata or stream bytes.
4. **Funding source separation (`sumber dana`)**:
   - `REIMBURSEMENT` (**Uang pribadi petugas**): The **only** funding source eligible to create a worker reimbursement payable (`PENDING_RECONCILIATION → RECONCILED_PAYABLE → FINANCE_APPROVED → DISBURSED`, or `REJECTED`).
   - `CASH_ADVANCE` (**Uang muka Handyman**): Tracked with `cashAdvanceReference` and mandatory receipt photo; `reimbursementStatus = 'NOT_APPLICABLE'`, `reimbursementPayableAmount = '0.00'`, `reimbursementPayeeUserId = null`.
   - `COMPANY_DIRECT` / `PETTY_CASH` / `WAREHOUSE_STOCK` (**Dana perusahaan / stok**): `reimbursementStatus = 'NOT_APPLICABLE'`, `reimbursementPayableAmount = '0.00'`, `reimbursementPayeeUserId = null`.
5. **Separation of Duties**:
   - **Mobile Crew Lead (`PIC_PEKERJAAN`)**: Uploads private receipt evidence, records supplier purchase (`biaya aktual`, `supplier/toko`, `tanggal transaksi`, `foto nota`, `sumber dana`, `referensi Work Order`), records usage/return, and views own reimbursement status.
   - **Operations (`tenant_company.read` / `tenant_company.manage` + exact-Building scope)**: Approves material requests, inspects private receipts, and verifies/reconciles material usage & eligibility (`reimbursementEligible`). Operations **cannot** approve Finance disbursement or disburse funds.
   - **Finance (`handyman.finance.read` / `handyman.finance.manage` + exact-Building scope)**: Inspects Building-scoped reimbursement queues & private `MATERIAL_RECEIPT` binaries, approves or rejects `RECONCILED_PAYABLE` claims, and disburses `FINANCE_APPROVED` claims. Anti-self-approval (`actorUserId !== reimbursementPayeeUserId`) is enforced on Finance approval and disbursement.

---

## 2. Existing & Extended Endpoints

| Method & Path | Persona & Permission | Role in Flow |
|---|---|---|
| `POST /api/v1/handyman/field/evidence/upload` | Assigned Crew Lead / Operations | Upload private binary receipt (`purpose: "MATERIAL_RECEIPT"`, JPEG/PNG/WebP/PDF, magic-byte + SHA-256 verified) returning `evidenceReference = "hm-ev://<uuid>"` |
| `GET /api/v1/handyman/field/evidence/:evidenceId` & `.../bytes` | Assigned Crew Lead / Operations (`tenant_company.read`) / Finance (`handyman.finance.read`, `MATERIAL_RECEIPT` only) | Read private receipt metadata or binary stream (exact-Building scoped for Operations & Finance) |
| `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases` | Assigned Crew Lead | Submit material purchase request (`fundingSource`, optional `workOrderId` verified against scope) |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/approve` | Operations (`tenant_company.manage` + Building scope) | Approve request quantity, ceiling unit price, and optional `cashAdvanceReference` |
| `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/purchase` (and Operations `/handyman/execution-scopes/.../purchase`) | Assigned Crew Lead or Operations (`tenant_company.manage` + Building scope) | Record actual cost (`actualUnitPrice`, `purchasedQuantity`, `actualTotalExpenseAmount`), `supplierName`, `purchaseDate`, `purchaseReference`, mandatory `receiptEvidenceReference` (`MATERIAL_RECEIPT`), and `workOrderId` guard |
| `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/usage` | Assigned Crew Lead | Record actual installed quantity |
| `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/return` (and Operations `/handyman/execution-scopes/.../return`) | Assigned Crew Lead or Operations (`tenant_company.manage` + Building scope) | Record unused material return (`WAREHOUSE`, `SUPPLIER_RETURN`, `COMPANY_CUSTODY`) |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reconcile` | Operations (`tenant_company.manage` + Building scope) | Verify physical balance (`used + returned == issued + purchased`), set `tenantChargeEligible`, and verify `reimbursementEligible` (`RECONCILED_PAYABLE` vs `REJECTED` for `REIMBURSEMENT`) |
| `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases` | Assigned Crew Lead / Inspector (redacted) | List scope material purchase records + 4-way ledger summary |
| `GET /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases` | Operations (`tenant_company.read` + Building scope) | List scope material purchase records + 4-way ledger summary |

---

## 3. New Endpoints Added in PART 01

| Method & Path | Permission & Scope | Purpose |
|---|---|---|
| `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId` | Authenticated Crew Lead / Inspector (commercial fields redacted for Inspector) | Read single material purchase record + immutable append-only `events` audit trail |
| `GET /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId` | `tenant_company.read` + Building scope | Operations read single material purchase record + `events` audit trail |
| `GET /api/v1/handyman/material-reimbursements` | `handyman.finance.read` + Building scope | Finance cross-scope queue for `fundingSource = 'REIMBURSEMENT'` filtered by actor's active Building assignments (`?buildingId=&reimbursementStatus=&workOrderId=&executionScopeId=`) |
| `GET /api/v1/handyman/execution-scopes/:executionScopeId/material-reimbursements` | `handyman.finance.read` + Building scope | Finance scope-level reimbursement list + ledger summary |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/approve` | `handyman.finance.manage` + Building scope | Finance approves `RECONCILED_PAYABLE` personal expense (`FINANCE_APPROVED`), recording `financeApprovedAmount`, `financeApprovedByUserId`, `financeApprovedAt`, and event `REIMBURSEMENT_FINANCE_APPROVED` |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/reject` | `handyman.finance.manage` + Building scope | Finance rejects `RECONCILED_PAYABLE` or `FINANCE_APPROVED` claim (`REJECTED`, `reimbursementPayableAmount = "0.00"`), recording `financeRejectionReason` and event `REIMBURSEMENT_FINANCE_REJECTED` |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/material-purchases/:purchaseRecordId/reimbursement/disburse` | `handyman.finance.manage` + Building scope | Finance records actual disbursement (`DISBURSED`) after `FINANCE_APPROVED`, enforcing exact `disbursedAmount == financeApprovedAmount`, unique `disbursementReference`, and event `REIMBURSEMENT_DISBURSED` |

---

## 4. Anti-Fraud & State Machine Error Codes

- `HANDYMAN_MATERIAL_RECEIPT_PURPOSE_INVALID` (`422`): Evidence uploaded with a purpose other than `MATERIAL_RECEIPT` (e.g. `EXECUTION_BEFORE`) cannot be used as `receiptEvidenceReference`.
- `HANDYMAN_MATERIAL_RECEIPT_DUPLICATE` (`409`): Blocks reusing the same `hm-ev://<uuid>` receipt attachment, uploading identical receipt bytes (same SHA-256 checksum) on another purchase record, or claiming the same `(supplierName, purchaseReference)` invoice twice.
- `HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM` (`409`): Blocks binding a receipt uploaded for another Execution Scope / Work Order or submitting a mismatched `workOrderId`.
- `HANDYMAN_REIMBURSEMENT_NOT_ELIGIBLE` (`422`): Blocks marking `CASH_ADVANCE`, `COMPANY_DIRECT`, `PETTY_CASH`, or `WAREHOUSE_STOCK` purchases as `reimbursementEligible: true` or routing them to Finance reimbursement endpoints.
- `HANDYMAN_REIMBURSEMENT_FINANCE_FORBIDDEN` (`403`): Blocks self-approval / self-disbursement (`actorUserId === reimbursementPayeeUserId`) or out-of-Building access.
- `HANDYMAN_REIMBURSEMENT_APPROVAL_REQUIRED` (`409`): Blocks `disburse` unless `reimbursementStatus === 'FINANCE_APPROVED'` (e.g. cannot disburse directly from `PENDING_RECONCILIATION` or `RECONCILED_PAYABLE`).
- `HANDYMAN_REIMBURSEMENT_ALREADY_DISBURSED` (`409`): Blocks double payment on an already `DISBURSED` record with a new `idempotencyKey`, and blocks reusing a `disbursementReference` already bound to another purchase record.
- `HANDYMAN_REIMBURSEMENT_AMOUNT_MISMATCH` (`422`): Blocks `approvedAmount > reimbursementPayableAmount` or `disbursedAmount !== financeApprovedAmount`.
- `HANDYMAN_REIMBURSEMENT_ILLEGAL_TRANSITION` (`409`): Blocks invalid state transitions (e.g. approving/disbursing a `REJECTED` claim or rejecting an already `DISBURSED` claim).

# CR-HM-E2E-FINANCIAL-RECONCILIATION — Backend Audit, Gap Closure & Cross-Repo Handoff Contract

- **Document ID:** `HANDYMAN-BAST-DP-INVOICE-PAYMENT-CLOSE-CONTRACT`
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/827baa53-handyman-backend`
- **Additive Migration:** `src/database/migrations/0458_handyman_e2e_financial_reconciliation_close.ts`
- **Focused E2E Verification Suite:** `tests/handyman-e2e-financial-reconciliation-close.test.ts`
- **Target Consumers:**
  - `Handyman_Customer_Care` (Customer Care Portal & Standalone Building Care Gateway)
  - `Handyman_Operations` (Operations, Supervisor, Finance, and Handyman Manager Portal)
  - `Handyman_Mobile` (Freelance Lead Worker & Field Inspector Mobile App)

---

## 1. PART A — Audit of Existing Implementation (Before & After Gap Closure)

Every baseline requirement was audited against actual database migrations (`0391`–`0457`), domain services, HTTP routers, and existing regression firewalls before applying additive gap closure in `0458_handyman_e2e_financial_reconciliation_close.ts`.

| # | Baseline Capability | Pre-CR Audit Status | Existing Authority (Files / Migrations) | Gap Identified & Closed in This CR | Post-CR Status |
|---|---|---|---|---|---|
| 1 | Tenant approves quotation and DP terms when applicable | `PARTIAL` | `0391_create_handyman_quotations.ts`, `0394_create_handyman_quotation_decisions.ts`, `src/modules/handyman-quotations/`, `src/modules/handyman-quotations-api/` | Quotation versions had no DP terms columns (`dp_required`, `dp_percentage`, `dp_amount`, `dp_terms_notes`). Added in migration `0458`, auto-computed on `issue` when `dpPercentage` is set, and exposed on quotation create/revision/issue/read DTOs. | `CLOSED` |
| 2 | DP can be paid before work completion | `PARTIAL` | `0412_create_handyman_customer_payments.ts`, `0433_handyman_customer_payment_proof.ts`, `src/modules/handyman-customer-payments/` | Ledger payments supported pre-completion recording, but had no commercial `obligation_stage` (`DP \| TERMIN \| PELUNASAN`), and `0433` trigger `handyman_customer_payment_proof_guard()` + payment-proof services blocked uploading proof before a `FINALIZED` invoice existed. Updated in `0458` and payment-proof services to allow pre-invoice DP/termin proof uploads. | `CLOSED` |
| 3 | Customer Care uploads payment proof for DP, installment (`TERMIN`), or final settlement (`PELUNASAN`) | `PARTIAL` | `src/modules/handyman-care-workspace/care-workspace-payment-proof.service.ts`, `src/modules/handyman-payment-proof/`, `src/modules/handyman-care-standalone-discovery/` | `CUSTOMER_CARE` role holds `handyman.care.building` (not `tenant_company.manage`, per `tests/iam-bootstrap.test.ts:1387`). Added Care-authorized building routes `POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments` and `POST .../payments/:paymentId/proof` (plus pre-invoice support on Care Workspace `/api/v1/handyman/care/requests/:requestId/payments/:paymentId/proof` and `/api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof`). | `CLOSED` |
| 4 | Finance verifies funds actually entered the destination account | `EXISTING` | `0412_create_handyman_customer_payments.ts`, `0447_handyman_finance_permissions.ts`, `src/modules/handyman-customer-ledger-api/` | `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm` and `/reject` gated by `tenant_company.manage` + `handyman.finance.manage` + exact-building scope guard. Customer Care never auto-marks payments `CONFIRMED` or invoices `PAID`. | `EXISTING` |
| 5 | DP `CONFIRMED` (verified) does not cause Work Order / Execution Scope `CLOSED` | `EXISTING` | `src/modules/handyman-customer-payments/handyman-customer-payment.service.ts`, `0395_create_handyman_execution_scopes.ts` | Confirming a DP payment mutates only `handyman_customer_payments.status = 'CONFIRMED'`. Execution scope remains `AUTHORIZED` (open for execution), and Manager `FINAL CLOSE` explicitly rejects closing when only DP or partial payment is paid (`ONLY_DP_OR_PARTIAL_PAID`). | `CLOSED` |
| 6 | Freelance Lead Worker records crew presence, work session, material, chargeable additional/variation work, and evidence | `EXISTING` | `0396`–`0402`, `0422`, `0435`–`0437`, `src/modules/handyman-work-sessions/`, `src/modules/handyman-material-execution-api/`, `src/modules/handyman-material-purchasing/`, `src/modules/handyman-scope-variations/`, `src/modules/handyman-field-evidence/` | Existing field/operations endpoints cover arrival/presence, work sessions, material estimation/issue/use/return/settlement, field material purchasing, 9-stage scope variations (`ADD \| REDUCE`), and byte-verified field evidence uploads. | `EXISTING` |
| 7 | Supervisor performs QC | `EXISTING` | `0403_create_handyman_evidence_qc.ts`, `0442_harden_handyman_qc.ts`, `src/modules/handyman-evidence-qc/` | Versioned QC checklist templates, scope bindings, Supervisor reporting-line authority (`assertHandymanQcSupervisorAuthority`), verified `QC_EVIDENCE` byte bindings, defect rectification/verification, and `assertCurrentGuardedHandymanQcPass`. | `EXISTING` |
| 8 | BAST is issued and accepted by authorized Tenant/PIC (including rework -> re-QC -> re-BAST after rejection) | `PARTIAL` | `0404_create_handyman_bast.ts`, `0405_handyman_bast_sign_off.ts`, `0445_bind_handyman_bast_to_qc_pass.ts`, `src/modules/handyman-bast/`, `src/modules/handyman-bast-api/`, `src/modules/handyman-bast-worker-api/` | `handyman_bast_one_active_idx` (`WHERE status <> 'VOID'`) and `findActiveBastByScopeId` previously blocked preparing a new BAST after customer `REJECTED`. Updated in `0458` (`WHERE status NOT IN ('VOID', 'REJECTED')`) and `prepareHandymanBast` to require a fresh Supervisor QC PASS (`qcRunId !== rejectedBast.qcRunId`) while preserving rejected BAST history. | `CLOSED` |
| 9 | Final invoice accounts for all verified payments, valid allocations, settled materials, and approved variations | `PARTIAL` | `0410`–`0414`, `0432_handyman_charge_tenant_invoice_source.ts`, `src/modules/handyman-customer-transactions/`, `src/modules/handyman-customer-payment-allocations/`, `src/modules/tenant-invoices/` | `handyman_charge_line_basis_consistency()` and `composeHandymanChargeLine` previously allowed only the initial `approved_quotation_version_id`. Updated in `0458` and `handyman-customer-transaction.service.ts` to allow `ADD` variation quotation lines (`final_charge_eligible = TRUE`), net `ADJUSTMENT` corrections on invoice line snapshots, mark `handyman_scope_variations.invoiced = TRUE` on invoice finalization, and expose `GET /api/v1/handyman/execution-scopes/:executionScopeId/invoice-reconciliation` deducting allocated DP exactly once. | `CLOSED` |
| 10 | Only Handyman Manager can perform `FINAL CLOSE` after invoice is `PAID` and all operational gates pass | `MISSING` | `0395_create_handyman_execution_scopes.ts`, `src/modules/iam-bootstrap/iam-canonical-roles.ts` | Added `CLOSED` status (`closed_at`, `closed_by_user_id`, `close_reason`) on `handyman_execution_scopes`, append-only `handyman_execution_scope_close_events` table, `GET .../final-close/readiness`, and `POST .../final-close` gated by `finding.close` + `handyman.finance.read` + exact-building access + non-field-actor guard + `FOR UPDATE` transaction lock. | `CLOSED` |
| 11 | BM fee, settlement, and warranty remain separate lifecycles | `EXISTING` | `0415`–`0422`, `src/modules/handyman-bm-fee-rules/`, `src/modules/handyman-entitlements/`, `src/modules/handyman-settlement-reconciliation/`, `src/modules/handyman-service-warranties/` | BM fee rules, entitlement facts, settlement units/reconciliations, and service warranties remain strictly separate lifecycles and are never auto-mutated by DP verification, invoice finalization, or Manager `FINAL CLOSE`. | `EXISTING` |

---

## 2. Domain Lifecycles & Authority Invariants

### 2.1 Single Authoritative Ledger (No Parallel Ledger)
- Every commercial money fact for an Execution Scope lives in the single authoritative CR-HM-13 ledger (`handyman_customer_transactions`, `handyman_charge_lines`, `handyman_customer_payments`, `handyman_payment_allocations`, `handyman_ledger_corrections`).
- Tenant Invoices (`tenant_invoices` with `handyman_execution_scope_id` and `tenant_invoice_lines` with `source_type = 'HANDYMAN_CHARGE'`) snapshot net composed charge lines (`cl.amount - SUM(ADJUSTMENT corrections)`) and derive payment status from confirmed, unreversed ledger allocations.

### 2.2 Quotation Version & DP Terms Lifecycle
- **Quotation Version Statuses:** `DRAFT -> ISSUED -> APPROVED | REJECTED | EXPIRED | SUPERSEDED`
- **DP Terms Fields on `handyman_quotation_versions`:**
  - `dpRequired: boolean` (default `false`)
  - `dpPercentage: number | null` (`> 0` and `<= 100` when set)
  - `dpAmount: string | null` (decimal string `"0.00"`; when `dpRequired = true` and `dpPercentage` is provided without an explicit `dpAmount`, issuing the quotation version automatically computes `dpAmount = round(versionTotal * dpPercentage / 100, 2)`)
  - `dpTermsNotes: string | null` (optional commercial note, max 500 chars)

### 2.3 Customer Payment & Obligation Stage Lifecycle
- **Payment Statuses:** `PENDING -> CONFIRMED | REJECTED`
- **Obligation Stages (`obligationStage`):** `'DP' | 'TERMIN' | 'PELUNASAN'` (default `'PELUNASAN'`)
- **Invariants:**
  - Customer Care reporting a payment (`POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments`) **always** creates the payment in `status = 'PENDING'` and never marks an invoice `PAID`.
  - Uploading payment proof (`PHOTO` or `DOCUMENT`, SHA-256 hashed, immutable in `evidence_submissions` with `execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'`) works **both before and after** a final invoice exists, provided the payment is in `PENDING` or `CONFIRMED` status.
  - Only an actor with `tenant_company.manage` + `handyman.finance.manage` and exact-building access can confirm (`CONFIRMED`) or reject (`REJECTED`) a payment.
  - Confirming a `DP` payment **never** transitions `handyman_execution_scopes.status` to `CLOSED`.
  - Duplicate `(transaction_id, external_reference)` with different parameters fails-closed with `409 HANDYMAN_CUSTOMER_PAYMENT_CONFLICT`.
  - Allocations (`handyman_payment_allocations`) are capped by both net unallocated confirmed payment (`payment.amount - reversed - refunded - applied`) and net unallocated charge line (`chargeLine.amount - adjusted - applied`). Over-allocation fails-closed with `409 HANDYMAN_PAYMENT_ALLOCATION_CAP_EXCEEDED`.

### 2.4 BAST & Re-QC Lifecycle
- **BAST Statuses:** `DRAFT -> ISSUED -> ACCEPTED | REJECTED` (or `DRAFT | ISSUED -> VOID`)
- **Invariants:**
  - `prepareHandymanBast` requires a current guarded Supervisor QC PASS (`assertCurrentGuardedHandymanQcPass`) on the execution scope and binds `qc_run_id` onto `handyman_bast_documents`.
  - If the most recent BAST on the execution scope was `REJECTED`, `prepareHandymanBast` fails-closed with `409 HANDYMAN_BAST_QC_NOT_READY` until a **new** guarded Supervisor QC PASS run (`qcRunId !== latestRejectedBast.qcRunId`) is completed after rework.
  - Previous `REJECTED` and `VOID` BAST rows remain preserved in `handyman_bast_documents` and `history.bastHistory`.

### 2.5 Execution Scope & Manager `FINAL CLOSE` Lifecycle
- **Execution Scope Statuses:** `AUTHORIZED -> CLOSED`
- **Derived Payment Statuses (`ledgerSummary.derivedPaymentStatus`):**
  - `'UNPAID'` — No confirmed payments and no pending DP
  - `'DP_PENDING'` — Unverified (`PENDING`) DP payment reported, zero confirmed payments
  - `'DP_PARTIAL'` — Confirmed DP > `0.00` but `< dpRequiredAmount`
  - `'DP_PAID'` — Confirmed DP `>= dpRequiredAmount` while remaining work balance is not yet settled
  - `'PARTIALLY_PAID'` — Confirmed payments exist, remaining balance `> 0.00`
  - `'PAID'` — Net charged `> 0.00`, remaining balance `=== 0.00`, and unallocated/overpaid confirmed funds `=== 0.00`
  - `'OVERPAID_UNRECONCILED'` — Net confirmed received exceeds net charged without refund/reconciliation
- **Mandatory Gates Revalidated Transactionally on Manager `FINAL CLOSE`:**
  1. `activeCrewAssigned`: Active crew assignment exists (`handyman_execution_scope_assignments.status = 'ACTIVE'`).
  2. `workSessionsCompleted`: At least 1 work session in `COMPLETED` or `CHECKED_OUT` status and 0 active/in-progress sessions.
  3. `materialsSettled`: 0 material execution lines outside `SETTLED | FINAL_CHARGE_READY` and 0 material purchase records outside `RECONCILED | REJECTED`.
  4. `variationsReconciled`: Every non-`REJECTED` scope variation is in `status = 'FINAL_CHARGE_ELIGIBILITY'`, `final_charge_eligible = TRUE`, and `invoiced = TRUE`.
  5. `supervisorQcPassed`: `assertCurrentGuardedHandymanQcPass` succeeds and 0 unverified defect records (`handyman_defect_records.status <> 'VERIFIED'`).
  6. `bastAccepted`: Active BAST is `ACCEPTED`, bound to the latest Supervisor QC PASS `qc_run_id`, with a non-empty customer `ACCEPT` `signature_digest` in `handyman_bast_sign_offs`.
  7. `noPendingPayments`: `pendingPaymentAmount === '0.00'` (zero `PENDING` customer payments).
  8. `ledgerFullySettled`: Ledger transaction is open, `chargedNet > 0.00`, `remainingBalanceAfterDpAndPayments === '0.00'`, and `unallocatedConfirmedAmount === '0.00'`.
  9. `finalInvoicePaid`: A `FINALIZED` tenant invoice exists for the scope, all scope charge lines are linked via `tenant_invoice_lines` (`source_type = 'HANDYMAN_CHARGE'`), `invoice.grossTotal === ledgerSummary.chargedNet`, `invoice.remainingBalance === '0.00'`, and `invoice.paymentStatus === 'PAID'`.
  10. `noBlockingExceptions`: Zero `DISPUTED` rows in `handyman_settlement_exceptions` for the scope.

---

## 3. Permissions & Persona Role Matrix

| Persona / Role | Canonical Role Code | Required Permissions | Allowed Actions in This Contract | Explicitly Forbidden (`403`) |
|---|---|---|---|---|
| **Customer Care** | `CUSTOMER_CARE` | `tenant_company.read`, `service_request.manage`, `handyman.care.building` | Record `PENDING` customer payment (`DP`, `TERMIN`, `PELUNASAN`) & upload payment proof via `/api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments` and `/payments/:paymentId/proof`; read customer ledger (`/customer-ledger`) and BAST views | Confirm/reject payment; compose charge lines; allocate payments; accept/reject BAST; execute Manager `FINAL CLOSE` |
| **Operations / Dispatcher** | `OPERATIONS` | `tenant_company.read`, `tenant_company.manage`, `work_order.read`, `work_order.manage`, `vendor.manage` | Create/revise/issue quotation with DP terms; assign crew; review/authorize scope variations; read `/customer-ledger` | Confirm/reject payment (`handyman.finance.manage` required); open/finish QC (`handyman.qc.manage` required); execute Manager `FINAL CLOSE` (`finding.close` + `handyman.finance.read` required) |
| **Freelance Lead Worker** | `MOBILE_STAFF` (+ active Crew Lead on scope) | `work_order.read`, `work_order.update_status`, `evidence.manage`, `handyman.bast.manage` | Record work sessions, material usage/settlement, field variations, field evidence; prepare/issue BAST via `/api/v1/handyman/worker/execution-scopes/:executionScopeId/bast/*` | Confirm/reject payment; accept/reject BAST; execute Manager `FINAL CLOSE` (blocked both by permission and by `assertNotFieldExecutionActorOnScope`) |
| **Supervisor** | Supervisor in workforce reporting line | `handyman.qc.manage`, `handyman.bast.manage`, `tenant_company.read`, `tenant_company.manage` | Open, record item outcomes, bind `QC_EVIDENCE`, finish QC run (`PASSED \| FAILED`); record variation QC outcome | Execute Manager `FINAL CLOSE` without `finding.close` + `handyman.finance.read` |
| **Authorized Tenant PIC** | Tenant PIC bound to request | `tenant_company.manage` + active `tenant_pics` email match (`assertHandymanTenantDecisionActor`) | Approve/reject quotation version (`POST .../quotation-versions/:id/decision`); approve/reject variation (`POST .../variations/:id/tenant-decision`); accept/reject BAST (`POST /api/v1/handyman/bast/:bastId/accept` or `/reject`) | Confirm/reject payment; execute Manager `FINAL CLOSE` |
| **Finance Verifier** | Finance Officer | `tenant_company.read`, `tenant_company.manage`, `handyman.finance.read`, `handyman.finance.manage`, `tenant_invoice.read`, `tenant_invoice.manage`, `evidence.read`, `evidence.manage` | Open ledger transaction; compose charge lines; upload/read payment proof; confirm/reject customer payments; allocate confirmed payments; record ledger adjustments/reversals/refunds; create/finalize tenant invoices; read `/financial-ledger` & `/invoice-reconciliation` | Execute Manager `FINAL CLOSE` (`finding.close` required) |
| **Handyman Manager** | `MANAGER` | `finding.close` + `handyman.finance.read` (+ `work_order.read`, `tenant_company.read`, `sla.read`, etc.) | Read `/invoice-reconciliation` and `/final-close/readiness`; execute `POST /api/v1/handyman/execution-scopes/:executionScopeId/final-close` | Field Crew Leads / assigned Inspectors on the same scope are blocked even if granted permissions (`403 HANDYMAN_FINAL_CLOSE_NOT_AUTHORIZED`) |

---

## 4. Actual Endpoints, Methods & DTO Contracts

### 4.1 Quotation DP Terms (`Handyman_Operations`, `Handyman_Customer_Care`)

#### Create Quotation (with optional DP terms on v1)
- **Method & Path:** `POST /api/v1/handyman/requests/:handymanRequestId/quotation`
- **Permission:** `tenant_company.manage` + exact-building access
- **Request Body:**
```json
{
  "notes": "Initial quotation with 40% DP",
  "dpRequired": true,
  "dpPercentage": 40,
  "dpAmount": "120.00",
  "dpTermsNotes": "40% DP required before technician mobilization"
}
```
> Note: `dpAmount` is optional when `dpPercentage` is provided; if omitted, `POST /api/v1/handyman/quotation-versions/:quotationVersionId/issue` automatically calculates `dpAmount` from the sum of the version's lines (`round(total * dpPercentage / 100, 2)`).

#### Create Next Quotation Version (Revision)
- **Method & Path:** `POST /api/v1/handyman/quotations/:quotationId/versions`
- **Permission:** `tenant_company.manage` + exact-building access
- **Request Body:**
```json
{
  "notes": "Revised quotation including variation work",
  "dpRequired": true,
  "dpPercentage": 40,
  "dpTermsNotes": "Original 120.00 DP carried forward"
}
```

#### Issue Quotation Version
- **Method & Path:** `POST /api/v1/handyman/quotation-versions/:quotationVersionId/issue`
- **Permission:** `tenant_company.manage` + exact-building access
- **Request Body:**
```json
{
  "validUntil": "2027-12-31T00:00:00.000Z",
  "dpRequired": true,
  "dpPercentage": 40,
  "dpTermsNotes": "40% DP required prior to execution"
}
```
- **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "id": "8e8a4a6e-5c4b-4b08-9132-89b900f11111",
    "quotationId": "3d3b1e20-4b7e-4c18-9214-21f400a22222",
    "versionNumber": 1,
    "status": "ISSUED",
    "notes": null,
    "dpRequired": true,
    "dpPercentage": 40,
    "dpAmount": "120.00",
    "dpTermsNotes": "40% DP required prior to execution",
    "issuedAt": "2026-10-20T08:00:00.000Z",
    "validUntil": "2027-12-31T00:00:00.000Z"
  }
}
```

#### Tenant PIC Quotation Decision (`APPROVE | REJECT`)
- **Method & Path:** `POST /api/v1/handyman/quotation-versions/:quotationVersionId/decision`
- **Headers:** `Idempotency-Key: <string 1..200 chars>`
- **Permission:** `tenant_company.manage` + authenticated user email must match the active `tenant_pics` row on the request (`assertHandymanTenantDecisionActor`)
- **Request Body:**
```json
{
  "decision": "APPROVE",
  "notes": "Quotation and 40% DP terms approved by Tenant PIC"
}
```
- **Response (`201 Created` on first call, `200 OK` on replay):** Returns `{ quotation, version, decision, executionScope, replayed }`.

---

### 4.2 Customer Care DP / Termin / Pelunasan Reporting & Payment Proof Upload (`Handyman_Customer_Care`)

#### Report Customer Payment (`PENDING`) via Building Care Gateway
- **Method & Path:** `POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments`
- **Permission:** `handyman.care.building` + exact-building access (`assertCareBuildingRequestInScope`)
- **Behavior:** Automatically opens the scope's customer ledger transaction if not yet open (using the approved quotation version's currency) and records a `PENDING` payment in `handyman_customer_payments`. Never marks the payment `CONFIRMED` or the invoice `PAID`.
- **Request Body:**
```json
{
  "amount": "50.00",
  "channel": "BANK_TRANSFER",
  "obligationStage": "DP",
  "providerName": "BCA",
  "providerReference": "BCA-DP-PART-01",
  "externalReference": "EXT-DP-PARTIAL-001",
  "idempotencyKey": "care-dp-report-001"
}
```
- **Response (`201 Created` on creation, `200 OK` on idempotent replay):**
```json
{
  "success": true,
  "data": {
    "transactionId": "f8859c28-f192-459e-9a4c-adbe5d20b5dd",
    "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
    "payment": {
      "id": "4e127b10-0f04-4d15-8b1e-111122223333",
      "clientId": "c0111111-1111-4111-8111-111111111111",
      "transactionId": "f8859c28-f192-459e-9a4c-adbe5d20b5dd",
      "status": "PENDING",
      "amount": "50.00",
      "currency": "IDR",
      "channel": "BANK_TRANSFER",
      "obligationStage": "DP",
      "providerName": "BCA",
      "providerReference": "BCA-DP-PART-01",
      "externalReference": "EXT-DP-PARTIAL-001",
      "receivedAt": "2026-10-20T08:05:00.000Z",
      "recordedByUserId": "u0111111-1111-4111-8111-111111111111",
      "decidedAt": null,
      "decidedByUserId": null,
      "rejectionReason": null,
      "createdAt": "2026-10-20T08:05:00.000Z"
    },
    "replayed": false
  }
}
```

#### Upload Customer Payment Proof via Building Care Gateway
- **Method & Path:** `POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments/:paymentId/proof`
- **Permission:** `handyman.care.building` + exact-building access
- **Supported Content-Types:**
  1. `multipart/form-data` with field `file` (`image/jpeg`, `image/png`, `image/webp`, or `application/pdf`, max 10 MB) and optional field `evidenceType` (`'PHOTO' | 'DOCUMENT'`, auto-inferred from MIME type when omitted).
  2. `application/json` with `{ evidenceType?: 'PHOTO' | 'DOCUMENT', file: { fileName, mimeType, contentBase64 } }`.
- **Response (`201 Created`):**
```json
{
  "success": true,
  "data": {
    "proof": {
      "id": "7a889900-1122-4333-8444-556677889900",
      "paymentId": "4e127b10-0f04-4d15-8b1e-111122223333",
      "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
      "invoiceId": null,
      "evidenceType": "PHOTO",
      "originalFileName": "dp-transfer-slip.png",
      "mimeType": "image/png",
      "fileSize": 18432,
      "contentSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "contentHashedAt": "2026-10-20T08:06:00.000Z",
      "hashAlgorithm": "SHA-256",
      "submittedByUserId": "u0111111-1111-4111-8111-111111111111",
      "createdAt": "2026-10-20T08:06:00.000Z"
    }
  }
}
```
> Additional supported payment-proof upload & read endpoints:
> - Care Workspace principal token: `POST /api/v1/handyman/care/requests/:requestId/payments/:paymentId/proof`
> - Finance / Operations execution-scope route: `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof` (accepts both `multipart/form-data` and JSON `{ file: { fileName, mimeType, contentBase64 } }`), `GET .../payment-proof` (list metadata), `GET .../payment-proof/:proofId/content` (stream verified bytes).

---

### 4.3 Finance Payment Verification, Charge Composition, Allocations & Corrections (`Handyman_Operations`)

#### Record Payment Directly on Execution Scope (Finance / Operations)
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments`
- **Permission:** `tenant_company.manage` + exact-building access
- **Request Body:**
```json
{
  "amount": "110.00",
  "channel": "BANK_TRANSFER",
  "obligationStage": "PELUNASAN",
  "providerName": "Mandiri",
  "providerReference": "MDR-001",
  "externalReference": "EXT-PELUNASAN-001",
  "idempotencyKey": "fin-pay-record-001"
}
```

#### Confirm Customer Payment (Finance Verification)
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm`
- **Permission:** `tenant_company.manage` + `handyman.finance.manage` + exact-building access
- **Request Body:** `{ "idempotencyKey": "fin-confirm-dp-001" }`
- **Response (`200 OK`):** `{ "success": true, "data": { "payment": { "status": "CONFIRMED", ... }, "event": { ... }, "replayed": false } }`

#### Reject Customer Payment (Finance Verification)
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject`
- **Permission:** `tenant_company.manage` + `handyman.finance.manage` + exact-building access
- **Request Body:** `{ "reason": "Transfer amount did not clear destination bank account", "idempotencyKey": "fin-reject-dp-001" }`
- **Response (`200 OK`):** `{ "success": true, "data": { "payment": { "status": "REJECTED", "rejectionReason": "...", ... }, "event": { ... }, "replayed": false } }`

#### Compose Governed Charge Line (Original Approved Scope Line or Eligible `ADD` Variation Line)
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-charge-lines`
- **Permission:** `tenant_company.manage` + exact-building access
- **Request Body:** `{ "quotationLineId": "<uuid>", "idempotencyKey": "compose-line-001" }`
- **Behavior:** Composes a charge line from either the initial `approved_quotation_version_id` or a revised quotation version linked to a scope variation on the same execution scope with `variation_type = 'ADD'`, `status = 'FINAL_CHARGE_ELIGIBILITY'`, and `final_charge_eligible = TRUE`.

#### Allocate Confirmed Payment to Charge Line
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/payment-allocations`
- **Permission:** `tenant_company.manage` + `handyman.finance.manage` + exact-building access
- **Request Body:**
```json
{
  "paymentId": "4e127b10-0f04-4d15-8b1e-111122223333",
  "chargeLineId": "6c998877-6655-4433-8222-110099887766",
  "amount": "50.00",
  "idempotencyKey": "alloc-dp-001"
}
```

#### Forward-Only Ledger Corrections (Adjustments, Reversals, Refunds)
- **Adjust Charge Line:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/ledger-adjustments`
  - Body: `{ "chargeLineId": "<uuid>", "amount": "10.00", "reason": "Agreed commercial discount", "idempotencyKey": "..." }`
- **Reverse Allocation:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/allocation-reversals`
  - Body: `{ "allocationId": "<uuid>", "reason": "Misallocated payment", "idempotencyKey": "..." }`
- **Reverse Payment:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/payment-reversals`
  - Body: `{ "paymentId": "<uuid>", "reason": "Bank chargeback", "idempotencyKey": "..." }`
- **Refund Unallocated Confirmed Payment (Overpayment Resolution):** `POST /api/v1/handyman/execution-scopes/:executionScopeId/ledger-refunds`
  - Body: `{ "paymentId": "<uuid>", "amount": "20.00", "reason": "Refund excess 20.00 overpayment", "idempotencyKey": "..." }`

---

### 4.4 BAST Prepare / Issue / Reject / Re-QC / Accept (`Handyman_Mobile`, `Handyman_Customer_Care`, `Handyman_Operations`)

- **Worker Prepare BAST:** `POST /api/v1/handyman/worker/execution-scopes/:executionScopeId/bast/prepare`
  - Permission: `handyman.bast.manage` + current active Crew Lead on scope
  - Body: `{ "idempotencyKey": "bast-prep-001" }`
  - Enforces `assertCurrentGuardedHandymanQcPass`. After a `REJECTED` BAST, requires a fresh Supervisor QC PASS (`qcRunId !== latestRejectedBast.qcRunId`) or fails with `409 HANDYMAN_BAST_QC_NOT_READY`.
- **Worker Issue BAST:** `POST /api/v1/handyman/worker/execution-scopes/:executionScopeId/bast/:bastId/issue`
  - Permission: `handyman.bast.manage` + current active Crew Lead on scope
  - Body: `{ "idempotencyKey": "bast-issue-001", "expectedVersion": 1 }`
- **Customer / Tenant PIC Reject BAST:** `POST /api/v1/handyman/bast/:bastId/reject`
  - Permission: `tenant_company.manage` + exact-building access
  - Body: `{ "rejectReason": "Ceiling panel edge needs wipe-down", "idempotencyKey": "bast-reject-001" }`
- **Customer / Tenant PIC Accept BAST:** `POST /api/v1/handyman/bast/:bastId/accept`
  - Permission: `tenant_company.manage` + exact-building access
  - Body: `{ "signatureDigest": "sha256:tenant-pic-sign-off-002", "evidenceRecordId": null, "idempotencyKey": "bast-accept-002" }`

---

### 4.5 Final Tenant Invoice & Handyman Reconciliation (`Handyman_Operations`)

#### Create Draft Tenant Invoice
- **Method & Path:** `POST /api/v1/tenant-companies/:tenantCompanyId/invoices`
- **Permission:** `tenant_invoice.manage` + exact-building access
- **Request Body:**
```json
{
  "buildingId": "<uuid>",
  "spaceId": "<uuid>",
  "invoiceNumber": "INV-HM-20261020-01",
  "invoiceDate": "2026-10-20",
  "dueDate": "2026-11-20",
  "currencyCode": "IDR",
  "notes": "Final Handyman Invoice"
}
```

#### Add Handyman Composed Charge Line to Invoice
- **Method & Path:** `POST /api/v1/tenant-invoices/:id/lines`
- **Permission:** `tenant_invoice.manage` + exact-building access
- **Request Body:**
```json
{
  "sourceType": "HANDYMAN_CHARGE",
  "sourceId": "<handymanChargeLineId>"
}
```
> Snapshots the net charge line amount (`cl.amount - SUM(ADJUSTMENT corrections)`) and binds `tenant_invoices.handyman_execution_scope_id` on the first Handyman line.

#### Finalize Tenant Invoice
- **Method & Path:** `POST /api/v1/tenant-invoices/:id/finalize`
- **Permission:** `tenant_invoice.manage` + exact-building access
- **Request Body:** `{}`
- **Behavior:** Re-snapshots net charge line amounts, transitions `tenant_invoices.status` to `'FINALIZED'`, and automatically marks all `FINAL_CHARGE_ELIGIBILITY` (`final_charge_eligible = TRUE`) variations on the bound execution scope as `invoiced = TRUE`.

#### Read Handyman Invoice & Payment Reconciliation Summary
- **Method & Path:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/invoice-reconciliation`
- **Permission:** `tenant_company.read` + `handyman.finance.read` + exact-building access
- **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
    "handymanRequestId": "1af87600-6bfc-4c8d-bc87-eb95532993fc",
    "scopeStatus": "AUTHORIZED",
    "closedAt": null,
    "closedByUserId": null,
    "closeReason": null,
    "currency": "IDR",
    "quotationDpTerms": {
      "quotationVersionId": "8e8a4a6e-5c4b-4b08-9132-89b900f11111",
      "versionNumber": 1,
      "dpRequired": true,
      "dpPercentage": 40,
      "dpAmount": "120.00",
      "dpTermsNotes": "40% DP required prior to execution"
    },
    "ledgerSummary": {
      "transactionId": "f8859c28-f192-459e-9a4c-adbe5d20b5dd",
      "chargedGross": "380.00",
      "adjusted": "0.00",
      "chargedNet": "380.00",
      "dpRequiredAmount": "120.00",
      "dpPendingAmount": "0.00",
      "dpVerifiedAmount": "120.00",
      "dpAllocatedAmount": "120.00",
      "dpRemainingRequiredAmount": "0.00",
      "terminVerifiedAmount": "0.00",
      "pelunasanVerifiedAmount": "260.00",
      "pendingPaymentAmount": "0.00",
      "totalConfirmedReceivedNet": "380.00",
      "totalConfirmedAllocatedNet": "380.00",
      "unallocatedConfirmedAmount": "0.00",
      "remainingBalanceAfterDpAndPayments": "0.00",
      "derivedPaymentStatus": "PAID"
    },
    "invoice": {
      "invoiceId": "31209f11-4455-4666-8777-8899aabbccdd",
      "invoiceNumber": "INV-HM-20261020-01",
      "status": "FINALIZED",
      "grossTotal": "380.00",
      "dpDeductedAmount": "120.00",
      "otherConfirmedAppliedAmount": "260.00",
      "totalAppliedAmount": "380.00",
      "remainingBalance": "0.00",
      "paymentStatus": "PAID"
    },
    "variations": [
      {
        "id": "55001122-3344-4555-8666-778899aabbcc",
        "variationNumber": 1,
        "variationType": "ADD",
        "status": "FINAL_CHARGE_ELIGIBILITY",
        "finalChargeEligible": true,
        "invoiced": true,
        "revisedQuotationVersionId": "99001122-3344-4555-8666-778899aabbcc",
        "targetQuotationLineId": null,
        "reducedQuantity": null
      }
    ],
    "history": {
      "quotationVersions": [
        {
          "id": "8e8a4a6e-5c4b-4b08-9132-89b900f11111",
          "versionNumber": 1,
          "status": "APPROVED",
          "dpRequired": true,
          "dpPercentage": 40,
          "dpAmount": "120.00",
          "createdAt": "2026-10-20T08:00:00.000Z"
        },
        {
          "id": "99001122-3344-4555-8666-778899aabbcc",
          "versionNumber": 2,
          "status": "ISSUED",
          "dpRequired": false,
          "dpPercentage": null,
          "dpAmount": null,
          "createdAt": "2026-10-20T08:10:00.000Z"
        }
      ],
      "bastHistory": [
        {
          "id": "b1000000-0000-4000-8000-000000000001",
          "status": "REJECTED",
          "qcRunId": "q1000000-0000-4000-8000-000000000001",
          "issuedAt": "2026-10-20T08:12:00.000Z",
          "acceptedAt": null,
          "rejectedAt": "2026-10-20T08:13:00.000Z",
          "voidedAt": null,
          "createdAt": "2026-10-20T08:11:30.000Z"
        },
        {
          "id": "b2000000-0000-4000-8000-000000000002",
          "status": "ACCEPTED",
          "qcRunId": "q2000000-0000-4000-8000-000000000002",
          "issuedAt": "2026-10-20T08:15:00.000Z",
          "acceptedAt": "2026-10-20T08:16:00.000Z",
          "rejectedAt": null,
          "voidedAt": null,
          "createdAt": "2026-10-20T08:14:30.000Z"
        }
      ],
      "invoiceHistory": [
        {
          "id": "31209f11-4455-4666-8777-8899aabbccdd",
          "invoiceNumber": "INV-HM-20261020-01",
          "status": "FINALIZED",
          "totalAmount": "380.00",
          "createdAt": "2026-10-20T08:18:00.000Z"
        }
      ]
    }
  }
}
```

---

### 4.6 Handyman Manager `FINAL CLOSE` Readiness & Execution (`Handyman_Operations`)

#### Read Final Close Readiness
- **Method & Path:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/final-close/readiness`
- **Permission:** `finding.close` + `handyman.finance.read` + exact-building access
- **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
    "handymanRequestId": "1af87600-6bfc-4c8d-bc87-eb95532993fc",
    "scopeStatus": "AUTHORIZED",
    "eligibleForFinalClose": true,
    "gates": {
      "activeCrewAssigned": true,
      "workSessionsCompleted": true,
      "materialsSettled": true,
      "variationsReconciled": true,
      "supervisorQcPassed": true,
      "bastAccepted": true,
      "noPendingPayments": true,
      "ledgerFullySettled": true,
      "finalInvoicePaid": true,
      "noBlockingExceptions": true
    },
    "blockers": [],
    "reconciliation": { "...": "HandymanInvoiceReconciliationSummary" }
  }
}
```

#### Execute Manager `FINAL CLOSE`
- **Method & Path:** `POST /api/v1/handyman/execution-scopes/:executionScopeId/final-close`
- **Permission:** `finding.close` + `handyman.finance.read` + exact-building access + caller must not be an executing crew member or assigned field inspector on the scope (`assertNotFieldExecutionActorOnScope`)
- **Request Body:**
```json
{
  "reason": "All operational, QC, BAST, and financial reconciliation gates verified",
  "idempotencyKey": "mgr-final-close-001"
}
```
- **Response (`200 OK`):**
```json
{
  "success": true,
  "data": {
    "closeEvent": {
      "id": "ce001122-3344-4555-8666-778899aabbcc",
      "clientId": "c0111111-1111-4111-8111-111111111111",
      "buildingId": "b0111111-1111-4111-8111-111111111111",
      "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
      "handymanRequestId": "1af87600-6bfc-4c8d-bc87-eb95532993fc",
      "bastId": "b2000000-0000-4000-8000-000000000002",
      "qcRunId": "q2000000-0000-4000-8000-000000000002",
      "transactionId": "f8859c28-f192-459e-9a4c-adbe5d20b5dd",
      "invoiceId": "31209f11-4455-4666-8777-8899aabbccdd",
      "currency": "IDR",
      "chargedNetAmount": "380.00",
      "paidAppliedAmount": "380.00",
      "actorUserId": "m0111111-1111-4111-8111-111111111111",
      "reason": "All operational, QC, BAST, and financial reconciliation gates verified",
      "idempotencyKey": "mgr-final-close-001",
      "occurredAt": "2026-10-20T08:20:00.000Z",
      "createdAt": "2026-10-20T08:20:00.000Z"
    },
    "readiness": {
      "executionScopeId": "92395aa1-decb-46b7-89f0-5e9bae7d0240",
      "handymanRequestId": "1af87600-6bfc-4c8d-bc87-eb95532993fc",
      "scopeStatus": "CLOSED",
      "eligibleForFinalClose": false,
      "gates": {
        "activeCrewAssigned": true,
        "workSessionsCompleted": true,
        "materialsSettled": true,
        "variationsReconciled": true,
        "supervisorQcPassed": true,
        "bastAccepted": true,
        "noPendingPayments": true,
        "ledgerFullySettled": true,
        "finalInvoicePaid": true,
        "noBlockingExceptions": true
      },
      "blockers": [],
      "reconciliation": {
        "scopeStatus": "CLOSED",
        "closedAt": "2026-10-20T08:20:00.000Z",
        "closedByUserId": "m0111111-1111-4111-8111-111111111111",
        "closeReason": "All operational, QC, BAST, and financial reconciliation gates verified"
      }
    },
    "replayed": false
  }
}
```

---

## 5. Error Codes & Blocker Vocabulary

| Error Code | HTTP Status | When Raised |
|---|---|---|
| `PERMISSION_DENIED` | `403` | Caller lacks required RBAC permission (`finding.close`, `handyman.finance.read`, `handyman.finance.manage`, `handyman.care.building`, etc.) |
| `FORBIDDEN` / `HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` | `403` | Cross-client or cross-building access attempt on execution-scope financial/close endpoints |
| `HANDYMAN_CARE_STANDALONE_NOT_FOUND` | `404` | Cross-building or unknown `(buildingId, requestId)` on `/api/v1/handyman/care/buildings/:buildingId/requests/:requestId/*` |
| `HANDYMAN_CUSTOMER_PAYMENT_CONFLICT` | `409` | Duplicate `(transaction_id, external_reference)` with different payment parameters or conflicting idempotency key |
| `HANDYMAN_PAYMENT_ALLOCATION_CAP_EXCEEDED` | `409` | Allocation exceeds unallocated confirmed payment amount or net charge line outstanding amount |
| `HANDYMAN_BAST_QC_NOT_READY` | `409` | BAST prepare/issue attempted without a current guarded Supervisor QC PASS, or after a `REJECTED` BAST without a fresh Supervisor QC PASS |
| `HANDYMAN_FINAL_CLOSE_NOT_AUTHORIZED` | `403` | Caller is an executing crew member or assigned field inspector on the scope |
| `HANDYMAN_FINAL_CLOSE_GATE_FAILED` | `409` | One or more mandatory `FINAL CLOSE` gates failed; `error.details` contains the array of `{ code, message }` blockers |
| `HANDYMAN_FINAL_CLOSE_ALREADY_CLOSED` | `409` | Scope is already `CLOSED` and request `idempotencyKey` / `reason` / `actorUserId` does not match the original close event |

### `HANDYMAN_FINAL_CLOSE_GATE_FAILED` Blocker Codes (`error.details[].code`)
- `NO_ACTIVE_CREW_ASSIGNMENT`
- `WORK_SESSION_NOT_COMPLETED`
- `WORK_SESSION_STILL_ACTIVE`
- `MATERIAL_EXECUTION_NOT_SETTLED`
- `MATERIAL_PURCHASE_NOT_RECONCILED`
- `VARIATION_NOT_RECONCILED`
- `SUPERVISOR_QC_NOT_PASSED`
- `OPEN_DEFECT_UNVERIFIED`
- `BAST_NOT_ACCEPTED`
- `BAST_SIGN_OFF_MISSING`
- `LEDGER_TRANSACTION_NOT_OPEN`
- `NO_POSTED_CHARGE_LINES`
- `PENDING_PAYMENT_UNVERIFIED`
- `ONLY_DP_OR_PARTIAL_PAID`
- `OUTSTANDING_BALANCE_UNPAID`
- `UNRECONCILED_OVERPAYMENT_OR_UNALLOCATED_FUNDS`
- `FINAL_INVOICE_NOT_FINALIZED`
- `FINAL_INVOICE_LINES_INCOMPLETE`
- `FINAL_INVOICE_NOT_PAID`
- `OPEN_SETTLEMENT_EXCEPTION`

---

## 6. Read Projections by Frontend Consumer

### 6.1 `Handyman_Customer_Care`
- **Quotation & DP Terms:** `GET /api/v1/handyman/requests/:handymanRequestId/quotation` (`versions[].dpRequired`, `dpPercentage`, `dpAmount`, `dpTermsNotes`).
- **Customer Care Ledger View:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/customer-ledger` (`payments[].obligationStage`, `payments[].status`, `totals`).
- **Customer Care BAST View:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/bast` and `GET /api/v1/handyman/bast/:bastId`.
- **Payment Reporting & Proof Upload:** `POST /api/v1/handyman/care/buildings/:buildingId/requests/:requestId/payments` and `POST .../payments/:paymentId/proof`.

### 6.2 `Handyman_Operations` (Operations, Supervisor, Finance, Manager)
- **Finance Ledger View:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/financial-ledger` (`handyman.finance.read`).
- **Invoice & DP Reconciliation View:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/invoice-reconciliation` (`handyman.finance.read` — includes `quotationDpTerms`, `ledgerSummary`, `invoice` with `dpDeductedAmount`, `variations`, and `history` of quotation versions, BASTs, and invoices).
- **Manager Final Close Readiness & Command:** `GET /api/v1/handyman/execution-scopes/:executionScopeId/final-close/readiness` and `POST /api/v1/handyman/execution-scopes/:executionScopeId/final-close` (`finding.close` + `handyman.finance.read`).

### 6.3 `Handyman_Mobile` (Freelance Lead Worker & Inspector)
- **Worker BAST Read & Commands:** `GET /api/v1/handyman/worker/execution-scopes/:executionScopeId/bast`, `POST .../bast/prepare`, `POST .../bast/:bastId/issue`, `POST .../bast/:bastId/void`.
- **Field Scope Variations:** `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/variations/findings`, `POST .../variations/proposals`, `POST .../variations/:variationId/execution`.
- **Field Evidence Uploads:** `POST /api/v1/handyman/field/evidence/uploads` (`VARIATION_FINDING`, `MATERIAL_RECEIPT`, `INSPECTION_EVIDENCE`, `BEFORE_AFTER_WORK`, `QC_EVIDENCE`).

---

## 7. Remaining `BLOCKED` Gaps

- **None (`0` BLOCKED gaps).** All 11 baseline requirements and all 12 mandatory E2E scenarios in `tests/handyman-e2e-financial-reconciliation-close.test.ts` pass against PostgreSQL 18.

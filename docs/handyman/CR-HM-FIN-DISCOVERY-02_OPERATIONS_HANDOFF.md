# CR-HM-FIN-DISCOVERY-02 — Handyman Operations PR #15 Contract Handoff

- **CR / Track:** `CR-HM-FIN-DISCOVERY-02` — Finance Discovery & Building-Scoped Reports
- **Repository:** `budiirmawan/Handyman-Backend` (branch `arena/4189033f-handyman-backend`, based on `aeaef6dd2a18b242b64169ddb60c8a93d0ab4424`)
- **Primary Consumer:** `budiirmawan/Handyman-Operations` Draft PR #15 (J10 / J12 Finance & Settlement Operations Workspace)
- **Resolved Gap IDs:**
  - `HM-BE-FIN-REPORT-SCOPE` (P0-A — Finance Report Building Isolation)
  - `HM-BE-FIN-DISCOVERY` (P0-B — Authoritative Finance Action Discovery)

All paths below are relative to `API_PREFIX` (normally `/api/v1`). Responses use the standard `{ success: true, data, meta: { requestId } }` and `{ success: false, error: { code, message, details? }, meta: { requestId } }` envelopes.

---

## 1. Exact Endpoint Paths & HTTP Methods

| Capability | Method & Path | Required Permission | Building Scope (BE-02G) |
| --- | --- | --- | --- |
| **P0-B: Finance Action Inbox Discovery** | `GET /handyman/finance/action-inbox` | `handyman.finance.read` | Required (`clientId` + active `user_building_assignments`; optional `buildingId` narrowing) |
| **P0-A: Client Financial Report** | `GET /handyman/financial-transactions` | `handyman.finance.read` | Required (`clientId` + active `user_building_assignments` applied in SQL before `LIMIT`; optional `buildingId` narrowing) |
| **P0-A: Client Customer-Ledger Report** | `GET /handyman/customer-ledger` | `tenant_company.read` or `tenant_company.manage` | Required (`clientId` + active `user_building_assignments` applied in SQL before `LIMIT`; optional `buildingId` narrowing) |
| **Downstream Action: Confirm Reported Payment** | `POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm` | `handyman.finance.manage` | Exact scope Building (`user_building_assignments`) |
| **Downstream Action: Reject Reported Payment** | `POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/reject` | `handyman.finance.manage` | Exact scope Building (`user_building_assignments`) |
| **Downstream Action: Compose Charge Line** | `POST /handyman/execution-scopes/:executionScopeId/customer-charge-lines` | `handyman.finance.manage` | Exact scope Building (`user_building_assignments`) |
| **Downstream Action: Allocate Payment** | `POST /handyman/execution-scopes/:executionScopeId/payment-allocations` | `handyman.finance.manage` | Exact scope Building (`user_building_assignments`) |
| **Downstream Action: Propagate Correction to Settlement** | `POST /handyman/execution-scopes/:executionScopeId/settlement/correction` | `handyman.settlement.manage` | Exact scope Building (`user_building_assignments`) |
| **Downstream Action: Settlement Ladder (`prepare` / `include` / `reconcile` / `settle`)** | `POST /handyman/execution-scopes/:executionScopeId/settlement/:step` | `handyman.settlement.manage` | Exact scope Building (`user_building_assignments`) |

---

## 2. P0-A — Building-Scoped Client Financial Report (`GET /handyman/financial-transactions`)

### Request Query Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | UUID | **Yes** | Target Client ID. |
| `buildingId` | UUID | No | Optional Building ID within `clientId`. When omitted, returns transactions across **only** the caller's actively assigned Buildings in `clientId`. When provided, narrows to that exact Building (or fails with `403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` if the caller lacks active assignment to `buildingId`). |
| `asOf` | ISO-8601 date-time | No | Point-in-time read timestamp (`<= asOf`). Defaults to server `NOW()`. |
| `limit` | integer (`1..200`) | No | Maximum transactions to return (default `50`, capped at `200`). |

> **Security invariant:** Query parameter `actorUserId` is **rejected with `400 VALIDATION_ERROR`** if supplied. The server binds `actorUserId` strictly from the authenticated session (`req.auth.userId`).

### Building Isolation Semantics

1. **Pre-query gate:** `canAccessBuildingScopedResource(actorUserId, { clientId, buildingId })` verifies active Client/Building assignment before querying. If `buildingId` is outside the caller's active `user_building_assignments`, the endpoint returns `403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` with no data, no totals, and no metadata leakage.
2. **In-query SQL filter before pagination and aggregation:** The `tx` CTE in `readClientBasisRows` joins `handyman_execution_scopes s ON s.id = t.execution_scope_id` and enforces:
   - `($4::uuid IS NULL OR s.building_id = $4::uuid)`
   - `EXISTS (SELECT 1 FROM user_building_assignments uba INNER JOIN buildings b ON b.id = uba.building_id WHERE uba.user_id = $5::uuid AND uba.building_id = s.building_id AND uba.status = 'ACTIVE' AND b.client_id = t.client_id)`
   before `ORDER BY t.opened_at ASC, t.id ASC LIMIT $3`.
3. **Downstream derivation:** Because `readHandymanFinancialClientAt` (`GET /handyman/financial-transactions`) and `readHandymanLedgerClientBasisAt` (`GET /handyman/customer-ledger`) both source their basis from `readClientBasisRows`, every returned transaction, charge line, payment, allocation, entitlement fact, aggregate total (`totals.gross`, `totals.netConfirmedPaid`, `totals.netAllocated`, `totals.unappliedConfirmedCash`, `totals.outstandingReceivable`, `totals.entitlementSummary`), and `transactionCount` reflects **only** the caller's authorized Buildings.
4. **Multi-Building support:** A Finance reader assigned to Buildings B1 and B2 within Client A receives combined reporting across B1 and B2 when `buildingId` is omitted, or single-Building reporting when `buildingId=B1` or `buildingId=B2` is passed, while transactions in unassigned sibling Building B3 are completely excluded.

---

## 3. P0-B — Authoritative Finance Action Inbox (`GET /handyman/finance/action-inbox`)

### Request Query Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | UUID | **Yes** | Target Client ID. |
| `buildingId` | UUID | No | Optional Building ID filter within `clientId`. |
| `tenantCompanyId` | UUID | No | Optional Tenant Company ID filter within `clientId`. |
| `executionScopeId` | UUID | No | Optional Execution Scope ID filter. |
| `handymanRequestId` | UUID | No | Optional Handyman Request ID filter. |
| `transactionId` | UUID | No | Optional Customer Transaction ID filter. |
| `recordType` | enum | No | `CUSTOMER_PAYMENT` \| `LEDGER_CORRECTION` \| `SETTLEMENT_UNIT` \| `CUSTOMER_TRANSACTION` |
| `actionCategory` | enum | No | `PAYMENT_VERIFICATION` \| `PAYMENT_ALLOCATION` \| `PENDING_CORRECTION` \| `PENDING_RECONCILIATION` \| `FINANCE_BLOCKER` |
| `recordStatus` | enum | No | Exact authoritative status filter (`PENDING`, `CONFIRMED`, `REFUND`, `REVERSAL`, `ADJUSTMENT`, `PAYABLE`, `INCLUDED_IN_SETTLEMENT`, `SETTLED`, `LEDGER_ONLY`). |
| `blockerCode` | enum | No | Exact blocker code filter (`NO_POSTED_CHARGE_FACTS`, `PROVISIONAL_PAYMENTS_PENDING`, `FUNDING_SHORTFALL`, `INCLUSION_MISMATCH`, `LEDGER_BASIS_MISMATCH`, `OPEN_EXCEPTION`). |
| `hasBlocker` | boolean (`true`\|`false`) | No | `true` = only items where `blockerCode IS NOT NULL`; `false` = only items where `blockerCode IS NULL`. |
| `responsiblePermission` | enum | No | `handyman.finance.manage` \| `handyman.settlement.manage` |
| `createdFrom` | ISO-8601 date-time | No | Inclusive lower bound on `createdAt`. |
| `createdTo` | ISO-8601 date-time | No | Inclusive upper bound on `createdAt` (`createdFrom <= createdTo`). |
| `includeCounts` | boolean (`true`\|`false`) | No | When `true`, computes `data.counts` over the **complete authorized and filtered result set** (independent of `limit`/`cursor`). When `false` or omitted, `data.counts` is omitted (`undefined`). |
| `limit` | integer (`1..100`) | No | Page size (default `20`, max `100`). |
| `cursor` | string (base64url) | No | Opaque keyset continuation cursor returned in `data.pagination.nextCursor`. |

Unknown query parameters or smuggled identity fields (such as `actorUserId`) are rejected with `400 VALIDATION_ERROR`.

### Authoritative Discovery Sources (4 Branches, Deduplicated)

Every item in `data.items` is backed by an existing database row and its authoritative state—never fabricated UI status and never requiring N+1 scans over the generic Operations request queue:

1. **Branch 1 — `CUSTOMER_PAYMENT` (`handyman_customer_payments`)**
   - **Customer-reported payments awaiting Finance verification (`status = 'PENDING'`):**
     - `actionCategory`: `'PAYMENT_VERIFICATION'`
     - `recordStatus`: `'PENDING'`
     - `blockerCode`: `'PROVISIONAL_PAYMENTS_PENDING'`
     - `responsible`: `{ permission: 'handyman.finance.manage', action: 'VERIFY_CUSTOMER_PAYMENT' }`
     - `provenance`: includes `paymentId`, `paymentStatus`, `paymentChannel`, `paymentReference`, `paymentProofEvidenceId` (resolved strictly from `evidence_submissions` where `execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'`, `execution_id = payment.id`, `client_id = payment.client_id`, `status = 'ACTIVE'`, `evidence_type IN ('PHOTO', 'DOCUMENT')`, `file_reference = 'evidence/' || id::text`, `file_size > 0`, and `content_sha256 IS NOT NULL`), and `recordedByUserId`.
   - **Confirmed payments with unallocated balance (`status = 'CONFIRMED'`, not reversed by `REVERSAL`, `amount - (allocated_gross - reversed_allocated) > 0`):**
     - `actionCategory`: `'PAYMENT_ALLOCATION'`
     - `recordStatus`: `'CONFIRMED'`
     - `allocationState`: `'UNALLOCATED'` (`allocatedAmount == '0.00'`) or `'PARTIALLY_ALLOCATED'` (`0 < allocatedAmount < amount`). Reversing an allocation (`REVERSAL` with `source_kind = 'ALLOCATION'`) nets out `reversed_allocated` and automatically returns the payment to `PAYMENT_ALLOCATION`.
     - `blockerCode`: `'NO_POSTED_CHARGE_FACTS'` if the transaction currently has `0` charge lines; otherwise `null`
     - `responsible`: `{ permission: 'handyman.finance.manage', action: 'ALLOCATE_CUSTOMER_PAYMENT' }`

2. **Branch 2 — `LEDGER_CORRECTION` (`handyman_ledger_corrections`)**
   - **Post-settlement or settlement-linked `REFUND | REVERSAL | ADJUSTMENT` rows whose `ledger_correction_id` has not yet been recorded in `handyman_settlement_exceptions` via `POST /handyman/execution-scopes/:executionScopeId/settlement/correction`:**
     - `actionCategory`: `'PENDING_CORRECTION'`
     - `recordStatus`: `correction_kind` (`'REFUND'` \| `'REVERSAL'` \| `'ADJUSTMENT'`)
     - `blockerCode`: `null`
     - `responsible`: `{ permission: 'handyman.settlement.manage', action: 'RECORD_SETTLEMENT_CORRECTION' }`
     - `provenance`: includes `ledgerCorrectionId`, `correctionKind`, `correctionSourceKind`, `entitlementCorrectionPending`, `settlementCorrectionPending: true`, `settlementUnitId`, and `settlementState`.

3. **Branch 3 — `SETTLEMENT_UNIT` (`handyman_settlement_units`)**
   - **Settlement units not yet in terminal clean state (`SETTLED` with latest reconciliation `MATCHED` and `0` exceptions):**
     - When latest reconciliation outcome is `'VARIANCE'` or `open_exception_count > 0`:
       - `actionCategory`: `'FINANCE_BLOCKER'`
       - `blockerCode`: `variance_cause` (`'FUNDING_SHORTFALL'`, `'INCLUSION_MISMATCH'`, `'LEDGER_BASIS_MISMATCH'`, `'OPEN_EXCEPTION'`) or `'OPEN_EXCEPTION'`
     - Otherwise (`PAYABLE`, `INCLUDED_IN_SETTLEMENT` awaiting reconciliation, or `INCLUDED_IN_SETTLEMENT` with `MATCHED` reconciliation awaiting `settle`):
       - `actionCategory`: `'PENDING_RECONCILIATION'`
       - `blockerCode`: `null`
     - `responsible`:
       - `latest_recon.outcome === 'VARIANCE'` and `variance_cause === 'FUNDING_SHORTFALL'` -> `{ permission: 'handyman.finance.manage', action: 'RESOLVE_FUNDING_SHORTFALL' }`
       - `latest_recon.outcome === 'VARIANCE'` -> `{ permission: 'handyman.settlement.manage', action: 'RESOLVE_SETTLEMENT_VARIANCE' }`
       - `open_exception_count > 0` -> `{ permission: 'handyman.settlement.manage', action: 'RECONCILE_SETTLEMENT_UNIT' }`
       - `recordStatus === 'PAYABLE'` -> `{ permission: 'handyman.settlement.manage', action: 'INCLUDE_IN_SETTLEMENT' }`
       - `latest_recon === null` or `latest_recon.occurred_at < latest_ev.occurred_at` -> `{ permission: 'handyman.settlement.manage', action: 'RECONCILE_SETTLEMENT_UNIT' }`
       - Otherwise -> `{ permission: 'handyman.settlement.manage', action: 'SETTLE_SETTLEMENT_UNIT' }`

4. **Branch 4 — `CUSTOMER_TRANSACTION` (`handyman_customer_transactions`)**
   - **Opened customer transactions (`status = 'LEDGER_ONLY'`) with zero `handyman_charge_lines`:**
     - `actionCategory`: `'FINANCE_BLOCKER'`
     - `recordStatus`: `'LEDGER_ONLY'`
     - `blockerCode`: `'NO_POSTED_CHARGE_FACTS'`
     - `responsible`: `{ permission: 'handyman.finance.manage', action: 'COMPOSE_CHARGE_LINES' }`

### Payment Proof Evidence Provenance Boundary (Migration `0433`)

- `provenance.paymentProofEvidenceId` is populated **only** when an authoritative row exists in `evidence_submissions` satisfying all of:
  - `execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'`
  - `execution_id = handyman_customer_payments.id`
  - `client_id = handyman_customer_payments.client_id`
  - `status = 'ACTIVE'`
  - `evidence_type IN ('PHOTO', 'DOCUMENT')`
  - `file_reference = 'evidence/' || id::text`, `file_size > 0`, and `content_sha256 IS NOT NULL`
- The database trigger `handyman_customer_payment_proof_guard()` (`0433_handyman_customer_payment_proof`) enforces that such an evidence row can only be created against a `PENDING` payment linked to a `FINALIZED` `tenant_invoices` row (`handyman_execution_scope_id = execution_scope_id`) with `HANDYMAN_CHARGE` invoice lines, via the Care Workspace upload contract (`POST /handyman/care/requests/:requestId/invoices/:invoiceId/payments/:paymentId/proof`).
- Generic field evidence (`handyman_field_evidence`), `WORK_ORDER` or `HANDYMAN_REQUEST` attachments in `evidence_submissions`, and `REMOVED` payment proofs are **never** inferred or substituted as payment proof.
- When a payment is recorded via Operations Customer Care (`POST /handyman/execution-scopes/:executionScopeId/customer-payments`) without a bound `HANDYMAN_CUSTOMER_PAYMENT` evidence submission, `provenance.paymentProofEvidenceId` truthfully remains `null`.

### Response Schema (`200 OK`)

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "recordId": "8f5c2d9a-4d3a-4b9c-9a1e-1d2e3f4a5b6c",
        "recordType": "CUSTOMER_PAYMENT",
        "recordStatus": "PENDING",
        "actionCategory": "PAYMENT_VERIFICATION",
        "blockerCode": "PROVISIONAL_PAYMENTS_PENDING",
        "executionScopeId": "33333333-4444-4555-8666-777777777777",
        "handymanRequestId": "44444444-5555-4666-8777-888888888888",
        "transactionId": "55555555-6666-4777-8888-999999999999",
        "clientId": "11111111-2222-4333-8444-555555555555",
        "buildingId": "22222222-3333-4444-8555-666666666666",
        "tenantCompanyId": "66666666-7777-4888-8999-000000000000",
        "currency": "IDR",
        "amount": "150.00",
        "allocatedAmount": "0.00",
        "unallocatedAmount": "0.00",
        "allocationState": null,
        "responsible": {
          "permission": "handyman.finance.manage",
          "action": "VERIFY_CUSTOMER_PAYMENT"
        },
        "provenance": {
          "paymentId": "8f5c2d9a-4d3a-4b9c-9a1e-1d2e3f4a5b6c",
          "paymentStatus": "PENDING",
          "paymentChannel": "BANK_TRANSFER",
          "paymentReference": "EXT-MDR-001",
          "recordedByUserId": "77777777-8888-4999-8000-111111111111",
          "paymentProofEvidenceId": null,
          "ledgerCorrectionId": null,
          "correctionKind": null,
          "correctionSourceKind": null,
          "entitlementCorrectionPending": false,
          "settlementCorrectionPending": false,
          "settlementUnitId": null,
          "settlementState": null,
          "reconciliationId": null,
          "reconciliationOutcome": null,
          "varianceCause": null,
          "varianceAmount": null,
          "openExceptionCount": 0
        },
        "createdAt": "2026-10-15T10:15:30.000Z",
        "updatedAt": "2026-10-15T10:15:30.000Z"
      }
    ],
    "pagination": {
      "limit": 20,
      "nextCursor": null,
      "hasMore": false
    },
    "counts": {
      "total": 1,
      "byActionCategory": {
        "PAYMENT_VERIFICATION": 1,
        "PAYMENT_ALLOCATION": 0,
        "PENDING_CORRECTION": 0,
        "PENDING_RECONCILIATION": 0,
        "FINANCE_BLOCKER": 0
      },
      "byRecordType": {
        "CUSTOMER_PAYMENT": 1,
        "LEDGER_CORRECTION": 0,
        "SETTLEMENT_UNIT": 0,
        "CUSTOMER_TRANSACTION": 0
      },
      "byRecordStatus": {
        "PENDING": 1
      },
      "byBlockerCode": {
        "PROVISIONAL_PAYMENTS_PENDING": 1
      },
      "byResponsiblePermission": {
        "handyman.finance.manage": 1,
        "handyman.settlement.manage": 0
      }
    }
  },
  "meta": {
    "requestId": "c81e728d-9d4c-42f6-b36e-7f8a9b0c1d2e"
  }
}
```

### Pagination & Count Semantics

1. **Deterministic Keyset Ordering:** Rows are ordered by `(created_at DESC, record_type DESC, record_id DESC)`.
2. **Opaque Continuation Cursor:** `pagination.nextCursor` encodes `{ createdAt, recordType, recordId }` as base64url JSON. Pass `cursor=<nextCursor>` on subsequent requests with the same filters. When `pagination.hasMore === false`, `pagination.nextCursor` is `null`.
3. **Mid-Walk Insertion Stability:** Because continuation uses keyset comparisons `(created_at < cursor.createdAt) OR (created_at = cursor.createdAt AND (record_type < cursor.recordType OR (record_type = cursor.recordType AND record_id < cursor.recordId)))`, newly created records with newer `created_at` timestamps sort ahead of the cursor and never cause duplicate rows or skipped rows in an in-flight continuation walk.
4. **Full-Result-Set Counts vs. Omitted Counts:**
   - When `includeCounts=false` (or omitted), `data.counts` is omitted (`undefined`).
   - When `includeCounts=true`, `data.counts` (`total`, `byActionCategory`, `byRecordType`, `byRecordStatus`, `byBlockerCode`, `byResponsiblePermission`) is computed by a separate aggregate query over the **entire authorized and filtered result set**—never over the current `limit` page slice.

---

## 4. Persona Separation & Required Permissions

| Persona | Granted Permissions | Allowed Capabilities | Explicitly Denied (`403`) |
| --- | --- | --- | --- |
| **Customer Care** | `tenant_company.read`, `tenant_company.manage` + active Building assignment | Record customer-reported payment (`POST .../customer-payments` -> creates `PENDING`), read customer ledger (`GET /handyman/customer-ledger`, `GET .../customer-ledger`) | `GET /handyman/finance/action-inbox`, `GET /handyman/financial-transactions`, payment `confirm`/`reject`, charge composition, allocations, refunds/reversals/adjustments, entitlement derivation, settlement |
| **Finance Reader** | `handyman.finance.read` + active Building assignment | `GET /handyman/finance/action-inbox`, `GET /handyman/financial-transactions`, `GET .../financial-transaction` | All Finance, Commercial, and Settlement mutations |
| **Finance Manager** | `handyman.finance.read`, `handyman.finance.manage` + active Building assignment | All Finance Reader reads + payment `confirm`/`reject`, open transaction, compose charge line, allocate payment, reverse allocation, refund, payment reversal, charge adjustment, derive entitlements | Commercial agreement authoring (`handyman.commercial.manage`), Settlement ladder (`handyman.settlement.manage`) |
| **Commercial Manager** | `handyman.commercial.manage` + active Building assignment | Author & activate commercial agreements (`POST /handyman/commercial-agreements*`) | Finance reads/writes (`handyman.finance.*`), Settlement ladder (`handyman.settlement.manage`) |
| **Settlement Manager** | `handyman.finance.read`, `handyman.settlement.manage` + active Building assignment | Finance reads + `POST .../settlement/prepare`, `include`, `reconcile`, `settle`, `correction` | Customer payment confirmation/rejection, allocations, refunds/reversals/adjustments (`handyman.finance.manage`) |
| **Platform Admin (Default Seed)** | `PLATFORM_ADMIN` foundation seed (withholds `handyman.commercial.manage`, `handyman.finance.read`, `handyman.finance.manage`, `handyman.settlement.manage`) | Platform administration only | Denied on all Finance reads, Finance mutations, Commercial mutations, and Settlement mutations unless explicitly granted the domain permission and active Building assignment |

---

## 5. Error Handling Matrix (`400` / `401` / `403` / `404` / `409`)

| HTTP Status | Error Code | Condition |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Missing or non-UUID `clientId`, invalid `buildingId`/`executionScopeId`/`transactionId`, unknown query parameter (including smuggled `actorUserId`), invalid enum filter, `createdFrom > createdTo`, invalid `limit` (`< 1` or `> 100` on inbox; `< 1` or `> 200` on financial report), or malformed `cursor`. |
| `401` | `AUTHENTICATION_REQUIRED` | Missing, expired, or invalid bearer session token. |
| `403` | `PERMISSION_DENIED` | Authenticated user lacks required permission (`handyman.finance.read` on inbox/report, `handyman.finance.manage` on finance mutations, `handyman.settlement.manage` on settlement mutations). |
| `403` | `BUILDING_ACCESS_DENIED` | On `GET /handyman/finance/action-inbox`: authenticated user has no active `user_building_assignments` in `clientId`, or requested `buildingId` is outside their active Building assignments. |
| `403` | `HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` | On `GET /handyman/financial-transactions` and `GET /handyman/customer-ledger`: authenticated user lacks active Building assignment for `clientId` / `buildingId`. |
| `404` | `HANDYMAN_*_NOT_FOUND` | Target `executionScopeId`, `paymentId`, `chargeLineId`, or `ledgerCorrectionId` does not exist on downstream action endpoints. |
| `409` | `HANDYMAN_*` conflict codes | Domain state transition conflicts on downstream action endpoints (e.g., confirming a non-`PENDING` payment, over-allocating beyond net payment/charge capacity, settling a unit with `VARIANCE` or open exceptions, or idempotency key payload mismatch). |

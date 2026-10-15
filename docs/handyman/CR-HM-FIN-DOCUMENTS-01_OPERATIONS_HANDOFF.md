# CR-HM-FIN-DOCUMENTS-01 — Payment Proof & Receipt Retrieval (Operations Handoff)

- **CR / Track:** `CR-HM-FIN-DOCUMENTS-01` — Payment Proof & Receipt Retrieval
- **Repository:** `budiirmawan/Handyman-Backend` (branch `arena/37710a19-handyman-backend`)
- **Primary Consumer:** `budiirmawan/Handyman-Operations` Draft PR #15 (Finance verification workspace)
- **Backend reference:** PR #30 MERGED (`main` `8b8bfd829382c690fea90db67c0c2c7a818a1eea`)
- **Resolved gap:** `HM-BE-FIN-DOCUMENT-READ` — Finance could discover
  `provenance.paymentProofEvidenceId` (CR-HM-FIN-DISCOVERY-02) but had **no
  authorized door to the proof metadata or its bytes**. The generic User
  evidence surface deliberately 404s payment proofs, and the Care workspace
  door is customer-side upload only.

All paths below are relative to `API_PREFIX` (normally `/api/v1`). Responses
use the standard `{ success: true, data, meta: { requestId } }` and
`{ success: false, error: { code, message, details? }, meta: { requestId } }`
envelopes.

---

## 1. Actual Retrieval Endpoints

| Capability | Method & Path | Required Permission | Building Scope (BE-02G) |
| --- | --- | --- | --- |
| **Payment-proof metadata** | `GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof` | `handyman.finance.read` | Exact scope Building (`user_building_assignments`) |
| **Payment-proof content (bytes)** | `GET /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/payment-proof/content` | `handyman.finance.read` | Exact scope Building (`user_building_assignments`) |
| **Finance detail read (ledger/charges)** | `GET /handyman/execution-scopes/:executionScopeId/financial-ledger` | `handyman.finance.read` | Exact scope Building (enforced inside `readHandymanLedgerTransactionAt`) |
| Downstream: verify payment | `POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm` / `reject` | `handyman.finance.manage` | Exact scope Building (unchanged) |
| Customer report payment | `POST /handyman/execution-scopes/:executionScopeId/customer-payments` | `tenant_company.manage` | Exact scope Building (unchanged) |
| Customer-side proof upload | `POST /handyman/care/requests/:requestId/invoices/:invoiceId/payments/:paymentId/proof` | Care workspace session (unchanged) | Care grant + occupancy (unchanged) |

**Discovery → retrieval flow for the Finance workspace:**
`GET /handyman/finance/action-inbox` (`handyman.finance.read`) returns
`provenance.paymentProofEvidenceId` (or `null` when no ACTIVE bound proof
exists) → use `executionScopeId` + `recordId` (=`paymentId`) on the two
payment-proof doors above.

---

## 2. IDs and Response Envelope

Path parameters are the frozen CR-HM-13 family ids:

- `executionScopeId` — the payment's execution scope (UUID). Also the
  authority anchor: an unknown scope is a bounded 404
  (`HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND`).
- `paymentId` — `handyman_customer_payments.id` (UUID). Must be anchored on
  the scope's own ledger transaction; any cross-scope/cross-tenant payment id
  is a bounded 404 (`HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND`) and is never
  resolved into a foreign payment fact.

Metadata response (`200`):

```json
{
  "success": true,
  "data": {
    "paymentProof": {
      "paymentId": "8f5c2d9a-…",
      "evidenceId": "a1b2c3d4-…",
      "executionType": "HANDYMAN_CUSTOMER_PAYMENT",
      "executionId": "8f5c2d9a-…",
      "clientId": "11111111-…",
      "evidenceType": "PHOTO",
      "originalFileName": "transfer-receipt.png",
      "mimeType": "image/png",
      "fileSize": 28,
      "contentSha256": "9f86d081…(64 hex)",
      "hashAlgorithm": "SHA-256",
      "status": "ACTIVE",
      "retentionState": "ACTIVE",
      "capturedAt": null,
      "createdAt": "2026-10-15T10:20:00.000Z"
    }
  },
  "meta": { "requestId": "…" }
}
```

Schema: `HandymanCustomerPaymentProofMetadata` in `docs/api/openapi.yaml`
(`additionalProperties: false`). **Never disclosed:** `file_reference` /
storage keys, storage or signed URLs, absolute storage paths, session
tokens, or any credential. `Cache-Control: no-store` on both doors.

---

## 3. MIME / Content Delivery

- `GET …/payment-proof/content` returns the **raw stored bytes** (not a JSON
  envelope) after byte-level validation:
  1. **Existence** — the managed object `evidence/<evidenceId>` must be
     readable in the shared evidence storage (the same boundary the Care
     upload writes through).
  2. **Size** — stored bytes must equal the recorded `file_size`.
  3. **Checksum** — recomputed SHA-256 must equal the authoritative
     upload-time `content_sha256` (migration 0433 makes both immutable).
- Headers: `Content-Type` = stored `mimeType` (`image/jpeg` | `image/png` |
  `image/webp` | `application/pdf` — the only kinds 0433 admits for
  `PHOTO`/`DOCUMENT` proofs), `Content-Length`, `Content-Disposition: inline;
  filename*=UTF-8''<originalFileName>`, `Cache-Control: no-store`.
- Bytes are reachable **only** through this authenticated route. There is no
  public storage URL and no browser bearer-token disclosure anywhere in the
  contract.

---

## 4. Required Permissions (exact)

| Action | Permission | Notes |
| --- | --- | --- |
| Retrieve proof metadata / content | `handyman.finance.read` | PLUS exact-Building assignment to the payment's execution-scope building. `tenant_company.read` is **not** accepted as a substitute. |
| Read ledger/charge detail (one scope) | `handyman.finance.read` | New `financial-ledger` door (§6). |
| Verify (confirm / reject) payment | `handyman.finance.manage` | Unchanged (CR-HM-FIN-AUTH-01). |
| Report (record) payment | `tenant_company.manage` | Unchanged — customer reporting is not Finance verification. |
| Client-wide customer-ledger report | `tenant_company.read` | Unchanged; Finance receives **no** tenant-wide read. |

Scope law: BE-02G — an actor must hold an explicit ACTIVE
`user_building_assignments` grant to the execution scope's **exact**
building. A same-Client sibling-Building assignment is a bounded 403
(`HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED`); a foreign-Client actor is
denied identically with no data leak.

---

## 5. Error Cases (bounded, fail-closed)

| Case | Status | `error.code` |
| --- | --- | --- |
| No / invalid session | 401 | `AUTHENTICATION_REQUIRED` |
| Missing `handyman.finance.read` (incl. `tenant_company.read`-only actors) | 403 | `PERMISSION_DENIED` |
| Sibling-Building or foreign-Client actor | 403 | `HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` |
| Unknown execution scope | 404 | `HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND` |
| Payment not anchored on the scope's transaction (incl. cross-payment / cross-tenant ids) | 404 | `HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND` |
| No ACTIVE bound proof: absent, `REMOVED`, purged, wrong parent (`WORK_ORDER` / `HANDYMAN_REQUEST`), Field Evidence, wrong evidence kind | 404 | `HANDYMAN_PAYMENT_PROOF_NOT_FOUND` (uniform — never inferred, never substituted) |
| Proof row authoritative but stored bytes unavailable | 404 | `EVIDENCE_FILE_NOT_FOUND` (**explicit unavailable state — never a fabricated download**) |
| Stored bytes truncated / checksum mismatch | 409 | `HANDYMAN_PAYMENT_PROOF_INTEGRITY_CONFLICT` (corrupt content is **never** served) |
| Malformed UUID path params | 400 | `VALIDATION_ERROR` |

**Separation invariants (tested):**

- Retrieval is strictly read-only: no payment status transition, no evidence
  status/retention/integrity mutation, no financial fact is written by any
  GET. A payment stays `PENDING` because its proof was read.
- Customer-submitted proof ≠ Finance verification outcome ≠ official
  receipt. Uploading proof never marks a payment confirmed or PAID;
  verification stays `handyman.finance.manage` (confirm/reject); reading a
  proof never verifies anything.

---

## 6. Finance Detailed Read Permission — Audit Outcome

**Question:** why do detailed ledger/charge reads require `tenant_company.read`
"in addition to" `handyman.finance.read`?

**Finding:** it is **not** an intended dual-permission requirement. The two
surfaces were gated separately and never reconciled:

- `GET /handyman/execution-scopes/:id/customer-ledger` and
  `GET /handyman/customer-ledger` (CR-HM-13 published read contract, mounted
  by CR-HM-17 GAP PART 05) require **`tenant_company.read` only** — that gate
  is frozen and is unchanged by this CR.
- Finance financial reads (`financial-transaction`, `financial-transactions`,
  `action-inbox`) require **`handyman.finance.read` only** (CR-HM-FIN-AUTH-01).

Consequence before this CR: a Finance verifier holding
`handyman.finance.read` + `handyman.finance.manage` could discover and
verify payments but could not read the charge-line/payment **detail** of the
transaction being verified without also holding the tenant-wide
`tenant_company.read`.

**Decision applied (minimal, safely scoped — no tenant-wide grant):** the
frozen CR-HM-13 read service (`readHandymanLedgerTransactionAt`, read-only,
with its own exact-Building wall) is now exposed on the Finance surface as
`GET /handyman/execution-scopes/:executionScopeId/financial-ledger` behind
`handyman.finance.read` — **one execution scope at a time**. No existing
gate was changed and `GET /handyman/customer-ledger` (client-wide) remains
`tenant_company.read`-only: Finance receives no tenant-wide read. Operations
may adopt this door instead of provisioning `tenant_company.read` to Finance
roles.

---

## 7. Official Payment Receipt — Capability Gap (not implemented here)

Audit result: **no distinct official receipt artifact exists for a Handyman
customer payment**, and none is manufactured by this CR.

- The customer-submitted proof is an `evidence_submissions` fact (0433),
  nothing more: it is **not** a receipt and does not mark anything PAID.
- The Finance verification outcome is the ledger decision
  (`CONFIRMED` / `REJECTED` on `handyman_customer_payments`) — a separate
  fact with its own authority (`handyman.finance.manage`).
- The existing `payment_receipts` module (BE-19F,
  `POST /tenant-invoices/:invoiceId/receipts`, `payment_receipt.manage`) is a
  **different** capability: receipts of recorded settlement against
  `invoice_payment_status` for tenant invoices. No code path issues one from
  a `handyman_customer_payments` CONFIRMED fact, and none is auto-issued on
  confirmation.

**Gap id `HM-BE-FIN-RECEIPT`:** issuing an official, numbered payment
receipt bound to a confirmed Handyman customer payment (naming, numbering,
issuer authority, void semantics, tenant-invoice reconciliation) requires a
separate product/authority decision and is out of scope of this retrieval
contract. Operations must not treat the retrieved proof screenshot as an
official receipt.

---

## 8. Validation Summary (this change)

- `npm run typecheck` — PASS.
- Focused PostgreSQL suite `tests/handyman-payment-proof-read.test.ts`
  (disposable embedded PostgreSQL + isolated evidence storage) — **7/7
  PASS**: authorized retrieval (metadata + authentic bytes), exact-payment
  binding / wrong-payment 404s, authentication + permission + Client/Building
  denials, generic Field Evidence / `HANDYMAN_REQUEST` / REMOVED non-serving,
  missing bytes (explicit unavailable) + corrupt/truncated bytes (409),
  Finance-only detail read without `tenant_company.read` (and unchanged
  tenant doors), zero mutations from GET with reporting/verification kept
  separate (plus action-inbox discovery regression).
- OpenAPI: `tests/handyman-payment-proof-openapi.test.ts` 3/3 PASS;
  `tests/openapi-contract.test.ts` 6/6 PASS (spec ↔ runtime parity).
- No production migrations, no deployment, no Operations-repository changes.

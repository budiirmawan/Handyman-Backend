# CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Finance Bank Receipt Attestation — Backend Gap Closure & API Handoff

- **Document ID:** `CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01`
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/6105302d-handyman-backend`
- **Additive Migration:** `src/database/migrations/0459_handyman_bank_receipt_attestation.ts`
- **Focused Verification Suite:** `tests/handyman-bank-receipt-attestation.test.ts`
- **Target Consumers:** `Handyman_Operations` (Finance, Handyman Manager), `Handyman_Mobile` (read-only), Frontend / API consumers
- **Supersedes Nothing:** Extends `0458` without rebuilding payment engine, ledger, BAST, invoice, or Manager FINAL CLOSE.

---

## 1. Audit — Gap Confirmed

| Area | Files / Migrations Audited | Pre-CR State | Gap |
|------|----------------------------|--------------|-----|
| Customer ledger confirm | `handyman-customer-payments/handyman-customer-payment.service.ts:decide()`, `handyman-customer-ledger-api.validation.ts:parseConfirmCustomerPaymentBody`, `0458` | `POST /handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm` accepted only `{idempotencyKey}`; `decidePayment` updated `status/decided_at/decided_by` only; no bank fields. | Finance could mark any `PENDING` as `CONFIRMED` without proving destination account or bank reference. |
| Bank destination config | `grep bank_account|payment_destination` across all migrations `0391-0458`, `0406` commercial agreements (aggregate root `handyman_commercial_agreement*`), `0412` payments | `0406` stores only agreement lifecycle (`PREPARE/ACTIVATE/SUPERSEDED` window overlap guard); `0412` stores `channel/amount/currency/provider free-text/externalReference UNIQUE per transactionId`; no `payment_destination` table; `client_configurations` generic KV exists but no bank key defined. | No configured OWNED bank account (client/building) to validate against. |
| Payment proof | `handyman-payment-proof` service `468 lines`, `0433` `0503` migration, `handyman-payment-proof.routes` | `PHOTO/DOCUMENT` byte-verified evidence, SHA256, retention; READ via `handyman.finance.read`; separate from bank attestation. | Must remain separate — a receipt photo is not a bank attestation. No overlap. |
| Ledger allocation | `handyman-payment-allocation.service` `471 lines`, `handyman-customer-ledger-read` `574 lines` | Allocation requires `status CONFIRMED + invoice FINALIZED`; gross/net cents authoritative. | No attestation tie-in existed. |
| FINAL CLOSE guards | `handyman-finance-close-api.routes.ts`, `0458` `handyman_execution_scopes` `closed_*`, `handyman_execution_scope_close_events` | `J10-J12` seams: `finding.close` + `handyman.finance.read` + exact-Building + non-field actor + `FOR UPDATE` lock; requires `PAID` invoice + 10 gates. | DP `VERIFIED` stayed `AUTHORIZED`, not `CLOSED`. Must remain. |
| Permissions | `0448_handyman_finance_authority_permissions` `0455` | `handyman.finance.read/manage`, `handyman.finance.settlement.manage`, `handyman.commercial.manage`, `finding.close` — none granted by default. | Reuse existing; no new permission code. |
| Error vocabulary | `src/shared/errors.ts` `3196` lines | No `HANDYMAN_BANK_*` codes. | 9 codes added. |

**Outcome:** Gap confirmed. Confirm path required 7-field Finance attestation + destination ownership + amount vs obligation + duplicate/replay/cross-tenant guards, immutable audit trail.

---

## 2. Gap Closure — What Was Added (Additive Only)

### 2.1 Database — Migration `0459_handyman_bank_receipt_attestation.ts`

```sql
handyman_bank_accounts (
  id UUID PK,
  client_id FK clients,
  building_id FK buildings NULLABLE + handyman_bank_account_building_consistency trigger,
  bank_name 1..100, account_number 1..64, account_holder_name 1..200,
  display_name 1..200, currency ENUM IDR/USD/SGD/MYR/AUD/EUR/GBP/JPY/CNY,
  is_active BOOL, created_by_user_id, created_at, updated_at,
  UNIQUE(client_id, bank_name, account_number),
  INDEX client_id, building_id
)

handyman_bank_receipt_attestations (
  id UUID PK,
  client_id FK clients,
  transaction_id FK handyman_customer_transactions,
  payment_id FK handyman_customer_payments UNIQUE — 1:1 with payment
  destination_bank_account_id FK handyman_bank_accounts,
  bank_transaction_id 1..200, amount_credited NUMERIC(18,2) >0, currency, bank_credited_at TIMESTAMPTZ <= NOW() AND >= NOW()-5y,
  verified_by_user_id FK users, verified_at TIMESTAMPTZ NOW(),
  bank_statement_evidence_ref 1..500 NULLABLE, created_at,
  UNIQUE(client_id, bank_transaction_id) — replay guard (duplicate bank ref 409),
  INDEX transaction_id, payment_id
)

Triggers:
  handyman_bank_receipt_attestation_consistency():
    - client/transaction/currency/account_active/amount==payment checks
    - building consistency: if destination account is building-scoped then scope building must match
  handyman_bank_receipt_attestation_block_mutation(): immutable append-only
Down: drops attestation table then bank accounts + helpers.
```

- Historical `CONFIRMED` payments (pre-0459) are **grandfathered**: no retroactive attestation required; they remain readable and allocation-eligible (ledger-authoritative law).
- Deactivating a bank account (`is_active=FALSE`) blocks future attestations but does not invalidate past ones.

### 2.2 Error Codes — `src/shared/errors.ts`

| Code | HTTP | When |
|------|------|------|
| `HANDYMAN_BANK_ACCOUNT_NOT_FOUND` | 404 | Destination account ID unknown |
| `HANDYMAN_BANK_ACCOUNT_CONFLICT` | 409 | Duplicate `(client, bank, account)` |
| `HANDYMAN_BANK_ACCOUNT_INVALID` | 400 | Validation on create/list |
| `HANDYMAN_BANK_ACCOUNT_NOT_AUTHORIZED` | 403 | Account belongs to other client or building-scoped mismatch |
| `HANDYMAN_BANK_RECEIPT_ATTESTATION_REQUIRED` | 400 | Confirm without attestation |
| `HANDYMAN_BANK_RECEIPT_ATTESTATION_INVALID` | 400 | Attestation field invalid |
| `HANDYMAN_BANK_RECEIPT_ATTESTATION_CONFLICT` | 409 | Payment already attested / currency mismatch / inactive account |
| `HANDYMAN_BANK_RECEIPT_DUPLICATE_REFERENCE` | 409 | `bankTransactionId` replayed within same `client_id` |
| `HANDYMAN_BANK_RECEIPT_AMOUNT_MISMATCH` | 409 | `amountCredited != payment.amount` (cents-exact) |

### 2.3 Domain — Modules Added

```
src/modules/handyman-bank-accounts/
  handyman-bank-account.types.ts        — maskedAccountNumber = ****last4
  handyman-bank-account.errors.ts
  handyman-bank-account.repository.ts   — insert/find/list/deactivate
  handyman-bank-account.service.ts      — client/building validation, canAccessBuildingScopedResource wall
  handyman-bank-account.routes.ts       — CRUD + list + deactivate

src/modules/handyman-bank-receipt-attestations/
  handyman-bank-receipt-attestation.types.ts
  handyman-bank-receipt-attestation.errors.ts
  handyman-bank-receipt-attestation.repository.ts
  handyman-bank-receipt-attestation.service.ts — parse helpers, read helpers
  handyman-bank-receipt-attestation.routes.ts  — read by payment/tx
```

### 2.4 Extended Flow — `handyman-customer-payments` + Ledger API

**Types extended:**

```ts
type ConfirmHandymanCustomerPaymentInput = {
  executionScopeId: string;
  paymentId: string;
  idempotencyKey: string;
  bankReceiptAttestation?: {           // NEW — required for CONFIRM
    destinationBankAccountId: string;   // UUID of handyman_bank_accounts
    bankTransactionId: string;          // 1..200 — bank's reference, UNIQUE per client
    amountCredited: string;             // canonical "NNN.NN" — must == payment.amount
    bankCreditedAt: string;             // ISO — not future, within 5y
    bankStatementEvidenceRef?: string | null; // 1..500, private, never logged as full account number
  };
};
```

**Service `decide()` (inside `withTransaction` with `FOR UPDATE` on `handyman_customer_transactions`):**

1. Authority preamble: `handymanExecutionScopeRepository.findScopeById` → `canAccessBuildingScopedResource` (exact-Building, `403`).
2. Idempotency replay check (same `transactionId + eventType + key` → return existing payment, `replayed:true` — deterministic even if attestation differs on replay).
3. If `decision === 'CONFIRMED'`:
   - Require `bankReceiptAttestation` else `400 ATTESTATION_REQUIRED`.
   - Validate fields (UUID, 1..200, MONEY_PATTERN, future block).
   - Fetch destination account → `404` if missing; `403` if `account.clientId != tx clientId`; `409` if inactive; `403` if building-scoped mismatch; `409` if currency mismatch.
   - Check duplicate `bank_transaction_id` per client (`409 DUPLICATE_REFERENCE`).
   - Ensure `toCents(amountCredited) === toCents(payment.amount)` else `409 AMOUNT_MISMATCH`.
   - `INSERT INTO handyman_bank_receipt_attestations ...` (FKs + UNIQUEs + trigger consistency); map UNIQUE violation → `409`.
   - Then `decidePayment` (`CONFIRMED`) + `appendPaymentEvent`.
4. `REJECT` path unchanged (no attestation required).

**Validation `parseConfirmCustomerPaymentBody`:**

- Still parses `idempotencyKey` as before.
- Optionally parses `bankReceiptAttestation` from `bankReceiptAttestation` | `bankReceipt` | `attestation` envelope, or flat top-level fields (`destinationBankAccountId`, `bankTransactionId`/`bankReferenceId`, `amountCredited`/`amount`, `bankCreditedAt`/`bankCreditDate`, `bankStatementEvidenceRef`).
- If any attestation field present → strict validation; returns ISO-normalized `bankCreditedAt`.
- If absent → `bankReceiptAttestation: null` — service throws `400 ATTESTATION_REQUIRED` (domain code, not generic 400).

**Controller `postConfirmCustomerPaymentHandler`:**

```ts
const body = parseConfirmCustomerPaymentBody(req.body);
await confirmHandymanCustomerPayment({
  executionScopeId, paymentId, idempotencyKey: body.idempotencyKey,
  ...(body.bankReceiptAttestation ? { bankReceiptAttestation: body.bankReceiptAttestation } : {}),
}, actor(req));
```

Sensitive `account_number` is **never** returned via API and never logged — only `maskedAccountNumber = ****last4` is exposed in reads/events.

### 2.5 HTTP — Registered in `src/routes/index.ts`

| Method | Path | Auth | Permission | Description |
|--------|------|------|------------|-------------|
| `POST` | `/api/v1/handyman/bank-accounts` | yes | `handyman.finance.manage` | Create destination account (client/building scoped) |
| `GET`  | `/api/v1/handyman/bank-accounts?clientId=&buildingId=&includeInactive=` | yes | `handyman.finance.read` | List accounts (masked) |
| `GET`  | `/api/v1/handyman/bank-accounts/:accountId` | yes | `handyman.finance.read` | Get one (masked) |
| `POST` | `/api/v1/handyman/bank-accounts/:accountId/deactivate` | yes | `handyman.finance.manage` | Deactivate |
| `GET`  | `/api/v1/handyman/bank-receipt-attestations/by-payment/:paymentId` | yes | `handyman.finance.read` | Read attestation for payment |
| `GET`  | `/api/v1/handyman/bank-receipt-attestations/by-transaction/:transactionId` | yes | `handyman.finance.read` | List attestations for tx |
| `POST` | `/api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm` | yes | `handyman.finance.manage` + exact-Building | **Extended** — now requires 7-field attestation |

All new routes enforce `canAccessBuildingScopedResource` (exact-Building) and client isolation.

---

## 3. What Is Preserved (Not Rebuilt)

| Preservation | How |
|--------------|-----|
| Payment engine | `0412` lifecycle `PENDING→CONFIRMED|REJECTED` one-way, ledger-authoritative; notifications never authority |
| Ledger allocations | DP/TERMIN/PELUNASAN `obligationStage`; `CONFIRMED + invoice FINALIZED` required for allocation; gross/net cents authoritative |
| Invoice | `0432` `handyman_charge_tenant_invoice_source` UNIQUE partial index; tenant-invoices remain source of truth |
| BAST | `0432` `invoice.reconciliation` deducts allocated DP once; BAST re-prep after rejection still requires fresh QC PASS (`0445` + `0458`) |
| Manager FINAL CLOSE | `0395` `handyman_execution_scopes.closed_*` + `handyman_execution_scope_close_events` append-only; `GET readiness` + `POST final-close` with `finding.close + handyman.finance.read` + exact-Building + non-field guard + `FOR UPDATE` + PAID + 10 gates; `DP VERIFIED` stays `AUTHORIZED` not `CLOSED` |
| Care proof | `0433` `handyman_customer_payment_proof` PHOTO/DOCUMENT byte-checked, SHA256, separate table — untouched |
| Commercial agreements | `0406` `handyman_commercial_agreement*` — pricing/bank columns forbidden, only `PREPARE/ACTIVATE/SUPERSEDED` window overlap guard |
| DP/TERMIN/PELUNASAN | Allocation stage vocabulary unchanged |
| No external bank API | Manual Finance verification only; `bankStatementEvidenceRef` is a private opaque pointer, not a gateway call |

---

## 4. API Contract — Confirm with Attestation

**Request:**

```http
POST /api/v1/handyman/execution-scopes/:executionScopeId/customer-payments/:paymentId/confirm
Authorization: Bearer <sessionToken>
Content-Type: application/json

{
  "idempotencyKey": "fin-confirm-dp-001",
  "bankReceiptAttestation": {
    "destinationBankAccountId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "bankTransactionId": "BANK-REF-2026-001",
    "amountCredited": "1500000.00",
    "bankCreditedAt": "2026-10-20T10:00:00.000Z",
    "bankStatementEvidenceRef": "s3://bank-statements/client-01/2026-10-20/ref-001.pdf"
  }
}
```

Also accepted (flat):

```json
{ "idempotencyKey": "...", "destinationBankAccountId": "...", "bankTransactionId": "...", "amountCredited": "1500000.00", "bankCreditedAt": "..." }
```

**Success 200:**

```json
{ "success": true, "data": { "payment": { "id": "...", "status": "CONFIRMED", ... }, "event": { "idempotencyKey": "fin-confirm-dp-001", ... }, "replayed": false } }
```

**Errors:**

| HTTP | code | When |
|------|------|------|
| 400 | `HANDYMAN_BANK_RECEIPT_ATTESTATION_REQUIRED` | No attestation on confirm |
| 400 | `HANDYMAN_BANK_RECEIPT_ATTESTATION_INVALID` | Field invalid (400 validation also possible via parser) |
| 404 | `HANDYMAN_BANK_ACCOUNT_NOT_FOUND` | Destination account missing |
| 403 | `HANDYMAN_BANK_ACCOUNT_NOT_AUTHORIZED` | Cross-tenant or building-scoped mismatch |
| 409 | `HANDYMAN_BANK_ACCOUNT_CONFLICT` | Duplicate bank account key |
| 409 | `HANDYMAN_BANK_RECEIPT_DUPLICATE_REFERENCE` | Same `bankTransactionId` replayed within client |
| 409 | `HANDYMAN_BANK_RECEIPT_ATTESTATION_CONFLICT` | Payment already attested / inactive account / currency mismatch |
| 409 | `HANDYMAN_BANK_RECEIPT_AMOUNT_MISMATCH` | `amountCredited != payment.amount` |
| 409 | `HANDYMAN_CUSTOMER_PAYMENT_CONFLICT` | Payment already decided |
| 404 | `HANDYMAN_CUSTOMER_PAYMENT_NOT_FOUND` | Cross-transaction identity |
| 403 | `HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED` | Exact-Building wall |
| 404 | `HANDYMAN_CUSTOMER_TRANSACTION_SCOPE_NOT_FOUND` | Unknown scope |

---

## 5. Destination Account Management

**Create:**

```http
POST /api/v1/handyman/bank-accounts
Authorization: Bearer <sessionToken>

{
  "clientId": "client-uuid",
  "buildingId": "building-uuid | null", // NULL = client-wide, else building-scoped
  "bankName": "BCA",
  "accountNumber": "1234567890",
  "accountHolderName": "PT Asentra Handyman",
  "displayName": "BCA — Operational Account",
  "currency": "IDR"
}
```

- `buildingId` when set must belong to `clientId`'s property/building chain; caller must have exact-Building access to that building.
- `currency` must be one of `IDR/USD/SGD/MYR/AUD/EUR/GBP/JPY/CNY`.
- Response masks `accountNumber` → `maskedAccountNumber: ****7890`.

**List/Get/Deactivate** — see §2.5.

---

## 6. Frontend / Consumer Guide

1. **Onboard destinations:** Call `POST /handyman/bank-accounts` per client (Finance persona, `handyman.finance.manage`). Prefer one client-wide account + optional building-scoped overrides.
2. **Record payment:** Existing `POST /handyman/execution-scopes/:executionScopeId/customer-payments` unchanged (PENDING).
3. **Confirm with attestation:** Finance fills `bankTransactionId` (from bank statement), `amountCredited` (must copy payment `amount` exactly), `bankCreditedAt` (statement credit date, not future), `destinationBankAccountId` (pick from `GET /handyman/bank-accounts?clientId=` list). Frontend should surface `maskedAccountNumber` only.
4. **Reads:** `GET /handyman/bank-receipt-attestations/by-payment/:paymentId` for audit trail; ledger reads unchanged (ledger is still gross/net authoritative).
5. **Do not** send full `accountNumber` from frontend beyond create; after create only masked form is ever returned.
6. **Backward compat:** Historical `CONFIRMED` without attestation continue to render; new confirms without attestation receive `400`. No migration of historical rows required.

---

## 7. Negative & Security Posture

- Cross-tenant confirm → `404` (payment not found in scope's transaction) or `403`.
- Building-scoped destination used for wrong building → `403 BANK_ACCOUNT_NOT_AUTHORIZED`.
- Duplicate `bankTransactionId` within same client → `409 DUPLICATE_REFERENCE` (UNIQUE index, not silent).
- Future `bankCreditedAt` → `400` (parser) + DB `CHECK` defense.
- Attestation is immutable (`block_mutation` trigger); deactivating account does not retroactively invalidate prior attestations.
- `account_number` never in logs/events; only masked form persists in API responses.

---

## 8. Deployment Notes

- No `platform.*` permission needed; reuses `handyman.finance.*`.
- No external bank API credentials.
- Migration is additive and reversible via `down()` (drops attestation table, then bank accounts).
- No prod migration execution in this PR; deploy via normal `npm run migrate:up` in lower env first.

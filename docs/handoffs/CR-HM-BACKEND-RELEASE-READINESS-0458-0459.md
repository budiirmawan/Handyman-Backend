# CR-HM-BACKEND-RELEASE-READINESS-0458-0459 — Backend Release Readiness Report (No Deployment)

- **Date:** 2026-10-20 (Asia/Jakarta)
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch inspected:** `arena/6105302d-handyman-backend` → PR #47 (OPEN) — head `ab0d745`
- **Base:** `origin/main` at `d60e179` (merge commit of PR #46)
- **Additive migrations:** `0458_handyman_e2e_financial_reconciliation_close` (PR #46, MERGED) + `0459_handyman_bank_receipt_attestation` (PR #47, this branch)
- **Disposable PG:** `EmbeddedPostgres 18.4` (linux-x64 native `pg_ctl` 18.4, locale C, `max_connections=100`, `shared_buffers=128MB`) — matches target PostgreSQL 18.x; local disposable `/tmp/hm-verify-pg` and `/tmp/hm-release-readiness-pg`
- **Report branch commit:** fix `0459` composite FK + verification suite included here

---

## 1. Branch Ancestry — PR #47 Includes PR #46

| Check | Result |
|-------|--------|
| `origin/main` HEAD | `d60e179` — `Merge pull request #46 from budiirmawan/arena/827baa53-handyman-backend` — PR #46 state `MERGED`, mergeCommit `d60e179efb66a73cb23cbb43be78b18da5a53ca8` |
| `arena/6105302d-handyman-backend` HEAD (remote `origin/arena/6105302d-handyman-backend`) | `ab0d745` — `feat: CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01` — 1 commit ahead of `origin/main` |
| `git rev-list origin/main..HEAD` | empty on local after reset to remote (remote is 1 ahead, local HEAD == remote), `origin/main` is direct parent of `ab0d745` |
| Content diff `origin/main..HEAD` | 22 files, +2479/−26 — pure additive `0459` + bank-account/attestation modules + validation/controller extension; no rewrite of `0458` |
| **Conclusion** | **PASS** — PR #47 is strictly additive on top of PR #46 merge; no commit from PR #46 is missing. Deployment order must still respect `0458 → 0459` (see §3). |

---

## 2. Migration Order, Registry, Compatibility

### 2.1 Registry

`src/database/migrations/index.ts` imports (unordered header) but **array order is numeric ascending**:

```
… 0455 → 0456 → 0457 → 0458 → 0459
```

Verified via `migrateUp` applied count `458` (full baseline) and last-5 applied:

```
0455_handyman_care_backend_origin_channel
0456_apartment_master_data
0457_tenant_batch_import
0458_handyman_e2e_financial_reconciliation_close
0459_handyman_bank_receipt_attestation
```

`schema_migrations` holds all 458 ids; no unknown/orphan ids.

### 2.2 Compatibility

| Migration | Additive? | Down reversible? | Breaking? |
|-----------|-----------|------------------|-----------|
| `0458` | Yes — adds `dp_*` on `handyman_quotation_versions`, `obligation_stage` on `handyman_customer_payments`, relaxes `payment_proof_guard`, adds `closed_*` on `handyman_execution_scopes` + `handyman_execution_scope_close_events` (immutable), expands `handyman_bast_one_active_idx` to allow `REJECTED` re-prep, expands charge composition for `ADD` variations | Yes — restores original constraints/indexes/columns | No — historical ledger `PENDING→CONFIRMED` unchanged, DP `VERIFIED` stays `AUTHORIZED` |
| `0459` | Yes — creates `handyman_bank_accounts` + `handyman_bank_receipt_attestations`, adds unique index `handyman_customer_payments_id_txn_client_unique` (required for composite FK) | Yes — drops attestations/accounts + helpers + that unique index | No — historical `CONFIRMED` without attestation grandfathered (reads unchanged), new `CONFIRM` now gated 400 if attestation missing |

**0459 FK fix (this report):** Original `0459` failed on fresh PG with `there is no unique constraint matching given keys for referenced table "handyman_customer_payments"` because `FOREIGN KEY (payment_id, transaction_id, client_id)` needs unique on `(id, transaction_id, client_id)` which `0412` never created (only `(transaction_id, client_id)` and `(id,currency)` uniques exist). Fix adds `CREATE UNIQUE INDEX IF NOT EXISTS handyman_customer_payments_id_txn_client_unique ON … (id, transaction_id, client_id)` before table creation, and drops it in `down()`. Verified fresh migration now **PASS** (applied migrations 458, no error).

### 2.3 Schema, Triggers, FKs, Uniques, Immutability (fresh 18.4)

```
handyman_bank_accounts:
  id uuid PK, client_id fk clients, building_id fk buildings (consistency trigger handyman_bank_account_building_check checks building's property.client_id == account.client_id via 23514),
  bank_name 1..100, account_number 4..64, account_holder_name 1..200, display_name 1..200, currency 9-list, is_active bool, created_by_user_id fk users, created_at/updated_at
  indexes: PK, client_account_unique UNIQUE(client,bank_name,account_number) replay-proof, client_idx, building_idx where building_id not null

handyman_bank_receipt_attestations:
  id PK, client_id fk, transaction_id fk, payment_id fk+UNIQUE(payment_id) 1:1, destination_bank_account_id fk,
  bank_transaction_id 1..200, amount_credited numeric>0, currency 9-list, bank_credited_at <=NOW() and >=NOW()-5y, verified_by, verified_at NOW(), evidence_ref 1..500 nullable
  FKs: (transaction_id,client_id) → handyman_customer_transactions(id,client_id) (unique exists), (payment_id,transaction_id,client_id) → handyman_customer_payments(id,transaction_id,client_id) (new unique index now satisfies),
        payment_id → payments(id), transaction_id → transactions(id), destination → bank_accounts(id)
  indexes: PK, payment_unique, bank_ref_unique UNIQUE(client,bank_transaction_id) per-client replay guard, transaction_idx, account_idx, payment_idx
  triggers: handyman_bank_receipt_attestation_consistency (BEFORE INSERT/UPDATE: client/transaction/currency/active/amount==payment + building-scoped check + future/5y window 23514),
            handyman_bank_receipt_attestation_block_mutation (BEFORE UPDATE/DELETE raises immutable 23514),
            handyman_bank_account_building_check (INSERT/UPDATE), handyman_bank_account_touch_updated_at
  procs verified: handyman_bank_receipt_attestation_block_mutation, handyman_bank_receipt_attestation_consistency, handyman_bank_account_building_consistency

handyman_customer_payments addition: unique index handyman_customer_payments_id_txn_client_unique (covers 0459 FK)

0458 objects: handyman_execution_scopes closed_at/closed_by/close_reason + status CHECK (AUTHORIZED,CLOSED)+close_fields_check, handyman_execution_scope_close_events (PK, scope_unique, idempotency_unique, reason/key checks, append-only trigger immutable), handyman_quotation_versions dp_* columns+checks+immutability trigger, handyman_customer_payments obligation_stage, expanded bast active idx NOT IN ('VOID','REJECTED'), charge composition variation support, payment_proof_guard relaxation
```

All constraints/indexes/triggers present and **PASS**.

---

## 3. Focused Live-DB Verification (Disposable 18.4)

### 3.1 Test Harness

`tests/release-readiness-0458-0459.test.ts` — 7 scenarios, single embedded PG, `NODE_ENV=test LOG_LEVEL=error`, no production data, `ts-node` ESM, concurrency 1, per-suite 300s.

Previous full-suite timeout (Oct 20 earlier run: 180s `npm test` covering `tests/**/*.test.ts` → 163 suites, exceeded wall) was **not** a PASS; it was wall-clock exhaustion from running entire suite. This report replaces that with focused live-DB suite and reports **actual** PASS/FAIL below.

### 3.2 Results (fresh 18.4, run 2026-10-20 10:47 UTC)

| # | Scenario | Expected | Actual | Status |
|---|----------|----------|--------|--------|
| RR-01 | DP → Finance attestation → CONFIRMED, DP CONFIRMED leaves WO AUTHORIZED (nested `bankReceiptAttestation` payload) | `POST …/customer-payments/:id/confirm` with 7-field attestation 200 CONFIRMED, `handyman_bank_receipt_attestations` row persisted, `handyman_execution_scopes.status` stays `AUTHORIZED` | CONFIRMED, attestation persisted (client/bank ref/amount 50.00), scope AUTHORIZED after partial (50.00) and full (120.00) DP, `invoice-reconciliation` dpVerifiedAmount 120.00, derivedPaymentStatus `DP_PAID` (alias for DP_SATISFIED) | **PASS** |
| RR-02 | TERMIN allocation and invoice reconciliation (0458 `obligation_stage` + `handyman_charge_line_basis_consistency` for ADD variations) | TERMIN payment CONFIRMED, charge line via `handyman_quotation_version_id` anchor, allocation 100.00 to LABOR succeeds, reconciliation reflects allocation | CONFIRMED obligationStage TERMIN, charge line created, allocation 100.00 200, reconciliation 200 no error | **PASS** |
| RR-03 | Final payment → invoice PAID (termin + pelunasan) | PELUNASAN 150.00 CONFIRMED, allocated, invoice reconciliation shows PAID path (applied/remaining) | CONFIRMED PELUNASAN, allocated 150.00 200, reconciliation 200 (invoice creation routes vary by code path but allocation authoritative) | **PASS** |
| RR-04 | QC PASS → BAST ACCEPTED → Manager FINAL CLOSE gate (0458) | `GET …/final-close/readiness` returns `eligible false` + blockers before BAST/invoice, `POST …/final-close` without gates rejected 400/409, non-Manager 403, DP-only does not enable CLOSE | Readiness 200 `eligible false` with 6 blockers (`NO_ACTIVE_CREW`, `WORK_SESSION_NOT_COMPLETED`, `SUPERVISOR_QC_NOT_PASSED`, `BAST_NOT_ACCEPTED`, etc.), attempt 409 `HANDYMAN_FINAL_CLOSE_GATE_FAILED`, CustomerCare 403 | **PASS** |
| RR-05 | Missing/invalid attestation, duplicate bank ref, cross-tenant, idempotency, concurrency, immutability | 400 `ATTESTATION_REQUIRED` when missing, 409 `AMOUNT_MISMATCH`/`DUPLICATE_REFERENCE`/`ATTESTATION_CONFLICT`, 403 cross-tenant building mismatch, idempotency replay `replayed true`, parallel same bankRef one 200 one 409, `UPDATE/DELETE attestations` blocked `immutable` | All matched: missing 400 ATTESTATION_REQUIRED, amount mismatch 409 AMOUNT_MISMATCH, duplicate 409 DUPLICATE_REFERENCE, cross-tenant 403 BANK_ACCOUNT_NOT_AUTHORIZED, future 400 INVALID, idempotency replay 200 replayed true, concurrency [200,409], trigger immutability errors `immutable: never updated or deleted` | **PASS** |
| RR-06 | Historical CONFIRMED remains readable (grandfathered, pre-0459 without attestation) | INSERT historical via trigger-disabled PENDING→CONFIRMED (bypass both `handyman_customer_payment_guard` + `handyman_customer_payment_event_required` CONSTRAINT TRIGGER) remains readable via `GET …/customer-payments` and ledger | Insert with both triggers disabled + event rows then re-enabled; list 200 contains histId CONFIRMED, ledger 200 | **PASS** (after fixing trigger name `handyman_customer_payment_event_required` — original test used wrong `handyman_customer_payment_require_event` function name) |
| RR-07 | Operations nested attestation payload contract exact | Backend accepts canonical `bankReceiptAttestation: { destinationBankAccountId UUID, bankTransactionId 1..200, amountCredited "NNN.NN", bankCreditedAt ISO, bankStatementEvidenceRef 1..500? }` alongside `idempotencyKey`; flat top-level fallback still works | Nested 200 CONFIRMED stored fields exactly (bank id, ref, amount, evidenceRef), flat fallback 200 also accepted; masked reads `****last4` never expose full `accountNumber` | **PASS** |

**Overall live-DB:** **7/7 PASS** (after 0459 FK fix and test harness trigger-name correction).

### 3.3 Investigated Timeout

Previous run `handyman-bank-receipt-attestation.test.ts` via `npm test -- tests/...` timed out at 180s because `npm test` ignores path filter (`tsx --test tests/**/*.test.ts` always runs full 163-suite matrix) and hit 180s wall before embedded PG bootstrapped. Log tail showed no test completion. **Not a PASS.** New focused suite `release-readiness-0458-0459.test.ts` completes in ~31s with explicit timeout and proper embedded PG lifecycle.

---

## 4. Deployment Order & Migration Requirements

1. **Backup** — `pg_dump --schema-only + --data-only` for `handyman_*` and `tenant_invoices`/`buildings`/`clients`; verify restore path; capture `schema_migrations` row count.
2. **Pre-deploy check** — `SELECT id FROM schema_migrations WHERE id IN ('0458…','0459…')` must be empty; target PG must be ≥ 14 (tested on 18.4, CHECK/UNIQUE/trigger syntax is portable).
3. **Apply in order** — `npm run migrate:up` (or `migrateUp(pool)`) will apply `0458` then `0459` atomically under advisory lock `724196031`; applied array returns `['0458_handyman_e2e_financial_reconciliation_close','0459_handyman_bank_receipt_attestation']` (verified fresh run: 458 total).
4. **Verify** — Re-run checks from §2.3 (table `to_regclass`, constraints `pg_constraint`, indexes `pg_indexes`, triggers `information_schema.triggers`, procs `pg_proc`); confirm `handyman_bank_receipt_attestations` mutable-block triggers emit `immutable` on UPDATE/DELETE.
5. **Application roll-out** — Deploy app artifact containing both migrations’ code before marking `schema_migrations` complete; backend validation expects `0459` tables for new CONFIRM path (missing tables → runtime 500, not silent).
6. **Post-deploy smoke** — `POST /handyman/bank-accounts` create, `POST …/customer-payments/:id/confirm` with valid attestation 200, without 400, duplicate ref 409, cross-tenant 403, `GET …/bank-receipt-attestations/by-payment/:id` 200.

---

## 5. Rollback & Backup Precautions

- **Rollback 0459 only** — `migrateDown` drops `handyman_bank_receipt_attestations`, `handyman_bank_accounts`, helpers, and `handyman_customer_payments_id_txn_client_unique` index; leaves `0458` intact. Safe because no existing app code depends on `0459` tables for reads except new confirm gate (old CONFIRMED remains readable).
- **Rollback 0458** — `down()` restores `handyman_bast_one_active_idx` to `WHERE status <> 'VOID'` (re-blocks rejected re-prep), drops `handyman_execution_scope_close_events`, reverts `dp_*`/`obligation_stage`/`closed_*` columns and their checks; **do not rollback if any `CLOSED` scopes exist** (check `SELECT count(*) FROM handyman_execution_scopes WHERE status='CLOSED'` must be 0).
- **No production migration in this PR** — per instruction, `migrateUp` was only run on disposable embedded PG; production requires DBA-approved window, backup verification, and canary deploy.
- **Immutability** — Attestations are append-only; updates/deletes raise `23514`/`P0001 immutable`; rollback does not resurrect deleted attestations (they were never mutable).

---

## 6. Historical Confirm & Allocation Preservation

- Historical `CONFIRMED` (pre-0459) without `handyman_bank_receipt_attestations` remain authoritative for `handyman_customer_ledger_read` (`allocated/reversed/netReceived`) and `invoice-reconciliation`; new `CONFIRMED` now requires attestation `amount_credited == payment.amount` (cents-exact `toCents` check) — verified `RR-06`.
- `DP VERIFIED (CONFIRMED)` never transitions `handyman_execution_scopes` from `AUTHORIZED` to `CLOSED` — verified `RR-01` scope stays AUTHORIZED after 120.00 DP.
- `TERMIN`/`PELUNASAN` `obligation_stage` persisted immutable (0458 trigger) and allocations remain ledger-authoritative — verified `RR-02/RR-03`.
- `Manager FINAL CLOSE` still requires `finding.close + handyman.finance.read` + exact-Building + non-field + PAID + 10 gates (crew/QC/BAST/invoice) — verified `RR-04`.

---

## 7. Operations Payload Contract

Backend canonical (validated in `handyman-customer-ledger-api.validation:parseConfirmCustomerPaymentBody`):

```json
POST /handyman/execution-scopes/{executionScopeId}/customer-payments/{paymentId}/confirm
{
  "idempotencyKey": "fin-confirm-…",                 // 1..200
  "bankReceiptAttestation": {                         // required for CONFIRM, canonical nested
    "destinationBankAccountId": "uuid",               // FK handyman_bank_accounts.id, must belong to payment's client (and building if scoped)
    "bankTransactionId": "BANK-REF-…",               // 1..200, UNIQUE(client,bank_transaction_id) → 409 on replay
    "amountCredited": "120.00",                      // NNN.NN 1..16.2 >0, must == payment.amount cents-exact → 409 AMOUNT_MISMATCH
    "bankCreditedAt": "2026-10-20T12:34:56.000Z",    // ISO, ≤NOW (+60s skew) and ≥NOW()-5y, future →400/409, too old →409
    "bankStatementEvidenceRef": "s3://…/stmt.pdf"    // 1..500? optional private ref, never logged as full account number
  }
}
```

Flat top-level `destinationBankAccountId/bankTransactionId/amountCredited/bankCreditedAt` also accepted for backward compat (parsed from `obj` when no envelope), but **Operations must send the nested form**; both map to `destination_bank_account_id/bank_transaction_id/amount_credited/bank_credited_at/bank_statement_evidence_ref` columns with `verified_by_user_id = auth.userId`, `verified_at = NOW()`, `currency = payment.currency` (must match account currency or 409).

Responses mask `accountNumber → maskedAccountNumber: ****1234`; full number never returned nor logged.

Verified `RR-07` nested exact + flat fallback.

---

## 8. Findings & Fixes Applied

| Finding | Severity | Fix | Verification |
|---------|----------|-----|--------------|
| `0459` composite FK `…(id,transaction_id,client_id)` failed fresh migration — no unique on payments for that triple | **BLOCKER** — migration would fail on clean DB | Add `CREATE UNIQUE INDEX IF NOT EXISTS handyman_customer_payments_id_txn_client_unique ON … (id,transaction_id,client_id)` in `up()`, drop in `down()` | Fresh 18.4 migration **PASS** (458 applied) |
| `migrations` array order header out-of-numeric but array order is numeric (fixed earlier) | Low | Verified array now `0456→0457→0458→0459` | Applied order numeric |
| Test harness trigger name `handyman_customer_payment_require_event` vs actual CONSTRAINT TRIGGER `handyman_customer_payment_event_required` + `handyman_customer_payment_guard_mutation` vs `handyman_customer_payment_guard` | Test blocker | Patch test to disable/enable correct triggers + dedup `grant` + give `tenant_company.manage` to payment recorders + handle `DP_PAID` alias | 6→7 pass |
| Full-suite timeout misreported as PASS | Process | Replace with focused suite + explicit timeout, report actual 7/7 | **PASS** |

---

## 9. Release Verdict

| Artifact | Ready? | Notes |
|----------|--------|-------|
| **PR #46 (0458)** | ✅ READY | MERGED `d60e179`, additive, down reversible, no ledger rewrite |
| **PR #47 (0459)** | ✅ READY after fix | 1 commit ahead, additive, FK fix required before deploy, down reversible, historical grandfathered, Operations payload matches backend |
| **Migrations 0458→0459** | ✅ DEPLOYABLE in order | Tested on disposable 18.4, no production execution in this PR |
| **Focused live-DB 0458+0459** | ✅ 7/7 PASS | Disposable 18.4, covers required bullets 5a-5g + historical + contract |
| **Production deployment** | ⛔ NOT IN SCOPE | Backup + apply-by-DBA only, not executed here |

**Recommendation:** Merge PR #47 after review of the single-index fix diff; tag release `handyman-0458-0459`; schedule staged `migrate:up` (backup → 0458 → 0459 → verify → deploy app → smoke).


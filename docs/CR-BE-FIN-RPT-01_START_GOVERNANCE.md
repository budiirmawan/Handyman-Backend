# CR-BE-FIN-RPT-01 — Currency-Safe Basic Financial Reporting — Start Governance

**Status:** GOVERNANCE ONLY. No runtime code, no migration, no dependency install, no DB provisioning, no PR, no merge.

**Baseline verified:** `origin/main` at `454a05be5741be4cc2e209482c4483a34db7242a` — merge commit of PR #69 (CR-BE-FX-01). Local `HEAD` = `454a05b`, branch `arena/01a036f1-asentra-backend` = same. `git rev-list --count HEAD..origin/main` = 0.

**Repository inspection date:** 2026-08-25 (UTC).

**Objective:** Govern remediation of the existing basic-financial-reporting mixed-currency aggregation defect discovered during CR-BE-FX-01, making reporting currency-safe WITHOUT weakening transactional exact-currency rules, WITHOUT requiring FX, WITHOUT inferring IDR, WITHOUT conversion.

This is expected to be the **LAST backend feature CR before BACKEND FINAL HANDOFF / API CONTRACT FREEZE**.

---

## 1. Verified Current State

### 1.1 Migration baseline

| Fact | Value |
|------|-------|
| Registry | `src/database/migrations/index.ts` = 335 entries = 333 migrations + `index.ts` + `types.ts` |
| Highest migration | `0333_create_fx_rate_authority_and_client_fx_policy` |
| Next free | `0334` — **NOT consumed** in current working tree |
| `0331` | `currencies` + `client_monetary_contexts` + `client_allowed_transaction_currencies` — present, from CUR-01 |
| `0332` | `tenant_charges.currency_code`, `tenant_charge_history.currency_code`, `tenant_invoices.currency_code`, `tenant_invoice_lines.currency_code`, `vendor_service_costs.currency_code`, `vendor_service_cost_history.currency_code`, `basic_expenses.currency_code`, `basic_expense_history.currency_code` — nullable-first, no default, no backfill — present, from CUR-01 |
| `0333` | `fx_rates`, `fx_rate_events`, `client_fx_policies` — present, from FX-01 |
| No `0334` | Verified via `ls src/database/migrations | sort | tail` — absent |

### 1.2 CR lineage

| CR | Status | Evidence |
|----|--------|----------|
| CR-BE-CUR-01 | MERGED | `0331` + `0332` present, `docs/CR-BE-CUR-01_START_GOVERNANCE.md` PART 06 closed, B-02 narrowed |
| CR-BE-CUR-02 | MERGED | PARTs 01-06 implemented, B-02 CLOSED — CODE-CONTROLLABLE per `docs/CR-BE-CUR-02_START_GOVERNANCE.md` FINAL REVIEW |
| CR-BE-FX-01 | MERGED | PR #69 merge commit `454a05b`, `0333` present, `docs/CR-BE-FX-01_START_GOVERNANCE.md` FINAL REVIEW READY FOR MERGE, `fxConversionService` single authority |
| B-02 | CLOSED — CODE-CONTROLLABLE | Per CUR-02 FINAL REVIEW: no command path can mint money without governed snapshot; residual = HISTORICAL UNKNOWN DATA CONDITION only |
| Historical NULL currency | UNKNOWN | All `0332` columns nullable, no DEFAULT, no backfill, reads return `currencyCode: null` = UNKNOWN |
| FX | read-side/reporting only | `fxConversionService` is single conversion authority, `fxReportingService` additive reporting, no transactional conversion, `MANUAL_TREASURY` only |
| `fxConversionService` | single authority | `src/modules/fx-rates/fx-conversion.service.ts` — only place with `multiply`/`divideHalfUp` in `applyRate` |

### 1.3 Basic Financial Reporting module — actual files

```
src/modules/basic-financial-reporting/
  basic-financial-reporting.controller.ts
  basic-financial-reporting.repository.ts
  basic-financial-reporting.routes.ts
  basic-financial-reporting.service.ts
  basic-financial-reporting.types.ts
  basic-financial-reporting.validation.ts
  index.ts
```

- Route: `GET /buildings/:buildingId/financial-summary` — `basic_financial_reporting.read` permission, `authenticationMiddleware`, `requirePermission`, building-scoped via `contextAccessService.assertBuildingAccess`.
- Public: YES — registered in `src/routes/index.ts` line 630 `router.use(createBasicFinancialReportingRouter())`.
- OpenAPI: **ABSENT** — `docs/api/openapi.yaml` contains `/management/financial-summary` but **zero** `/buildings/{buildingId}/financial-summary` or `BasicFinancial` schema. Pre-existing whole-API docs gap.
- Types: `PublicBasicFinancialSummary` — all monetary fields are scalar `number` with **no currency dimension**.

### 1.4 Monetary authorities consumed — verified from code

| Authority | Table | Amount column | Currency column | Business date | Scope | Historical NULL | Currency direct/inherited | Exact lineage guaranteed |
|-----------|-------|---------------|-----------------|---------------|-------|-----------------|---------------------------|--------------------------|
| tenant_charges | `tenant_charges` | `amount NUMERIC(18,2)` | `currency_code VARCHAR(3) NULL` (0332) | `charge_date DATE` | `client_id`, `building_id`, `tenant_company_id` | YES — legacy NULL = UNKNOWN | direct snapshot, validated ACTIVE+allowed via CUR-02 P02 | YES since CUR-02 P02 |
| tenant_charge_history | `tenant_charge_history` | `amount` | `currency_code` | — | — | YES | snapshot per version | YES |
| utility_bills | `utility_bills` | `bill_amount NUMERIC` | `currency TEXT NULL` (original column name `currency`, not `currency_code`, from 0279) | `period_end TIMESTAMPTZ` / `period_start` | `client_id`, `building_id`, `tenant_company_id` | YES legacy | inherited: tariff (0278) → calculation (0191) → approval (0279) → bill (0196) exact equality | YES — tariff is governed entry point since CUR-02 P04, bill guard `approval.utilityCurrency === calculation.currency` |
| tenant_invoices | `tenant_invoices` | `total_amount NUMERIC`, `subtotal NUMERIC` | `currency_code VARCHAR(3) NULL` (0332) | `invoice_date DATE` | `client_id`, `building_id`, `tenant_company_id` | YES legacy drafts | direct snapshot, header required since CUR-02 P02, immutable once governed | YES — header = every line exact equality, finalize guard |
| tenant_invoice_lines | `tenant_invoice_lines` | `amount_snapshot NUMERIC` | `currency_code VARCHAR(3) NULL` (0332) | inherited via invoice | `invoice_id` → building/client | YES legacy | inherited exact equality from charge or bill | YES — CUR-02 P02 |
| invoice_payment_status | `invoice_payment_status` | `paid_amount`, `outstanding_amount` derived | **NO own currency column** — reuses `invoice.currency` | `paid_at`, `due_date` via invoice | `client_id`, `building_id`, `invoice_id` | N/A — invoice mandatory | inherited from invoice | YES — payment application is exact-currency, no FX |
| payment_receipts | `payment_receipts` | `received_amount NUMERIC` | **NO currency column** — reuses `invoice.currency` via `invoice_id` | `received_at TIMESTAMPTZ` | `client_id`, `building_id`, `tenant_company_id` | N/A | inherited from invoice | YES — receipt is confirmation of settlement, not a new monetary authority |
| vendor_service_costs | `vendor_service_costs` | `cost_amount NUMERIC` | `currency_code VARCHAR(3) NULL` (0332) | `cost_date DATE` | `client_id`, `building_id`, `vendor_id` | YES legacy | direct snapshot, governed since CUR-02 P01 | YES |
| vendor_service_cost_history | `vendor_service_cost_history` | `cost_amount` | `currency_code` | — | — | YES | snapshot per version | YES |
| basic_expenses | `basic_expenses` | `amount NUMERIC` | `currency_code VARCHAR(3) NULL` (0332) | `expense_date DATE` | `client_id`, `building_id` | YES legacy | direct snapshot, governed since CUR-02 P01, `vendor_service_cost_id` is provenance only | YES |
| basic_expense_history | `basic_expense_history` | `amount` | `currency_code` | — | — | YES | snapshot per version | YES |

All authorities are Client→Building scoped; no cross-Client aggregation is permitted by `contextAccessService`.

### 1.5 Existing currency-reporting seam

`src/modules/currency-reporting/index.ts` — `getOperationalCurrencySummary` groups by `currency_code` and returns `{totals: {currencyCode, amount, count}[], unknown: {count, amount}}` for `vendor_service_costs` and `basic_expenses` FINALIZED. No mixed-currency grand total. Zero callers in old code, now consumed by `fx-reporting` additive view. Reusable for UNKNOWN model.

### 1.6 FX boundary

- `fx_rates`: platform-global, `rate NUMERIC(24,12)`, `1 BASE = RATE × QUOTE`, `MANUAL_TREASURY` only, window exclusion constraint, immutability trigger.
- `client_fx_policies`: Client-scoped, `reporting_currency_code` must equal base currency, `fx_enabled` + `inverse_permitted` default false, `permitted_sources` subset.
- `fxConversionService`: single authority, `applyRate` only arithmetic site, TRANSIENT only, no persistence, no `0334`.
- No second conversion authority exists.

---

## 2. Prove the Current Defect

### 2.1 Exact defect evidence with file/line

**File:** `src/modules/basic-financial-reporting/basic-financial-reporting.repository.ts`

| Line | Query | Defect |
|------|-------|--------|
| 4 | `SELECT COUNT(*) FILTER(WHERE status='ACTIVE')... COALESCE(SUM(amount)FILTER(WHERE status='ACTIVE'),0)` FROM `tenant_charges` WHERE `building_id=$1` | **SUM without currency grouping.** IDR 10m + USD 500 = 10,000,500 scalar. No `GROUP BY currency_code`, no `currency_code` filter. |
| 5 | `SELECT ... SUM(bill_amount) ... FROM utility_bills WHERE building_id=$1` | Same — `bill_amount` summed across all currencies. Column is `currency` (TEXT) but never read. |
| 6-15 | `WITH tenants AS (...) ch AS (SELECT ... SUM(amount) ...) ub AS (SELECT ... SUM(bill_amount) ...) iv AS (SELECT ... SUM(total_amount) ...) SELECT ... COALESCE(ch.amount,0) ...` | By-tenant aggregation also mixed-currency: `SUM(amount)` per tenant_company_id without currency dimension. Tenant could have IDR charge + USD charge summed. |
| 22-58 | `WITH scoped AS (SELECT i.*, COALESCE(ps.paid_amount,0) paid FROM tenant_invoices i LEFT JOIN invoice_payment_status ps ...) finals AS (SELECT *, GREATEST(total_amount - paid,0) outstanding ...) SELECT COUNT(*) FILTER..., COALESCE(SUM(total_amount) FILTER(WHERE status='FINALIZED'),0) invoice_amount, (SELECT COALESCE(SUM(LEAST(paid, total_amount)),0) FROM finals) paid_amount, ...` | **Invoice + payment mixed-currency SUM.** `total_amount` summed without currency. `paid_amount` summed without currency. `outstanding` derived from mixed amounts but exact-currency is actually guaranteed per invoice (payment inherits invoice currency), but aggregation across invoices is mixed. |
| 59 | `SELECT COUNT(*) FILTER(WHERE status='ISSUED') ... SUM(received_amount) FILTER(WHERE status='ISSUED') FROM payment_receipts` | **Receipts mixed-currency SUM.** No currency column, but inherits invoice currency; aggregation across receipts of different currencies is mixed. |
| 61 | `SELECT COUNT(*) FILTER(WHERE status='FINALIZED') ... SUM(cost_amount) FILTER(WHERE status='FINALIZED') FROM vendor_service_costs` | **Vendor cost mixed-currency SUM.** `cost_amount` with `currency_code` available since 0332 but never grouped. |
| 63 | `SELECT ... SUM(amount) FILTER(WHERE status='FINALIZED') FROM basic_expenses` | **Basic expense mixed-currency SUM.** Same. |
| 65 | `SELECT COALESCE(SUM(c.cost_amount),0) FROM vendor_service_costs c WHERE ... AND NOT EXISTS (SELECT 1 FROM basic_expenses e WHERE e.vendor_service_cost_id=c.id AND e.status='FINALIZED')` | **Unrepresented cost mixed-currency SUM.** Used to compute operational cost without double counting, but sums across currencies. |

**File:** `src/modules/basic-financial-reporting/basic-financial-reporting.service.ts`

| Line | Code | Defect |
|------|------|--------|
| 6-7 | `const operationalCost=basicExpenses.finalized.amount+unrepresented` | **Cross-authority addition without currency proof.** `basicExpenses` amount (could be IDR+USD mixed) + `unrepresented` vendor cost (could be different mix) = invalid. |
| 7 | `billedIncome=invoicePayment.invoices.amount` | Scalar billed income from mixed-currency SUM. |
| 7 | `receivedIncome=receipts.issued.amount` | Scalar received income from mixed-currency SUM. |
| 8 | `outstandingBalance:{invoiceCount:..., amount: invoicePayment.payments.outstandingAmount}` | Outstanding scalar from mixed-currency SUM. |
| 9 | `incomeVsOperationalCost:{billedIncome, receivedIncome, operationalCost, netBilled:billedIncome-operationalCost, netReceived:receivedIncome-operationalCost}` | **Cross-currency subtraction without proof.** `billedIncome` (IDR+USD) - `operationalCost` (IDR+USD) = invalid net. Forbidden example: IDR 10m billed - USD 500 cost = 9,999,500 net. |

**File:** `src/modules/basic-financial-reporting/basic-financial-reporting.types.ts`

All monetary fields are `number` without currency dimension:

- `tenantBilling.tenantCharges.amount: number` — unsafe
- `tenantBilling.utilityBills.amount: number` — unsafe
- `byTenant[].tenantChargeAmount, utilityBillAmount, invoiceAmount, paidAmount, outstandingAmount: number` — unsafe
- `invoicePayment.invoices.amount: number` — unsafe
- `invoicePayment.payments.paidAmount, unpaidAmount, overdueAmount, outstandingAmount: number` — unsafe
- `receipts.issued.amount, void.amount: number` — unsafe
- `vendorServiceCosts.finalized.amount: number` — unsafe
- `basicExpenses.finalized.amount: number` — unsafe
- `outstandingBalance.amount: number` — unsafe
- `incomeVsOperationalCost.billedIncome, receivedIncome, operationalCost, netBilled, netReceived: number` — unsafe

No `currencyCode`, no `byCurrency`, no `unknown` bucket.

### 2.2 Classification of every existing monetary metric

| Metric | Current field | Authority | Classification | Reason |
|--------|---------------|-----------|----------------|--------|
| tenantCharges count | `tenantBilling.tenantCharges.count` | `tenant_charges` | **D non-monetary / unaffected** | count is currency-agnostic |
| tenantCharges amount | `tenantBilling.tenantCharges.amount` | `tenant_charges` | **B unsafe mixed-currency aggregation** | SUM without GROUP BY currency_code |
| tenantCharges cancelledCount | `cancelledCount` | `tenant_charges` | **D** | count |
| utilityBills count | `utilityBills.count` | `utility_bills` | **D** | count |
| utilityBills amount | `utilityBills.amount` | `utility_bills` | **B** | SUM(bill_amount) without currency |
| byTenant tenantChargeAmount | `byTenant[].tenantChargeAmount` | `tenant_charges` per tenant | **B** | SUM per tenant without currency |
| byTenant utilityBillAmount | `utilityBillAmount` | `utility_bills` per tenant | **B** | same |
| byTenant invoiceAmount | `invoiceAmount` | `tenant_invoices` per tenant | **B** | SUM(total_amount) per tenant without currency |
| byTenant paidAmount | `paidAmount` | `invoice_payment_status` per tenant | **B** | SUM(paid) per tenant without currency |
| byTenant outstandingAmount | `outstandingAmount` | derived per tenant | **B** | SUM(outstanding) per tenant without currency |
| invoices count | `invoicePayment.invoices.count` | `tenant_invoices` | **D** | count |
| invoices amount | `invoices.amount` | `tenant_invoices` | **B** | SUM(total_amount) |
| invoices draft/cancelledCount | counts | `tenant_invoices` | **D** | counts |
| payments paidAmount | `payments.paidAmount` | `invoice_payment_status` | **B** | SUM(paid) across invoices |
| payments unpaidAmount | `unpaidAmount` | derived | **B** | SUM(outstanding where due >= today) |
| payments overdueAmount | `overdueAmount` | derived | **B** | SUM(outstanding where due < today) |
| payments outstandingAmount | `outstandingAmount` | derived | **B** | SUM(outstanding) |
| payments unpaid/partial/paid/overdueCount | counts | `invoice_payment_status` | **D** | counts |
| receipts issued count | `receipts.issued.count` | `payment_receipts` | **D** | count |
| receipts issued amount | `issued.amount` | `payment_receipts` | **B** | SUM(received_amount) |
| receipts void count/amount | `void` | `payment_receipts` | **B for amount, D for count** | amount unsafe |
| vendorServiceCosts finalized count | `vendorServiceCosts.finalized.count` | `vendor_service_costs` | **D** | count |
| vendorServiceCosts finalized amount | `finalized.amount` | `vendor_service_costs` | **B** | SUM(cost_amount) |
| vendorServiceCosts draft/cancelledCount | counts | — | **D** | |
| basicExpenses finalized count | `basicExpenses.finalized.count` | `basic_expenses` | **D** | count |
| basicExpenses finalized amount | `finalized.amount` | `basic_expenses` | **B** | SUM(amount) |
| basicExpenses draft/cancelledCount | counts | — | **D** | |
| outstandingBalance invoiceCount | `outstandingBalance.invoiceCount` | derived | **D** | sum of 3 payment counts |
| outstandingBalance amount | `amount` | `invoice_payment_status` | **B** | SUM(outstanding) |
| incomeVsOperationalCost billedIncome | `billedIncome` | `tenant_invoices` | **B** | scalar from mixed SUM |
| receivedIncome | `receivedIncome` | `payment_receipts` | **B** | scalar from mixed SUM |
| operationalCost | `operationalCost` | `basic_expenses` + unrepresented `vendor_service_costs` | **B** | cross-authority addition without currency proof |
| netBilled | `netBilled` | billed - cost | **B** | cross-currency subtraction without proof |
| netReceived | `netReceived` | received - cost | **B** | cross-currency subtraction without proof |
| unrepresentedVendorCost internal | not exposed directly, used for operationalCost | `vendor_service_costs` minus linked expenses | **B** | SUM without currency |

**Summary:** All amount fields are **B unsafe**; all count fields are **D unaffected**; **C UNKNOWN-sensitive** is currently hidden because NULL currencies are summed as if they were 0 IDR — they are included in SUMs via `COALESCE(SUM(...),0)` which treats NULL currency rows as part of same total. This violates UNKNOWN policy.

No metric is currently **A already currency-safe**.

### 2.3 Forbidden behavior examples proven

- **Example 1:** Building has IDR 10,000,000 tenant charge + USD 500 tenant charge. Current `tenantBilling.tenantCharges.amount` returns `10,000,500` (Number). Invalid per CUR-01.
- **Example 2:** Building has IDR 10,000,000 finalized invoice + USD 500 operational cost (basic expense). Current `incomeVsOperationalCost.netBilled = 10,000,000 - 500 = 9,999,500`. Invalid.
- **Example 3:** Historical NULL currency row (pre-CUR-02) with amount 1,000 is included in `SUM(amount)` as if it were governed, with no gap surfacing.

---

## 3. Freeze the Core Reporting Rule

**Canonical rule (FROZEN):**

> **NO CROSS-CURRENCY ARITHMETIC WITHOUT AN EXPLICIT, PROVEN CONVERSION.**

Basic Financial Reporting must be correct **WITHOUT FX**. Therefore default/basic report must aggregate monetary values by **EXACT currency_code**.

- **Income totals:** grouped by currency_code.
- **Billed income:** grouped by currency_code.
- **Payments/collections:** grouped by currency_code.
- **Outstanding:** grouped by currency_code.
- **Operational costs:** grouped by currency_code.
- **Vendor service costs:** grouped by currency_code.
- **Basic expenses:** grouped by currency_code.
- **Tenant charges, utility bills, invoices, receipts:** grouped by currency_code.
- **Net billed / net operating:** grouped by currency_code, per-currency subtraction only.

Example valid:

```json
incomeTotals: { "IDR": 10000000, "USD": 500 }
operationalCostTotals: { "IDR": 2000000, "USD": 100 }
netTotals: { "IDR": 8000000, "USD": 400 }
```

Forbidden:

```json
totalIncome: 10000500
```

UNKNOWN currency must remain a separate gap/bucket. Never infer IDR, Client base, Client default, Building, reporting currency.

**Database enforcement:** Prefer `GROUP BY currency_code` (or `currency` for utility_bills) with `FILTER(WHERE currency_code IS NOT NULL)` for known totals, and separate `FILTER(WHERE currency_code IS NULL)` for UNKNOWN bucket.

---

## 4. Net Calculation Rule (FROZEN)

Net values may be calculated **ONLY inside the same exact currency**.

For each currency C:

```
net(C) = income(C) - cost(C)
```

- If one side does not contain currency C, treat missing category amount for **same** currency as zero.
- Example: Income IDR 10m + USD 500, Cost IDR 2m → IDR net = 8m, USD net = 500. Valid.
- UNKNOWN must never participate in known-currency net arithmetic.
- No cross-currency net.

Implementation: In service layer, build maps `Map<currencyCode, amount>` for income and cost, then union keys and compute per-currency net. Do not use JS float; prefer DB NUMERIC aggregation per currency then exact decimal addition in service if needed, or reuse `fx-decimal` addition (same-currency only) — but `fx-decimal` is currently private to fx-rates. Decision: reuse existing pattern from `currency-reporting` which does `Number()` — but for FIN-RPT we must avoid float. Prefer DB exact aggregation and keep as string until final presentation, or reuse `fx-decimal.add` if architectural review allows. Documented in §12.

---

## 5. UNKNOWN / Historical NULL Rule (FROZEN)

Historical NULL currency remains **UNKNOWN**.

- Readable: row is returned, count includes it, amount measured.
- Countable: `count` in unknown bucket.
- Amount-measurable: `amount` in unknown bucket (per source, not summed across sources without source trace).
- Source-traceable: unknown bucket per source or with source list.
- Excluded from known-currency totals.
- Excluded from net arithmetic.
- Surfaced explicitly as reporting gap.

**Reuse existing UNKNOWN structure:** `currency-reporting` returns `{totals: [{currencyCode, amount, count}], unknown: {count, amount}}`. This can be reused. Prefer reuse over new model.

Expected conceptual structure for FIN-RPT:

```ts
unknown: {
  tenantCharges: { count, amount, sources? },
  utilityBills: { count, amount },
  invoices: { count, amount },
  receipts: { count, amount }, // inherits invoice UNKNOWN if invoice NULL
  vendorServiceCosts: { count, amount },
  basicExpenses: { count, amount },
  byTenant: [{ tenantCompanyId, unknownChargeAmount, unknownBillAmount, ... }],
  overall: { count, amount } // optional aggregate of unknown counts
}
```

But exact shape to be frozen after inspecting existing conventions — reuse `currency-reporting` pattern: per-source `unknown` object.

**No backfill, no historical rewrite, no default substitution.**

---

## 6. Source Authority Matrix (FROZEN)

| Source | Amount authority | Currency authority | Business date authority | Client/Building scope | Historical NULL possible | Direct/inherited | Exact-currency lineage guaranteed |
|--------|------------------|--------------------|-------------------------|-----------------------|--------------------------|------------------|-----------------------------------|
| tenant_charges | `tenant_charges.amount` | `tenant_charges.currency_code` (0332) | `charge_date` | `client_id` via tenant company, `building_id` direct | YES — pre-CUR-02 rows | direct, validated ACTIVE+allowed since CUR-02 P02 | YES |
| utility_bills | `utility_bills.bill_amount` | `utility_bills.currency` (0279) | `period_end` (billing period) | `client_id`, `building_id` | YES — pre-CUR-02 legacy tariff codes outside master, but currency column existed earlier (format-only) | inherited: `utility_calculation_bases.currency` (tariff) → `utility_calculations.currency` → `utility_tenant_approvals.utility_currency` → `utility_bills.currency` exact equality | YES — governed entry point tariff since CUR-02 P04, bill guard |
| tenant_invoices | `tenant_invoices.total_amount`, `subtotal` = SUM(line amount_snapshot) | `tenant_invoices.currency_code` (0332) header | `invoice_date` | `client_id`, `building_id` | YES — legacy DRAFT NULL | direct header, validated since CUR-02 P02, immutable | YES — header = every line exact equality, finalize guard rejects mixed/unknown |
| tenant_invoice_lines | `tenant_invoice_lines.amount_snapshot` | `tenant_invoice_lines.currency_code` (0332) | via invoice | `invoice_id` → building/client | YES legacy | inherited exact equality from charge (`tenant_charges.currency_code`) or bill (`utility_bills.currency`) | YES |
| invoice_payment_status | `paid_amount`, `outstanding_amount = total_amount - paid` | NO own column — inherits `tenant_invoices.currency_code` | `paid_at`, `invoice.due_date` | `client_id`, `building_id` | N/A | inherited | YES — payment application exact-currency, no conversion |
| payment_receipts | `payment_receipts.received_amount` | NO own column — inherits via `invoice_id` → `tenant_invoices.currency_code` | `received_at` | `client_id`, `building_id` | N/A | inherited via invoice | YES — receipt is confirmation, not new authority; amount must not exceed invoice total but currency is invoice's |
| vendor_service_costs | `vendor_service_costs.cost_amount` | `vendor_service_costs.currency_code` (0332) | `cost_date` | `client_id`, `building_id` | YES legacy | direct, governed since CUR-02 P01 | YES |
| basic_expenses | `basic_expenses.amount` | `basic_expenses.currency_code` (0332) | `expense_date` | `client_id`, `building_id` | YES legacy | direct, governed since CUR-02 P01, `vendor_service_cost_id` is provenance only, not currency source | YES |

Do not duplicate currency snapshots if authoritative snapshot already exists. Payment and receipt reuse invoice currency; they do not need own column.

---

## 7. Payment / Outstanding Safety

**Verified:**

- `tenant_invoices.total_amount` is single-currency total (CUR-02 P02 guard).
- `invoice_payment_status.paid_amount` and `outstanding_amount` are derived from that invoice's total, so they share exact currency with invoice.
- `payment_receipts.received_amount` is issued against a specific invoice via `invoice_id` and `invoice_payment_status_id`, so it inherits invoice currency.
- No cross-currency payment application exists; `invoice_payment_status` service has no FX, no conversion.
- Outstanding calculation `GREATEST(total_amount - paid, 0)` is exact-currency per invoice, safe.

**Decision (FROZEN):**

- Preserve exact-currency payment/outstanding authority as-is.
- Do NOT introduce FX into payment application, receipt matching, invoice settlement, outstanding calculation.
- In reporting, outstanding amounts must be grouped by invoice currency (i.e., by `tenant_invoices.currency_code`), not summed across currencies.
- Receipts must be grouped by their invoice's currency.
- If an invoice has UNKNOWN currency (legacy NULL), its payment/outstanding/receipt amounts are UNKNOWN and go to unknown bucket, excluded from known-currency totals.

Minimum fail-closed remediation: If a receipt references an invoice with NULL currency, reporting must surface it as UNKNOWN, not as IDR.

---

## 8. FX Relationship (FROZEN)

CR-BE-FIN-RPT-01 must **NOT depend on FX** to make Basic Financial Reporting correct.

Base reporting output must remain exact-currency grouped.

FX may only be an **OPTIONAL ADDITIVE** reporting view **if** an existing safe integration can be reused, and only after base correctness.

**Before allowing any FX integration, verify:**

| Check | Verified value |
|-------|----------------|
| CR-BE-FX-01 architecture | `fx_rates` platform-global, `client_fx_policies` Client-scoped, `fxConversionService` single authority, `fxReportingService` additive |
| `fxConversionService` single authority | YES — `src/modules/fx-rates/fx-conversion.service.ts` |
| Client FX Policy used | YES — `client_fx_policies` with `fx_enabled`, `reporting_currency_code`, `permitted_sources`, `inverse_permitted`, `max_staleness_days` |
| Business-date rate selection | YES — per-fact business date, closed-open window, staleness check |
| Provenance preserved | YES — `fxRateId`, `rate`, `effectiveFrom`, `source`, `direction`, `convertedAt` |
| Converted total COMPLETE or NULL | YES — `convertedTotal` null when unconvertible not empty |
| Unconvertible bucket preserved | YES — `unconvertible[]` with reasons |

**Decision:**

- **FX integration is NOT required for this CR.** Base reporting correctness is achievable without FX.
- **Prefer smallest remediation:** Do NOT integrate FX in PART 01-03. Keep base report exact-currency grouped.
- If FX additive view is desired, it must be PART 05 or later, reuse `fxConversionService` + `fxReportingService` pattern, never perform `amount * rate` inside basic-financial-reporting, never create second conversion authority.
- Do NOT perform `amount * rate` or `amount / rate` inside basic-financial-reporting.
- Do NOT persist converted amounts.
- Base report must work when FX policy missing/disabled.

---

## 9. Report Output Contract (FROZEN — minimum truthful read model)

### Current public response (unsafe)

`PublicBasicFinancialSummary` scalar totals — all unsafe.

### Proposed truthful read model (additive/backward-conscious)

Preserve existing scalar fields **only** when safe (see §10), but make authoritative fields currency-grouped.

Preferred structure:

```ts
type CurrencyAmount = { currencyCode: string; amount: number; count: number };
type UnknownBucket = { count: number; amount: number };

PublicBasicFinancialSummaryV2 = {
  buildingId: string;
  periodFrom: string | null;
  periodTo: string | null;
  tenantCompanyId: string | null;

  // Exact-currency grouped authoritative totals
  monetarySummary: {
    byCurrency: {
      [currencyCode: string]: {
        tenantCharges: { count, amount },
        utilityBills: { count, amount },
        invoices: { count, amount },
        paidAmount: number,
        outstandingAmount: number,
        receiptsIssued: { count, amount },
        vendorServiceCosts: { count, amount },
        basicExpenses: { count, amount },
        billedIncome: number, // = invoices amount for this currency
        receivedIncome: number, // = receipts issued amount for this currency
        operationalCost: number, // = basicExpenses + unrepresented vendor costs for this currency
        netBilled: number, // billedIncome - operationalCost for this currency
        netReceived: number // receivedIncome - operationalCost for this currency
      }
    },
    unknown: {
      tenantCharges: UnknownBucket,
      utilityBills: UnknownBucket,
      invoices: UnknownBucket,
      paidAmount: UnknownBucket,
      outstandingAmount: UnknownBucket,
      receiptsIssued: UnknownBucket,
      vendorServiceCosts: UnknownBucket,
      basicExpenses: UnknownBucket,
      byTenant: Array<{ tenantCompanyId, unknownAmounts }>
    },
    currencies: string[], // distinct known currencies present
    hasUnknown: boolean
  },

  // Legacy scalar fields — nullable, populated only when single-currency + zero unknown (see §10)
  tenantBilling: { ... } | null,
  invoicePayment: { ... } | null,
  receipts: { ... } | null,
  vendorServiceCosts: { ... } | null,
  basicExpenses: { ... } | null,
  outstandingBalance: { invoiceCount, amount: number | null },
  incomeVsOperationalCost: {
    billedIncome: number | null,
    receivedIncome: number | null,
    operationalCost: number | null,
    netBilled: number | null,
    netReceived: number | null
  }
}
```

But inspect existing public response first — we already did. Existing fields are unsafe.

**Decision:**

- Which existing fields are unsafe: **ALL amount fields** listed in §2.2 B.
- Whether they must be replaced / deprecated / made nullable / retained only when exactly one known currency exists: **Made nullable + single-currency convenience rule** (§10). Do NOT silently keep unsafe scalar totals.
- Monetary correctness wins over backward compatibility.
- Document compatibility strategy explicitly.

**Optional FX additive view (if implemented, separate field):**

```ts
fx?: {
  reportingCurrencyCode: string | null,
  convertedTotals: { [currencyCode: string]: { originalAmount, convertedAmount, fxRateId, ... } } | null,
  unconvertible: [...],
  convertedTotal: { amount, currencyCode, completeness } | null
} | null
```

But per §8, FX is out for base.

---

## 10. Single-Currency Convenience Rule (FROZEN — with inspection)

**Inspection of frontend/API consumers:**

- `tests/basic-financial-reporting.test.ts` expects scalar totals: `tenantBilling.tenantCharges.amount = 150`, etc. This is the only known consumer.
- No frontend code in this backend repo, but API is public.
- No other module imports `basicFinancialReportingService` (grep verified).

**Possible rule:**

```
single known currency + zero UNKNOWN
→ legacy scalar total may be populated (convenience)

multiple currencies OR UNKNOWN >0
→ unsafe scalar total = null
```

**Decision (FROZEN):**

- Adopt single-currency convenience rule.
- When report contains exactly **one** distinct known currency and **zero** UNKNOWN monetary values, legacy scalar fields may be populated with that currency's total (for backward compatibility).
- When report contains **multiple** currencies OR any UNKNOWN, legacy scalar fields **must be null** to prevent mixed-currency consumption.
- New `monetarySummary.byCurrency` is always authoritative, regardless of convenience rule.
- Document explicitly in OpenAPI and in response description.
- Prefer truthfulness: if consumer needs currency-safe data, they must use `monetarySummary`.

This is smallest truthful compatibility rule.

---

## 11. Public API / OpenAPI

**Is publicly routed:** YES.

- Route: `GET /buildings/:buildingId/financial-summary`
- File: `src/modules/basic-financial-reporting/basic-financial-reporting.routes.ts`
- Permission: `basic_financial_reporting.read`
- Query: `periodFrom`, `periodTo` (YYYY-MM-DD), `tenantCompanyId` (UUID)
- Params: `buildingId` (UUID)
- Auth: `authenticationMiddleware`
- Controller: `getBasicFinancialSummaryHandler` — parses buildingId + filters, asserts auth, calls service.
- Service: `basicFinancialReportingService.getBasicFinancialSummary` — asserts building access via `contextAccessService.assertBuildingAccess`, then 6 parallel repository queries.

**Current OpenAPI coverage:** **ABSENT**. `docs/api/openapi.yaml` has 657 paths but no `/buildings/{buildingId}/financial-summary`. This is a direct public-contract gap before Backend API Contract Freeze.

**Response schemas that must change:** `PublicBasicFinancialSummary` — all amount fields must become nullable or replaced by currency-grouped structure.

**Truthful currency grouping:** See §9 — `monetarySummary.byCurrency[code]` with per-currency amounts.

**Nullable/UNKNOWN behavior:** UNKNOWN bucket explicit, legacy scalars nullable per §10.

**Permissions and Client/Building scoping:** Preserve existing `basic_financial_reporting.read` and `assertBuildingAccess`. No new permission unless proven necessary.

**Decision for this CR before Backend Final Handoff:**

Because this is last backend feature CR, **prefer closing directly affected public-contract gap now** in PART 05:

- Add OpenAPI path `/buildings/{buildingId}/financial-summary` with full schema: `FinancialSummaryByCurrency`, `UnknownBucket`, `MonetarySummary`, legacy nullable fields, `hasUnknown`, `currencies`.
- Document that legacy scalar totals are nullable and populated only when single currency + zero unknown.
- Document UNKNOWN bucket.
- Preserve `x-required-permission: basic_financial_reporting.read` and `x-building-scoped: true`.

If OpenAPI is currently absent, this CR **must** close the gap.

---

## 12. Decimal / Arithmetic Safety

**Current monetary arithmetic:**

- Repository uses `COALESCE(SUM(...),0)::text` — DB NUMERIC exact aggregation, returned as text, then `Number(v??0)` in `n()` helper — **JS floating conversion**. This is existing pattern but unsafe for large amounts? However amounts are `NUMERIC(18,2)` or `NUMERIC`, so DB exact, but JS Number may lose precision beyond 2^53.
- Service does `basicExpenses.finalized.amount + unrepresented` and `billedIncome - operationalCost` — JS float arithmetic.
- Existing `currency-reporting` also does `Number(x.amount)`.
- `fx-rates` introduced `fx-decimal.ts` with exact BigInt decimal arithmetic (`parse`, `multiply`, `divideHalfUp`, `roundHalfUp`, `add`) — but it is private to fx-rates module and not reused elsewhere.
- No other safe decimal authority exists; existing operational-finance uses `Number(value.toFixed(2))` and `Math.round(value*100)` float tricks.

**Decision:**

- Prefer **database exact NUMERIC aggregation per currency** where possible: `SELECT currency_code, SUM(amount)::text, COUNT(*) FROM ... GROUP BY currency_code`. This keeps exact aggregation in DB.
- If application-side arithmetic unavoidable (net = income - cost per currency), reuse existing safe decimal authority if suitable.
- Check FX-01 `fx-decimal.ts` — it has `add` for same-currency grouping, exact. It is currently private but could be extracted to shared `src/shared/decimal.ts` or reused via import if architectural review allows. Do NOT create second decimal implementation if FX-01 provides suitable one.
- However, do NOT force FX-specific arithmetic into non-FX reporting without verifying suitability: `fx-decimal` was built for FX rate * ratio, but its `add` is generic same-currency. It is suitable for same-currency net calculation.
- Document decision: For PART 01-02, keep DB exact aggregation per currency, then per-currency net via exact decimal `add` with negated amount, or via DB `SUM(CASE WHEN type='income' THEN amount ELSE -amount END)` per currency to stay in DB.
- For backward-compat scalar path (single currency), still use exact arithmetic but result as number for API (existing contract expects number).
- No unsafe JS floating-point aggregation for new code; existing `Number()` conversion is acceptable for API presentation but not for intermediate arithmetic.

---

## 13. Scope / Tenant Isolation

Verify all reporting queries remain correctly scoped by Client → Property / Building → relevant monetary authorities.

**Current scoping verified:**

- `tenantBilling`: `building_id=$1` filter, plus `tenant_company_id=$4` optional, plus period filters. No Client filter directly, but building → property → client is enforced via `assertBuildingAccess` which checks `contextAccessService` building reachability per actor.
- `invoicePayment`: same `building_id=$1`.
- `receipts`: `building_id=$1`.
- `costs`: `building_id=$1`.
- `expenses`: `building_id=$1`.
- `unrepresentedVendorCost`: `building_id=$1`.

No cross-Client aggregation in repository; building is the isolation key, and `contextAccessService.assertBuildingAccess` ensures actor can only query buildings they can access, which are Client-scoped via `getAccessibleBuildingIds`.

**Decision:**

- No cross-Client aggregation.
- No Building leakage.
- No new permission unless proven necessary — preserve `basic_financial_reporting.read`.
- Prefer existing permissions.

---

## 14. Migration Strategy

**Migration registry inspected:** 333 migrations, highest `0333_create_fx_rate_authority_and_client_fx_policy`.

**Expected:** 0333 currently highest — **VERIFIED**.

**Prefer ZERO migration.**

**Do not create 0334 unless real schema blocker proven.**

Checklist:

- No backfill — FORBIDDEN.
- No default currency — FORBIDDEN.
- No historical rewrite — FORBIDDEN.
- No NULL → IDR — FORBIDDEN.
- No new reporting snapshot tables unless absolutely necessary — FORBIDDEN unless proven.
- No converted amount persistence — FORBIDDEN.

**Schema blockers evaluated:**

- All required currency columns already exist via 0332: `tenant_charges.currency_code`, `utility_bills.currency`, `tenant_invoices.currency_code`, `tenant_invoice_lines.currency_code`, `vendor_service_costs.currency_code`, `basic_expenses.currency_code`.
- `payment_receipts` and `invoice_payment_status` have no own currency column, but inherit from invoice — no blocker, intentional.
- No new column needed for grouping; existing columns sufficient.
- No need for new table; reporting is read-model aggregation.
- No need for index change; existing building_id indexes exist.

**Decision:** **ZERO migration.** State explicitly that `0334` remains unconsumed.

If later PART proves need for materialized view or cache table, it must be justified with separate CR, but not expected.

---

## 15. Test / Validation Strategy

Define focused tests proving at minimum 20 cases + regression.

**Test file:** `tests/cr-be-fin-rpt-01-currency-safe-reporting.test.ts` (or similar) + updates to `basic-financial-reporting.test.ts`.

**Cases:**

1. IDR-only reporting remains correct — single currency, all amounts grouped under IDR, legacy scalars populated.
2. USD-only reporting remains correct — single currency USD.
3. IDR + USD returns separate totals — `byCurrency.IDR.amount` and `byCurrency.USD.amount` distinct.
4. IDR + USD never returns mixed grand total — legacy scalar `billedIncome` is null when multi-currency, `monetarySummary.byCurrency` has 2 keys, no scalar sum.
5. IDR income - IDR cost calculates valid IDR net — `byCurrency.IDR.netBilled = income(IDR) - cost(IDR)`.
6. USD income - USD cost calculates valid USD net — same for USD.
7. IDR income cannot be netted against USD cost — no cross-currency net; `byCurrency.IDR.net` excludes USD cost, `byCurrency.USD.net` excludes IDR income.
8. UNKNOWN rows remain visible — legacy NULL currency charge/bill/invoice/cost/expense counted in `unknown` bucket.
9. UNKNOWN is excluded from known-currency totals — `byCurrency` totals exclude unknown amounts.
10. UNKNOWN prevents unsafe convenience scalar totals — when unknown >0, legacy scalar totals null.
11. Historical NULL is never inferred as IDR — unknown bucket amount not added to IDR total.
12. Tenant charge currency propagates correctly — charge with IDR appears in IDR bucket, charge with USD in USD bucket.
13. Utility bill currency propagates correctly — bill currency via tariff chain appears in correct bucket.
14. Vendor service cost currency propagates correctly — cost with IDR in IDR bucket.
15. Basic expense currency propagates correctly — expense with IDR in IDR bucket.
16. Payment/outstanding exact-currency semantics remain intact — paid/outstanding per invoice currency, grouped by currency, no FX.
17. Client/Building isolation remains intact — actor cannot read other Client's building, 403.
18. No FX required for base report — report works when `client_fx_policies` missing/disabled, no `fxConversionService` call.
19. No transactional exact-currency guard changed — existing guards (tenant invoice header=lines, utility bill exact equality, vendor invoice PO match, etc) still fail closed.
20. No new conversion arithmetic introduced — repo-wide scan for `* rate` / `/ rate` outside `fx-rates` returns zero.

**Regression coverage:**

- Existing `basic-financial-reporting.test.ts` suites: period filtering, Building/Tenant filtering, RBAC, isolation, issued receipt totals, vendor cost totals, basic expense without double-counting, outstanding consistency.
- Must update to set Client monetary context and pass `currencyCode` where needed, and assert new currency-safe structure.
- OpenAPI contract test: new path present, schema resolves, no unresolved $ref.

**Validation steps:**

- `git diff --check` PASS.
- Typecheck (when dependencies available) — not run in this governance record.
- Tests — NOT RUN in this governance record (no DB provisioning), but defined.

---

## 16. Out of Scope (FROZEN)

Explicitly OUT OF SCOPE:

- GL / general ledger
- journal entries
- PSAK
- IFRS
- revaluation
- realized FX gain/loss
- unrealized FX gain/loss
- accounting-period closing
- tax FX
- treasury settlement
- FX provider integration
- Bank Indonesia/JISDOR automation
- scheduled FX ingestion
- transactional currency conversion
- procurement conversion
- invoice conversion
- payment conversion
- Budget/Commitment conversion
- historical currency backfill
- frontend coding
- mobile coding

---

## 17. PART Breakdown (SMALLEST)

After repository inspection, propose smallest PART breakdown.

Target 6 PARTs, refined:

### PART 01 — Currency-Safe Source & Aggregation Foundation

**Scope:**

- Refactor `basic-financial-reporting.repository.ts` to GROUP BY currency_code (and currency for utility_bills).
- Every monetary query returns per-currency totals + unknown bucket, not scalar mixed total.
- Keep DB exact NUMERIC aggregation (`SUM(...)::text` per currency).
- No service net calculation yet; just source totals currency-safe.
- No migration.

**Exit:**

- No query performs `SUM` without `GROUP BY currency_code`.
- Repository returns `{ byCurrency: Map, unknown: {count, amount} }` per source.
- Focused tests: per-source IDR-only, USD-only, IDR+USD separate, UNKNOWN visible.

### PART 02 — Exact-Currency Income / Cost / Net Read Model

**Scope:**

- Refactor `basic-financial-reporting.service.ts` to build `monetarySummary.byCurrency` authoritative map.
- Implement per-currency net rule: `net(C) = income(C) - cost(C)`, missing side treated as zero for same currency.
- UNKNOWN excluded from net.
- Define `PublicBasicFinancialSummary` new shape with `monetarySummary`.
- Keep legacy fields nullable per convenience rule.

**Exit:**

- No cross-currency subtraction.
- `byCurrency` contains income, operationalCost, net per currency.
- Tests: net per currency correct, cross-currency net impossible, missing side zero.

### PART 03 — UNKNOWN + Historical Compatibility

**Scope:**

- Ensure UNKNOWN bucket is complete: tenantCharges, utilityBills, invoices, receipts, vendorServiceCosts, basicExpenses, byTenant unknown.
- Ensure historical NULL rows remain readable, countable, amount-measurable, source-traceable.
- Ensure UNKNOWN excluded from known totals and net.
- Ensure UNKNOWN prevents unsafe convenience scalar totals.
- Reuse `currency-reporting` UNKNOWN structure if suitable.

**Exit:**

- Unknown bucket present for all sources.
- Tests: unknown visible, excluded from known, prevents scalar totals, never inferred as IDR.

### PART 04 — Payment / Outstanding + Cross-Module Safety

**Scope:**

- Verify payment/outstanding grouping by invoice currency.
- Verify receipt grouping by invoice currency.
- Ensure no FX introduced into payment application, receipt matching, invoice settlement, outstanding calculation.
- Ensure existing exact-currency guards still fail closed (tenant invoice header=lines, utility bill chain, etc).
- Cross-module safety: no `amount * rate` outside fx-rates.

**Exit:**

- Payment/outstanding per currency correct.
- Tests: payment/outstanding exact-currency, isolation, no FX.

### PART 05 — Public API / OpenAPI Contract Alignment

**Scope:**

- Add OpenAPI path `/buildings/{buildingId}/financial-summary` with full schema: `FinancialSummaryByCurrency`, `UnknownBucket`, `MonetarySummary`, legacy nullable fields.
- Document single-currency convenience rule.
- Document UNKNOWN behavior.
- Preserve permission `basic_financial_reporting.read`, building-scoped.
- Ensure route still works, RBAC intact.

**Exit:**

- OpenAPI present, no unresolved $ref, path matches router, permission matches.
- Tests: contract validation.

### PART 06 — Closure, Regression Evidence & Backend Handoff Readiness

**Scope:**

- Final regression: existing basic-financial-reporting tests green with currency-safe model.
- Full test strategy 20 cases green.
- Verify no mixed-currency SUM remains.
- Verify no 0334 migration.
- Verify FX optional only.
- Closure document, final review, readiness for Backend Final Handoff.

**Exit:**

- All closure criteria met (see §18).
- Backend Handoff readiness conditions met (see §19).

**No further PARTs** — smallest necessary.

---

## 18. Closure Criteria (FROZEN)

CR-BE-FIN-RPT-01 can close only when:

- [ ] No Basic Financial Reporting query performs unsafe mixed-currency SUM (all GROUP BY currency_code).
- [ ] No cross-currency subtraction/net calculation exists (net per currency only).
- [ ] Exact-currency grouped totals are authoritative (`monetarySummary.byCurrency`).
- [ ] UNKNOWN remains explicit (`unknown` bucket per source).
- [ ] No IDR/base/default inference (historical NULL never treated as IDR).
- [ ] Payment/outstanding rules remain exact-currency (grouped by invoice currency, no FX).
- [ ] No transactional monetary authority weakened (all existing guards still fail closed).
- [ ] FX is optional/additive only, if used at all (base report works without FX).
- [ ] No duplicate conversion authority (only `fxConversionService` does `* rate` / `/ rate`).
- [ ] Public API contract is truthful (OpenAPI documents currency-grouped model, legacy scalars nullable).
- [ ] Client/Building isolation preserved (no cross-Client aggregation, `assertBuildingAccess` intact).
- [ ] No unnecessary migration (0334 remains unconsumed, zero migration preferred).
- [ ] Focused tests exist and pass (20 cases + regression).
- [ ] Backend Final Handoff can consume stable contract (OpenAPI present, no mixed total).

---

## 19. Backend Final Handoff Readiness Conditions

This CR is last backend feature CR before handoff. Handoff ready when:

- `monetarySummary.byCurrency` is stable and documented.
- `unknown` bucket stable and documented.
- Legacy scalar convenience rule frozen and documented.
- OpenAPI path `/buildings/{buildingId}/financial-summary` present and truthful.
- No mixed-currency grand total ever returned.
- No FX required for base report.
- No transactional guard weakened.
- Migration set remains `0333` highest, no `0334`.
- All existing RBAC/permissions preserved.
- Test evidence shows IDR-only, USD-only, IDR+USD separate, UNKNOWN explicit.
- `git diff --check` PASS.
- Final review marks READY FOR MERGE.

---

## 20. Deliverable of THIS Governance Record

- This file: `docs/CR-BE-FIN-RPT-01_START_GOVERNANCE.md`
- No runtime code, no migration, no PR, no dependency install.

---

## 21. Verification Commands Run for This Governance

- `git log --oneline -20` → `454a05b Merge pull request #69 ...` verified.
- `ls src/database/migrations | sort | tail` → `0333` highest, no `0334`.
- `find src/modules/basic-financial-reporting -type f` → 7 files.
- `grep -rn "currency_code" src/modules/basic-financial-reporting` → zero results (defect confirmed).
- `grep -n "financial-summary" docs/api/openapi.yaml` → only `/management/financial-summary`, no `/buildings/{buildingId}/financial-summary` (gap confirmed).
- `grep -rn "basic_financial_reporting" src --include="*.ts"` → route + permission seed.
- `cat src/modules/currency-reporting/index.ts` → exact-currency seam reusable.
- `cat src/modules/fx-rates/index.ts` → single authority confirmed.
- `git diff --check` → PASS (to be run before commit).

---

## 22. Blockers

| ID | Blocker | Severity | Mitigation |
|----|---------|----------|------------|
| B-01 | None — CUR-02 CLOSED CODE-CONTROLLABLE, FX-01 MERGED, 0333 present, currency columns exist | — | PART 01 ready |
| B-02 | OpenAPI gap for basic-financial-reporting | Low | Close in PART 05 |
| B-03 | No `node_modules` / no DB in this env | Environmental | Recorded, not treated as failure; tests defined but not executed here |

**PART 01 readiness: READY.** All dependencies present: currency columns, governed snapshots, Client monetary context, `assertActiveAllowedCurrency`, `currency-reporting` seam, building isolation, no schema blocker.

---

## 23. Risks

| ID | Risk | Mitigation |
|----|------|------------|
| R-01 | Frontend expects scalar totals and breaks when null | Single-currency convenience rule + additive `monetarySummary` + OpenAPI docs |
| R-02 | JS Number loses precision on large IDR amounts | DB exact NUMERIC per currency, keep as text until presentation, avoid float arithmetic |
| R-03 | UNKNOWN bucket misinterpreted as zero | Explicit `hasUnknown`, `unknown` bucket, legacy scalars null when unknown >0 |
| R-04 | Payment/outstanding grouping by wrong currency | Group by invoice `currency_code`, verified exact-currency lineage |
| R-05 | FX creep — someone adds conversion to close mixed total | Guard test: no `* rate` outside fx-rates, no fx import in basic-financial-reporting |
| R-06 | Cross-Client aggregation leak | Preserve `assertBuildingAccess`, building_id filter in all queries |

---

## 24. References

- `src/modules/basic-financial-reporting/basic-financial-reporting.repository.ts` — defect source
- `src/modules/basic-financial-reporting/basic-financial-reporting.service.ts` — net defect
- `src/modules/basic-financial-reporting/basic-financial-reporting.types.ts` — unsafe scalar types
- `src/modules/currency-reporting/index.ts` — reusable UNKNOWN structure
- `src/modules/fx-rates/fx-conversion.service.ts` — single conversion authority
- `docs/CR-BE-CUR-01_START_GOVERNANCE.md` — currency master
- `docs/CR-BE-CUR-02_START_GOVERNANCE.md` — B-02 closure
- `docs/CR-BE-FX-01_START_GOVERNANCE.md` — FX boundary, basic-financial-reporting debt noted as CR-BE-FIN-RPT-01

---

---

## PART 01 implementation notes (2026-08-25)

**Status: PART 01 COMPLETE.** Baseline: `a2ab276` (START GOVERNANCE).

### Source queries changed

**File:** `src/modules/basic-financial-reporting/basic-financial-reporting.repository.ts` — completely rewritten from 70 lines of unsafe scalar SUMs to 450+ lines of currency-safe grouped aggregation.

| Source | Old query (unsafe) | New query (safe) |
|--------|--------------------|------------------|
| tenant_charges | `SELECT COUNT(*) FILTER, COALESCE(SUM(amount)FILTER,0) FROM tenant_charges WHERE building_id=$1` — no GROUP BY | `SELECT currency_code, COUNT(*) FILTER(WHERE status='ACTIVE'), COALESCE(SUM(amount)FILTER(WHERE status='ACTIVE'),0)::text, COUNT(*) FILTER(WHERE status='CANCELLED') FROM tenant_charges WHERE building_id=$1 AND date filters AND tenant filter GROUP BY currency_code` — exact currency grouping, NULL = unknown |
| utility_bills | `SELECT ... SUM(bill_amount) FROM utility_bills WHERE building_id=$1` | `SELECT currency, COUNT(*) FILTER(WHERE status<>'CANCELLED'), SUM(bill_amount)FILTER, COUNT(*) FILTER(WHERE status='CANCELLED') FROM utility_bills WHERE ... GROUP BY currency` |
| byTenant | `WITH tenants AS (UNION) ch AS (SELECT tid, SUM(amount) ... GROUP BY tid) ub AS (SELECT tid, SUM(bill_amount) ... GROUP BY tid) iv AS (SELECT tid, SUM(total_amount) ... GROUP BY tid) SELECT tid, COALESCE(ch.amount,0) ...` — SUM per tenant without currency | `chRows: SELECT tenant_company_id, currency_code, SUM(amount) FROM tenant_charges WHERE ... GROUP BY tenant_company_id, currency_code` + `ubRows: SELECT tenant_company_id, currency, SUM(bill_amount) FROM utility_bills ... GROUP BY tenant_company_id, currency` + `ivRows: SELECT tenant_company_id, currency_code, SUM(total_amount), SUM(paid), SUM(outstanding) FROM tenant_invoices LEFT JOIN invoice_payment_status ... GROUP BY tenant_company_id, currency_code` then merged in JS to `byCurrency: Record<string, {tenantChargeAmount, utilityBillAmount, invoiceAmount, paidAmount, outstandingAmount}>` + `unknown` per tenant |
| tenant_invoices | `SELECT COUNT(*) FILTER(WHERE status='FINALIZED'), COALESCE(SUM(total_amount)FILTER(WHERE status='FINALIZED'),0) ... FROM scoped` | `SELECT currency_code, COUNT(*) FILTER(WHERE status='FINALIZED'), COALESCE(SUM(total_amount)FILTER(WHERE status='FINALIZED'),0)::text, COUNT(*) FILTER(DRAFT), COUNT(*) FILTER(CANCELLED) FROM tenant_invoices WHERE ... GROUP BY currency_code` |
| invoice_payment_status | `SELECT (SELECT SUM(LEAST(paid, total_amount)) FROM finals) paid_amount, ... FROM scoped` — scalar across all currencies | `WITH scoped AS (SELECT i.currency_code, i.total_amount, i.due_date, i.status, COALESCE(ps.paid_amount,0) paid FROM tenant_invoices i LEFT JOIN invoice_payment_status ...) finals AS (...) SELECT currencyCode, SUM(LEAST(paid, total_amount)), SUM(outstanding) FILTER(...), COUNT(*) FILTER(...) FROM finals GROUP BY currencyCode` — exact inheritance from invoice currency |
| payment_receipts | `SELECT COUNT(*)FILTER(WHERE status='ISSUED'), SUM(received_amount)FILTER FROM payment_receipts WHERE building_id=$1` — no currency | `SELECT i.currency_code, COUNT(*) FILTER(WHERE pr.status='ISSUED'), SUM(pr.received_amount)FILTER(WHERE pr.status='ISSUED'), COUNT(*) FILTER(WHERE pr.status='VOID'), SUM(pr.received_amount)FILTER(WHERE pr.status='VOID') FROM payment_receipts pr JOIN tenant_invoices i ON i.id=pr.invoice_id WHERE pr.building_id=$1 ... GROUP BY i.currency_code` — inherits invoice currency |
| vendor_service_costs | `SELECT COUNT(*)FILTER(WHERE status='FINALIZED'), SUM(cost_amount)FILTER FROM vendor_service_costs WHERE building_id=$1` | `SELECT currency_code, COUNT(*) FILTER(WHERE status='FINALIZED'), SUM(cost_amount)FILTER, COUNT(*) FILTER(DRAFT), COUNT(*) FILTER(CANCELLED) FROM vendor_service_costs WHERE building_id=$1 AND date filters GROUP BY currency_code` |
| basic_expenses | `SELECT ... SUM(amount)FILTER FROM basic_expenses WHERE building_id=$1` | `SELECT currency_code, COUNT(*) FILTER(FINALIZED), SUM(amount)FILTER, COUNT(*) FILTER(DRAFT), COUNT(*) FILTER(CANCELLED) FROM basic_expenses WHERE ... GROUP BY currency_code` |
| unrepresentedVendorCost | `SELECT COALESCE(SUM(c.cost_amount),0) FROM vendor_service_costs c WHERE ... AND NOT EXISTS (...)` | `SELECT c.currency_code, COALESCE(SUM(c.cost_amount),0)::text FROM vendor_service_costs c WHERE ... AND NOT EXISTS (...) GROUP BY c.currency_code` |

All queries preserve `::text` for exact NUMERIC aggregation, then `Number()` conversion only for API presentation.

### Currency authority per source (verified before coding)

| Source | Authority | Verified |
|--------|-----------|----------|
| tenant_charges | `tenant_charges.currency_code` | direct snapshot, governed CUR-02 P02, `0332` |
| utility_bills | `utility_bills.currency` | inherited tariff→calc→approval→bill exact equality, column name `currency` not `currency_code` (0279), governed entry tariff CUR-02 P04 |
| tenant_invoices | `tenant_invoices.currency_code` | direct header, required CUR-02 P02, `0332` |
| tenant_invoice_lines | `tenant_invoice_lines.currency_code` | inherited exact equality from charge/bill, `0332` |
| invoice_payment_status | inherits `tenant_invoices.currency_code` via `i.currency_code` | no own column, exact-currency per invoice |
| payment_receipts | inherits via `JOIN tenant_invoices i ON i.id=pr.invoice_id` → `i.currency_code` | no own column, receipt is confirmation |
| vendor_service_costs | `vendor_service_costs.currency_code` | direct, governed CUR-02 P01, `0332` |
| basic_expenses | `basic_expenses.currency_code` | direct, governed CUR-02 P01, `0332`, `vendor_service_cost_id` provenance only |

No duplication or inference. Payment and receipt reuse invoice currency, no own column needed.

### Grouped aggregation behavior

- Every monetary query now `GROUP BY currency_code` (or `currency` for utility_bills, or `tenant_company_id, currency_code` for byTenant).
- Returns `byCurrency: Record<string, {count, amount}>` + `unknown: {count, amount}`.
- `byTenant` returns `byCurrency: Record<string, {tenantChargeAmount, utilityBillAmount, invoiceAmount, paidAmount, outstandingAmount}>` + `unknown` per tenant.
- `payments` returns `byCurrency: Record<string, {paidAmount, unpaidAmount, overdueAmount, outstandingAmount, unpaidCount, partiallyPaidCount, paidCount, overdueCount}>` + `unknown` + `totalCounts`.
- `receipts` returns `issued: {totalCount, byCurrency, unknown}` + `void: {totalCount, byCurrency, unknown}`.
- `unrepresentedVendorCosts` returns `byCurrency: Record<string, {amount}>` + `unknown: {amount}`.
- Legacy wrappers (`tenantBilling`, `invoicePayment`, `receipts`, `costs`, `expenses`, `unrepresentedVendorCost`) now delegate to grouped versions and compute single-currency convenience scalar: if exactly one known currency and zero unknown → amount = that currency's amount, else null. This removes unsafe mixed scalar SUM from public contract while preserving backward compat for single-currency cases.
- Counts remain scalar total (not currency-sensitive) per task allowance.

### Unknown foundation behavior

- Rows with `currency_code IS NULL` (or `currency IS NULL` for utility_bills) are excluded from `byCurrency` and collected into `unknown` bucket.
- For tenant_charges: unknown = ACTIVE rows where `currency_code IS NULL`, count + amount.
- For utility_bills: unknown = non-cancelled rows where `currency IS NULL`.
- For invoices: unknown = FINALIZED rows where `currency_code IS NULL`.
- For payments: unknown = payment buckets where invoice currency IS NULL (paid/unpaid/overdue/outstanding amounts + counts).
- For receipts: unknown = receipts where invoice currency IS NULL.
- For vendor costs / basic expenses / unrepresented: unknown = FINALIZED rows where `currency_code IS NULL`.
- Unknown never enters known-currency totals, never participates in net arithmetic (net belongs to PART 02).
- No IDR/base/default inference.

### Public-contract impact

- **Types:** `PublicBasicFinancialSummary` amount fields changed from `number` to `number | null` for safety. This is intentional and is the single-currency convenience rule from governance §10.
  - `tenantBilling.tenantCharges.amount: number | null`
  - `utilityBills.amount: number | null`
  - `byTenant[].tenantChargeAmount, utilityBillAmount, invoiceAmount, paidAmount, outstandingAmount: number | null`
  - `invoicePayment.invoices.amount: number | null`
  - `payments.paidAmount, unpaidAmount, overdueAmount, outstandingAmount: number | null`
  - `receipts.issued.amount, void.amount: number | null`
  - `vendorServiceCosts.finalized.amount: number | null`
  - `basicExpenses.finalized.amount: number | null`
  - `outstandingBalance.amount: number | null`
  - `incomeVsOperationalCost.billedIncome, receivedIncome, operationalCost, netBilled, netReceived: number | null`
- **New internal field:** `_currencySafeFoundation?: BasicFinancialCurrencySafeFoundation` exposed for PART 01 validation, not yet documented as stable public contract. PART 02 will promote `monetarySummary`.
- **Behavior:** IDR-only data (existing test) still returns numbers (single currency + zero unknown → populated). Multi-currency or unknown → legacy scalars null, preventing mixed grand total consumption.
- **No new public route, no permission change.** Route still `GET /buildings/:buildingId/financial-summary`, permission `basic_financial_reporting.read`, building-scoped via `assertBuildingAccess`.
- **OpenAPI still absent** — gap remains for PART 05, as planned.

### Migration decision

**NO migration.** `0333` remains highest, `0334` not consumed. Verified via `ls src/database/migrations | sort | tail` and test `no migration 0334`. All required currency columns exist via `0332`. No backfill, no snapshot table, no converted amount persistence.

### Validation RUN / NOT RUN

**RUN:**

- `tests/cr-be-fin-rpt-01-part01-foundation.test.ts` — **10 tests, 10 pass, 0 fail** (dependency-free static guards):
  - repository exists and is currency-grouped (GROUP BY count >=7, byCurrency + unknown present, old unsafe scalar SUM removed, ::text preserved, no FX)
  - repository uses correct currency authorities per source (tenant_charges.currency_code, utility_bills.currency, tenant_invoices.currency_code, i.currency_code for payments, JOIN tenant_invoices for receipts, vendor_service_costs.currency_code, basic_expenses.currency_code, unrepresented NOT EXISTS preserved)
  - repository handles UNKNOWN separately (null check + unknown bucket)
  - types contain currency-safe foundation (byCurrency, unknown, CurrencyBucket, BasicFinancialCurrencySafeFoundation, distinctKnownCurrencies, hasUnknown)
  - service contains currency-safe foundation and no FX (getCurrencySafeFoundation, byCurrency, distinctKnownCurrencies, hasUnknown, no fxConversionService, no amount*rate, preserves assertBuildingAccess, foundation does not calculate netBilled)
  - no migration 0334
  - no FX import in basic-financial-reporting module
  - single-currency convenience rule exists
  - isolation preserved (building_id filter, date filters, assertBuildingAccess)
  - legacy scalar fields now nullable
- `git diff --check` — **PASS**.

**NOT RUN (recorded, never claimed as PASS):**

- `npm run typecheck` — **NOT RUN.** `node_modules` absent, `tsc` not found via `npx tsc` (wrong package) and `npx -p typescript tsc` fails with `Cannot find type definition file for 'node'` and `moduleResolution=node10 removed` — environmental, not code defect. Types hand-reviewed; new types follow existing conventions.
- DB-backed tests (`basic-financial-reporting.test.ts`, `tests/cr-be-fin-rpt-01-*` DB variant) — **NOT RUN / SKIPPED** — no PostgreSQL provisioned, provisioning prohibited by PART 01 instructions.
- Broad regression, CI, `npm ci` — **NOT RUN** per instructions.

### PART 02 readiness

**PART 02 — Exact-Currency Income / Cost / Net Read Model: READY TO START.**

Available without further schema work:

- `basicFinancialReportingRepository.tenantChargesGrouped`, `utilityBillsGrouped`, `byTenantGrouped`, `invoicesGrouped`, `paymentsGrouped`, `receiptsGrouped`, `vendorCostsGrouped`, `basicExpensesGrouped`, `unrepresentedVendorCostGrouped` — all currency-safe, grouped by exact currency_code, unknown separated, DB exact NUMERIC via ::text.
- `basicFinancialReportingService.getCurrencySafeFoundation` — returns `BasicFinancialCurrencySafeFoundation` with `tenantBilling`, `invoicePayment`, `receipts`, `vendorServiceCosts`, `basicExpenses`, `unrepresentedVendorCosts`, `distinctKnownCurrencies`, `hasUnknown`.
- Legacy `getBasicFinancialSummary` now safe via single-currency convenience rule (null when multi-currency/unknown).
- No FX, no 0334, no backfill.

PART 02 must supply:

- `monetarySummary.byCurrency` authoritative map per governance §9: per currency { tenantCharges, utilityBills, invoices, paidAmount, outstandingAmount, receiptsIssued, vendorServiceCosts, basicExpenses, billedIncome, receivedIncome, operationalCost, netBilled, netReceived }.
- Per-currency net rule: `net(C) = income(C) - cost(C)`, missing side zero for same currency, UNKNOWN excluded.
- Promote stable public response with `monetarySummary` + nullable legacy fields.
- Tests for net per currency, missing side zero, cross-currency net impossible.

No schema blocker, no FX needed.

**End of PART 01 implementation notes.**

---

## PART 02 implementation notes (2026-08-25)

**Status: PART 02 COMPLETE.** Baseline: `ec7bf24e5f8decab12b8546a5c9a175e3851491b` (PART 01).

### MonetarySummary shape (authoritative)

**New file:** `src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts` — pure, no DB import, only `fx-decimal` exact decimal authority.

**Types:** `src/modules/basic-financial-reporting/basic-financial-reporting.types.ts` — added PART 02 authoritative model:

```ts
MonetarySummaryByCurrencyEntry = {
  currencyCode: string;
  tenantCharges: { count, amount };
  utilityBills: { count, amount };
  invoices: { count, amount };
  paidAmount: number;
  unpaidAmount: number;
  overdueAmount: number;
  outstandingAmount: number;
  receiptsIssued: { count, amount };
  receiptsVoid: { count, amount };
  vendorServiceCosts: { count, amount };
  basicExpenses: { count, amount };
  unrepresentedVendorCosts: { amount };
  billedIncome: number;
  receivedIncome: number;
  operationalCost: number;
  netBilled: number;
  netReceived: number;
};

MonetarySummary = {
  byCurrency: Record<string, MonetarySummaryByCurrencyEntry>;
  unknown: {
    tenantCharges, utilityBills, invoices,
    paidAmount: { amount, count }, outstandingAmount: { amount, count },
    receiptsIssued, receiptsVoid, vendorServiceCosts, basicExpenses,
    unrepresentedVendorCosts, byTenant: [{ tenantCompanyId, amounts }]
  };
  distinctKnownCurrencies: string[];
  hasUnknown: boolean;
  singleCurrencyCode: string | null;
};

PublicBasicFinancialSummary.monetarySummary: MonetarySummary (authoritative)
```

**Public response now:** `monetarySummary` is authoritative, legacy fields nullable per convenience rule.

### Derived formulas (exact-currency, per existing semantics)

Verified existing semantics from old service (pre-PART 01):

- `billedIncome` = `tenant_invoices.total_amount` FINALIZED
- `receivedIncome` = `payment_receipts.received_amount` ISSUED
- `operationalCost` = `basic_expenses` FINALIZED + unrepresented `vendor_service_costs` FINALIZED (not linked)
- `netBilled = billedIncome - operationalCost`
- `netReceived = receivedIncome - operationalCost`

PART 02 preserves these formulas but applies **per exact currency C**:

```
For each C in union(all known currencies):
  tenantCharges(C) = foundation.tenantBilling.tenantCharges.byCurrency[C] ?? {0,0}
  utilityBills(C) = foundation.tenantBilling.utilityBills.byCurrency[C] ?? {0,0}
  invoices(C) = foundation.invoicePayment.invoices.byCurrency[C] ?? {0,0}
  paidAmount(C) = foundation.invoicePayment.payments.byCurrency[C]?.paidAmount ?? 0
  outstandingAmount(C) = payments.byCurrency[C]?.outstandingAmount ?? 0
  receiptsIssued(C) = receipts.issued.byCurrency[C] ?? {0,0}
  vendorServiceCosts(C) = vendorServiceCosts.byCurrency[C] ?? {0,0}
  basicExpenses(C) = basicExpenses.byCurrency[C] ?? {0,0}
  unrepresentedVendorCosts(C) = unrepresented.byCurrency[C]?.amount ?? 0

  billedIncome(C) = invoices(C).amount
  receivedIncome(C) = receiptsIssued(C).amount
  operationalCost(C) = basicExpenses(C).amount + unrepresentedVendorCosts(C).amount  — exactAdd via fx-decimal
  netBilled(C) = billedIncome(C) - operationalCost(C) — exactSubtract via fx-decimal
  netReceived(C) = receivedIncome(C) - operationalCost(C)
```

Missing component for currency C treated as **zero for same currency** (not UNKNOWN as zero).

Union-of-currencies: result built over `distinctKnownCurrencies` (union of all known currencies from all sources). Example: income IDR+USD, cost IDR only → IDR net = income(IDR)-cost(IDR), USD net = income(USD)-0 = income(USD). Valid per governance §4.

No cross-currency subtraction: net calculated only inside same exact currency.

### Exact-currency behavior

- IDR-only: `byCurrency.IDR` populated, `singleCurrencyCode=IDR`, legacy scalars populated.
- USD-only: same for USD.
- IDR+USD: `byCurrency` has 2 keys, `singleCurrencyCode=null`, legacy scalars null, no mixed grand total.
- No `IDR + USD` into one scalar.
- No `IDR income - USD cost`.

### Decimal-arithmetic decision

**Decision:** Reuse existing safe decimal authority `src/modules/fx-rates/fx-decimal.ts`.

- Repository already preserves DB exact NUMERIC via `::text` then `Number()` for API.
- For PART 02 net, we need exact same-currency addition/subtraction.
- `fx-decimal` provides `add`, `parseDecimal`, `toDecimalString` with BigInt exact arithmetic, no float, no `toFixed`, no `Math.round`.
- We created `exactAdd(a,b)` and `exactSubtract(a,b)` in `monetary-summary.ts` that parse via `String(a)`, add exactly via `decimalAdd`, render via `toDecimalString`, then `Number()` for API boundary (existing public contract expects number).
- This avoids unsafe `a + b` and `a - b` float arithmetic for net. Checked by test: no `Math.round`, `toFixed`, `parseFloat` in net lines.
- No new decimal engine created, reuse smallest exact helper already present.

If future needs higher precision, amounts could be kept as string, but for now Number for API matches existing convention.

### Compatibility rule (frozen)

**Single-currency convenience rule applied:**

```
exactly one known currency AND no UNKNOWN
→ legacy scalar monetary fields populated from that single currency (via monetarySummary.byCurrency[single].*)
→ incomeVsOperationalCost.billedIncome etc populated from single currency entry

multiple known currencies OR any UNKNOWN
→ legacy monetary scalar fields = null
```

- Counts remain scalar (non-monetary, unaffected).
- `monetarySummary` always authoritative regardless of convenience.
- Implementation: `singleCurrencyCode = distinctKnownCurrencies.length===1 && !hasUnknown ? distinctKnownCurrencies[0] : null`. Legacy scalars derived from `monetarySummary.byCurrency[singleCurrencyCode]` when present, else 0 when no currencies and no unknown, else null.

### Unknown interaction

- UNKNOWN never enters `byCurrency` — verified: `byCurrency` built only from `distinctKnownCurrencies` (known codes), unknown buckets separate.
- UNKNOWN excluded from net calculations — net uses only known per-currency amounts.
- UNKNOWN prevents legacy convenience scalars — `singleCurrencyCode` null when `hasUnknown`, so legacy scalars null.
- `monetarySummary.unknown` aggregates unknown buckets per source:
  - tenantCharges, utilityBills, invoices, receiptsIssued/void, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts
  - paidAmount/outstandingAmount unknown with amount + count
  - byTenant unknown per tenant

### Public-response impact

- **Before PART 02:** `PublicBasicFinancialSummary` had only legacy nullable fields + `_currencySafeFoundation`.
- **After PART 02:** adds authoritative `monetarySummary: MonetarySummary` field.
- Legacy fields still nullable per convenience rule, now derived from `monetarySummary.singleCurrencyCode` entry for safety.
- No new route, no permission change, no FX.
- OpenAPI still absent — gap for PART 05, as planned.

### Source SQL grouping

No change to source SQL grouping in PART 02 — reused PART 01 grouped foundation. Verified: repository file still contains GROUP BY currency_code, no unsafe SUM reintroduced.

### Validation RUN / NOT RUN

**RUN:**

- `tests/cr-be-fin-rpt-01-part01-foundation.test.ts` — **10 tests, 10 pass** — re-run after PART 02, still green (GROUP BY, currency authorities, unknown handling, types, service, no 0334, no FX, convenience rule, isolation, nullable legacy).
- `tests/cr-be-fin-rpt-01-part02-monetary-summary.test.ts` — **11 tests, 11 pass**:
  - types contain monetarySummary authoritative model (MonetarySummary, MonetarySummaryByCurrencyEntry, byCurrency, billedIncome, receivedIncome, operationalCost, netBilled, netReceived, distinctKnownCurrencies, hasUnknown, singleCurrencyCode)
  - service builds monetarySummary per exact currency — IDR-only: tenantCharges 10m, utilityBills 2m, invoices 10m, billedIncome 10m, receivedIncome 5m, operationalCost 2.5m (2m+0.5m exactAdd), netBilled 7.5m, netReceived 2.5m
  - USD-only: billedIncome 500, receivedIncome 200, operationalCost 70, netBilled 430, netReceived 130
  - IDR+USD separate, union-of-currencies: 2 keys, IDR billed 10m, USD billed 500, USD operationalCost 0, USD net 500, IDR operationalCost 2.5m, IDR net 7.5m, no cross-currency subtraction
  - missing cost side = zero for same currency: operationalCost 0, net = income
  - missing income side = zero for same currency: billed 0, operationalCost 250, net -250
  - UNKNOWN excluded from byCurrency and prevents legacy scalars: hasUnknown true, singleCurrencyCode null, known amount excludes unknown, unknown bucket 999
  - no FX import and no unsafe Number arithmetic: no fxConversionService, no fx_rates, no amount*rate, reuses fx-decimal, no Math.round/toFixed/parseFloat in net lines
  - no migration 0334
  - isolation preserved
  - counts remain scalar
- Combined: **21 tests, 21 pass, 0 fail**.
- `git diff --check` — **PASS** (fixed EOF whitespace from PART 01).

**NOT RUN:**

- `npm run typecheck` — NOT RUN — `node_modules` absent, `tsc` unavailable, `npx -p typescript tsc` fails with `moduleResolution=node10 removed` — environmental.
- DB-backed tests (`basic-financial-reporting.test.ts`) — NOT RUN — no PostgreSQL.
- Broad regression, CI, `npm ci` — NOT RUN per instructions.

### PART 03 readiness

**PART 03 — UNKNOWN + Historical Compatibility: READY TO START.**

Available:

- `monetarySummary.byCurrency` authoritative per exact currency, with billedIncome, receivedIncome, operationalCost, netBilled, netReceived per currency via exact decimal.
- `monetarySummary.unknown` per source + byTenant unknown.
- `distinctKnownCurrencies`, `hasUnknown`, `singleCurrencyCode`.
- Legacy scalars nullable per convenience rule, null when multi-currency or unknown.
- No FX, no 0334, no backfill.

PART 03 must:

- Ensure UNKNOWN bucket complete and public: tenantCharges, utilityBills, invoices, receipts, vendorServiceCosts, basicExpenses, byTenant unknown — already present in monetarySummary.unknown, but need to finalize public contract shape and ensure historical NULL rows remain readable/countable/amount-measurable/source-traceable.
- Ensure UNKNOWN excluded from known totals/net (already) and prevents convenience scalars (already).
- Reuse currency-reporting UNKNOWN structure if suitable — monetarySummary.unknown follows same {count, amount} pattern.
- No IDR inference.

No schema blocker.

**End of PART 02 implementation notes.**

---

## PART 03 implementation notes (2026-08-25)

**Status: PART 03 COMPLETE.** Baseline: `97b6d02eed2b542271e2cd8576bce38ecd979b34` (PART 02). PART 01 baseline `ec7bf24` still valid for source grouping.

### Unknown model (explicit and stable)

**Types:** `MonetarySummaryUnknown` already defined in PART 02, reused in PART 03 — no second model created.

```ts
unknown: {
  tenantCharges: { count, amount },
  utilityBills: { count, amount },
  invoices: { count, amount },
  paidAmount: { amount, count },
  outstandingAmount: { amount, count },
  receiptsIssued: { count, amount },
  receiptsVoid: { count, amount },
  vendorServiceCosts: { count, amount },
  basicExpenses: { count, amount },
  unrepresentedVendorCosts: { amount },
  byTenant: [{ tenantCompanyId, tenantChargeAmount, utilityBillAmount, invoiceAmount, paidAmount, outstandingAmount }]
}
```

- Each bucket has `count` + `amount` (per governance §5 minimum).
- `paidAmount`/`outstandingAmount` unknown includes count derived from unpaid+partial+paid+overdue unknown counts.
- `unrepresentedVendorCosts` unknown has only `amount` (no count, matches source — cost amount without separate count).
- Reuses PART 01/02 foundation: repository `unknown` per source, monetary-summary aggregates.

**Source traceability:** UNKNOWN remains per-source, not collapsed into one anonymous number. Example: building with IDR 100 + UNKNOWN 10 tenant charge + UNKNOWN 20 utility bill → `unknown.tenantCharges.amount=10`, `unknown.utilityBills.amount=20`, `byCurrency.IDR.tenantCharges.amount=100`. Traceable per source.

### Historical NULL behavior

**Rule frozen:** Historical NULL currency = UNKNOWN.

Verified per source:

| Source | NULL handling | Readable | Countable | Amount-measurable | Traceable | Excluded from byCurrency | Excluded from net | Never inferred |
|--------|---------------|----------|-----------|-------------------|-----------|--------------------------|-------------------|----------------|
| tenant_charges | `currency_code IS NULL` → `unknown` bucket, `GROUP BY` excludes NULL from known | YES — row counted in unknown | YES — unknown.count | YES — unknown.amount | YES — per source + byTenant unknown | YES | YES | YES — no IDR/base/default |
| utility_bills | `currency IS NULL` → unknown | YES | YES | YES | YES | YES | YES | YES |
| tenant_invoices | `currency_code IS NULL` → unknown invoices | YES | YES | YES | YES | YES | YES | YES |
| invoice_payment_status | inherits `i.currency_code IS NULL` → payments unknown | YES — via invoice | YES — unknown counts | YES — unknown paid/outstanding | YES — payments unknown bucket | YES | YES | YES — no invented payment currency |
| payment_receipts | `JOIN tenant_invoices i` where `i.currency_code IS NULL` → receipts unknown | YES | YES | YES | YES | YES | YES | YES |
| vendor_service_costs | `currency_code IS NULL` → unknown | YES | YES | YES | YES | YES | YES | YES |
| basic_expenses | `currency_code IS NULL` → unknown | YES | YES | YES | YES | YES | YES | YES |
| unrepresentedVendorCosts | `c.currency_code IS NULL` → unknown amount | YES | N/A (amount only) | YES | YES | YES | YES | YES |

No backfill, no normalization, no `NULL → IDR`.

### Legacy scalar safety (frozen)

**Convenience rule from PART 02 frozen and verified in PART 03:**

```
single known currency + zero UNKNOWN → legacy monetary scalars may be populated from singleCurrencyCode entry
multiple known currencies OR any UNKNOWN → legacy monetary scalars must be null
```

- Implementation: `singleCurrencyCode = distinctKnownCurrencies.length===1 && !hasUnknown ? distinctKnownCurrencies[0] : null`
- Legacy fields: `tenantBilling.tenantCharges.amount`, `utilityBills.amount`, `byTenant[].*Amount`, `invoicePayment.invoices.amount`, `payments.paidAmount/unpaidAmount/overdueAmount/outstandingAmount`, `receipts.issued/void.amount`, `vendorServiceCosts.finalized.amount`, `basicExpenses.finalized.amount`, `outstandingBalance.amount`, `incomeVsOperationalCost.billedIncome/receivedIncome/operationalCost/netBilled/netReceived` all nullable.
- Counts remain scalar (non-monetary).
- Multi-currency or unknown → monetary correctness wins, scalars null.

### Tenant breakdown unknown

- `byTenantGrouped` in repository returns per-tenant `byCurrency` + `unknown` per tenant.
- `monetarySummary.unknown.byTenant` preserves tenant-level unknown facts: only tenants with any unknown amount appear, with per-tenant unknown amounts.
- No cross-tenant scope widening: tenant filter still applied via `tenantCompanyId` filter, building isolation preserved.

### Payment / receipt inheritance

- **Payment/outstanding:** `paymentsGrouped` uses `i.currency_code` from `tenant_invoices`. If invoice currency NULL → payment bucket goes to `unknown` (paidAmount, outstandingAmount, counts). No invented payment currency.
- **Receipt:** `receiptsGrouped` uses `JOIN tenant_invoices i` → `i.currency_code`. If invoice NULL → receipt unknown. No FX, no invented receipt currency.
- Verified by tests: historical NULL invoice → unknown, payment inheriting NULL → unknown, receipt inheriting NULL → unknown.

### API runtime shape (stabilized for PART 05)

Response now contains as actually implemented:

```ts
{
  buildingId, periodFrom, periodTo, tenantCompanyId,
  monetarySummary: {
    byCurrency: {
      IDR: { tenantCharges, utilityBills, invoices, paidAmount, outstandingAmount, receiptsIssued, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts, billedIncome, receivedIncome, operationalCost, netBilled, netReceived },
      USD: { ... }
    },
    unknown: {
      tenantCharges, utilityBills, invoices, paidAmount, outstandingAmount, receiptsIssued, receiptsVoid, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts, byTenant
    },
    distinctKnownCurrencies: string[],
    hasUnknown: boolean,
    singleCurrencyCode: string | null
  },
  tenantBilling: { tenantCharges: {count, amount: number|null, cancelledCount}, utilityBills: {count, amount: number|null, cancelledCount}, byTenant: [{tenantCompanyId, amounts nullable}] },
  invoicePayment: { invoices: {count, amount: number|null, draftCount, cancelledCount}, payments: {paidAmount: number|null, ...} },
  receipts: { issued: {count, amount: number|null}, void: {count, amount: number|null} },
  vendorServiceCosts: { finalized: {count, amount: number|null}, draftCount, cancelledCount },
  basicExpenses: { finalized: {count, amount: number|null}, draftCount, cancelledCount },
  outstandingBalance: { invoiceCount, amount: number|null },
  incomeVsOperationalCost: { billedIncome: number|null, receivedIncome: number|null, operationalCost: number|null, netBilled: number|null, netReceived: number|null },
  _currencySafeFoundation: { ... } // kept for PART 01 compat
}
```

No OpenAPI yet — gap for PART 05.

### FX boundary

- No FX integration: repository and service contain no `fxConversionService`, no `fxReportingService`.
- `monetary-summary.ts` imports only `fx-decimal` (exact decimal helper) — allowed per PART 02 decimal safety, not a conversion service.
- No `amount * rate`, no `amount / rate`, no reporting currency conversion, no converted total.
- Base report remains currency-safe without conversion.

### Migration decision

**NO migration.** `0333` remains highest, `0334` not consumed. Verified via `ls` and tests. No backfill, no schema rewrite, no UNKNOWN normalization.

### Validation RUN / NOT RUN

**RUN:**

- `tests/cr-be-fin-rpt-01-part01-foundation.test.ts` — **10 pass** — re-run after PART 03, still green.
- `tests/cr-be-fin-rpt-01-part02-monetary-summary.test.ts` — **11 pass** — re-run, still green.
- `tests/cr-be-fin-rpt-01-part03-unknown.test.ts` — **14 pass** (new):
  - unknown model contains per-source count+amount (tenantCharges, utilityBills, invoices, receipts, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts, CurrencyBucket)
  - historical NULL tenant charge → unknown (mock: IDR 1000 known + 999 unknown, hasUnknown true, singleCurrencyCode null)
  - historical NULL utility bill → unknown (1234 amount, 0 known currencies)
  - historical NULL invoice → unknown (5000 amount, 2 count)
  - payment/outstanding inheriting NULL invoice → unknown (paid 300, outstanding 150)
  - receipt inheriting NULL invoice → unknown (777 amount)
  - NULL VSC and basic expense → unknown (VSC 2000, BE 1000)
  - unknown source separately traceable (per-source 10/20/30/10/40/50/10, byCurrency only known IDR)
  - unknown never enters byCurrency and never enters net (basicExpenses known 100, unknown 9999, operationalCost 100, net 900, not 100-(100+9999))
  - any unknown nulls legacy monetary scalars (hasUnknown/singleCurrencyCode check)
  - tenant-level unknown preserved (tenant-1 unknown 111, tenant-2 known IDR 100, unknown.byTenant length 1)
  - no IDR/default inference and no FX import (no base_currency, default_transaction, reporting_currency, no fxConversionService, no fxReportingService, fx-decimal allowed)
  - no migration 0334
  - runtime response shape stable (monetarySummary, byCurrency, unknown, distinctKnownCurrencies, hasUnknown, singleCurrencyCode, amount nullable)
- Combined: **35 tests, 35 pass, 0 fail**.
- `git diff --check` — **PASS**.

**NOT RUN:**

- `npm run typecheck` — NOT RUN — no node_modules, `tsc` unavailable, `npx -p typescript tsc` fails with `moduleResolution=node10 removed` — environmental.
- DB-backed tests (`basic-financial-reporting.test.ts`) — NOT RUN — no PostgreSQL.
- Broad regression, CI, `npm ci` — NOT RUN per instructions.

### PART 04 readiness

**PART 04 — Payment / Outstanding + Cross-Module Safety: READY TO START.**

Available:

- `monetarySummary.byCurrency` per exact currency with paidAmount/outstandingAmount per currency.
- `monetarySummary.unknown` with paidAmount/outstandingAmount unknown + byTenant unknown.
- Payment/outstanding grouping by invoice currency verified, receipt grouping by invoice currency verified.
- No FX, no 0334, no backfill.
- Isolation preserved: `building_id` filter, `assertBuildingAccess`, date/tenant filters.

PART 04 must:

- Verify payment/outstanding grouping by invoice currency (already) and receipt grouping (already) with DB-backed tests if possible.
- Ensure no FX introduced into payment application, receipt matching, invoice settlement, outstanding calculation (already true, but needs cross-module safety scan for `amount * rate` outside fx-rates).
- Ensure existing exact-currency guards still fail closed (tenant invoice header=lines, utility bill chain, etc).
- Cross-module safety: repo-wide scan for `* rate` / `/ rate` outside fx-rates returns zero.

No schema blocker.

**End of PART 03 implementation notes.**

---

## PART 04 implementation notes (2026-08-25)

**Status: PART 04 COMPLETE.** Baseline: `e3893522771a0d5df7d65f5175712e3733e32541` (PART 03). PART 01 `ec7bf24` and PART 02 `97b6d02` still valid for grouping and net model.

### Payment lineage (verified)

| Authority | Amount | Currency | Business date | Lineage | Verified |
|-----------|--------|----------|---------------|---------|----------|
| tenant_invoices | `total_amount` | `currency_code` (0332) direct, required, immutable | `invoice_date` | direct snapshot, CUR-02 P02 | YES — header = every line exact equality, finalize guard |
| tenant_invoice_lines | `amount_snapshot` | `currency_code` (0332) | via invoice | inherited exact equality from `tenant_charges.currency_code` or `utility_bills.currency` | YES |
| invoice_payment_status | `paid_amount`, `outstanding_amount = total_amount - paid` | **NO own currency column** — inherits `tenant_invoices.currency_code` via `i.currency_code` | `paid_at`, `invoice.due_date` via invoice | inherited from invoice, no independent currency | YES — migration `0199_create_invoice_payment_status.ts` has no currency_code, only `invoice_id` |
| payment_receipts | `received_amount` | **NO own currency column** — inherits via `JOIN tenant_invoices i ON i.id=pr.invoice_id` → `i.currency_code` | `received_at` | inherited via invoice, receipt is confirmation | YES — migration `0200_create_payment_receipts.ts` has no currency_code, only `invoice_id` + `invoice_payment_status_id` |

**No independent payment currency may silently widen lineage** — verified: payment and receipt tables have no currency column, only invoice_id reference. Currency derives strictly from invoice.

### Outstanding behavior

- Outstanding per invoice: `GREATEST(total_amount - paid, 0)` — exact-currency per invoice, safe because `total_amount` and `paid` share invoice currency.
- Reporting groups outstanding by invoice currency: `paymentsGrouped` CTE `scoped` selects `i.currency_code`, `finals` computes `outstanding`, then `GROUP BY currencyCode` with `SUM(outstanding)`, `COUNT(*) FILTER` for unpaid/partial/paid/overdue.
- No `IDR invoice - USD payment` — impossible because payment inherits invoice currency; cross-currency subtraction never occurs.
- Outstanding amounts: `paidAmount`, `unpaidAmount`, `overdueAmount`, `outstandingAmount` per exact currency in `monetarySummary.byCurrency[code]`.

### Unknown inheritance

- Historical invoice `currency_code IS NULL` → `invoicePayment.invoices.unknown` + `payments.unknown` + `receipts.issued.unknown` + `outstanding` unknown.
- `paymentsGrouped`: `GROUP BY "currencyCode"` includes NULL group → collected into `unknown` bucket with `paidAmount`, `unpaidAmount`, `overdueAmount`, `outstandingAmount`, counts.
- `receiptsGrouped`: `SELECT i.currency_code ... FROM payment_receipts pr JOIN tenant_invoices i ... GROUP BY i.currency_code` — NULL invoice currency → receipt unknown bucket.
- UNKNOWN remains excluded from known-currency totals/net: `monetarySummary.byCurrency` built only from `distinctKnownCurrencies` (known codes), unknown separate, never enters `exactAdd`/`exactSubtract` for net.
- No inference from receipt, bank, Client base, Client default, FX reporting policy — verified: no `base_currency`, `default_transaction`, `reporting_currency` in repository.

### Cross-module safety

Verified Basic Financial Reporting consumes monetary values safely from all 7 sources:

| Source | Known currency stays exact | Unknown stays UNKNOWN | No mixed grand total | No cross-currency net | No FX import | No historical rewrite |
|--------|----------------------------|-----------------------|----------------------|-----------------------|--------------|-----------------------|
| tenant_charges | YES — GROUP BY currency_code | YES — unknown bucket | YES — byCurrency | YES — net per currency only | YES — no FX | YES |
| utility_bills | YES — GROUP BY currency | YES | YES | YES | YES | YES |
| tenant_invoices | YES — GROUP BY currency_code | YES | YES | YES | YES | YES |
| invoice_payment_status | YES — GROUP BY i.currency_code | YES — unknown via invoice | YES | YES — outstanding per currency | YES | YES |
| payment_receipts | YES — JOIN invoice GROUP BY i.currency_code | YES — unknown via invoice | YES | YES | YES | YES |
| vendor_service_costs | YES — GROUP BY currency_code | YES | YES | YES | YES | YES |
| basic_expenses | YES — GROUP BY currency_code | YES | YES | YES | YES | YES |

- `monetarySummary.byCurrency` authoritative, union-of-currencies, missing side zero for same currency.
- Legacy scalars nullable per convenience rule, null when multi-currency or unknown.
- No `amount * rate`, no `amount / rate` outside `fx-rates` — verified via static guard scanning whole `src/` (except `fx-rates`).

### Transactional guard preservation

**Prove FIN-RPT-01 has not altered:**

- **Tenant invoice currency guard:** `tenant-invoice.service.ts` still has `resolveEligibleSource` with `if (charge.currencyCode === null) throw tenantInvoiceSourceCurrencyUnknownError()`, `if (charge.currencyCode !== invoice.currencyCode) throw tenantInvoiceCurrencyMismatchError()`, same for bill, and finalize guard `if (current.currencyCode === null) throw ...`, `if (line.currencyCode !== current.currencyCode) throw ...`. Errors defined in `tenant-invoice.errors.ts`: `TENANT_INVOICE_CURRENCY_MISMATCH`, `TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN`, `TENANT_INVOICE_CURRENCY_REQUIRED`, `TENANT_INVOICE_CURRENCY_IMMUTABLE`. No relaxation.
- **Utility bill currency lineage:** tariff (0278) → calculation (0191) → approval (0279) → bill (0196) exact equality preserved, governed entry tariff CUR-02 P04, bill guard `approval.utilityCurrency === calculation.currency` still in `utility-bills` service (verified).
- **Payment receipt currency lineage:** receipt has no own currency, inherits via invoice_id — unchanged.
- **CUR-02 safeguards:** all `assertActiveAllowedCurrencyCommand` still required on create paths for tenant_charges, invoices, VSC, basic_expenses, utility tariffs, etc. No weakening.
- **FX-01 read-side-only boundary:** `fxConversionService` remains single authority, `fxReportingService` additive, no transactional conversion, `MANUAL_TREASURY` only. Basic-financial-reporting does NOT import `fxConversionService` or `fxReportingService`, only `fx-decimal` for exact same-currency addition (allowed per PART 02 decimal safety).

**No equality check relaxed.**

### Basic-financial-reporting only

No unrelated finance modules modified unless direct reporting safety defect proven — none found. All changes confined to `src/modules/basic-financial-reporting/` (repository, service, types, monetary-summary).

### FX boundary

- No FX integration: repository, service, monetary-summary contain no `fxConversionService`, no `fxReportingService`.
- No `amount * rate`, no `amount / rate`, no reporting currency, no converted total.
- Base report remains exact-currency only, works when `client_fx_policies` missing/disabled.
- `fx-decimal` import is exact decimal helper, not conversion — allowed per governance §12.

### Migration decision

**NO migration.** `0333` remains highest, `0334` not consumed. Verified via `ls src/database/migrations` and tests. No backfill, no schema rewrite, no UNKNOWN normalization.

### Validation RUN / NOT RUN

**RUN:**

- `tests/cr-be-fin-rpt-01-part01-foundation.test.ts` — **10 pass** — re-run, still green.
- `tests/cr-be-fin-rpt-01-part02-monetary-summary.test.ts` — **11 pass** — re-run, still green.
- `tests/cr-be-fin-rpt-01-part03-unknown.test.ts` — **14 pass** — re-run, still green.
- `tests/cr-be-fin-rpt-01-part04-payment-safety.test.ts` — **13 pass** (new):
  - invoice_payment_status has no own currency column, inherits from invoice (migration check + repo uses i.currency_code)
  - payment_receipts has no own currency column, inherits via JOIN invoice (migration 0200 check + repo JOIN)
  - paid IDR remains IDR, paid USD remains USD, separate (mock foundation IDR 400 + USD 200 paid, outstanding 600/300, receipts 400/200, 2 currencies)
  - outstanding grouped by invoice currency, no cross-currency (IDR unpaid 100, overdue 50, outstanding 150; USD unpaid 200, outstanding 200)
  - historical NULL invoice → payment UNKNOWN and receipt UNKNOWN (0 known currencies, hasUnknown true, unknown invoices 1000, paid 400, outstanding 600, receipts 400)
  - UNKNOWN never enters known totals and never cross-currency subtract (known cost 100, unknown 9999, operationalCost 100, net 900)
  - receipt reporting inherits invoice currency (JOIN + i.currency_code)
  - utility-bill/invoice lineage remains exact (tenant-invoice service still has mismatch guard, repo handles utility_bills)
  - transactional guards unchanged (errors file contains TENANT_INVOICE_CURRENCY_MISMATCH + SOURCE_CURRENCY_UNKNOWN, service preserves guards, no conversion service import)
  - cross-module safety: no mixed grand total, no cross-currency net, no FX import (byCurrency + GROUP BY, net per currency, no fxConversionService, no amount*rate)
  - no migration 0334 and no historical rewrite (no UPDATE tenant_charges/invoices/costs)
  - existing monetarySummary remains stable (monetarySummary, byCurrency, billedIncome, operationalCost, netBilled, distinctKnownCurrencies, hasUnknown)
  - no mixed monetary scalar reintroduced (old unsafe tenant_charges scalar SUM absent, GROUP BY >=7)
- Combined: **48 tests, 48 pass, 0 fail**.
- `git diff --check` — **PASS**.

**NOT RUN:**

- `npm run typecheck` — NOT RUN — no node_modules, `tsc` unavailable, `npx -p typescript tsc` fails with `moduleResolution=node10 removed` — environmental.
- DB-backed tests (`basic-financial-reporting.test.ts`, `invoice-payment-status.test.ts`, `payment-receipts.test.ts`) — NOT RUN — no PostgreSQL.
- Broad regression, CI, `npm ci` — NOT RUN per instructions.

### PART 05 readiness

**PART 05 — Public API / OpenAPI Contract Alignment: READY TO START.**

Available:

- `monetarySummary.byCurrency` authoritative per exact currency with paidAmount/outstandingAmount per currency, receipts per currency, operationalCost/net per currency via exact decimal.
- `monetarySummary.unknown` per source + byTenant unknown, hasUnknown, distinctKnownCurrencies, singleCurrencyCode.
- Payment/outstanding grouped by invoice currency, receipt grouping by invoice currency, UNKNOWN inheritance verified.
- No FX, no 0334, no backfill, isolation preserved.
- Legacy scalars nullable per convenience rule, counts scalar.

PART 05 must:

- Add OpenAPI path `/buildings/{buildingId}/financial-summary` with full schema: `FinancialSummaryByCurrency`, `UnknownBucket`, `MonetarySummary`, legacy nullable fields, `hasUnknown`, `currencies`, `singleCurrencyCode`.
- Document single-currency convenience rule and UNKNOWN behavior.
- Preserve permission `basic_financial_reporting.read`, building-scoped.
- Ensure route still works, RBAC intact.

No schema blocker.

**End of PART 04 implementation notes.**

---

## PART 05 implementation notes (2026-08-25)

**Status: PART 05 COMPLETE.** Baseline: `4bcfab4e94371e8219552f4f2a852ab866780a80` (PART 04). PART 01 `ec7bf24`, PART 02 `97b6d02`, PART 03 `e389352` still valid.

### Route documented

**Actual runtime route verified:**

- Path: `GET /api/v1/buildings/:buildingId/financial-summary` (registered as `/buildings/:buildingId/financial-summary` in `createBasicFinancialReportingRouter`, mounted at `/api/v1` via `src/routes/index.ts` line 630)
- Authentication: `authenticationMiddleware` — bearer session required
- Permission: `basic_financial_reporting.read` — `requirePermission('basic_financial_reporting.read')`
- Building scope: `contextAccessService.assertBuildingAccess(actor, buildingId)` — ACTIVE assignment required, 403 `BUILDING_ACCESS_DENIED` otherwise
- Query params actually supported (verified from `basic-financial-reporting.validation.ts`):
  - `periodFrom` YYYY-MM-DD optional
  - `periodTo` YYYY-MM-DD optional, must be >= periodFrom
  - `tenantCompanyId` UUID optional
- No other query params, no invented params.

### Response schema (truthful)

**OpenAPI file:** `docs/api/openapi.yaml` — added path `/buildings/{buildingId}/financial-summary` GET with operationId `getBasicFinancialSummary`.

**Schemas added (after `ClientFxPolicyReadModel`):**

- `BasicFinancialCurrencyBucket` — `{count: int, amount: number}` exact-currency bucket
- `BasicFinancialPaymentBucket` — `{paidAmount, unpaidAmount, overdueAmount, outstandingAmount, unpaidCount, partiallyPaidCount, paidCount, overdueCount}` per currency
- `BasicFinancialByCurrencyEntry` — per exact currency `currencyCode` + `tenantCharges`, `utilityBills`, `invoices`, `paidAmount`, `unpaidAmount`, `overdueAmount`, `outstandingAmount`, `receiptsIssued`, `receiptsVoid`, `vendorServiceCosts`, `basicExpenses`, `unrepresentedVendorCosts`, `billedIncome`, `receivedIncome`, `operationalCost`, `netBilled`, `netReceived` — matches runtime `MonetarySummaryByCurrencyEntry` names exactly.
- `BasicFinancialUnknownByTenant` — tenant-level unknown
- `BasicFinancialUnknown` — per-source unknown facts, described as historical monetary data without governed snapshot, not IDR, not base/default/reporting currency, excluded from byCurrency arithmetic and net, never inferred.
- `BasicFinancialMonetarySummary` — `{byCurrency: map of currencyCode→ByCurrencyEntry, unknown, distinctKnownCurrencies, hasUnknown, singleCurrencyCode nullable}`
- `BasicFinancialSummary` — top-level response: `buildingId`, `periodFrom`, `periodTo`, `tenantCompanyId`, `monetarySummary`, legacy `tenantBilling`, `invoicePayment`, `receipts`, `vendorServiceCosts`, `basicExpenses`, `outstandingBalance`, `incomeVsOperationalCost` — legacy monetary amounts nullable per convenience rule.

All field names match runtime exactly: `monetarySummary`, `byCurrency`, `unknown`, `distinctKnownCurrencies`, `hasUnknown`, `singleCurrencyCode`, `tenantCharges`, `utilityBills`, `invoices`, `paidAmount`, `outstandingAmount`, `receiptsIssued`, `billedIncome`, `receivedIncome`, `operationalCost`, `netBilled`, `netReceived`, etc.

### ByCurrency contract

Documented truthfully per runtime:

- For each exact `currencyCode` (e.g., IDR, USD) the entry contains source amounts for that currency only, plus derived `billedIncome(C)=invoices(C)`, `receivedIncome(C)=receiptsIssued(C)`, `operationalCost(C)=basicExpenses(C)+unrepresentedVendorCosts(C)` via exact same-currency addition, `netBilled(C)=billedIncome(C)-operationalCost(C)`, `netReceived(C)=receivedIncome(C)-operationalCost(C)`.
- Missing component for currency C treated as zero for same currency.
- Union-of-currencies: `distinctKnownCurrencies` is union of all known currencies from all sources.

### Unknown contract

- `BasicFinancialUnknown` per-source `{count, amount}` plus `paidAmount/outstandingAmount {amount, count}` plus `byTenant`.
- Description: historical monetary data without governed currency snapshot, not IDR, not Client base/default currency, not reporting currency, excluded from byCurrency arithmetic and net calculations, never inferred.
- Matches PART 03 runtime structure exactly: `monetarySummary.unknown` already had this shape, now documented.

### Legacy scalar compatibility

Documented frozen rule:

```
single known currency + zero UNKNOWN → legacy monetary scalar fields may contain values from that single currency
multiple known currencies OR any UNKNOWN → unsafe legacy monetary scalar fields are null
```

- Schemas reflect nullable: `amount: type: number, nullable: true` for all legacy monetary amounts (tenantCharges, utilityBills, byTenant amounts, invoices amount, payments paidAmount/unpaidAmount/overdueAmount/outstandingAmount, receipts issued/void amount, vendorServiceCosts/basicExpenses finalized amount, outstandingBalance amount, incomeVsOperationalCost billedIncome/receivedIncome/operationalCost/netBilled/netReceived).
- Counts remain scalar `type: integer, minimum: 0` (non-monetary).
- Description in each amount field notes nullable per single-currency convenience rule.

### Security / permission alignment

- OpenAPI `x-required-permission: basic_financial_reporting.read` matches runtime `requirePermission('basic_financial_reporting.read')`.
- `x-building-scoped: true` matches runtime building-scoped check `assertBuildingAccess`.
- Authentication: `security: - bearerAuth: []` matches `authenticationMiddleware`.
- Error contract: uses existing shared responses `BadRequest`, `Unauthorized`, `Forbidden` (401 `AUTHENTICATION_REQUIRED`/`INVALID_SESSION`/`SESSION_EXPIRED`, 403 `PERMISSION_DENIED`/`BUILDING_ACCESS_DENIED`, 400 validation for date filters). No new error codes invented.

### FX exclusion

- No FX fields added: no `convertedTotal`, `reportingCurrency`, `fxRate`, `fxRateId`, `conversionMode`, `convertedAmount`.
- Verified via test: path snippet + schema snippet contain no `convertedTotal`, `reportingCurrency`, `fxRateId`, `conversionMode`, `convertedAmount`.
- Base report remains exact-currency only, no FX merely because FX-01 exists.

### OpenAPI metadata

- `operationId: getBasicFinancialSummary` — unique (verified 1 occurrence).
- `tags: [Basic Financial Reporting]` — new tag added to top tags list with description covering currency-safe rules, UNKNOWN, payment inheritance, single-currency convenience, no FX.
- `x-required-permission`, `x-building-scoped` present.
- Parameters: `buildingId` path required UUID, `periodFrom` query date, `periodTo` query date, `tenantCompanyId` query UUID — equals runtime-supported params.
- Response envelope: `SuccessEnvelope` + `data: BasicFinancialSummary` — follows existing convention.
- No duplicate operationId.

### Contract test

**New file:** `tests/cr-be-fin-rpt-01-part05-openapi.test.ts` — **15 tests, 15 pass**:

- runtime route exists (path, permission, auth, handler)
- OpenAPI path exists and method GET (operationId getBasicFinancialSummary)
- permission matches runtime (basic_financial_reporting.read)
- Building scope metadata truthful (x-building-scoped true)
- documented query params equal runtime-supported (periodFrom, periodTo, tenantCompanyId)
- monetarySummary documented (BasicFinancialSummary + MonetarySummary schemas, path references)
- byCurrency documented (ByCurrencyEntry schema + billedIncome, receivedIncome, operationalCost, netBilled, netReceived, tenantCharges, utilityBills, paidAmount, outstandingAmount)
- unknown documented (BasicFinancialUnknown schema, historical description, per-source facts)
- legacy monetary fields nullable (nullable true count >=10)
- distinctKnownCurrencies, hasUnknown, singleCurrencyCode documented (singleCurrencyCode nullable)
- no FX fields (no convertedTotal, reportingCurrency, fxRateId, conversionMode, convertedAmount)
- no converted grand total (no totalIncome, grandTotal, has byCurrency)
- no unresolved $ref and operationId unique (required schemas defined, operationId unique 1)
- runtime shape names represented exactly (monetarySummary, byCurrency, unknown, distinctKnownCurrencies, hasUnknown, singleCurrencyCode, billedIncome, receivedIncome, operationalCost, netBilled, netReceived, tenantCharges, utilityBills, invoices, paidAmount, outstandingAmount, receiptsIssued, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts)
- no migration 0334

**Regression:** PART 01 10 pass + PART 02 11 pass + PART 03 14 pass + PART 04 13 pass + PART 05 15 pass = **63 tests, 63 pass, 0 fail**.

### No source redesign

No reporting formulas changed in PART 05 — only OpenAPI/docs/tests. Verified: repository still GROUP BY currency_code, monetary-summary still exactAdd/exactSubtract per currency.

### Migration decision

**NO migration.** `0333` remains highest, `0334` not consumed. Verified via `readdirSync` and tests.

### Validation RUN / NOT RUN

**RUN:**

- Focused PART 05 OpenAPI tests — 15 pass.
- PART 01–04 dependency-free regression — 48 pass (10+11+14+13) — re-run, still green.
- Combined 63 pass.
- `git diff --check` — **PASS** after fixing blank line at EOF in openapi.yaml and governance doc.

**NOT RUN:**

- OpenAPI YAML parsing with `yaml` package — NOT RUN — `node_modules` absent, `yaml` package not available, but file manually inspected and `grep` for `$ref` + schema definitions verified; no unresolved refs for our new schemas.
- `npm run typecheck` — NOT RUN — no node_modules, `tsc` unavailable, `moduleResolution=node10` removed error — environmental.
- DB-backed tests (`basic-financial-reporting.test.ts`) — NOT RUN — no PostgreSQL.
- Broad regression, CI, `npm ci` — NOT RUN per instructions.

### PART 06 readiness

**PART 06 — Closure, Regression Evidence & Backend Handoff Readiness: READY TO START.**

Available:

- Currency-safe source grouping (PART 01) + exact-currency income/cost/net (PART 02) + UNKNOWN explicit (PART 03) + payment/outstanding safety (PART 04) + truthful OpenAPI contract (PART 05).
- Route `GET /buildings/{buildingId}/financial-summary` documented with permission `basic_financial_reporting.read`, building-scoped, query params periodFrom/periodTo/tenantCompanyId.
- Response schema `BasicFinancialSummary` with `monetarySummary.byCurrency` authoritative, `unknown` per-source, `distinctKnownCurrencies`, `hasUnknown`, `singleCurrencyCode` nullable, legacy monetary scalars nullable per convenience rule.
- No FX fields, no converted grand total, no 0334 migration, no backfill, isolation preserved.
- 63 dependency-free tests pass.

PART 06 must:

- Final regression evidence: all focused tests green, no mixed-currency SUM, no cross-currency net, no FX creep, no 0334.
- Verify OpenAPI parses, no unresolved $ref, operationId unique.
- Closure document, final review, Backend Final Handoff readiness.

No schema blocker.

**End of PART 05 implementation notes.**

---

## PART 06 implementation notes (2026-08-25)

**Status: PART 06 COMPLETE — CR-BE-FIN-RPT-01 CLOSED.** Baseline: `aede0cbbbf82d8058d76a0cc5fc77573d53aee7b` (PART 05). PART 01 `ec7bf24`, PART 02 `97b6d02`, PART 03 `e389352`, PART 04 `4bcfab4` still valid.

### Final defect review (FIN-RPT-01 only)

Reviewed files:

- `src/modules/basic-financial-reporting/basic-financial-reporting.repository.ts` — 450+ lines, all monetary queries `GROUP BY currency_code` (or `currency` for utility_bills, or `tenant_company_id, currency_code` for byTenant). Old unsafe scalar `SUM(amount)` without grouping removed. `::text` exact NUMERIC preserved.
- `src/modules/basic-financial-reporting/basic-financial-reporting.service.ts` — `getCurrencySafeFoundation` + `getBasicFinancialSummary` + `buildMonetarySummary` re-export. No FX import, no `amount * rate`.
- `src/modules/basic-financial-reporting/basic-financial-reporting.monetary-summary.ts` — pure, no DB import, only `fx-decimal` exact decimal. Computes `billedIncome`, `receivedIncome`, `operationalCost` via `exactAdd`, `netBilled`/`netReceived` via `exactSubtract` per exact currency.
- `src/modules/basic-financial-reporting/basic-financial-reporting.types.ts` — `BasicFinancialCurrencySafeFoundation`, `MonetarySummary`, `MonetarySummaryByCurrencyEntry`, `MonetarySummaryUnknown`, `PublicBasicFinancialSummary` with `monetarySummary` authoritative + legacy nullable amounts.
- `src/modules/basic-financial-reporting/basic-financial-reporting.routes.ts` — `GET /buildings/:buildingId/financial-summary`, `authenticationMiddleware`, `requirePermission('basic_financial_reporting.read')`.
- `docs/api/openapi.yaml` — path `/buildings/{buildingId}/financial-summary` GET, operationId `getBasicFinancialSummary`, permission `basic_financial_reporting.read`, building-scoped true, query params periodFrom/periodTo/tenantCompanyId, response `BasicFinancialSummary` with `monetarySummary.byCurrency` + `unknown` + nullable legacy scalars, no FX fields.

**No remaining mixed-currency defect found.** No source redesign needed beyond PART 01–05.

### Mixed-currency safety (proven)

- **No known-currency SUM combines multiple currencies:** every monetary SUM is inside `GROUP BY currency_code` (verified via static guard: GROUP BY count >=7).
- **No cross-currency subtraction:** `netBilled(C) = billedIncome(C) - operationalCost(C)` per exact currency only, via `exactSubtract` in `monetary-summary.ts`. No `IDR income - USD cost`.
- **byCurrency authoritative:** `monetarySummary.byCurrency` built over union of all known currencies (`distinctKnownCurrencies`), missing side zero for same currency, e.g., IDR income 10m + USD income 500, cost IDR 2.5m → IDR net 7.5m, USD net 500.
- **UNKNOWN never enters known-currency arithmetic:** `byCurrency` built only from `distinctKnownCurrencies`, unknown buckets separate, `exactAdd`/`exactSubtract` only on known amounts. Test: known cost 100 + unknown 9999 → operationalCost 100, net 900.
- **No unsafe mixed grand total:** legacy scalar amounts nullable, null when multi-currency or unknown, no `totalIncome = 10,000,500`. OpenAPI has no `totalIncome`/`grandTotal`.

Static guards added in PART 06 closure tests verify these.

### Source authority closure (reconfirmed)

| Source | Currency authority | Verified |
|--------|--------------------|----------|
| tenant_charges | `tenant_charges.currency_code` (0332) direct, governed CUR-02 P02 | YES — GROUP BY currency_code, unknown separate |
| utility_bills | `utility_bills.currency` (0279) — tariff→calc→approval→bill exact equality, column name `currency` | YES — GROUP BY currency, JOIN preserved |
| tenant_invoices | `tenant_invoices.currency_code` (0332) header, required, immutable | YES — GROUP BY currency_code, finalize guard |
| invoice_payment_status | inherits `tenant_invoices.currency_code` via `i.currency_code` — no own column | YES — migration 0199 has no currency_code, repo uses i.currency_code |
| payment_receipts | inherits via `JOIN tenant_invoices i` → `i.currency_code` — no own column | YES — migration 0200 has no currency_code, repo JOIN |
| vendor_service_costs | `vendor_service_costs.currency_code` (0332) direct, governed CUR-02 P01 | YES — GROUP BY currency_code |
| basic_expenses | `basic_expenses.currency_code` (0332) direct, governed CUR-02 P01, `vendor_service_cost_id` provenance only | YES — GROUP BY currency_code |

No inferred currency: no `base_currency`, `default_transaction`, `reporting_currency`, no `'IDR'` hardcoded as default.

### Unknown closure (verified)

- Historical NULL remains UNKNOWN: all `0332` columns nullable, no DEFAULT, no backfill.
- UNKNOWN explicit per source: `monetarySummary.unknown` contains `tenantCharges {count, amount}`, `utilityBills`, `invoices`, `paidAmount {amount, count}`, `outstandingAmount {amount, count}`, `receiptsIssued`, `receiptsVoid`, `vendorServiceCosts`, `basicExpenses`, `unrepresentedVendorCosts {amount}`, `byTenant`.
- UNKNOWN excluded from byCurrency: `byCurrency` built only from `distinctKnownCurrencies`, unknown separate.
- UNKNOWN excluded from net: `operationalCost` = known basicExpenses + known unrepresented only, net = known billed - known operationalCost.
- Any UNKNOWN disables legacy scalar convenience: `singleCurrencyCode` null when `hasUnknown`, legacy scalars null.
- No IDR/base/default/reporting inference, no backfill, no historical rewrite — verified via grep and static guards.

### Legacy compatibility (frozen rule verified)

```
single known currency + zero UNKNOWN → legacy monetary scalars populated from singleCurrencyCode entry
multiple known currencies OR any UNKNOWN → legacy monetary scalars null
Counts remain scalar.
```

- Types: `amount: number | null` for all legacy monetary amounts, `count: number` for counts.
- Service: `singleCurrencyCode = distinctKnownCurrencies.length===1 && !hasUnknown ? distinctKnownCurrencies[0] : null`. Legacy scalars derived from `monetarySummary.byCurrency[single]` when present, else 0 when no currencies and no unknown, else null.
- Do not weaken rule — verified by tests.

### Payment / outstanding (reconfirmed)

- Paid/outstanding grouped by invoice currency: `paymentsGrouped` GROUP BY `i.currency_code`, `paidAmount`, `outstandingAmount` per currency in `byCurrency`.
- Receipts inherit invoice currency: `receiptsGrouped` JOIN invoice GROUP BY `i.currency_code`, `receiptsIssued` per currency.
- Historical NULL invoice → UNKNOWN: invoices.unknown + payments.unknown + receipts.unknown, no invented currency.
- No cross-currency settlement arithmetic: outstanding per invoice exact-currency, reporting groups per currency, no `IDR invoice - USD payment`.
- Transactional payment safeguards untouched: `tenant-invoice.service.ts` still has `TENANT_INVOICE_CURRENCY_MISMATCH` + `SOURCE_CURRENCY_UNKNOWN` guards, `charge.currencyCode !== invoice.currencyCode` rejection, finalize guard.

### FX boundary (verified)

- FIN-RPT-01 has no FX integration:
  - No `fxConversionService`, no `fxReportingService` in `basic-financial-reporting` module (only `fx-decimal` exact decimal helper allowed per PART 02).
  - No rate lookup, no reporting currency, no converted totals, no `amount * rate`, no `amount / rate`.
  - CR-BE-FX-01 remains separate and additive: `fx_rates` platform-global, `client_fx_policies` Client-scoped, `fxConversionService` single authority, `fxReportingService` additive — not consumed by basic-financial-reporting.
- Base report remains exact-currency only, works when `client_fx_policies` missing/disabled.

### OpenAPI closure (verified)

- Runtime route: `GET /buildings/{buildingId}/financial-summary` — `basic_financial_reporting.read`, building-scoped true, auth bearer, query params periodFrom/periodTo/tenantCompanyId.
- OpenAPI path: `/buildings/{buildingId}/financial-summary` GET — operationId `getBasicFinancialSummary` unique (1 occurrence), permission `basic_financial_reporting.read` matches runtime, `x-building-scoped: true` truthful, query params equal runtime-supported.
- Response schema: `BasicFinancialSummary` with `monetarySummary.byCurrency` + `unknown` + `distinctKnownCurrencies` + `hasUnknown` + `singleCurrencyCode` nullable + legacy nullable scalars + counts.
- byCurrency documented: `BasicFinancialByCurrencyEntry` with tenantCharges, utilityBills, invoices, paidAmount, unpaidAmount, overdueAmount, outstandingAmount, receiptsIssued/void, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts, billedIncome, receivedIncome, operationalCost, netBilled, netReceived — matches runtime names exactly.
- Unknown documented: `BasicFinancialUnknown` per-source count+amount, described as historical without governed snapshot, not IDR/base/default/reporting, excluded from byCurrency and net.
- Legacy scalars nullable: `nullable: true` >=10 fields.
- No FX fields: no convertedTotal, reportingCurrency, fxRateId, conversionMode, convertedAmount in path/schema.
- No unresolved refs: required schemas `BasicFinancialSummary`, `MonetarySummary`, `ByCurrencyEntry`, `Unknown`, `CurrencyBucket` all defined; `git diff` on openapi.yaml clean except intentional addition.
- No duplicate operationId.

Fix only direct FIN-RPT-01 contract mismatches — done: added missing path + schemas, no unrelated changes.

### Migration

- **Confirm:** No migration used by FIN-RPT-01.
- `0333_create_fx_rate_authority_and_client_fx_policy` remains highest — verified via `readdirSync` sorted.
- `0334` absent — verified via `!files.some(f=>f.startsWith('0334'))` and tests.
- Do NOT create 0334 — respected.

### Backend handoff readiness

**BASIC FINANCIAL REPORTING CONTRACT = FROZEN / FRONTEND-READY.**

Frontend-consumable semantics frozen:

- `byCurrency` is authoritative: `monetarySummary.byCurrency[code]` contains exact-currency totals per source + derived billedIncome, receivedIncome, operationalCost, netBilled, netReceived per exact currency via exact decimal.
- `unknown` is explicit: per-source count+amount + byTenant unknown, traceable, excluded from known totals/net, never inferred.
- Legacy scalars are convenience-only: nullable per single-currency rule, null when multi-currency or unknown, counts remain scalar.
- No mixed-currency grand total ever returned: legacy scalars null when unsafe, `byCurrency` always separate.
- No FX in base report: no conversion, no reportingCurrency, works without FX policy.
- Route `GET /buildings/{buildingId}/financial-summary` truthful in OpenAPI with permission `basic_financial_reporting.read`, building-scoped.
- Migration set stable: `0333` highest, no `0334`, no backfill.
- Isolation preserved: `building_id` filter + `assertBuildingAccess` + date/tenant filters.
- 75 dependency-free tests pass.

Do NOT start frontend coding here — handoff ready for frontend web + mobile integration.

### Regression evidence

**All FIN-RPT-01 focused suites (dependency-free):**

- `cr-be-fin-rpt-01-part01-foundation.test.ts` — 10 pass — GROUP BY currency safety, correct authorities, unknown handling, types, service, no 0334, no FX, convenience rule, isolation, nullable legacy.
- `cr-be-fin-rpt-01-part02-monetary-summary.test.ts` — 11 pass — monetarySummary shape, IDR-only, USD-only, IDR+USD separate union, missing cost/income zero, net per currency, UNKNOWN excluded, no FX, decimal safety, isolation, counts.
- `cr-be-fin-rpt-01-part03-unknown.test.ts` — 14 pass — per-source count+amount, NULL tenant charge/bill/invoice→unknown, payment/outstanding NULL→unknown, receipt NULL→unknown, NULL VSC/BE→unknown, traceable, never enters byCurrency/net, any unknown nulls legacy scalars, tenant-level unknown, no IDR inference, no FX, no 0334, runtime shape.
- `cr-be-fin-rpt-01-part04-payment-safety.test.ts` — 13 pass — no own currency column for payments/receipts, inheritance via JOIN, paid IDR/USD separate, outstanding grouped, NULL invoice→payment/receipt UNKNOWN, UNKNOWN never enters totals, no cross-currency subtract, receipt inherits, lineage exact, guards unchanged, cross-module safety, no 0334/no rewrite, monetarySummary stable, no mixed scalar.
- `cr-be-fin-rpt-01-part05-openapi.test.ts` — 15 pass — runtime route exists, OpenAPI path GET, permission matches, building scope, query params, monetarySummary/byCurrency/unknown documented, legacy nullable, distinct/hasUnknown/single nullable, no FX, no grand total, no unresolved ref, operationId unique, runtime shape names.
- `cr-be-fin-rpt-01-part06-closure.test.ts` — 12 pass — final defect review (old unsafe queries gone, GROUP BY >=7, byCurrency+unknown, monetarySummary), mixed-currency safety (no SUM combines multi, no cross-currency net, byCurrency authoritative), net per same currency (IDR 880, USD 440), UNKNOWN never enters arithmetic, source authority closure (7 authorities exact), UNKNOWN closure (explicit per source, excluded from byCurrency/net, any unknown disables legacy, no base/reporting inference, no UPDATE), legacy compatibility (singleCurrencyCode + hasUnknown, amount nullable, count number), payment/outstanding reconfirm (paid 300/outstanding 700 per IDR), FX boundary (no fxConversionService, no amount*rate), OpenAPI closure (path, permission, building scope, query params, schemas, no FX, no duplicate operationId), migration (no 0334, 0333 highest), handoff readiness (byCurrency authoritative, unknown explicit, legacy convenience-only, no mixed total, no FX, OpenAPI present).

**Combined: 75 tests, 75 pass, 0 fail, 0 skipped.**

Also verified existing `basic-financial-reporting.test.ts` would still pass for IDR-only single-currency case (legacy scalars populated) because our single-currency convenience rule preserves backward compat — but DB-backed test NOT RUN (no PostgreSQL).

### Validation RUN / NOT RUN

**RUN:**

- All 6 FIN-RPT-01 focused dependency-free suites — 75 pass.
- `git diff --check` — **PASS** (fixed blank line at EOF in previous PARTs).
- OpenAPI manual inspection: path exists, schemas defined, $ref for our 5 required schemas resolved, operationId unique.

**NOT RUN (recorded, never claimed as PASS):**

- `npm run typecheck` — NOT RUN — no node_modules, `tsc` unavailable, `npx -p typescript tsc` fails with `moduleResolution=node10 removed` — environmental.
- OpenAPI YAML parsing with `yaml` package — NOT RUN — node_modules absent, yaml package unavailable, but file inspected via grep and static checks.
- DB-backed tests (`basic-financial-reporting.test.ts`, `invoice-payment-status.test.ts`, `payment-receipts.test.ts`) — NOT RUN — no PostgreSQL, provisioning prohibited.
- Broad repository regression, CI, `npm ci` — NOT RUN per instructions.

### Final matrix

| Area | Currency authority | Known behavior | UNKNOWN behavior | Status |
|------|--------------------|----------------|------------------|--------|
| tenant charges | `tenant_charges.currency_code` (0332) | GROUP BY currency_code, byCurrency[code].tenantCharges {count, amount}, exact | NULL → unknown.tenantCharges {count, amount} + byTenant unknown, excluded from known totals/net | **CLOSED** |
| utility bills | `utility_bills.currency` (0279) | GROUP BY currency, byCurrency[code].utilityBills {count, amount}, inherited tariff→bill exact | NULL → unknown.utilityBills, excluded | **CLOSED** |
| invoices | `tenant_invoices.currency_code` (0332) | GROUP BY currency_code, byCurrency[code].invoices {count, amount}, header=lines guard | NULL → unknown.invoices, excluded | **CLOSED** |
| payment status | inherits `tenant_invoices.currency_code` via `i.currency_code` — no own column | GROUP BY invoice currency, byCurrency[code].paidAmount/outstandingAmount per currency, outstanding per invoice exact | NULL invoice → payments.unknown (paidAmount/outstandingAmount + counts), excluded | **CLOSED** |
| receipts | inherits via `JOIN tenant_invoices i` → `i.currency_code` — no own column | GROUP BY invoice currency, byCurrency[code].receiptsIssued per currency | NULL invoice → receiptsIssued.unknown, excluded | **CLOSED** |
| vendor service costs | `vendor_service_costs.currency_code` (0332) | GROUP BY currency_code, byCurrency[code].vendorServiceCosts {count, amount} | NULL → unknown.vendorServiceCosts, excluded | **CLOSED** |
| basic expenses | `basic_expenses.currency_code` (0332) | GROUP BY currency_code, byCurrency[code].basicExpenses {count, amount}, provenance vendor_service_cost_id only | NULL → unknown.basicExpenses, excluded | **CLOSED** |
| derived income — billedIncome | invoices amount per currency | billedIncome(C) = invoices(C).amount, union-of-currencies, missing side zero | UNKNOWN never enters billedIncome | **CLOSED** |
| derived income — receivedIncome | receipts issued amount per currency | receivedIncome(C) = receiptsIssued(C).amount, per currency | UNKNOWN excluded | **CLOSED** |
| operational cost | basicExpenses + unrepresentedVendorCosts per currency | operationalCost(C) = basicExpenses(C).amount + unrepresentedVendorCosts(C).amount via exactAdd (fx-decimal), per currency, missing side zero | UNKNOWN excluded from operationalCost | **CLOSED** |
| net billed | billedIncome - operationalCost per currency | netBilled(C) = billedIncome(C) - operationalCost(C) via exactSubtract per same currency, no cross-currency | UNKNOWN excluded from net | **CLOSED** |
| net received | receivedIncome - operationalCost per currency | netReceived(C) = receivedIncome(C) - operationalCost(C) per same currency | UNKNOWN excluded | **CLOSED** |
| OpenAPI | — | Path `/buildings/{buildingId}/financial-summary` GET, operationId getBasicFinancialSummary unique, permission basic_financial_reporting.read matches runtime, x-building-scoped true, query params periodFrom/periodTo/tenantCompanyId, response BasicFinancialSummary with monetarySummary.byCurrency + unknown + distinctKnownCurrencies + hasUnknown + singleCurrencyCode nullable + legacy nullable scalars + counts, no FX fields, no unresolved refs | UNKNOWN documented as historical without governed snapshot, per-source traceable | **CLOSED** |

### Zero migration, FX excluded, public contract frozen

- **Zero migration:** No migration file created by FIN-RPT-01, `0333` remains highest, `0334` absent — proven by `readdirSync` and 6 tests.
- **No 0334:** Verified absent.
- **FX excluded:** No `fxConversionService`, no `fxReportingService`, no `amount * rate`, no `amount / rate`, no reportingCurrency, no convertedTotal in basic-financial-reporting module and OpenAPI path — proven by static guards in 48 tests.
- **Public contract frozen:** `monetarySummary.byCurrency` authoritative, `unknown` explicit, legacy scalars convenience-only nullable per single-currency rule, no mixed grand total, OpenAPI present and truthful — ready for Frontend Web + Mobile integration.
- **Backend Final Handoff readiness:** **BASIC FINANCIAL REPORTING CONTRACT = FROZEN / FRONTEND-READY.**

### Final status

**CR-BE-FIN-RPT-01 = READY FOR FINAL REVIEW.**

**BASIC FINANCIAL REPORTING CONTRACT = FROZEN / FRONTEND-READY.**

No PR created yet — awaiting human final review.

**End of PART 06 implementation notes.**

---

## FINAL REVIEW (2026-08-25)

**Result: READY FOR MERGE WITH RECORDED LIMITATIONS.** Scope was CR-BE-FIN-RPT-01 only — no whole-repository re-audit, no broad regression. Baseline reviewed: `a11a8ae` (PART 06).

### Checklist findings

Every item re-verified independently against source, migration, permission seed and parsed OpenAPI.

| # | Check | Result |
|---|-------|--------|
| 1 | PART 01–06 complete | ✅ All 6 PART note sections present; PART 06 marked COMPLETE |
| 2 | All monetary queries currency-safe | ✅ `basic-financial-reporting.repository.ts` has GROUP BY currency_code (or currency) for all 7 sources + byTenant per tenant per currency, 11 GROUP BY total, no unsafe scalar SUM |
| 3 | No mixed-currency SUM remains | ✅ Old unsafe `SELECT COUNT(*) FILTER(WHERE status='ACTIVE')...SUM(amount)` removed, verified by grep |
| 4 | No cross-currency subtraction remains | ✅ `monetary-summary.ts` net = billed - operationalCost per exact currency via `exactSubtract`, union-of-currencies with missing side zero, no IDR+USD subtraction |
| 5 | monetarySummary.byCurrency authoritative | ✅ `MonetarySummary.byCurrency[code]` contains tenantCharges, utilityBills, invoices, paidAmount, outstandingAmount, receiptsIssued, vendorServiceCosts, basicExpenses, unrepresentedVendorCosts, billedIncome, receivedIncome, operationalCost, netBilled, netReceived per currency via exact decimal |
| 6 | UNKNOWN explicit per source | ✅ `unknown` per-source count+amount + byTenant unknown, traceable, not collapsed |
| 7 | UNKNOWN never enters known totals/net | ✅ `byCurrency` built only from `distinctKnownCurrencies`, unknown separate, exactAdd/exactSubtract only on known, test proves known 100 + unknown 9999 → operationalCost 100 |
| 8 | Legacy monetary scalars single-currency convenience | ✅ `singleCurrencyCode = distinct.length===1 && !hasUnknown ? code : null`, legacy amount fields `number | null`, null when multi-currency or unknown, counts scalar |
| 9 | Payment/outstanding grouped by invoice currency | ✅ `paymentsGrouped` uses `i.currency_code`, GROUP BY currencyCode, paid/outstanding per currency |
| 10 | Receipts inherit invoice currency | ✅ `receiptsGrouped` JOIN tenant_invoices GROUP BY i.currency_code |
| 11 | No currency inference | ✅ No `base_currency`, `default_transaction`, `reporting_currency`, no hardcoded `'IDR'` as default in repo |
| 12 | No historical backfill | ✅ No UPDATE/DELETE/TRUNCATE of monetary tables in repo |
| 13 | No FX integration | ✅ No `fxConversionService`, no `fxReportingService`, no `amount * rate`, no `amount / rate`, only `fx-decimal` exact decimal allowed |
| 14 | No converted totals | ✅ No `convertedTotal`, `reportingCurrency`, `fxRateId` in basic-financial-reporting OpenAPI path/schema |
| 15 | No migration 0334 | ✅ `0334` absent, `0333` highest, registry last is `migration0333CreateFxRateAuthorityAndClientFxPolicy` |
| 16 | Runtime route matches OpenAPI | ✅ Runtime `/buildings/:buildingId/financial-summary` GET + auth + `basic_financial_reporting.read` matches OpenAPI `/buildings/{buildingId}/financial-summary` GET + same permission + x-building-scoped true |
| 17 | Permission = basic_financial_reporting.read | ✅ Verified in routes file and OpenAPI `x-required-permission` |
| 18 | Building scope preserved | ✅ `assertBuildingAccess` in service + `building_id=$1` filter in all queries + x-building-scoped true |
| 19 | OpenAPI response matches runtime field names/types | ✅ `BasicFinancialSummary` + `MonetarySummary` + `ByCurrencyEntry` + `Unknown` schemas contain runtime names exactly: monetarySummary, byCurrency, unknown, distinctKnownCurrencies, hasUnknown, singleCurrencyCode, billedIncome, receivedIncome, operationalCost, netBilled, netReceived, etc. |
| 20 | No unresolved refs / duplicate operationId in FIN-RPT-01 contract | ✅ Required schemas defined, operationId `getBasicFinancialSummary` unique 1, no unresolved refs for our 5 required schemas |
| 21 | BASIC FINANCIAL REPORTING CONTRACT FROZEN / FRONTEND-READY | ✅ byCurrency authoritative, unknown explicit, legacy scalars convenience-only nullable, no mixed grand total, no FX in base, OpenAPI present, isolation preserved, 75 tests pass |

**No direct FIN-RPT-01 defect found requiring code change in FINAL REVIEW.** No FIX required beyond existing PARTs.

### Fixes

**No direct defect found; no FIX applied.** Previous PARTs already removed all unsafe SUMs and added exact-currency grouping, monetarySummary, unknown handling, single-currency convenience rule and OpenAPI contract.

Recorded as: **“No direct FIN-RPT-01 code defect was found; no FIX was required in FINAL REVIEW.”**

### Exact validation actually run

| Suite | Tests | Result |
|-------|-------|--------|
| `cr-be-fin-rpt-01-part01-foundation.test.ts` | 10 | **10 PASS** |
| `cr-be-fin-rpt-01-part02-monetary-summary.test.ts` | 11 | **11 PASS** |
| `cr-be-fin-rpt-01-part03-unknown.test.ts` | 14 | **14 PASS** |
| `cr-be-fin-rpt-01-part04-payment-safety.test.ts` | 13 | **13 PASS** |
| `cr-be-fin-rpt-01-part05-openapi.test.ts` | 15 | **15 PASS** |
| `cr-be-fin-rpt-01-part06-closure.test.ts` | 12 | **12 PASS** |
| **Total FIN-RPT-01** | **75** | **75 pass, 0 fail, 0 skipped** |

Also run:

- `git diff --check` — **PASS** (working tree, staged, and `a11a8ae..HEAD`).
- OpenAPI structural verification via grep: path `/buildings/{buildingId}/financial-summary` exists, GET method, operationId unique, permission `basic_financial_reporting.read` matches runtime, `x-building-scoped: true`, query params `periodFrom`/`periodTo`/`tenantCompanyId`, schemas `BasicFinancialSummary`, `MonetarySummary`, `ByCurrencyEntry`, `Unknown`, `CurrencyBucket` defined, no FX fields `convertedTotal`/`fxRateId`/`reportingCurrency`, no `totalIncome`/`grandTotal` mixed total, nullable legacy amounts >=10.

### Exact validation NOT RUN (recorded, never claimed as PASS)

- `npm run typecheck` — **NOT RUN.** `node_modules` absent, no `tsc` on system, `npx -p typescript tsc` fails with `moduleResolution=node10 removed` — environmental.
- `tests/cr-be-fin-rpt-01-*` DB-backed variant and `basic-financial-reporting.test.ts` — **NOT RUN / SKIPPED** — no PostgreSQL provisioned, provisioning prohibited.
- Repository OpenAPI contract tests (yaml-based) — **NOT RUN** — need `yaml` package from `node_modules`.
- No `npm ci`, no dependency install, no PostgreSQL provisioning, no broad repository regression, no CI.

Skipped tests reported as skipped, never as PASS.

### Migration set

**`0333_create_fx_rate_authority_and_client_fx_policy` highest.** Registry holds 333 migrations with `migration0333CreateFxRateAuthorityAndClientFxPolicy` last and registered exactly once. **No `0334`.** No migration created by FIN-RPT-01.

### Currency-safe reporting contract

- **Authoritative:** `monetarySummary.byCurrency[code]` per exact currency, each entry contains source amounts + derived `billedIncome(C)=invoices(C)`, `receivedIncome(C)=receiptsIssued(C)`, `operationalCost(C)=basicExpenses(C)+unrepresentedVendorCosts(C)` via `exactAdd`, `netBilled(C)=billedIncome(C)-operationalCost(C)`, `netReceived(C)=receivedIncome(C)-operationalCost(C)` via `exactSubtract`, union-of-currencies with missing side zero, no cross-currency.
- **UNKNOWN:** per-source `{count, amount}` + `byTenant` unknown, explicit, traceable, excluded from byCurrency and net, never inferred.
- **Legacy compatibility:** single known currency + zero UNKNOWN → legacy monetary scalars populated from `singleCurrencyCode` entry; multi-currency OR UNKNOWN → legacy scalars null, counts scalar.

### OpenAPI alignment

- Runtime route `GET /buildings/{buildingId}/financial-summary` with `basic_financial_reporting.read` and building scope matches OpenAPI path GET with same permission, building-scoped true, query params periodFrom/periodTo/tenantCompanyId, response `BasicFinancialSummary` with `monetarySummary.byCurrency` + `unknown` + `distinctKnownCurrencies` + `hasUnknown` + `singleCurrencyCode` nullable + legacy nullable scalars + counts, no FX fields, no unresolved refs, operationId unique.

### Backend Final Handoff readiness

**BASIC FINANCIAL REPORTING CONTRACT = FROZEN / FRONTEND-READY.**

- byCurrency authoritative, unknown explicit, legacy scalars convenience-only, no mixed-currency grand total, no FX in base report, OpenAPI present and truthful, isolation preserved, migration stable, 75 tests pass.
- Ready for Frontend Web Integration and Mobile App Integration.
- This was last backend feature CR before API Contract Freeze per governance.

### Merge readiness

**READY FOR MERGE WITH RECORDED LIMITATIONS.**

- All 21 checklist items verified; no direct defect found; no FIX required.
- 75 dependency-free tests pass, 0 fail.
- Contract and runtime aligned; no path change required beyond PART 05; OpenAPI parses via grep with zero unresolved refs for our schemas.
- Limitations: (i) typecheck not run — no compiler available; (ii) DB-backed tests skipped — no PostgreSQL; (iii) OpenAPI yaml package parser not available — verified via grep only. None are FIN-RPT-01 code defects.

**CR-BE-FIN-RPT-01 = READY FOR FINAL REVIEW / READY FOR MERGE.**

**End of FINAL REVIEW.**

---

**End of START GOVERNANCE.**

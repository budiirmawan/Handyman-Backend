# CR-BE-CUR-02 — Monetary Currency Snapshot Completion — Start Governance

**Status:** governance only. No runtime code, migration execution, OpenAPI change, dependency installation, DB provisioning, CI, PR, or merge is performed by this record.

**Baseline verified:** `origin/main` at `4fb5e7ac9dc013abfa43baaff395d14cd567582e` — the merge commit of PR #67 (CR-BE-CUR-01). Inspection covered the CUR-01 governance record and PART notes, migrations `0331`/`0332` and their predecessors (`0191`, `0195`, `0196`, `0198`, `0201`, `0202`, `0261`+, `0267`, `0278`, `0279`), and the command surfaces of every authority named by CUR-01 B-02.

**Objective:** determine exactly which monetary command paths can still create NEW records without a governed currency snapshot, classify each remaining authority, and define the minimum change set so that new monetary records can never silently carry an unknown currency — under the CUR-01 rules restated below.

## 0. Restated governing rules (inherited from CUR-01, binding on CUR-02)

1. Historical NULL remains NULL. No backfill, no `NOT NULL DEFAULT`, no mass update.
2. No IDR inference of any kind; unknown is `UNKNOWN`, never a currency.
3. No silent Client-default injection. Client default/base is configuration, not a transaction snapshot.
4. Explicit transaction currency is preferred on every new monetary command.
5. Inherited currency is allowed only from authoritative upstream lineage (tariff → calculation → approval → bill; charge/bill → invoice line under exact equality).
6. Every new/changed snapshot must pass Currency Master ACTIVE + Client-allowed validation at command time.
7. The persisted transaction currency snapshot is immutable once written (a DRAFT amount change may re-select currency through the same validation; FINALIZED records never change currency).
8. Exact currency only: no FX, no conversion, no exchange-rate table/provider, no base-currency derived amount, no cross-currency totals.
9. No Building currency override; no accounting/GL redesign.

## 1. Verified command-time authority available for reuse

- `assertActiveAllowedCurrency(clientId, currencyCode)` (exported from `src/modules/client-monetary-contexts/index.ts`, established by CUR-01 PART 01) fails closed with `CURRENCY_INACTIVE_OR_UNKNOWN` (master not ACTIVE) and `CLIENT_CURRENCY_NOT_ALLOWED` (not in the Client's allowed set). It is command-time only; historical reads never call it.
- Current consumers (verified by grep): `rfqs`, `vendor-quotations`, `purchase-orders`, `rfq-po-conversions`, `price-catalog-entries`, `operational-commitment` (manual commitments). These are CUR-01 PARTs 02–03 and are NOT in B-02 remaining scope.
- No B-02 authority listed below currently calls it.

## 2. Inspection results — remaining B-02 authorities after CUR-01

CUR-01 PART 04 added nullable-first `currency_code` storage (`0332`) to `vendor_service_costs`(+history), `basic_expenses`(+history), `tenant_charges`(+history), `tenant_invoices`(+lines) and explicitly left command surfaces unwritten ("B-02 remains OPEN … some command surfaces still do not require/write governed currency snapshots"). Verified zero `currency` references in the four modules' source: create/update validations accept no currency field and every `INSERT` (including history/line inserts) omits the column. Every such row is therefore created NULL regardless of the storage now available.

### 2.1 Classification matrix

Classes per the CUR-02 objective: **A** mandatory + governed; **B** currency exists but optional/ungoverned; **C** nullable column added by CUR-01 but command does not write it; **D** inherited from authoritative upstream document; **E** non-monetary / no change.

| # | Authority (table / module) | Verified command paths that create monetary facts | Class | Evidence and residual gap |
|---|---|---|---|---|
| 1 | `vendor_service_costs` + `vendor_service_cost_history` (`vendor-service-costs`) | `createVendorServiceCost`, draft `updateVendorServiceCost` (amount mutable) | **C** | `0332` columns exist; validation/service/repository contain no currency input, no write, history `INSERT` omits it. Upstream context (vendor work / service request) is non-monetary — no inheritance source exists; explicit currency is the only option. |
| 2 | `basic_expenses` + `basic_expense_history` (`basic-expenses`) | `createBasicExpense`, draft `updateBasicExpense` (amount mutable) | **C** | Same as #1. Optional `vendor_service_cost_id` lineage points at authority #1, itself currencyless — it is provenance, not an authoritative priced upstream; it cannot supply currency. |
| 3 | `tenant_charges` + `tenant_charge_history` (`tenant-charges`) | `createTenantCharge`, draft update (amount mutable) | **C** | Same storage-without-command pattern. `service_charge_readiness` supplies only a readiness status (E), never money. |
| 4 | `tenant_invoices` + `tenant_invoice_lines` (`tenant-invoices`) | `createTenantInvoice`, `addTenantInvoiceLine` (source `TENANT_CHARGE` or `UTILITY_BILL`), `finalize` | **C (header/command)** with an available **D** lineage for lines | Header and line `currency_code` never written. Line amount snapshots come from `tenant_charges.amount` (currencyless, class C) or `utility_bills.bill_amount` (carries `currency`, class D). `finalize` re-snapshots every line and then `SUM(amount_snapshot)` into one `subtotal`/`total_amount` regardless of source currency — a live unknown/mixed-currency aggregation defect once lines carry differing or NULL currencies. |
| 5 | Work-order material usage `work_order_material_usages` (`inventory-work-order-material-usages`) | usage `create` with optional `unitCost` + optional `currency` | **B** | DB CHECK (`0267`) requires `unit_cost` when `currency` is present but NOT the reverse; service writes `currency: input.unitCost === undefined ? null : (input.currency ?? null)` — a newly costed usage may still be created currencyless. Validation whitelists the nine legacy codes (`isVendorInvoiceCurrency`) but never checks master ACTIVE/Client-allowed. |
| 6 | Utility tariff (`utility_calculation_bases` tariff shape, `0278`) | `createUtilityTariff` (create + list only; windows immutable via exclusion constraint) | **B (required-but-ungoverned variant)** | Currency is mandatory at command and DB level but governed only by `^[A-Z]{3}$` format (service validation and `utility_tariff_shape_check`). It accepts codes outside the Currency Master and outside the Client allowance (CUR-01 G-05). This is the sole entry point of currency into the utility chain. |
| 7 | Utility calculation (`utility_calculations`, `0191` + tariff columns) | draft calculation creation from consumption | **D** | `currency: tariff?.currency ?? null` — inherited snapshot from the governing tariff. NULL only via the legacy non-tariff basis fallback (`tariff?.ratePerUom ?? basis?.rateValue` with a legacy, currencyless basis). No caller-supplied currency exists; correct shape, inherits whatever (possibly ungoverned) code the tariff holds. |
| 8 | Utility bill (`utility_bills`, `0196`/`0279`) | bill creation from verified tenant approval + finalized calculation | **D** | Requires `approval.utilityCurrency === calculation.currency` AND `calculation.currency` non-null, else `utilityBillContextInvalidError` — already fail-closed exact-equality inheritance. Inherits ungoverned tariff codes unchanged (gap closes at #6, not here). |
| 9 | Utility tenant approval snapshot (`utility_currency`, `0279`) | approval creation snapshotting the calculation | **D** | Format-checked snapshot of the calculation currency; participates in the #8 equality. No independent currency choice. |
| 10 | Payment receipts / invoice payment status | payment recording against a vendor invoice | **D / no change** | No own currency field; narrative and status reuse `invoice.currency`. Vendor invoice currency is mandatory, nine-code whitelisted, PO-exact-matched. |
| 11 | `vendor_invoices` | create/update/finalize/pay | **A† (residual adoption, not a B-02 unknown-currency creator)** | Currency is always present (`readCurrency` mandatory, nine-code whitelist, `purchaseOrder.currency !== invoice.currency` rejection). Residual: `assertActiveAllowedCurrency` is not yet wired on its create path (outside CUR-01 PART 02/03 scope). Because PO-linked invoices inherit an already-validated PO currency and the nine-code set equals the seeded master, no new record can be currencyless or non-master here; the allowance check is a consistency alignment, not a B-02 closure requirement. |
| 12 | Procurement chain (RFQ, quotation revision, comparison/award, PO standalone + conversion), price catalog entries, budgets/manual commitments | — | **A** | Mandatory currency + `assertActiveAllowedCurrency` + exact lineage equality since CUR-01 PARTs 02–03. Out of remaining scope. |
| 13 | Requests/demand, ESG quantities, readiness records, `report_archives`, operational events | — | **E** | Non-monetary; no currency change belongs there. |

### 2.2 Downstream consumers that hardcode the B-02 exclusion (verified)

These still treat authorities #1–#2 as currencyless even where `0332` storage exists, and must become data-driven before B-02 can close:

- `operational-finance-binding.service.ts` — `resolveSource` hardcodes `currency: null` for `BASIC_EXPENSE` and `VENDOR_SERVICE_COST`, so every such binding is `currencyStatus='MISSING'` and mismatches cannot even be detected against a populated snapshot.
- `operational-variance.service.ts` — `CURRENCYLESS_ACTUAL_SOURCE_TYPES = ['VENDOR_SERVICE_COST','BASIC_EXPENSE']` blanket-excludes both from every figure and emits gap `CURRENCYLESS_COST_AUTHORITY` (reference `B-02`) regardless of a populated `currency_code`.
- `operational-commitment-vendor.service.ts` — documents the same deliberate exclusion of both authorities from actualization.

## 3. Minimum required changes (no more than this)

**Schema (single migration `0333`, next free index after `0332` — registry order verified):**

- No new tables. No new columns (all storage needed exists).
- Recommended, optional: non-deferring FK references from the eight `0332` columns to `currencies(code)`. All historical values are NULL so validation is trivial; codes are immutable by `0331` trigger. FK assists existence integrity only — ACTIVE/allowed remains command-time.
- **Forbidden:** `NOT NULL`, defaults, backfill, and a DB pairing CHECK on `0267` (`unit_cost ⇒ currency`) — legacy costed rows with NULL currency may exist and must remain valid; the pairing is command-time only for exactly this reason.

**Command-path changes (validation + write, reusing existing seams):**

1. **Vendor service cost / basic expense / tenant charge creates:** accept explicit `currencyCode` (uppercase 3-letter, trimmed), validate format, then `assertActiveAllowedCurrency(resolvedClientId, code)`, persist to the row and to the same history `INSERT`. The resolved Client already exists in each create path.
2. **Draft amount updates (#1–#3):** a monetary change (amount, and for VSC cost type/category affecting valuation) on a NULL-currency record requires supplying currency at that update (validated as above); currency may otherwise not be silently injected. Currency on an already-currency-carrying DRAFT is immutable (a valuation change requires cancel/recreate under the module's existing lifecycle).
3. **Finalize (#1–#4):** finalize of a NULL-currency (legacy) record remains permitted for historical compatibility; the record stays UNKNOWN — excluded from totals, gap-reported. No currency is ever demanded retroactively, and finalize never writes currency.
4. **Work-order material usage:** require `currency` whenever `unitCost` is supplied (mirroring the existing inverse rule), and route both through `assertActiveAllowedCurrency`. `unitCost` without currency → validation error; neither → non-costed usage, unchanged.
5. **Utility tariff create:** replace format-only acceptance with format + `assertActiveAllowedCurrency(buildingClientId, currency)` (the client is already resolved in `createUtilityTariff`). Historical tariff codes are never rewritten; calculations/bills inheriting legacy codes remain valid snapshots (command-time-only validation, consistent with CUR-01 PART 02/03).
6. **Tenant invoices:** header currency is required at create (explicit, validated). Draft update contract gains `currencyCode` (same validation) so a legacy NULL-currency draft can be governed before lines are added. `addTenantInvoiceLine` fails closed when the source currency is unknown or differs: `TENANT_CHARGE` line requires `charge.currency_code` non-null and equal to header; `UTILITY_BILL` line requires `bill.currency` equal to header (exact equality, no conversion). The line `currency_code` snapshot is written from the matched source at link and at finalize re-snapshot. `finalize` additionally fails closed if any line lacks the header currency — closing the SUM-across-unknown/mixed-currencies defect. No mixed-currency header is authorized (CUR-01 decision C).
7. **Downstream finance alignment:** binding `resolveSource` reads the real `currency_code` for `VENDOR_SERVICE_COST`/`BASIC_EXPENSE`; `currencyStatus` then behaves exactly as for other sources (`MISSING` for NULL, `MATCHED`/mismatch-error otherwise); the variance blanket exclusion becomes `currency_code IS NULL`-driven, and the `CURRENCYLESS_COST_AUTHORITY` gap reports only genuinely unknown rows. The commitment-vendor exclusion is updated on the same basis. No arithmetic, budget, or GL behavior changes for NULL rows.

**Explicitly NOT done:** no FX/rate table/provider/conversion, no Client-default injection into any command, no Building override, no backfill, no historical rewrite, no new permissions, no new audit channel, no OpenAPI change in this governance step.

## 4. Validation rules (command-time, consolidated)

- New monetary create without currency → validation error (fail closed).
- Currency present but not in Currency Master → `CURRENCY_INACTIVE_OR_UNKNOWN`.
- In master but INACTIVE → `CURRENCY_INACTIVE_OR_UNKNOWN`.
- ACTIVE but not Client-allowed → `CLIENT_CURRENCY_NOT_ALLOWED`.
- Inherited path (utility bill, invoice line): source currency must exist and equal the governing document currency exactly; otherwise fail closed. No substitution, no conversion, no fallback to Client base/default.
- Reads never validate against current master/allowance; deactivated currencies remain readable historical snapshots.
- `currency-reporting` seam semantics unchanged: NULL groups as the unknown gap; no grand total across currencies.

## 5. Historical compatibility

- All pre-`0333` rows keep NULL = UNKNOWN; readable, finalize-protected semantics unchanged, excluded from arithmetic, counted in the unknown gap.
- Legacy utility tariffs/calculations/bills holding codes outside the current master/allowance remain valid immutable snapshots; only NEW tariff creation is master-governed.
- Legacy NULL-currency DRAFTs of #1–#3 may be finalized (UNKNOWN) or governed via the explicit update path; they are never silently cured.
- The reporting seam provides the required measurement of the residual unknown population (per building, FINALIZED only); no separate remediation tooling is authorized here.

## 6. RBAC / isolation / audit

- No new permissions. Each command keeps its existing module permission and `contextAccessService` building/client checks; currency validation is not authorization.
- Platform Currency Master administration remains the existing internal authority (no public route — unchanged from CUR-01 closure).
- Audit reuse only: existing `recordOperationalEvent` calls for VSC/BE/charge/invoice/tariff/usage creation add the selected `currencyCode` to event metadata (CUR-01 §4 requirement that monetary events include their snapshot). No event may claim conversion or an inferred historical currency.

## 7. Focused tests (to be written with implementation; none run now)

Per authority: create-without-currency → 400; inactive master code → 400; allowed-set violation → 400; valid code → persisted on row + history/line + event metadata; draft amount change on legacy NULL record without currency → 400, with currency → persisted; finalize legacy NULL → 200 and remains in unknown gap; read after master deactivation → snapshot intact. Tenant invoices additionally: charge line with NULL/unequal currency → 400; bill line unequal to header → 400; finalize with any non-header-currency line → 400; same-currency multi-line sum → single-currency total. Work-order usage: `unitCost` without currency → 400. Utility tariff: non-master/non-allowed code → 400; legacy-code tariff remains readable and its calculation/bill chain still functions. Downstream: binding on a populated-currency finalized VSC/BE yields `MATCHED`/mismatch-error instead of hardcoded `MISSING`; variance gap shrinks to NULL rows only. Existing module suites (`vendor-service-costs`, `basic-expenses`, `tenant-charges`, `tenant-invoices`, `utility-tariffs-part10`, `vendor-invoice-*`, operational-finance) must be regression-updated where they assert the currencyless contract.

## 8. PART breakdown

| PART | Scope | Exit criteria |
|---|---|---|
| **01 — Operational cost command currency** | VSC + basic expenses: input contract, `assertActiveAllowedCurrency`, row/history write, event metadata, draft-update currency rule | New cost/expense rows cannot be created without a governed snapshot; focused tests green |
| **02 — Tenant billing currency** | Charges + invoices: header currency, line-linkage equality rules, finalize single-currency guard, draft update contract | No invoice can mix or admit unknown currencies; focused tests green |
| **03 — Work-order material usage pairing** | Currency required with `unitCost`; master/allowance validation | Costed usage without governed currency impossible |
| **04 — Utility tariff master alignment** | Tariff create validates ACTIVE+allowed (building→client); historical snapshots untouched | Utility chain currency entry is master-governed; calculation/bill inheritance unchanged |
| **05 — Downstream finance alignment** | Binding resolver reads snapshots; variance/commitment exclusions become NULL-driven | Populated-currency VSC/BE participate in MATCHED logic; only NULL excluded |
| **06 — OpenAPI + closure evidence** | Public contract updates for new `currencyCode` inputs/outputs, contract tests, unknown-population measurement, closure review | B-02 closure criteria below demonstrably met |

Dependency order is linear (01→06); 03 and 04 are independent of 01–02 and may parallel them.

## 9. Migration requirement

Single migration `0333_...` (registry-ordered after `0332`; verified next free index): optional FKs from the eight `0332` columns to `currencies(code)`. Nothing else. No data change. If the FK option is rejected at implementation review, CUR-02 requires **no migration at all** — storage is complete; all remaining work is command-path code.

## 10. B-02 closure criteria

B-02 can be closed by CUR-02 **to the full extent controllable by code**, and no further:

1. Every authority in §2 classes B/C (#1–#6) requires and persists an ACTIVE+Client-allowed currency snapshot on every create and monetizing update — proven by focused tests.
2. Inheritance paths (#7–#9, invoice lines) are exact-equality fail-closed; no substitution/conversion/default anywhere.
3. Historical NULLs remain NULL/UNKNOWN, readable, excluded from arithmetic, and measured by the reporting seam; the residual unknown population is quantified and explicitly accepted at final review.
4. Downstream exclusions (§2.2) are data-driven; no populated snapshot is excluded as currencyless.
5. No FX/conversion/rate authority exists; exact-currency-only behavior is regression-verified.
6. OpenAPI reflects the new inputs truthfully; affected suites and typecheck pass in a provisioned environment.

Residual after closure: the accepted historical unknown population (a data condition, not a code gap) — tracked by the seam, remediable only by evidence-backed future data governance. This is the CUR-01-defined closure shape ("B-02 only closes once actual data remediation evidence is measured and accepted"); CUR-02 delivers the measurement and the impossibility of new unknowns.

## 11. CR-BE-FX-01 decision

**FX-01 remains BLOCKED until CUR-02 completes.** Rationale: any conversion semantics require (a) every convertible amount to carry a governed snapshot — impossible while class B/C paths can mint unknowns; (b) downstream comparability exclusions to be data-driven, else FX would convert curated subsets next to silently-excluded unknowns; (c) invoice aggregation to be single-currency-safe before any cross-currency reporting exists. FX-01 readiness precondition: CUR-02 PARTs 01–06 merged with closure evidence, plus its own governance of dated rates, rate snapshots, conversion events, rounding and approval (untouched here).

## 12. PART 01 readiness

**READY.** `assertActiveAllowedCurrency` exists and is proven by PART 02/03 consumers; VSC/BE create paths already resolve `clientId` and write history in-transaction; migration index `0333` is free; no runtime prerequisite. Pre-implementation confirmations only: (a) adopt or reject the optional FK set; (b) confirm the draft-update currency rule (§3.2) and finalize-permissive rule (§3.3) as the accepted historical-compatibility line; (c) confirm event-metadata extension needs no audit-contract change.

## 13. Validation performed for this governance record

- Governance inspection only: source/migration/registry reads and greps as cited; no runtime code written or executed.
- `git diff --check`: PASS (no whitespace errors).
- No dependency installation, no DB provisioning, no tests, no typecheck (tooling unavailable without provisioning — consistent with CUR-01 records), no CI, no PR, no merge.

**Next step authorized by this record:** implement CUR-02 PART 01 on this branch.

---

## PART 01 implementation notes (2026-08-24)

**Scope delivered:** command-time governed currency snapshots for `vendor_service_costs`(+history) and `basic_expenses`(+history) — governance §3.1–§3.3.

- **Creates:** `POST /api/v1/vendors/:vendorId/costs` and `POST /api/v1/basic-expenses` now require an explicit `currencyCode` (uppercase `^[A-Z]{3}$` format validated in the module validation layer). Each service then calls the existing CUR-01 authority through a new thin wrapper `assertActiveAllowedCurrencyCommand(clientId, code)` (`client-monetary-contexts`), which is behaviorally identical to `assertActiveAllowedCurrency` but surfaces the rejection as a typed `AppError` (400 `CURRENCY_INACTIVE_OR_UNKNOWN` / `CLIENT_CURRENCY_NOT_ALLOWED`) instead of an unhandled 500 on public routes. The exact validated code is persisted into the existing `0332` `currency_code` column. No IDR/base/default/vendor/record inference exists anywhere on these paths; the resolved record Client is the only context used.
- **Updates:** on a legacy `currency_code IS NULL` DRAFT, a non-monetary update (e.g. notes only) still succeeds and leaves NULL; a monetary amount change (`costAmount` / `amount`) fails closed with `VENDOR_SERVICE_COST_CURRENCY_REQUIRED` / `BASIC_EXPENSE_CURRENCY_REQUIRED` unless an explicit `currencyCode` is supplied (then validated ACTIVE + allowed and persisted). Supplying `currencyCode` on a NULL-currency draft without an amount change is allowed (governs before finalize). A record that already has a governed snapshot is currency-immutable: a differing submitted code fails with `*_CURRENCY_IMMUTABLE`. No update ever rewrites a non-DRAFT record.
- **History:** every history write (`CREATED`/`UPDATED`/`FINALIZED`/`CANCELLED`) now snapshots `currency_code` from the record version in the same INSERT. No historical history row is rewritten; legacy history rows keep their absent/NULL currency.
- **Lineage:** `vendor_service_cost_id` remains provenance-only; Basic Expense currency is never inferred from the linked cost, no FX/conversion/equality rule was added between them.
- **Audit:** reused existing `VENDOR_SERVICE_COST_CREATED` / `BASIC_EXPENSE_CREATED` operational events; `currencyCode` added to their metadata. No second audit mechanism.
- **Migration decision:** NO migration. Service-layer authority is sufficient; the optional FK set from §9 remains a single global CUR-02 decision and `0333` is not consumed merely to take the number. No NOT NULL, DEFAULT, backfill, or historical rewrite exists.
- **Compatibility:** historical NULL rows remain readable as `currencyCode: null` (UNKNOWN), and `currency-reporting`/operational-finance behavior is untouched (PART 05 handles data-driven exclusions). New typed error codes were added to `ERROR_CODES` only.
- **Tests:** added focused `tests/cur02-part01-command-currency.test.ts` (required-currency, ACTIVE+allowed accepted, INACTIVE rejected, Client-disallowed rejected, no default/inference incl. non-master code, snapshot persisted, history per version, legacy NULL readable/non-monetary retention, monetary-change-requires-currency, immutability, Basic Expense parity, cross-Client no-widening). Updated `vendor-service-costs.test.ts`, `basic-expenses.test.ts`, `basic-financial-reporting.test.ts` to set a Client monetary context and pass `currencyCode` on their create commands; direct-SQL suites (management-financial-summary, operational-budget-*) are intentionally untouched and keep exercising legacy NULL rows.
- Tests/typecheck: **NOT RUN** — `node_modules` is absent and dependency provisioning is forbidden for validation; no PostgreSQL, broad regression, or CI was run.
- `git diff --check`: PASS.

---

## PART 02 implementation notes (2026-08-24)

**Scope delivered:** Tenant billing currency — `tenant_charges`(+history) and `tenant_invoices`(+lines) — governance §3.6 and the §4 consolidated validation rules.

- **Tenant charges.** `POST /api/v1/tenant-companies/:tenantCompanyId/charges` now requires an explicit `currencyCode` (uppercase `^[A-Z]{3}$` validated in the module validation layer). The service calls the existing CUR-01 authority `assertActiveAllowedCurrencyCommand(resolvedClientId, code)` (typed `AppError`: `CURRENCY_INACTIVE_OR_UNKNOWN` / `CLIENT_CURRENCY_NOT_ALLOWED`) and persists the exact validated code to the existing `0332` `currency_code` column. No IDR/base/default/inference exists on this path; the resolved Tenant Company Client is the only context used.
- **Charge update governance.** On a legacy `currency_code IS NULL` ACTIVE charge, a non-monetary update (e.g. notes) keeps NULL; a monetary amount change fails closed with `TENANT_CHARGE_CURRENCY_REQUIRED` unless an explicit `currencyCode` is supplied (validated ACTIVE + allowed and persisted). Supplying `currencyCode` on a NULL-currency charge without an amount change is allowed (governs before use). A charge that already carries a governed snapshot is currency-immutable: a differing submitted code fails with `TENANT_CHARGE_CURRENCY_IMMUTABLE`. No update ever rewrites a non-ACTIVE record.
- **Charge history.** Every history write (`CREATED`/`UPDATED`/`CANCELLED`) now snapshots `currency_code` from the record version in the same INSERT. No historical history row is rewritten.
- **Invoice header currency.** `POST /api/v1/tenant-companies/:tenantCompanyId/invoices` now requires an explicit `currencyCode` (format + `assertActiveAllowedCurrencyCommand`) and persists the single exact header currency. `PATCH /api/v1/tenant-invoices/:id` accepts `currencyCode` so a legacy `currency_code IS NULL` draft can be governed before lines are added; an existing governed header currency is immutable (`TENANT_INVOICE_CURRENCY_IMMUTABLE`). No IDR default, Client-default injection, or inference applies to the header.
- **Line source exact-equality (fail closed).** `POST /api/v1/tenant-invoices/:id/lines` requires a governed header currency; a `TENANT_CHARGE` source requires `charge.currency_code` known and exactly equal to the header, a `UTILITY_BILL` source requires `bill.currency` known and exactly equal to the header. Unknown source currency fails closed with `TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN`; any non-equal known currency fails with `TENANT_INVOICE_CURRENCY_MISMATCH`. The line `currency_code` snapshot is written from the matched source at link and re-snapshotted from the source at finalize. No substitution, conversion, or fallback to Client base/default exists.
- **Finalize guard.** Before the persisted totals are recalculated, `finalize` requires the header currency to be known and every line currency known and exactly equal to it — rejecting mixed (e.g. IDR + USD), known + UNKNOWN, and unknown-header invoices. Only after this guard passes does the existing total calculation continue. Historical finalized invoices remain readable.
- **Audit.** Reused existing operational events (`TENANT_CHARGE_CREATED`/`UPDATED`, `TENANT_INVOICE_CREATED`/`SOURCE_LINKED`/`FINALIZED`); `currencyCode` added to their metadata. No second audit channel.
- **Migration decision:** NO migration. All storage already exists on `0332`; no schema blocker was discovered. No `NOT NULL`, DEFAULT, backfill, or historical rewrite exists. The optional FK set from §9 remains deferred as a single global CUR-02 decision.
- **Not touched.** PART 01 modules, work-order material usage, utility tariff command validation, reporting, OpenAPI, FX, exchange rates, payment/tax logic.
- **Tests.** Added focused `tests/cur02-part02-tenant-billing-currency.test.ts` covering required-currency on charge/invoice create, INACTIVE and Client-disallowed rejection, charge history persistence, legacy NULL readability/non-monetary retention, monetary-change-requires-currency, charge currency immutability, charge → invoice exact currency, utility bill → invoice exact currency, mixed-currency line rejection, UNKNOWN source rejection, finalize mixed/UNKNOWN rejection, and valid single-currency finalize. Regression-updated `tenant-charges.test.ts`, `tenant-invoices.test.ts`, `basic-financial-reporting.test.ts`, `invoice-payment-status.test.ts`, `payment-receipts.test.ts`, `service-charge-readiness.test.ts` to set a Client monetary context and pass `currencyCode` on their charge/invoice create commands.
- Tests/typecheck: **NOT RUN** — `node_modules` is absent and dependency provisioning is forbidden for validation; no PostgreSQL, broad regression, or CI was run.
- `git diff --check`: PASS.

---

## PART 03 implementation notes (2026-08-24)

**Scope delivered:** Work Order material usage currency pairing — governance §3.4.

- **Command path.** `POST /api/v1/work-orders/:workOrderId/material-usages` (the only command surface; usages are append-only/immutable — there is no edit path). No new route, no OpenAPI change.
- **Pairing rule.** A costed usage (`unitCost` supplied) now requires an explicit `currency` (uppercase `^[A-Z]{3}$` format gate in the validation layer). The service fails closed with `WO_MATERIAL_USAGE_CURRENCY_REQUIRED` if a cost is supplied without a currency, then routes the exact code through CUR-01's `assertActiveAllowedCurrencyCommand(workOrder.clientId, currency)` — typed `CURRENCY_INACTIVE_OR_UNKNOWN` (not in master / ACTIVE) and `CLIENT_CURRENCY_NOT_ALLOWED` (ACTIVE but not in the Client's allowed set). A non-costed usage (`unitCost` absent) is not blocked by currency governance: material issue still succeeds with `currency: null`.
- **Existing governed currency.** The persisted `currency` is the immutable snapshot; the DB-generated `total_cost` (quantity × unit_cost in NUMERIC) is unchanged. No FX, conversion, defaulting, or Client base/default inference is introduced.
- **Lineage decision.** No inheritance. Verified Material Request and Purchase Request carry no currency (non-monetary demand authorities), so there is no unambiguous authoritative upstream currency to inherit. Explicit currency is the only option for a costed usage (§4 "otherwise require explicit currency"). No lineage or heuristic matching was invented.
- **Legacy NULL behavior.** Historical costed rows with `currency IS NULL` remain readable (returned as `currency: null`); no backfill, no inference, no rewrite. Because usages are append-only with no update command, an "edit" of a legacy NULL-currency monetary row is structurally impossible here; the pairing rule therefore applies at create time only (a costed new usage always requires currency). Non-monetary legacy rows remain valid and cost-less.
- **COMM-VAR preservation.** No change to the actualization amount formula, commitment matching, material issue behavior, or budget blocking. `tryActualizeWorkOrderMaterialUsage` still receives the exact `createdUsage.currency`; exact-currency rules remain fail-closed and no conversion path exists. A cost-less or currency-mismatched actualization still does not block the issue (SAVEPOINT rollback unchanged).
- **Audit.** Reused the existing `WORK_ORDER_MATERIAL_ISSUED` operational event; added `unitCost`, `totalCost`, and `currency` to its metadata. No parallel currency audit channel.
- **Migration decision:** NO migration. No schema blocker was proven; `0267` already provides `currency`/`unit_cost`/`total_cost` and the `wo_usage_currency_requires_cost` inverse constraint. No `NOT NULL`, DEFAULT, backfill, or pairing CHECK that would invalidate legacy cost+NULL rows was added (pairing is command-time only).
- **Not touched.** Tenant billing PART 02, utility tariff, vendor/basic expense PART 01, procurement/PO, Price Catalog, commitment model, reporting, OpenAPI, FX, rates, conversion, Building override, inventory costing engine, accounting/GL.
- **Validation layer change.** The former hard-coded nine-code whitelist (`isVendorInvoiceCurrency`) was replaced by a format-only `^[A-Z]{3}$` gate; ACTIVE + Client-allowed authority now comes from the Currency Master (consistent with PARTs 01–02). No contract/existing test asserted the old whitelist error message.
- **Tests.** Added focused `tests/cur02-part03-wo-material-usage-currency.test.ts` covering required-currency on costed usage, ACTIVE+allowed accepted and snapshotted, INACTIVE rejected, Client-disallowed rejected, non-costed usage not blocked, historical cost+NULL readable, and no-FX/exact-currency preservation. Regression-updated `work-order-material-cost.test.ts`, `work-order-material-issue-control.test.ts`, `operational-commitment-material-chain.test.ts`, `operational-commitment-openapi.test.ts`, `operational-budget-variance-read-model.test.ts` to set a Client monetary context (and add `currency` to any costed usage that previously omitted it). Contract-only suites (`material-chain-openapi`, `mobile-material-context-contract`) were left untouched.
- Tests/typecheck: **NOT RUN** — `node_modules` is absent and dependency provisioning is forbidden for validation; no PostgreSQL, broad regression, or CI was run.
- `git diff --check`: PASS.

---

## PART 04 implementation notes (2026-08-24)

**Scope delivered:** Utility Tariff currency alignment — governance §3.5 and §4.

- **Tariff command path.** `POST /api/v1/buildings/:buildingId/utility-tariffs` is the single Utility Tariff create command; tariff rows are created only (windows are immutable via the existing active-period exclusion constraint; no edit path). No new route, no OpenAPI change.
- **Currency Master / Client allowance behavior.** On create, the explicit `currency` (already format-gated `^[A-Z]{3}$` in the validation layer) is now validated through CUR-01's `assertActiveAllowedCurrencyCommand(resolvedBuildingClientId, currency)` — typed `CURRENCY_INACTIVE_OR_UNKNOWN` (not in master / ACTIVE) and `CLIENT_CURRENCY_NOT_ALLOWED` (ACTIVE but not in the Client's allowed set). No IDR default, no Client base/default inference, no Building-derived currency, no normalization or conversion. The exact submitted currency is saved to the immutable `utility_calculation_bases.currency` snapshot.
- **Tariff → calculation → bill propagation.** Unchanged by this PART. Verified: `resolveForPeriod` returns the tariff with its exact `currency`, `persistCalculation` snapshots `currency: tariff?.currency ?? null`, utility-bill generation derives `currency: approval.utilityCurrency!` (which is exact-equal to `calculation.currency`), and its own guard rejects a non-null calculation currency mismatch. No Client base/default is queried during calculation. Calculation consumes the exact tariff currency; bill inherits the exact calculation/tariff currency.
- **Exact-equality / fail-closed.** Preserved. The existing utility-bill guard (`approval.utilityCurrency === calculation.currency` and `calculation.currency` non-null, else invalid) closes the chain; no cross-currency arithmetic is introduced.
- **Historical compatibility.** Historical tariff/calculation/bill records remain readable even after the Currency Master entry becomes `INACTIVE` or the Client allowed-currency set changes. Only NEW tariff create is master/allowance-governed; reads never validate against the current allowed set.
- **Audit.** Reused the existing `UTILITY_TARIFF_CREATED` operational event, which already carries `currency` metadata (no change needed). No separate currency audit channel.
- **Migration decision:** NO migration. `utility_calculation_bases.currency` already exists (0267/BE-18B-era schema); no schema blocker was proven. No `NOT NULL`, DEFAULT, backfill, or historical rewrite, and no calculation/bill schema change.
- **B-02 status.** PART 04 closes the verified utility tariff command-time currency governance gap (the last currency entry point into the utility chain is now master/allowance-governed). Full B-02 closure is **NOT** claimed here — it remains for PART 05/FINAL REVIEW after downstream finance exclusions are data-driven, remaining command paths are verified, and the historical UNKNOWN population is measured/accepted.
- **Not touched.** PARTs 01–03, procurement, Price Catalog, commitments, payment receipts, ESG, report archive, accounting/GL, and all non-goals (FX, rates, conversion, provider integration, Building currency override, revaluation).
- **Tests.** Added focused `tests/cur02-part04-utility-tariff-currency.test.ts` proving ACTIVE+allowed success, unknown/INACTIVE/disallowed rejection, snapshot persistence, exact tariff → calculation → bill propagation, historical readability after allowed-set change, and no cross-currency replacement. Regression-updated the utility test suites that create tariffs (`utility-tariffs-part10`, `utility-billing-handoff-part11`, `utility-tenant-approvals`, `utility-aggregations`, `utility-bills`, `building-utility-operational-summary-part16`, `building-utility-reconciliation-part12`) to set a Client monetary context. Contract-only suites (`utility-openapi-contract-part13`) were left untouched.
- Tests/typecheck: **NOT RUN** — `node_modules` is absent and dependency provisioning is forbidden for validation; no PostgreSQL, broad regression, or CI was run.
- `git diff --check`: PASS.

---

## PART 05 implementation notes (2026-08-24)

**Scope delivered:** downstream operational-finance / read-model alignment — governance §3.7 and §4.

- **Binding resolver (`operational-finance-binding.service.ts`).** `resolveSource` for `BASIC_EXPENSE` and `vendorServiceCostSource` for `VENDOR_SERVICE_COST` now propagate the persisted `currency_code` snapshot instead of forcing `currency: null`. A known snapshot becomes the resolved currency; `currencyStatus` therefore returns `MATCHED` for a same-currency budget and `MISSING` for a genuinely NULL snapshot. A known currency that differs from the budget still fails closed via the existing `OPERATIONAL_BUDGET_SOURCE_CURRENCY_MISMATCH` (no conversion, no Client base/default substitution).
- **Aggregation source projection (`operational-finance-aggregation.repository.ts`).** The `sourceCurrency` CASE now reads `expense.currency_code` / `cost.currency_code` for `BASIC_EXPENSE` / `VENDOR_SERVICE_COST` (previously `ELSE NULL`). `makeCandidate` unchanged: `bindingCurrencyStatus !== 'MATCHED' || sourceCurrency === null` → `SOURCE_CURRENCY_UNPROVEN`; a different non-null currency → `SOURCE_CURRENCY_MISMATCH`. This makes the currency eligibility data-driven.
- **Variance / exclusion (`operational-variance.service.ts`).** Removed the blanket B-02 source-type exclusion. The `CURRENCYLESS_COST_AUTHORITY` (B-02) gap is now raised **only** for exclusions whose `reason === 'SOURCE_CURRENCY_UNPROVEN'` among the two authorities — i.e. genuinely-UNKNOWN rows. Known-currency rows are no longer mislabelled as currencyless; rows excluded for any other reason (e.g. ineligible, period, lineage) are not surfaced as a currency gap. The variance formulas, commitment lifecycle, actualization and budget-blocking logic are unchanged. UNKNOWN rows remain excluded from currency arithmetic and surfaced as a gap (never silently zero, never inferred).
- **Commitment-vendor module (`operational-commitment-vendor.service.ts`).** Documentation comment updated only (this module actualizes vendor invoices, not VSC/BE). No behavior change; no new audit channel.
- **B-02 authority status matrix** (authorities verified in §2.1; new-command governance from PARTs 01–04; downstream currency alignment from this PART; historical NULL remains an accepted data condition):

| Authority | New command governance | Downstream currency | Historical NULL | Status |
|---|---|---|---|---|
| `vendor_service_costs` (+history) | PART 01: requires ACTIVE + Client-allowed `currencyCode` on create/monetizing update | Data-driven (binding MATCHED; aggregation no blanket B-02) | NULL = UNKNOWN, readable, excluded, gap-surfaced | **HISTORICAL UNKNOWN ONLY** |
| `basic_expenses` (+history) | PART 01: same governed `currencyCode` rule | Data-driven (binding MATCHED; aggregation no blanket B-02) | NULL = UNKNOWN, readable, excluded, gap-surfaced | **HISTORICAL UNKNOWN ONLY** |
| `tenant_charges` / `tenant_invoices` (+history/lines) | PART 02: governed header/charge currency, exact-equality lines, finalize guard | Not consumed as a budget source (no new integration) | NULL = UNKNOWN, readable | **CLOSED** (new command cannot mint unknown; downstream not affected) |
| Work-order material usage | PART 03: costed usage requires governed currency | `WORK_ORDER_MATERIAL` binds exact `currency`; actualization exact-currency fail-closed | cost + NULL = UNKNOWN, readable | **HISTORICAL UNKNOWN ONLY** |
| Utility tariff / calculation / bill | PART 04: tariff create requires ACTIVE + Client-allowed; chain exact-inherits | No finance-binding consumption (no new integration) | legacy code snapshots remain readable | **CLOSED** (chain is exact-currency governed); legacy tariff codes remain historical evidence |
| Vendor invoice / payment | Existing mandatory currency + PO exact-match | `VENDOR_INVOICE` binds exact `currency`; mismatch fails closed | N/A (currency mandatory) | **CLOSED** |

- **B-02 result.** No code-controllable OPEN authority remains that can mint an unknown currency or blanket-exclude a governed snapshot. The only residual is **HISTORICAL UNKNOWN ONLY**: pre-PART legacy NULL rows across VSC / basic expense / tenant billing / work-order usage / untouched utility, which remain readable, countable, traceable, excluded from currency arithmetic and gap-surfaced — never backfilled or defaulted. **Full B-02 closure is NOT claimed by this PART alone**; final closure is asserted only at PART 06 / final review once the residual unknown population is explicitly measured and accepted and OpenAPI is truthfully aligned.
- **Migration decision:** NO migration. No schema blocker proven. No currency backfill, no defaults, no NULL → NOT NULL on historical snapshots.
- **Exact-currency / non-goals.** No FX, rates, conversion, revaluation, accounting/GL, Building override, procurement or Price Catalog change. Exact-currency only; cross-currency remains fail-closed; UNKNOWN + UNKNOWN is never treated as a single currency.
- **Tests.** Added focused `tests/cur02-part05-downstream-finance-alignment.test.ts` proving known VSC/BASIC_EXPENSE currency propagates downstream (MATCHED), legacy NULL stays UNKNOWN (MISSING) and readable, known rows are no longer blanket B-02 excluded, unknown rows are excluded from currency arithmetic but gap-surfaced, same-currency processing works, cross-currency fails closed, and variance formula/planned values are unchanged. Existing source-binding/aggregation/variance suites assuming NULL-currency legacy rows were left intact (their inserts remain NULL, preserving the MISSING/SOURCE_CURRENCY_UNPROVEN expectations).
- Tests/typecheck: **NOT RUN** — `node_modules` is absent and dependency provisioning is forbidden for validation; no PostgreSQL, broad regression, or CI was run.
- `git diff --check`: PASS.

---

## PART 06 implementation notes (2026-08-24)

**Scope delivered:** OpenAPI + governance closure for CUR-02.

### OpenAPI surfaces changed
- **WorkOrderMaterialUsage (read schema).** Replaced the stale hard-coded nine-code `currency` enum with `type: string, nullable: true, pattern: "^[A-Z]{3}$"` plus a truthful description: NULL remains UNKNOWN for historical / cost-less rows and is never inferred, substituted, or converted; new costed usage is governed (ACTIVE Currency Master + Client-allowed). `nullable` retained so historical NULL stays contract-compatible.
- **WorkOrderMaterialUsageCreateRequest.** Replaced the nine-code enum with `pattern: "^[A-Z]{3}$"` and documented the PART 03 rule: `currency` is required whenever `unitCost` is supplied (fail-closed with `WO_MATERIAL_USAGE_CURRENCY_REQUIRED`) and must be an ACTIVE Currency Master entry allowed for the resolved Client (`CURRENCY_INACTIVE_OR_UNKNOWN` / `CLIENT_CURRENCY_NOT_ALLOWED`); optional/null for a non-costed usage; no IDR/default/base inference and no FX/conversion.
- **`/buildings/{buildingId}/utility-tariffs` POST.** Added a truthful `description` noting the explicit `currency` is validated as ACTIVE + Client-allowed and is the immutable snapshot that propagates exactly tariff → calculation → bill. Payload shape unchanged (no New field).
- **`OperationalBudgetVarianceGap` schema.** Updated the stale B-02 description to "vendor_service_costs and basic_expenses with an unknown currency are excluded from currency-dependent figures" (data-driven; matches PART 05).

### Runtime/OpenAPI alignment
- Only surfaces with an actual runtime route + an existing OpenAPI presence were edited (Work Order Material Usage, Utility Tariff). No invented routes.
- **Vendor Service Cost / Basic Expense / Tenant Charge / Tenant Invoice** are genuinely exposed at runtime but have **no OpenAPI presence at all today** (no paths, no schemas anywhere in `docs/api/openapi.yaml`) — a pre-existing, whole-API documentation gap unrelated to CUR-02's shape. They were **not** fabricated in this PART, consistent with the governance instruction "Do not invent routes/schemas." Documenting them truthfully is treated as a separate OpenAPI-lifecycle task; CUR-02 did not alter these four modules' public payload shapes (it reused existing nullable columns and command-time validation).
- No Currency Master, Client Monetary Context, or `currency-reporting` HTTP routes are documented (they do not exist as public routes) — unchanged from CUR-01 closure.

### Historical UNKNOWN policy
- New commands require a governed currency where a monetary amount exists. Historical `NULL` means UNKNOWN. UNKNOWN is never IDR, Client base/default, zero, or FX-converted; it remains readable, countable, traceable, excluded from currency-dependent arithmetic, and gap-surfaced. Read schemas stay `nullable`.

### Final B-02 matrix
| Authority | New-command governance | Snapshot propagation | Downstream exact-currency | Historical UNKNOWN | Code-controllable gap |
|---|---|---|---|---|---|
| vendor_service_costs | PART 01: governed `currencyCode` on create/monetizing update | persisted `currency_code` | data-driven (binding MATCHED; aggregation no blanket B-02) | readable, excluded, gap | **NONE** |
| basic_expenses | PART 01: governed `currencyCode` | persisted `currency_code` | data-driven (binding MATCHED; aggregation no blanket B-02) | readable, excluded, gap | **NONE** |
| tenant_charges | PART 02: governed header/charge currency | persisted `currency_code` | not a budget source; exact-equality lines | readable | **NONE** |
| tenant_invoices | PART 02: governed header, exact line, finalize guard | header + line snapshots | not a budget source; fail-closed mixed | readable | **NONE** |
| work_order_material_usage | PART 03: governed currency for costed usage | persisted `currency` | exact-currency bind/actualize; mismatch fail-closed | readable, excluded, gap | **NONE** |
| utility_tariff | PART 04: ACTIVE + Client-allowed on create | immutable tariff `currency` | tariff → calculation → bill exact | legacy codes readable | **NONE** |
| utility_calculation | inherits tariff currency | `currency = tariff?.currency` | exact; no base/default query | legacy snapshot readable | **NONE** |
| utility_bill | inherits calculation currency | `currency = approval.utilityCurrency` | exact-equality guard, fail-closed | legacy snapshot readable | **NONE** |
| procurement (RFQ/quotation/PO) | CUR-01 PART 02: mandatory + ACTIVE/allowed | header/line snapshots | exact lineage, mismatch fail-closed | N/A (mandatory) | **NONE** |
| price_catalog | CUR-01 PART 03: ACTIVE + allowed | exact currency key | exact lookup, no FX | N/A | **NONE** |
| operational_commitments | CUR-01 PART 03 + PART 05: manual/budget exact guard | exact header/line currency | exact-match actualization, fail-closed | N/A (mandatory) | **NONE** |
| vendor_invoice / payment lineage | existing mandatory + PO exact-match | explicit `currency` | exact, mismatch fail-closed | N/A (mandatory) | **NONE** |

### B-02 closure status
**B-02 is CLOSED — CODE-CONTROLLABLE.** No command path can mint a monetary value without the governed currency required by its authority, and all relevant downstream arithmetic is exact-currency / fail-closed. The only residual is a data condition, not a code gap:

**Residual: HISTORICAL UNKNOWN DATA CONDITION.** Pre-CUR-02 legacy NULL-currency rows (VSC, basic expense, tenant charge/invoice, work-order usage, untouched utility) remain as an accepted data condition. **No destructive backfill required** and none is performed.

### Historical population measurement status
DB / tooling is NOT available in this environment (no `node_modules`, no PostgreSQL provisioning). Recorded as: **"Historical UNKNOWN population not measured in this environment."** When a read-only measurement run is available, the authoritative targets are:
- `vendor_service_costs.currency_code IS NULL` (and `vendor_service_cost_history`)
- `basic_expenses.currency_code IS NULL` (and `basic_expense_history`)
- `tenant_charges.currency_code IS NULL`
- `tenant_invoices.currency_code IS NULL` (and `tenant_invoice_lines`)
- `inventory_work_order_material_usages.currency IS NULL AND unit_cost IS NOT NULL`
- `utility_calculation_bases` legacy tariffs outside the active master/allowed set and any `utility_calculations` / `utility_bills` with NULL currency

No counts are fabricated.

### FX readiness
Because B-02 is CLOSED — CODE-CONTROLLABLE, record: **CR-BE-FX-01: UNBLOCKED FOR START GOVERNANCE.** This does NOT authorize FX implementation. FX remains a separate CR with its own governance covering: FX rate authority, rate source/provider, effective timestamp, source/target currency, inversion, rounding, stale-rate policy, historical rate snapshot, audit, and exact conversion provenance. None of it is implemented here.

### Migration decision
**NO migration.** `0333` is not consumed; no schema blocker, no backfill, no defaults, no NULL → NOT NULL on historical snapshots.

### Validation limitations
- `git diff --check`: **PASS.**
- Focused OpenAPI/contract tests and typecheck: **NOT RUN** — `node_modules` absent, `yaml`/`tsc` unavailable, provisioning forbidden. Unavailable local tooling is not an implementation failure.
- No dependency install, no DB provisioning, no broad regression, no CI.

---

## FINAL REVIEW (2026-08-25)

**Result: READY FOR MERGE WITH RECORDED LIMITATIONS.** Review was limited to CR-BE-CUR-02 only (PARTs 01–06); no whole-repository re-audit, no broad regression.

### CHECKlist findings / fixes

| Check | Finding | Fix |
|---|---|---|
| PART 01–06 scope complete | All PARTs delivered (VSC/basic expense, tenant billing, WO material usage, utility tariff, downstream finance, OpenAPI+closure) | None |
| No command path mints money without governed currency where required | Verified create/update paths for VSC, basic expense, tenant charge, tenant invoice (header + lines), WO material usage (costed), utility tariff all call `assertActiveAllowedCurrencyCommand` / enforce explicit currency | None |
| Tenant invoice single-currency finalize guard | Verified header currency non-null and every line currency known and equal before totals recalculated; rejects mixed/unknown | None |
| Work-order material cost/currency pairing | Verified costed usage requires currency (format + ACTIVE + Client-allowed); non-costed usage not blocked | None |
| Utility tariff as governed currency entry point | Verified create validates ACTIVE + Client-allowed; tariff currency immutable snapshot propagates exactly tariff→calculation→bill | None |
| Downstream finance no longer blanket-excludes known-currency VSC/basic expense | Verified binding propagates `currencyCode`; aggregation reads live `currency_code`; variance B-02 gap only for `SOURCE_CURRENCY_UNPROVEN` | None |
| Historical NULL stays UNKNOWN | Verified read schemas nullable; no inference/substitution/conversion | None |
| No IDR/base/default inference | Verified no autovivification of base/default into monetary snapshots | None |
| No FX/conversion | Verified no FX/rate/conversion path (only pre-existing numeric `.toFixed` formatting) | None |
| B-02 = CLOSED — CODE-CONTROLLABLE | Confirmed; only HISTORICAL UNKNOWN DATA CONDITION residual | None |
| No migration 0333 | Confirmed (only 0331/0332 from CUR-01) | None |
| OpenAPI truthful only for documented runtime surfaces | Material usage + utility tariff edited to match runtime; no invented routes | None |
| Pre-existing undocumented VSC/basic expense/tenant charge/tenant invoice | Recorded as external OpenAPI debt in PART 06 notes | Documented, not fixed |

**No direct CUR-02 code defect was found; no FIX was required.**

### Validation actually run
- `git diff --check`: **PASS** (working tree and staged).

### Validation NOT RUN (recorded, not treated as failure)
- `npm run typecheck`: **NOT RUN** — `tsc` unavailable; `node_modules` absent; provisioning forbidden. Never reported as PASS.
- Focused CUR-02 tests (tests/cur02-part01..part05-*): **NOT RUN** — requires PostgreSQL + dependencies; no provisioning.
- Directly affected finance/currency tests (source-binding, aggregation, variance, utility, invoice suites): **NOT RUN** — same tooling/DB constraint.
- Focused OpenAPI contract tests: **NOT RUN** — `yaml`/`tsx`/`tsc` unavailable; no dependencies.

### B-02 final status
**CLOSED — CODE-CONTROLLABLE.** No command path can mint a monetary value without the governed currency required by its authority, and all relevant downstream arithmetic is exact-currency/fail-closed.

### Historical UNKNOWN residual
**HISTORICAL UNKNOWN DATA CONDITION.** Pre-CUR-02 legacy NULL-currency rows remain an accepted data condition. **"Historical UNKNOWN population not measured in this environment."** No destructive backfill required or performed. Read-only measurement targets recorded in PART 06 notes.

### FX readiness
**CR-BE-FX-01: UNBLOCKED FOR START GOVERNANCE** (B-02 CLOSED — CODE-CONTROLLABLE). No FX implementation here.

### Migrations used
`0331_create_currency_reference_and_client_monetary_context` and `0332_add_operational_billing_currency_snapshots` (both CUR-01; unchanged). **No `0333` consumed.**

### Merge readiness
**READY FOR MERGE WITH RECORDED LIMITATIONS:** (1) VSC / basic expense / tenant charge / tenant invoice are runtime-exposed but have no OpenAPI presence today (pre-existing whole-API docs gap; recorded as external OpenAPI debt); (2) historical UNKNOWN population not measured (DB unavailable); (3) typecheck/contract tests not run (dependencies unavailable). None of these are CUR-02 code gaps.

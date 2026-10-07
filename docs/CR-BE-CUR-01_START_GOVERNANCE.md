# CR-BE-CUR-01 — Currency & Monetary Context Foundation — Start Governance

**Status:** governance only; no runtime, migration, OpenAPI, or dependency change.

**Baseline verified:** `origin/main` / this Arena branch at `cad4fe6fdded26ede670a59ec241b296b5e10b41` (includes CR-BE-EXP-01). Inspection covered migrations, monetary modules, reporting/export, and the PRICE-01, COMM-VAR-01, PRO-02, SVC-01, and EXP-01 governance records.

## 1. Verified current authorities

### 1.1 Scope and configuration

- `clients` (`0012`) is the top-level commercial/isolation boundary, but has **no currency field**.
- `properties` (`0017`) and `buildings` (`0018`) contain country/location and timezone only; neither has currency. Building ownership is derived via Property, so no duplicate Client authority should be introduced.
- There is no `currencies`, client-currency configuration, exchange-rate, FX, conversion, or external-rate-provider table/module.

### 1.2 Existing explicit currency authorities

The established procurement/finance code set is the same nine-code DB whitelist: `IDR, USD, SGD, MYR, AUD, EUR, GBP, JPY, CNY`.

| Area / authority | Verified storage and behavior | Currency finding |
|---|---|---|
| Purchase request / demand | `purchase_requests` and material/service requests (`0176`–`0178`) hold demand, quantity/UOM and no monetary authority | No currency is needed until a monetary sourcing context is created. |
| RFQ | `rfqs.currency VARCHAR(3) NOT NULL` (`0313`) | Nine-code CHECK; RFQ is the procurement-chain currency context. |
| Quotation | `vendor_quotation_revisions.currency` (`0315`), quotation line prices `NUMERIC(18,2)` | Nine-code CHECK and service-layer exact equality with RFQ; submitted revisions are immutable. |
| Comparison / award | comparison run/evidence currency (`0316`) and frozen price facts | Nine-code CHECK; quotation/RFQ mismatch is rejected. Award is selection/provenance, not a new monetary authority. |
| Purchase order | `purchase_orders.currency` and issuance snapshot (`0269`, `0271`) | Nine-code CHECK; PO derives currency from its readiness/source chain. PO lines carry `unit_price`/`line_amount` but no separate line currency, correctly relying on immutable header context. |
| Price catalog | `price_catalog_entries.currency`, `unit_price NUMERIC(18,2)` (`0319`, widened for SERVICE by `0325`) | Nine-code CHECK; currency is part of effective-tier exclusion/resolution key; exact-match only. |
| Budget / commitment | `operational_budgets.currency` (`0283`); commitment header and immutable entries (`0311`, `0312`) | Nine-code CHECK; commitment entries snapshot currency and variance excludes mismatches. |
| Vendor invoice / payment | `vendor_invoices.currency`, `invoice_amount NUMERIC(18,2)` (`0261`+) | Nine-code CHECK; PO-linked invoice must match PO currency. Payment receipts/status inherit invoice context rather than define a different currency. |
| Work-order material cost | optional `unit_cost`, generated `total_cost`, optional `currency` (`0267`) | Nine-code when supplied, but nullable legacy/operational cost context remains. |
| Utility tariffs/calculation/bill | tariff, applied calculation and bill snapshots (`0278`, `0279`, `0191`, `0196`) | Currency travels from tariff through finalized calculation/bill; validation/check is merely `^[A-Z]{3}$`, not ISO/master governed. |
| Tenant charge/invoice | `tenant_charges.amount` (`0195`) and history; `tenant_invoices` totals/line snapshots (`0198`) | Monetary but **currencyless**. |
| Vendor service cost / basic expense | `vendor_service_costs.cost_amount` and history (`0201`); `basic_expenses` examined through operational-finance | Monetary but **currencyless**. Existing variance code explicitly identifies both as B-02 and excludes them. |
| ESG | `0326`–`0329` uses metric/waste quantities, baselines and targets with UOMs | No monetary ESG authority found; no currency change belongs in ESG. |
| Reporting/export | current reporting reads source monetary values; `report_archives` (`0330`, EXP-01) stores archive/provenance, not money | Reports must preserve source currency and cannot sum unlike currencies. |

## 2. Gap matrix and hard-coded assumptions

| ID | Evidence | Gap / risk | CUR-01 governance |
|---|---|---|---|
| G-01 | Repeated nine-code CHECKs/types in `0261`, `0269`, `0283`, `0311`–`0316`, `0319`/`0325` | Duplicated whitelist is a de facto, code-bound currency authority, not a governed master. | Replace incrementally with a global reference master and Client allowance validation; preserve historical snapshots. |
| G-02 | Clients/buildings have no monetary context | No default/allowed transaction currency or configuration lifecycle. | Add Client base/default + allowed-currency context. No building override in PART 01. |
| G-03 | `0201`, basic expenses, `0195`, `0198` | Monetary rows lack currency; B-02 remains real. | Nullable-first currency snapshot; do not infer/backfill IDR; unknown is excluded/fail-closed. |
| G-04 | `0267` optional currency | Costed material usage can remain currencyless. | Require currency whenever a monetary cost is newly created/changed after cutover; legacy null remains unknown. |
| G-05 | `0278`/`0279` only uppercase-three-letter format | Accepts non-ISO/non-enabled codes and is inconsistent with the nine-code authorities. | Convert to master/Client-allowed validation in the utility alignment PART; retain historical code snapshot. |
| G-06 | RFQ → quotation exact match; PO/budget/commitment checks; other links are partial | Cross-document rules are not one complete, shared contract. | Establish lineage rules below; no silent substitution/conversion. |
| G-07 | Search found no rate table/module/provider | FX is absent. | Explicitly defer to CR-BE-FX-01. |
| G-08 | Many older `NUMERIC` amounts; newer procurement commonly `NUMERIC(18,2)` | Scale differs, and application read models use JS numbers/`toFixed(2)`. | No rewrite in CUR-01; govern boundaries and isolate a later arithmetic remediation if evidence requires it. |

**IDR assessment.** `IDR` appears as one member of the nine-code list, not as a verified runtime default or conversion assumption. It must not be used as a migration default. The historical implicit-IDR question is unanswerable from schema/code and must remain `UNKNOWN`, not silently made IDR.

## 3. Governing decisions

### A. Currency master

Adopt a **platform-global reference master**, not Client-scoped identities. ISO-style currency identity is global; allowing each Client to define `USD` or its decimal exponent would make cross-Client platform behavior inconsistent. A proposed `currencies` authority has immutable uppercase `code` (three characters), `name`, optional/validated ISO numeric code (three digits), `decimal_precision` (0–6), and `status ACTIVE|INACTIVE`, plus normal timestamps/audit attribution. The implementation seed must use a reviewed ISO 4217 dataset, not merely promote the existing nine-code list as “ISO”.

A Client is allowed to use a global currency through a separate Client-scoped configuration. `INACTIVE` blocks new selection globally but never invalidates historical rows. Currency code, numeric code, and decimal precision are identity attributes: once referenced, correction is a governed replacement/deprecation procedure, not a rewrite.

### B. Client monetary context

Introduce one Client monetary context: `base_currency_code` and a non-empty set of `allowed_transaction_currency_codes`, with the base currency required to be allowed and active for new configuration. Base/default is a creation-time convenience and reporting partition/default, **not** a conversion target and not a substitute for a transaction snapshot.

No Building override is justified in CUR-01: existing Building-specific commercial distinctions already live in utility tariff and price-catalog tiers, while all sourced documents are Client-scoped and building-bound. A future building override requires demonstrated contractual/legal need, explicit precedence, and independent historical snapshot rules; it must not be inferred from `country_code` or timezone.

### C. Transaction currency and historical snapshot

Every money-bearing transaction must retain its uppercase `currency_code` snapshot alongside the amount. A FK/reference to the master can assist selection integrity, but the persisted code is the historical fact and remains readable after master/client deactivation or configuration change. A transaction must not dynamically render/recalculate from current Client default.

Required contexts: RFQ/quotation/award/PO chain (header context with line inheritance where all lines are necessarily same currency); price catalog entry; commitment header and every immutable commitment entry; work-order material/service cost; vendor and tenant invoices, charges, payment snapshots where applicable; utility tariff/calculation/bill; basic expense. A document that allows mixed currencies in the future needs a currency on each monetary line and explicit header-total semantics; CUR-01 does **not** authorize mixed-currency headers.

### D. Cross-document propagation

1. Request has no monetary currency. Creating an RFQ selects an allowed Client currency and freezes it on the RFQ.
2. RFQ currency must equal every quotation revision, comparison/evidence price context, recommendation/award selection context, and converted PO. Existing exact-match behavior is retained and generalized.
3. An award does not convert or choose a new currency; a PO adopts the awarded/RFQ currency. A PO line inherits header currency and must not be independently re-denominated.
4. A PO-origin commitment and every ledger entry use the PO/commitment currency. Actualization only accepts an exact-currency authoritative actual. Currency mismatch is a recorded non-comparable outcome, never a conversion.
5. Price-catalog lookup remains exact currency equality. It may provide a same-currency reference only; it cannot determine RFQ/PO currency.
6. Invoice/utility/cost lineage must exact-match its governing priced/approved source when a direct source relationship exists. A source-less actual must carry its own currency or be `UNKNOWN` legacy and excluded from arithmetic.

### E. Explicit FX boundary

CUR-01 creates **no** exchange-rate table, provider, API call, conversion, base-currency derived amount, cross-currency aggregate, or automatic substitution. No governed FX authority exists today. **CR-BE-FX-01** is the required future change for dated rate source, quote/base pair, rate precision, rate snapshot, conversion event, rounding and approval/audit. Until then, equality only: different currencies are separately displayed/filtered and are non-comparable.

### F. Precision and rounding

- Preserve existing stored schemas/financial arithmetic in CUR-01. The dominant newer monetary convention is `NUMERIC(18,2)`; legacy utility, expenses and billing include unconstrained `NUMERIC`.
- New monetary amounts should be stored as decimal `NUMERIC`, never float, with scale no less than the currency master decimal precision. The exact common storage scale is an implementation decision only after surveying all active arithmetic and API contracts; it must not truncate currencies with a higher ISO exponent.
- Validate input at the authority boundary against the selected currency precision. Calculate line extensions and document totals in database decimal/application decimal arithmetic, round once at each explicit persisted authority boundary using a documented future rounding mode (proposed: half-up), and snapshot the resulting amount. Do not round intermediate aggregation values through JS `Number`/`toFixed` as a currency migration side effect.
- No retrospective re-scaling or recalculation is authorized.

## 4. Isolation, RBAC, and audit

The reference master is platform-global configuration and must be administered only by an existing platform configuration authority; do not add a broad new permission just for CUR-01. Client monetary context is Client-scoped and uses the existing Client/configuration administration permission pattern. All reads must respect caller Client reachability; a global master listing does not disclose Client enablement.

Creation/update transaction permissions remain their existing module permissions. Those commands additionally validate active master + Client allowed-currency status; they do not gain a new transaction permission. Existing historical/read access remains able to display a snapshot even where its currency became inactive.

Audit operational events/configuration history must record currency-master lifecycle, Client base/allowed set changes, actor, request correlation, and before/after safe codes. Monetary transaction events must include their selected currency snapshot. No audit event may claim an FX conversion or write an inferred historical currency.

## 5. Compatibility, migration, and B-02 decision

**Next migration is `0331`**: `0330_create_report_archives` is now present/registered from EXP-01. Applied migrations are immutable; none is edited.

1. PART 01 may introduce the global reference and Client monetary-context tables/configuration only, with reviewed seed data and no transaction rewrite.
2. For an existing money-bearing table missing currency, add nullable `currency_code` with a structural pairing rule for new writes (amount present requires currency after cutover). Do not use `NOT NULL DEFAULT 'IDR'` and do not mass update.
3. Backfill only rows with documentary, immutable, same-record evidence of a currency (for example a direct frozen tariff/calculation/PO snapshot), recording source/provenance. Otherwise leave null/`UNKNOWN` semantics; no fabricated historical fact.
4. New/updated monetary records fail closed if currency is unknown, inactive, or not Client-allowed. Legacy unknown records remain readable, explicitly labelled unknown, excluded from totals/comparisons/commitment actualization, and reported as remediation gaps.
5. Existing explicit currency rows are not rewritten merely to add an FK/master relation; validate them against an imported master and preserve their stored code. Rows outside the initial supported enabled set require a deliberate master seed/configuration decision, not coercion.

**B-02 reassessment:** PRICE-01/COMM-VAR-01 correctly excluded `vendor_service_costs` and `basic_expenses` because neither has authoritative currency. It is **not closed** by this governance record. CUR-01 defines the only safe path to closure: evidence-backed backfill or unknown exclusion, then required snapshot currency for new records and downstream exact-currency eligibility. `tenant_charges`/`tenant_invoices` are analogous currencyless billing gaps and are added to the remediation scope.

## 6. Relationship to existing CRs

- **PRICE-01:** retain price catalog’s currency key, exact lookup and no-FX rule. Replace duplicated nine-code checks only through compatibility-safe later migrations. PRICE-01 B-02 stays open.
- **COMM-VAR-01:** retain commitment/ledger snapshots and mismatch exclusion. Its variance gap reporting is the required fail-closed precedent.
- **PRO-02:** RFQ is the selected/frozen procurement currency authority; request remains non-monetary. Preserve quotation equality and PO lineage.
- **SVC-01:** service price entries use the same price-catalog currency semantics; SERVICE’s no-UOM/service-line amount shape changes no currency rule.
- **EXP-01:** archive/export is not a money authority. Export must include source currency per amount, partition/group totals by currency, and prohibit cross-currency totals absent FX-01.

## 7. Small implementation PARTs

| PART | Scope | Exit / dependency |
|---|---|---|
| **01 — Currency Reference & Client Monetary Context** | Global currency master, reviewed seed, Client base/allowed context, lifecycle/RBAC/audit/read contract; no transaction rewrites. | Ready after migration-index verification and an approved platform-vs-client configuration permission mapping. |
| **02 — Procurement Currency Propagation** | Replace procurement duplicated validation safely; enforce Client allowance on new RFQ and exact snapshots through quotation, award and PO. | Regress PRO-02/PRICE-01/SVC-01 contracts; no conversion. |
| **03 — Price Catalog & Commitment Currency Alignment** | Master/Client validation at price catalog and budget/commitment boundaries; preserve immutable entry snapshots and mismatch behavior. | No price/commitment amount recalculation. |
| **04 — Operational Cost / Billing Currency Alignment** | Nullable-first currency snapshot treatment for vendor service costs, basic expenses, work-order usage, tenant charges/invoices, utility tariff/calculation/bill and payment contexts. | B-02 only closes once actual data remediation evidence is measured and accepted. |
| **05 — Reporting & Cross-Module Validation** | Currency-safe read models/exports, per-currency grouping, unknown/mismatch gap reporting, lineage validation. | No mixed-currency total or base conversion. |
| **06 — OpenAPI + Closure** | Contract/documentation/test sweep and closure evidence. | Only after all monetary create/update/read contracts are implemented; OpenAPI is untouched in this governance CR. |

## 8. Risks, blockers, and PART 01 readiness

| ID | Risk/blocker | Response |
|---|---|---|
| R-01 | Treating implicit Indonesian deployment context as IDR fact | Never infer/backfill; unknown fails closed. |
| R-02 | Master deactivation changes history | Persist code snapshots and allow historical reads. |
| R-03 | Duplicated whitelist replacement breaks legacy contracts | Stage validation; preserve existing supported codes and test each module. |
| R-04 | Numeric scale/JS-number rounding changes money | Do not change arithmetic in CUR-01; separately prove precision behavior. |
| R-05 | Cross-currency reporting silently sums | Partition by currency and expose non-comparability. |
| R-06 | Existing `0329` migration-index debt noted by EXP-01 | Verify/repair it under authorized work before executing `0331`; do not edit it here. |

**PART 01 readiness: CONDITIONALLY READY.** The model is decided and no runtime prerequisite is needed. Before implementation, verify the existing `0329` migration registration/import consistency identified by EXP-01, confirm the existing platform configuration administrator mapping (to avoid a new permission), approve the reviewed ISO seed source and supported-code activation policy, and confirm `0331` remains next. No migration number is reserved by this document.

---

## PART 01 implementation notes (2026-08-24)

- Added migration `0331_create_currency_reference_and_client_monetary_context` and registered it after `0330`.
- The EXP-01 `0329` registry inconsistency was verified to block migration-module compilation/execution: `migration0329CreateEsgBaselinesTargetsVerification` was referenced in the registry without an import. This PART adds only the missing existing import; it does not change the `0329` migration.
- `currencies` is a platform-global, seeded nine-code reference table. Its code has a database immutability trigger; no delete surface is introduced. Status is `ACTIVE|INACTIVE` and historical referenced codes remain retained.
- `client_monetary_contexts` and `client_allowed_transaction_currencies` are Client-scoped. Deferred database validation requires active base/default currencies and requires both to be in the allowed set. Allowed mappings only accept active currencies. No Client context or transaction record was backfilled.
- Client context writes use existing Client access isolation and record `CLIENT_MONETARY_CONTEXT_SET` through `operational_events` within the same transaction. The existing operational-event authority is Client-required, so platform-global master status administration has no false Client audit event; a future platform-audit authority is required before exposing global currency lifecycle commands.
- No transaction table, OpenAPI document, FX/rate/conversion behavior, Building override, or monetary arithmetic was changed.

---

## PART 02 implementation notes (2026-08-24)

- RFQ creation and explicit DRAFT currency changes now require an ACTIVE Currency Master code allowed for the resolved RFQ Client. No default currency is inferred and existing snapshots are not rewritten.
- Vendor quotation revision currency retains the RFQ exact-equality guard and, on its new/changed quotation command paths, additionally requires the RFQ Client's ACTIVE allowed currency.
- Standalone new PO creation validates its resolved Client context; award-to-PO conversion validates the exact awarded quotation/RFQ currency before persisting the inherited PO snapshot. Existing comparison, recommendation, award and conversion equality guards remain the audit/provenance authority.
- Validation is command-time only. Historical reads do not call Currency Master/allowed-set validation, so later deactivation/configuration changes do not invalidate documented snapshots.
- No FX, conversion, Client-default inference, monetary arithmetic, backfill, transaction schema, price/commitment/billing/reporting/export change, or parallel currency audit channel was added.

---

## PART 03 implementation notes (2026-08-24)

- New Price Catalog entries require an ACTIVE Currency Master code allowed for the entry Client before existing reference/tier/window validation. Existing material/service shapes, tier resolution, effective dating, replacement/correction and exact lookup are unchanged.
- New manual Operational Commitments require the locked budget Client's ACTIVE allowed currency before the pre-existing exact budget-currency guard. Derived PO/line commitment paths retain their upstream exact-snapshot authority and are not re-denominated.
- No reads invoke current master/Client allowance validation; historical catalog and commitment snapshots remain readable after deactivation or configuration changes. Existing price/commitment operational events remain the only audit channels.
- Tests: NOT RUN. `tsc`/test tooling remains unavailable without dependency provisioning; no provisioning, PostgreSQL, broad regression, or CI was run.

---

## PART 04 implementation notes (2026-08-24)

- Added nullable-first `currency_code` snapshot columns, without defaults or backfill, to vendor service cost (+ history), basic expense (+ history), tenant charge (+ history), and tenant invoice (+ line) monetary authorities. Existing NULL rows remain unknown/readable and cannot be represented as a governed cross-currency amount.
- Work-order material usage already has optional `currency`; no duplicate field was added. Utility tariff/calculation/bill already propagates a currency snapshot, so no schema duplication was made in this PART. Its legacy three-letter validation/master adoption remains a subsequent command-surface alignment task.
- This is intentionally schema-only for currencyless historical authorities: adding a command input would require a complete domain contract/audit/history projection sweep not authorized by the nullable-first compatibility step. No IDR inference, default injection, arithmetic/tax/payment change, or cross-currency aggregation was introduced.
- B-02 is narrowed only structurally: the affected cost authorities now have a place for an explicit future governed snapshot, but remains OPEN for historical NULL rows and until future command paths require/validate new snapshots. No claim is made for untouched utility/work-order or legacy records.
- Tests/typecheck: NOT RUN; tooling is unavailable without dependency provisioning. No dependency installation, PostgreSQL provisioning, broad regression, or CI was run.

---

## PART 05 implementation notes (2026-08-24)

- Added a thin `currency-reporting` read seam for finalized Vendor Service Costs and Basic Expenses. It returns exact-currency totals per source and a separate `unknown` count/amount gap; it deliberately exposes no mixed-currency grand total and never substitutes Client base/default.
- Added an exported Client monetary-context read seam returning the existing Client-scoped base/default/allowed configuration with its existing access check. No mutation or audit event occurs on reads.
- Existing procurement, Price Catalog, commitment and utility read authorities retain their exact snapshot/equality semantics. This PART adds no FX or cross-module conversion. B-02 remains OPEN for unknown historical rows and authorities not yet given a governed command-time snapshot.
- Tests/typecheck: NOT RUN; required tooling is unavailable without dependency provisioning. No provisioning, PostgreSQL, broad regression, or CI was run.

---

## PART 06 — OpenAPI and governance closure (2026-08-24)

### OpenAPI/runtime alignment

No OpenAPI path or schema was added or modified. This is intentional and is the aligned outcome for the delivered runtime:

- Currency Master is a seeded platform reference authority with repository/service support but **no public HTTP route**.
- Client Monetary Context has a Client-scoped service/read seam but **no public HTTP route**.
- `currency-reporting` is an internal exported read seam and **not a public HTTP route**.
- Existing public RFQ, quotation, PO, Price Catalog and commitment APIs already expose their pre-existing currency snapshot fields. PARTs 02–03 changed command-time authority validation, not their public payload shape.
- PART 04 added nullable storage only; vendor service costs, basic expenses, tenant charges and tenant invoices do not yet expose a new public `currencyCode` contract. Documenting it in OpenAPI would be false.

Accordingly, no direct CUR-01 OpenAPI/runtime contract mismatch exists to fix in this closure. A later CR that exposes Currency Master, Client Monetary Context, currency-safe reporting, or PART-04 snapshots over HTTP must add matching OpenAPI paths/schemas and focused contract tests in that same CR.

### Delivered historical and exact-currency contract

- Persisted transaction currency remains the document/record snapshot. Currency-master deactivation and Client default/allowed-set changes do not rewrite historical records.
- A nullable PART-04 `currency_code` is **UNKNOWN**, not IDR, Client base currency, Client default transaction currency, or an inferred conversion result.
- New/changed adopted procurement, Price Catalog and manual commitment commands validate ACTIVE Currency Master and Client allowance while preserving their existing exact lineage equality checks.
- No FX authority, exchange-rate table/provider, conversion, base-currency normalization, Building override, accounting/GL change, or historical backfill exists.
- The internal operational reporting seam groups finalized vendor-service-cost and basic-expense totals by exact non-NULL currency and returns NULL values as a separate unknown count/amount gap. It returns no converted or mixed-currency grand total.

### B-02 and CR closure

**B-02 remains OPEN / NARROWED.** PART 04 created nullable-first storage for the affected vendor-service-cost, basic-expense, tenant-charge and tenant-invoice authorities, but historical NULL snapshots remain unknown and some command surfaces still do not require/write governed currency snapshots. No closure is claimed for utility/work-order legacy gaps or any unadopted authority.

Migrations used by CUR-01 are `0331_create_currency_reference_and_client_monetary_context` and `0332_add_operational_billing_currency_snapshots`. PART 01 added the missing `0329` registry import only because its absent import blocked migration registry execution; `0329` itself was not changed. No migration/backfill inferred IDR.

**Future boundary:** CR-BE-FX-01, not CUR-01, must govern any dated exchange-rate authority, source/provenance, conversion snapshots, rounding, approval, and reporting conversion semantics.

### Validation and final-review readiness

- `git diff --check`: PASS.
- Focused CUR-01 OpenAPI/contract tests: **NOT RUN** — no dedicated public CUR-01 route exists and test tooling is unavailable without dependency provisioning.
- `npm run typecheck`: **NOT RUN** — `tsc` is unavailable in the current dependency environment; dependencies were not installed.
- No PostgreSQL provisioning, broad regression, CI, KI-003 work, PR, or merge was performed.

**FINAL REVIEW readiness: READY WITH RECORDED LIMITATIONS.** Review must retain the B-02 OPEN/NARROWED status, confirm the intentionally absent public OpenAPI surface, and treat PART-04 nullable snapshots and the internal reporting seam as incomplete public-contract work rather than a currency migration/backfill.

---

## FINAL REVIEW (2026-08-24)

**Result: READY FOR MERGE WITH RECORDED LIMITATIONS.** Review was limited to CR-BE-CUR-01 files and adopted authorities.

### Findings and fixes

- Verified `0331` and `0332` are each imported and ordered once in `src/database/migrations/index.ts` after `0330`.
- Verified `0331` establishes the global Currency Master, immutable code trigger, approved nine-code seed, Client base/default context and allowed-currency relation.
- Verified PARTs 02–03 call the same active-and-Client-allowed command-time authority while retaining RFQ → quotation → award → PO exact equality, Price Catalog exact lookup/replacement behavior, and commitment exact budget/upstream behavior.
- Verified `0332` is nullable-first only: it contains no default, IDR inference, update/backfill, FX/rate, or transaction-table rewrite. Historical NULL remains UNKNOWN.
- Verified the internal currency-reporting seam has no mixed-currency grand total and reports the NULL/unknown gap separately.
- Verified the only 0329-related change is the required registry import in `index.ts`; `0329_create_esg_baselines_targets_verification.ts` itself is unchanged.
- Verified no public currency/context/reporting route or false OpenAPI claim was introduced. **No direct CUR-01 defect requiring code change was found.**

### Validation actually run

- `git diff --check`: **PASS**.
- Static migration/registry and CR-only diff inspection: **PASS**.

### Validation not run

- `npm run typecheck`: **NOT RUN** successfully — attempted, but failed immediately with `tsc: not found` (exit 127). Dependencies were not installed.
- Focused CUR-01 and directly affected contract tests: **NOT RUN** — test tooling/environment is unavailable without dependency provisioning; no PostgreSQL was provisioned.
- No broad regression, CI, KI-003 work, PR merge, or unrelated remediation was performed.

### Closure facts

- CUR-01 migrations: `0331_create_currency_reference_and_client_monetary_context`, `0332_add_operational_billing_currency_snapshots`.
- **B-02 remains OPEN / NARROWED:** historical NULL currency rows remain and command-time governed snapshots are not yet universal. It is not artificially closed.
- There is no IDR inference, FX, exchange-rate table/provider, conversion, base-currency normalization, Building override, accounting/GL change, or historical backfill.
- **CR-BE-FX-01** remains the required future boundary for all exchange-rate and conversion authority.

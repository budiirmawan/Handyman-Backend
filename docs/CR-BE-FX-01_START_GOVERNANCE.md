# CR-BE-FX-01 — Foreign Exchange & Exchange Rate Foundation — Start Governance

**Status:** GOVERNANCE ONLY. No runtime code, no migration file, no dependency install, no
`npm ci`, no CI, no PR, no merge is performed by this record. No migration number is consumed.

**Baseline verified:** `origin/main` at `a5ae3b03365e07fb6b08e99c3894d1ca51b0fad2` — the merge
commit of PR #68 (CR-BE-CUR-02). `git rev-list --count HEAD..origin/main` returned **0**; local
`HEAD`, `origin/main`, and the working branch base are the same commit. Required baseline
precondition **CR-BE-CUR-02 = MERGED / CLOSED** is therefore satisfied.

**Predecessor mandate honoured.** CUR-01 §E and CUR-02 §11/§"FX readiness" both deferred every
exchange-rate concern to this CR and recorded **CR-BE-FX-01: UNBLOCKED FOR START GOVERNANCE**.
CUR-01 §E named the required contents: *"dated rate source, quote/base pair, rate precision,
rate snapshot, conversion event, rounding and approval/audit"*. Each is governed below.

---

## 1. Verified current state

### 1.1 Repository facts (all re-verified at baseline `a5ae3b0`)

| Fact | Verified value |
|---|---|
| Migration registry | `src/database/migrations/` = 334 files = **332 migrations** + `index.ts` + `types.ts` |
| Highest migration | `0332_add_operational_billing_currency_snapshots` |
| **Next free migration number** | **`0333`** (not consumed by this record) |
| TypeScript sources | 2,824 `.ts` files under `src/` |
| Tests | 425 entries under `tests/` = **424 `*.test.ts` files** + 1 helper |
| OpenAPI contract | `docs/api/openapi.yaml`, 46,532 lines |
| **FX presence in `src/`** | **ZERO.** `grep -rn -i -E '\b(fx_rate\|fxRate\|exchange_rate\|exchangeRate\|currencyConversion\|fx_conversion)\b' src/` → no matches |
| FX module | **NONE.** No `fx`/`exchange`/`treasury`/`rate` module directory exists |
| FX in OpenAPI | **NONE.** The only `/…exchange…` path is `/vendor-rfq-access/exchange` (RFQ access **token** exchange — unrelated to FX) |

### 1.2 Existing authorities FX must extend (never replace)

| Authority | Location | Verified shape |
|---|---|---|
| **Currency Master** | `currencies` (`0331`), `src/modules/currencies/index.ts` | `code VARCHAR(3) PRIMARY KEY`, `name`, `numeric_code VARCHAR(3)`, `decimal_precision SMALLINT 0–6`, `status ACTIVE\|INACTIVE`. Code immutability enforced by trigger `currencies_code_immutable` → `prevent_currency_code_change()`. Seeded: IDR(0dp), USD(2), SGD(2), MYR(2), AUD(2), EUR(2), GBP(2), JPY(0), CNY(2) — **9 codes** |
| **Client Monetary Context** | `client_monetary_contexts` + `client_allowed_transaction_currencies` (`0331`), `src/modules/client-monetary-contexts/index.ts` | Per-Client `base_currency_code` + `default_transaction_currency_code`, both required ACTIVE and in the allowed set. Deferred constraint trigger `validate_client_monetary_context`; before-insert/update trigger `client_allowed_currency_active` |
| **Allowed transaction currencies** | `client_allowed_transaction_currencies (client_id, currency_code)` | Client-scoped allow-list; PK on the pair; indexed by `currency_code` |
| **Command-time currency authority** | `assertActiveAllowedCurrency` / `assertActiveAllowedCurrencyCommand` in `src/modules/client-monetary-contexts/index.ts` | Fails closed with `CURRENCY_INACTIVE_OR_UNKNOWN` / `CLIENT_CURRENCY_NOT_ALLOWED`. **12 consumer modules** verified: `basic-expenses`, `inventory-work-order-material-usages`, `operational-finance` (commitments), `price-catalog-entries`, `purchase-orders`, `rfq-po-conversions`, `rfqs`, `tenant-charges`, `tenant-invoices`, `utility-tariffs`, `vendor-quotations`, `vendor-service-costs` |
| **Exact-currency read seam** | `src/modules/currency-reporting/index.ts` → `getOperationalCurrencySummary` | Groups by `currency_code`, returns per-currency totals + an `unknown` bucket. **Verified: ZERO callers in `src/` or `tests/`** — an unwired seam |

### 1.3 Procurement monetary snapshots (exact-currency, must stay unchanged)

| Authority | Currency column | Verified constraint |
|---|---|---|
| `purchase_orders` (+history) `0269` | `currency TEXT NOT NULL` | `CHECK (currency IN ('IDR','USD','SGD','MYR','AUD','EUR','GBP','JPY','CNY'))` |
| `rfqs` `0313` | `currency VARCHAR(3) NOT NULL` | 9-code CHECK |
| `vendor_quotation_revisions` `0315` | `currency VARCHAR(3) NOT NULL` | 9-code CHECK |
| `rfq_comparisons` `0316` / `0320` | comparison + `reference_currency` | exact-equality lineage |
| `price_catalog_entries` `0319` / `0325` | `currency VARCHAR(3) NOT NULL` | 9-code CHECK; **ACTIVE-overlap `EXCLUDE` index includes `currency`**, so two live prices in different currencies coexist and lookup is exact-match only |
| `vendor_invoices` (+history) `0261` | `currency TEXT NOT NULL` | 9-code CHECK; `vendor-invoices` service line 834 rejects `purchaseOrder.currency !== invoice.currency` as `CURRENCY_MISMATCH` |

### 1.4 Budget / Commitment (exact-currency, must stay unchanged)

- `operational_budgets` `0283`: `currency VARCHAR(3) NOT NULL` + 9-code CHECK, `planned_amount NUMERIC(18,2)`. Live-period exclusion `operational_budgets_live_period_exclusion` uses `daterange(...) WITH &&`.
- `operational_commitments` `0311`: `currency NOT NULL`, `committed/actualized/released/open_amount NUMERIC(18,2)`, `open_amount` a `GENERATED ALWAYS AS … STORED` column. Migration header states currency is set *"once at creation and never rewritten"*.
- `operational_commitment_entries` `0312`: every immutable ledger entry carries its own `currency NOT NULL`; `SUM(signed_amount) = open_amount` invariant — **this is an exact-currency invariant that FX must never touch**.

### 1.5 Actualization / variance / aggregation (exact-currency, must stay unchanged)

| Consumer | Verified exact-currency behaviour |
|---|---|
| `operational-finance-binding.service.ts:246-252` | `currencyStatus()` returns `MISSING` for NULL and **throws** `operationalBudgetSourceCurrencyMismatchError()` on mismatch |
| `operational-finance-aggregation.service.ts:128-135` | `SOURCE_CURRENCY_UNPROVEN` (NULL) and `SOURCE_CURRENCY_MISMATCH` exclusions; `currencyEligible=false` |
| `operational-variance.service.ts:44,228-239` | `CURRENCYLESS_ACTUAL_SOURCE_TYPES = ['VENDOR_SERVICE_COST','BASIC_EXPENSE']` now labels **only** genuine `SOURCE_CURRENCY_UNPROVEN` gaps (`CURRENCYLESS_COST_AUTHORITY`, reference `B-02`) |
| `operational-commitment-vendor.service.ts:119-138` | NULL or ≠ commitment currency → event `OPERATIONAL_COMMITMENT_VENDOR_CURRENCY_MISMATCH`, `{outcome:'CURRENCY_MISMATCH'}`, **nothing actualized, no conversion** |
| `operational-commitment-material.service.ts:102-103,337-356` | same fail-closed shape for material actualization |
| `tenant-invoice.service.ts:81-119,190-196` | header currency required; every line source currency must be **known and exactly equal**; unknown or mixed → `TENANT_INVOICE_SOURCE_CURRENCY_UNKNOWN` / `TENANT_INVOICE_CURRENCY_MISMATCH` |
| `tenant-invoice.repository.ts:125-126,171-172` | `subtotal`/`total_amount = SUM(amount_snapshot)` — **only ever safe because of the single-currency guard above** |

### 1.6 Utility chain, vendor service cost, basic expense, tenant billing

- `utility_calculation_bases` tariff (`0278`): currency mandatory; **`EXCLUDE USING gist` over `tstzrange(effective_from, effective_to, '[)') WITH &&` WHERE `status='ACTIVE'`** — the repository's proven non-overlapping-window pattern.
- `utility_calculations` (`0191`) / `utility_bills` (`0196`/`0279`): inherit tariff → calculation → approval → bill by exact equality; `utilityBillContextInvalidError` on mismatch.
- `vendor_service_costs`, `basic_expenses`, `tenant_charges`, `tenant_invoices`: nullable-first `currency_code` (`0332`), now governed at command time by CUR-02 PARTs 01–02. **Historical rows remain NULL = UNKNOWN.**

### 1.7 Reporting / export / audit / operational variance

| Surface | Verified state | FX consequence |
|---|---|---|
| `src/modules/reporting-export/` (projections, CSV/XLSX/PDF renderers, registry) | **ZERO `currency` references; ZERO monetary amounts.** All KPIs are counts, man-hours, consumption quantities | Export is currently currency-blind, not currency-mixing. **FX-01 must not add converted amounts to exports** (CUR-01 §EXP-01: export is not a money authority) |
| `src/modules/basic-financial-reporting/` | **ZERO `currency` references** | No reporting currency exists anywhere today |
| `src/modules/currency-reporting/` | Exact-currency summary + Client context read model; **zero callers** | This is the natural FX-01 PART 04 integration point |
| `src/modules/audit/` → `authentication_audit_events` (`0011`) | **Authentication-only**, `event_type` locked by a 9-value CHECK | Cannot carry domain FX events without a destructive CHECK change — **not authorized** |
| `src/modules/operational-events/` → `operational_events` (`0080`) | `client_id UUID **NOT NULL**`, `entity_id UUID NOT NULL`, `event_type TEXT` (free-form, no CHECK), `metadata JSONB` | Usable for **Client-scoped** FX policy events. **Unusable for platform-global rate maintenance** — there is no owning Client |
| `src/modules/configuration-audit/` | Reads `operational_events` (verified: `FROM operational_events`) | Same `client_id NOT NULL` constraint |

### 1.8 Reusable platform authorities (verified, to be reused — not reinvented)

| Authority | Location | FX-01 reuse |
|---|---|---|
| RBAC middleware | `src/modules/auth/rbac.middleware.ts` → `requirePermission(code)`, default-deny | Gate every FX route |
| Permission catalogue | `FOUNDATION_PERMISSIONS` in `src/database/seeds/foundation-access.seed.ts`; naming `snake_case.action` | Add FX codes only |
| Exceptional-authority set | `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` = `{operational_budget.override, rfq.award, price_catalog.override}` | Precedent for withholding an approval authority from PLATFORM_ADMIN |
| Segregated verifier precedent | `esg.verify` (separate from `esg.manage`) | Precedent for maker-checker split |
| Dedicated-code justification precedent | `integration_webhook.read/manage` — *"reusing configuration codes would let any config editor mint outbound URLs and secrets"* | Justifies dedicated FX policy codes |
| Non-overlapping effective windows | `0278` `btree_gist` + `EXCLUDE USING gist … tstzrange('[)') … WHERE status='ACTIVE'` | Rate window ambiguity prevention |
| Provider-neutral seam | `src/shared/provider-result.ts` + `EMAIL_PROVIDER` / `WHATSAPP_PROVIDER` discriminators | Provider boundary pattern |
| Append-only history precedent | `vendor_invoice_history`, `work_contract_history`, `operational_commitment_entries` | `fx_rate_events` shape |
| Monetary scale | `NUMERIC(18,2)` dominant (`0311`, `0269`, `0319`, …); legacy unconstrained `NUMERIC` in utility/expenses/billing (CUR-01 §F) | Converted-amount scale |

### 1.9 Authorities verified as **absent** (drives the rate-type decision)

| Searched for | Result | Consequence |
|---|---|---|
| Fiscal / accounting period authority | **None.** Only `operational_budgets.period_start/period_end DATE` and `utility_meter_consumptions.period_start/period_end TIMESTAMPTZ`. No period-close, no ledger cut-off | No `MONTH_END`/`ACCOUNTING` selection axis exists |
| Contract with an FX clause | **None.** `work_contracts` (`0272`) has **0** currency references; no `contract_fx` concept anywhere | No `CONTRACTUAL` rate type is justifiable |
| General ledger / journal / revaluation | **None** (`grep` for `general_ledger\|journal_entry\|revaluation` in `src/` → no domain hit) | No `ACCOUNTING` rate type; GL revaluation stays a NON-GOAL |
| Client-scoped rate storage | **None** | Rate storage scope is an open decision — resolved in §4 |

---

## 2. Architecture decision

### D-1 — FX is a **read-side reporting authority layered on top of** the CUR-01/02 snapshot model

CUR-01/02 established that **the persisted transaction currency snapshot is the historical fact**
and is immutable once written. FX-01 adds a *second, derived, explicitly-provenanced* view. It
never edits, reinterprets, or re-denominates a stored amount or currency code.

```
                        ┌──────────────────────────────────────────┐
  WRITTEN, IMMUTABLE    │  Monetary record                         │
  (CUR-01 / CUR-02)     │  amount + currency_code  (transaction)   │
                        └───────────────┬──────────────────────────┘
                                        │  read only
                                        ▼
                        ┌──────────────────────────────────────────┐
  DERIVED, PROVENANCED  │  Governed Conversion Service (ONE)       │
  (FX-01)               │  fxConversionService.convert(...)        │
                        │  resolves: Client FX Policy + FX Rate    │
                        └───────────────┬──────────────────────────┘
                                        │
                    ┌───────────────────┴────────────────────┐
                    ▼                                        ▼
        ┌───────────────────────┐               ┌──────────────────────────┐
        │ TRANSIENT read model  │               │ MATERIALIZED snapshot    │
        │ inline provenance,    │               │ persisted converted amt  │
        │ nothing stored        │               │ + fx_conversions ledger  │
        └───────────────────────┘               └──────────────────────────┘
```

**Rejected alternative — write-side conversion.** Converting at command time (storing a converted
amount on the RFQ/PO/invoice) was rejected because it would (a) break the CUR-01 immutability rule,
(b) require re-conversion whenever a rate is corrected, and (c) authorize the cross-currency
transactional workflows explicitly listed as NON-GOALS.

### D-2 — Rate **values are platform-global**; rate **policy is Client-scoped**

This mirrors the CUR-01 split exactly: *monetary identity is global* (`currencies`), *monetary
usage is Client-scoped* (`client_allowed_transaction_currencies`).

- **Platform-global `fx_rates`.** An exchange rate is a market fact. Per-Client rate tables would
  let two Clients hold different "USD/IDR for 2026-03-01" values — unauditable and irreconcilable
  against any external source (Bank Indonesia publishes one number).
- **Client-scoped `client_fx_policies`.** Whether FX is enabled, which sources are trusted, which
  target currency is reported, whether inverse is permitted, and how stale a rate may be are all
  Client governance decisions.

**Consequence that shaped the audit design:** `operational_events.client_id` is `NOT NULL`
(`0080`, verified). A platform-global rate therefore has **no owning Client** and cannot be
audited through the existing operational-event authority. FX-01 adds a dedicated append-only
`fx_rate_events` ledger rather than relaxing a shared `NOT NULL` used by every module.

### D-3 — One conversion authority; the arithmetic lives in exactly one function

No module may write `amount * rate` or `amount / rate`. All conversion goes through
`fxConversionService` (§7). A PART 05 regression test asserts this statically.

### D-4 — Triangular / multi-leg conversion is **out of scope**

FX-01 permits exactly two derivations: **DIRECT** (a stored pair) and **INVERSE** (the governed
reciprocal of a stored pair). `A → C` via `B` is **not permitted**: it compounds rounding error,
requires a governed leg order, and would silently introduce a third currency into a two-currency
request. Rejected by design, recorded here so it is never implemented informally.

---

## 3. Canonical rate convention (FROZEN)

### **`1 BASE = RATE × QUOTE`**

`fx_rates.rate` is the number of **QUOTE** units equal to **one** unit of **BASE**.

```
  base_currency_code = USD , quote_currency_code = IDR , rate = 16250.000000000000
  →  1 USD = 16 250 IDR
  →  120 USD  --DIRECT-->  120 × 16250        = 1 950 000 IDR
  →  1 950 000 IDR --INVERSE--> 1 950 000 ÷ 16250 = 120 USD   (only if policy permits inverse)
```

**The single primitive is MULTIPLICATION.** Division appears **only** on the governed INVERSE
path, where it is recorded as such (§11).

### Why this direction and not the alternative

The alternative convention (`RATE = units of BASE per 1 QUOTE`, i.e. `1 IDR = 0.0000615 USD`) was
**rejected**:

1. It contradicts how every candidate provider publishes. Bank Indonesia / JISDOR and any
   treasury rate sheet quote *rupiah per foreign unit* — `1 USD = 16 250 IDR`. Storing the
   reciprocal would force an inversion at **ingestion**, moving the precision loss into the
   authoritative record where it is invisible.
2. It makes the common case (`IDR`-base Client reporting a `USD` cost, or the reverse) a division
   of a very small stored number, amplifying representation error.
3. `BASE → QUOTE` reads identically to the market convention used by the operations team, so a
   human reviewer can validate a stored rate by eye.

**Frozen.** Once PART 01 ships, the convention is immutable. A future change would require a
new CR, a new column, and an explicit migration of every stored snapshot — i.e. it is designed
never to happen.

### Precision

| Field | Type | Rationale |
|---|---|---|
| `fx_rates.rate` | **`NUMERIC(24, 12)`** | A rate is a **ratio, not a monetary amount**, so the repository's `NUMERIC(18,2)` monetary convention deliberately does not apply. 12 integer digits cover any historically real rate; 12 decimals keep a directly-published small rate (e.g. `0.000061538462`) meaningful to ~1e-11 relative error. `CHECK (rate > 0)` — a zero or negative rate is never valid |
| Converted amount | Target currency's monetary scale, `NUMERIC(18,2)` minimum | Matches the dominant repository convention and never truncates below `currencies.decimal_precision` (0 for IDR/JPY, 2 for the rest) |
| Rounding mode | **Half-up, applied once**, at the persisted boundary | Exactly the mode CUR-01 §F proposed. Never round an intermediate; never round through JS `Number`/`toFixed` |

---

## 4. FX Rate Authority (data model — PART 01)

`fx_rates` — **append-only in effect**: a rate's business columns are immutable once written;
correction is *supersession by a new row*, never an in-place edit.

| Column | Type | Governance |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | |
| `base_currency_code` | `VARCHAR(3) NOT NULL REFERENCES currencies(code)` | Must be ACTIVE at creation |
| `quote_currency_code` | `VARCHAR(3) NOT NULL REFERENCES currencies(code)` | Must be ACTIVE at creation; `CHECK (base <> quote)` |
| `rate_type` | `TEXT NOT NULL DEFAULT 'REFERENCE'` | `CHECK (rate_type IN ('REFERENCE'))` in FX-01 — see §5 |
| `rate` | `NUMERIC(24,12) NOT NULL` | `CHECK (rate > 0)` |
| `effective_from` | `TIMESTAMPTZ NOT NULL` | Window start (inclusive) |
| `effective_to` | `TIMESTAMPTZ` | Window end (exclusive); `NULL` = currently open. `CHECK (effective_to IS NULL OR effective_to > effective_from)` |
| `status` | `TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'` | `CHECK (status IN ('PENDING_APPROVAL','ACTIVE','REJECTED','SUPERSEDED','INACTIVE'))` |
| `source` | `TEXT NOT NULL` | `CHECK (source IN ('MANUAL_TREASURY'))` in FX-01 — the provider seam, §13 |
| `source_reference` | `TEXT` | Provider/treasury document reference (rate-sheet ID, BI bulletin ref). Free-form provenance |
| `ingested_at` | `TIMESTAMPTZ` | Reserved for automated ingestion; `NULL` for manual entry |
| `supersedes_rate_id` | `UUID REFERENCES fx_rates(id)` | Correction lineage; `UNIQUE` partial index so a rate can never be superseded twice |
| `superseded_by_rate_id` | `UUID REFERENCES fx_rates(id)` | Reverse link, maintained by the service in the same transaction |
| `created_by_user_id` | `UUID NOT NULL REFERENCES users(id)` | **Maker** |
| `approved_by_user_id` | `UUID REFERENCES users(id)` | **Checker**; `NOT NULL` whenever `status='ACTIVE'`; `CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id)` |
| `approved_at` | `TIMESTAMPTZ` | Required with `approved_by_user_id` |
| `deactivated_at` / `deactivated_by_user_id` | | Required with `status='INACTIVE'` |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |

**Structural guards (all in the PART 01 migration):**

1. **Window non-overlap** — reuses the `0278` pattern verbatim:
   ```sql
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_active_window_exclusion
     EXCLUDE USING gist (
       base_currency_code WITH =, quote_currency_code WITH =, rate_type WITH =,
       tstzrange(effective_from, effective_to, '[)') WITH &&
     ) WHERE (status = 'ACTIVE');
   ```
   → **ambiguous multiple ACTIVE rates for a pair+type are structurally impossible**, which makes
   `FX_RATE_AMBIGUOUS` a defence-in-depth guard rather than a routine outcome.
2. **Immutability trigger** — a `BEFORE UPDATE` trigger rejecting any change to
   `base_currency_code`, `quote_currency_code`, `rate`, `rate_type`, `effective_from`,
   `effective_to`, `source`, `source_reference`, `created_by_user_id`. Same mechanism as
   `prevent_currency_code_change()` on `currencies`. **Only `status`, approval, supersession and
   deactivation fields may change.**
3. **Lookup index** — `(base_currency_code, quote_currency_code, rate_type, effective_from DESC)
   WHERE status = 'ACTIVE'`, mirroring the `0278` tariff index.

`fx_rate_events` — **append-only audit ledger** (no `client_id`; justified in §2/D-2):

`id`, `fx_rate_id`, `event_type`, `actor_user_id`, `request_id`, `metadata JSONB`,
`occurred_at`, `created_at`. No UPDATE/DELETE code path, ever.

---

## 5. Rate types — minimum enterprise-safe model

**Decision: exactly ONE rate type in FX-01 — `REFERENCE` — behind an extensible CHECK column.**

Evidence-driven rejection of the others:

| Candidate | Verdict | Verified reason |
|---|---|---|
| `SPOT` | **Rejected** | Asentra has no settlement, no intraday trading, no dealing desk. A "spot rate" is indistinguishable from a dated published rate here |
| `DAILY` | **Rejected as a separate type** | Collapses into `REFERENCE`. The **effective-date axis already performs the selection** that a `DAILY` type would |
| `MONTH_END` | **Deferred, not created** | **No fiscal/accounting-period authority exists** (§1.9) — nothing could select it. Creating it would mint an unselectable enum value |
| `ACCOUNTING` | **Rejected** | No GL, no journal, no revaluation anywhere in `src/` (§1.9). GL revaluation is a stated NON-GOAL |
| `CONTRACTUAL` | **Rejected** | `work_contracts` (`0272`) carries **zero** currency references; no contract FX clause exists to reference |

**The key architectural insight:** Asentra selects rates **by effective date, not by rate type**.
Once `(base, quote, effective window)` disambiguates, a second type dimension adds no selection
value — only a way to disagree about which number is "the" rate.

**Enterprise-safe because it is extensible without damage.** `rate_type` is a real, `NOT NULL`,
CHECK-constrained column present from PART 01, and it is part of the uniqueness/window key from
day one. A future CR that proves a distinct selection purpose (e.g. a real period-close) widens
the CHECK — a non-destructive, additive migration — with **no** redefinition of existing rows and
**no** re-keying.

**Extension rule (frozen):** a new `rate_type` may be added **only** by a CR that demonstrates a
consumer which cannot be served by effective-date selection. Adding a type to "make the model
look complete" is prohibited.

---

## 6. Client FX Policy (`client_fx_policies` — PART 01 schema, PART 02 command surface)

| Column | Type | Governance |
|---|---|---|
| `client_id` | `UUID PRIMARY KEY REFERENCES clients(id)` | One policy per Client, matching `client_monetary_contexts` |
| `fx_enabled` | `BOOLEAN NOT NULL DEFAULT false` | **Fail closed by default.** No policy row = FX unavailable |
| `reporting_currency_code` | `VARCHAR(3) NOT NULL REFERENCES currencies(code)` | See "Reporting currency relationship" below |
| `permitted_sources` | `TEXT[] NOT NULL` | Subset of `fx_rates.source`; empty array = nothing may be used |
| `inverse_permitted` | `BOOLEAN NOT NULL DEFAULT false` | Governs §11. **Default `false` = fail closed** |
| `max_staleness_days` | `SMALLINT` | `NULL` = no staleness bound beyond the effective window. When set, a selected rate older than the bound is rejected |
| `created_by_user_id` / `updated_by_user_id` / `created_at` / `updated_at` | | Attribution |

A `BEFORE INSERT OR UPDATE` trigger validates `reporting_currency_code` is ACTIVE **and** present
in `client_allowed_transaction_currencies`, reusing the exact shape of
`validate_client_monetary_context` / `validate_client_allowed_currency` from `0331`.

### Base / reporting currency relationship

- `client_monetary_contexts.base_currency_code` already exists and is already required ACTIVE +
  allowed (`0331`).
- **FX-01 does NOT add a second reporting axis.** `client_fx_policies.reporting_currency_code`
  is **required to equal the Client's `base_currency_code`** in FX-01, enforced by the policy
  validation trigger.
- **Why:** CUR-01 §B already defines base as the *"reporting partition/default"*, and no consumer
  of a distinct reporting currency exists (§1.7 — zero currency references in every reporting
  module). Introducing a divergent reporting currency would create a second conversion target
  with nothing reading it.
- **Extension rule:** decoupling `reporting_currency_code` from `base_currency_code` requires its
  own CR, because it would make a single monetary record convertible to *two* different targets
  and would need governed precedence between them.

### Permitted rate sources

FX-01: `permitted_sources ⊆ {'MANUAL_TREASURY'}`. A Client that permits no source can never
convert, even when a rate exists.

### Rate selection policy (the complete, ordered resolution)

Given `(clientId, fromCurrency, toCurrency, referenceDate)`:

1. **Identity short-circuit.** If `fromCurrency === toCurrency`, return the amount unchanged with
   `direction: 'IDENTITY'` and **no rate lookup**. A `1:1` rate is **never stored and never
   synthesized**. This is the only "conversion" that needs no rate.
2. **Currency leg validity.** Both legs must exist in `currencies` and be `ACTIVE` →
   else `FX_CURRENCY_INACTIVE_OR_UNKNOWN`. If either leg is `NULL`/UNKNOWN →
   `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` (§14).
3. **Client policy.** A policy row must exist with `fx_enabled = true` → else
   `FX_CLIENT_POLICY_MISSING` / `FX_NOT_ENABLED_FOR_CLIENT`.
4. **Reporting target.** `toCurrency` must equal `reporting_currency_code` (or be the transaction
   currency when reporting *out* of base) → else `FX_TARGET_NOT_GOVERNED`. FX-01 supports
   transaction ↔ reporting only.
5. **Window resolution.** Select the row where
   `status='ACTIVE' AND rate_type='REFERENCE' AND effective_from <= referenceDate AND
   (effective_to IS NULL OR effective_to > referenceDate)` for the ordered pair.
   - Ordered pair found → `direction: 'DIRECT'`.
   - Not found; reverse pair found **and** `inverse_permitted` → `direction: 'INVERSE'`.
   - Neither → `FX_PAIR_NOT_GOVERNED` (or `FX_RATE_NOT_EFFECTIVE` if rows exist for the pair but
     outside the window).
6. **Source permission.** `source = ANY(permitted_sources)` → else `FX_RATE_SOURCE_NOT_PERMITTED`.
7. **Staleness.** If `max_staleness_days` is set and `referenceDate - effective_from` exceeds it →
   `FX_RATE_STALE`.
8. **Multiplicity.** More than one candidate → `FX_RATE_AMBIGUOUS` (structurally prevented by the
   exclusion constraint; retained as a guard).

### Effective-date rules

- **The reference date is the monetary record's own business date** — `expense_date`,
  `cost_date`, bill/consumption `period_end`, PO/invoice date — **never `created_at` and never
  "today".** Rationale: a report must be reproducible years later; keying on `created_at` would
  make a re-run of the same historical report return different numbers.
- Windows are **closed-open `[effective_from, effective_to)`**, identical to `0278`.
- A rate may be created with a **future `effective_from`**. That is legitimate scheduling, not an
  error — selection simply cannot reach it until the window opens.

### Fallback behaviour

**There is no fallback.** Explicitly prohibited:

| Prohibited | Why |
|---|---|
| Latest-rate fallback ("use the most recent rate if the dated one is missing") | Silently re-states history; a corrected rate would retroactively change old reports |
| `1:1` assumption | Fabricates a rate. Explicitly forbidden |
| Client base/default substitution for an unknown currency | Repeats exactly the inference CUR-01 §2 (IDR assessment) prohibited |
| Cross/triangular routing via a third currency | §2/D-4 |
| Rounding to "close enough" | Rounding happens once, at the boundary, half-up |

---

## 7. Governed Conversion Service Boundary

**ONE authority:** `src/modules/fx-rates/` exporting `fxConversionService`.

```
fxConversionService.convert({ clientId, amount, fromCurrency, toCurrency,
                              referenceDate, purpose, actorUserId? })
  → { originalAmount, originalCurrency,
      convertedAmount, targetCurrency,
      rate, rateDirection: 'DIRECT' | 'INVERSE' | 'IDENTITY',
      fxRateId, rateBaseCurrency, rateQuoteCurrency,
      rateEffectiveFrom, rateSource, rateSourceReference,
      convertedAt, purpose }
  | throws one of the §14 fail-closed codes
```

**Frozen rules:**

1. `amount * rate` and `amount / rate` exist in **exactly one** function
   (`applyRate`) inside this module. PART 05 adds a static regression test asserting no other
   file under `src/` performs that arithmetic.
2. Every other module obtains a converted figure **only** through `convert()`. No module may read
   `fx_rates` directly for arithmetic purposes.
3. Decimal arithmetic only. No JS float multiplication of monetary values; no `toFixed` as a
   rounding mechanism (CUR-01 §F).
4. The service is **pure with respect to business records** — it never mutates a monetary row.
5. `IDENTITY` is returned by the service, not by callers, so that the "no rate needed" case is
   itself governed and cannot be hand-rolled per module.

**Conversion classes (this is what keeps audit clean):**

| Class | Definition | Persistence | Audit |
|---|---|---|---|
| **TRANSIENT** | Computed inside a read model, returned in the response, never stored | **None** | **None** — provenance is returned **inline in the payload**. Prevents unbounded audit/write amplification on every report render |
| **MATERIALIZED** | A converted amount is persisted or exported | `fx_conversions` ledger row (migration `0334`) | The ledger row **is** the audit record; no separate event is emitted |

FX-01's runtime surface (PART 04 reporting read models) is **TRANSIENT**. `0334` is therefore
**conditional** (§16) — it ships only if a PART introduces a persisted converted amount.

---

## 8. FX Snapshot (provenance contract)

Every converted result — transient or materialized — carries **all** of the following. A converted
amount without complete provenance is not a valid result and must not be returned.

| # | Field | Source |
|---|---|---|
| 1 | Original amount | The monetary record, unchanged |
| 2 | Original currency | The monetary record's `currency_code` snapshot, unchanged |
| 3 | Converted amount | Computed, rounded once half-up to target scale |
| 4 | Target currency | Resolved from Client FX policy |
| 5 | FX rate | `fx_rates.rate` **as stored**, copied — never re-read later |
| 6 | FX rate effective date/time | `fx_rates.effective_from` |
| 7 | Rate source | `fx_rates.source` (+ `source_reference`) |
| 8 | **Rate authority reference ID** | `fx_rates.id` — the single most important field: it makes the conversion permanently re-derivable |
| 9 | Conversion timestamp / purpose | `convertedAt`, `purpose` |
| 10 | Direction | `DIRECT` / `INVERSE` / `IDENTITY` (§11) |

**Immutability guarantee.** "Historical conversion must never silently change when the FX table
changes later" is satisfied structurally, not by discipline:

- Rate business columns are **immutable** (PART 01 trigger). A correction inserts a **new row** and
  marks the old `SUPERSEDED`.
- The snapshot stores `fx_rate_id`. Re-derivation therefore resolves **that exact rate row**, never
  "the currently active rate".
- Superseding or deactivating a rate **cannot** alter any previously produced converted amount.

---

## 9. Exact-currency boundary — operations that MUST NOT auto-convert

FX reporting **does not** authorize cross-currency transactional workflows. Every row below is a
verified fail-closed equality today and **must remain byte-identical** after FX-01.

| Authority | Verified exact-currency rule | FX-01 obligation |
|---|---|---|
| **RFQ** (`0313`) | `currency NOT NULL`, ACTIVE + Client-allowed | Unchanged. An RFQ's currency is never derived from FX |
| **Quotation revision** (`0315`) | must equal the RFQ currency | Unchanged |
| **Comparison / evidence price** (`0316`,`0320`) | `RFQ_COMPARISON_CURRENCY_INVALID` on mismatch | Unchanged. **No cross-currency bid comparison via FX** — comparing a USD bid to an IDR bid by converting one is a commercial act, not a report |
| **Award** (`0317`,`0318`) | **Verified: `0317` carries ZERO currency columns** — an award stores no currency of its own. The currency reaches the PO through `rfq-po-conversions`, which calls `assertActiveAllowedCurrency(rfq.clientId, quotation.currency)` and adopts the quotation currency verbatim (CUR-01 §D.3: *"an award does not convert or choose a new currency"*) | Unchanged |
| **PO** (`0269`) | `purchaseOrder.currency !== invoice.currency` → `CURRENCY_MISMATCH` | Unchanged |
| **RFQ→PO conversion** (`rfq-po-conversions`) | adopts `quotation.currency` verbatim | Unchanged |
| **Price Catalog** (`0319`/`0325`) | exact-match lookup; `currency` is part of the ACTIVE-overlap `EXCLUDE` key; `CURRENCY_INCOMPATIBLE` is an explicit absence reason | Unchanged. **FX must never make a differently-currencied price "compatible"** |
| **Budget** (`0283`) | `currency NOT NULL`; `operational_budgets_live_period_exclusion` | Unchanged |
| **Commitment** (`0311`/`0312`) | `currency` set once, never rewritten; `SUM(signed_amount) = open_amount` | Unchanged. **A converted amount must never enter the open-amount invariant** |
| **Invoice lineage** (`0261`, tenant invoices) | vendor: PO exact match; tenant: header = every line, fail closed | Unchanged |
| **Payments** (`invoice_payment_status`) | reuse `invoice.currency`; no own currency field | Unchanged. **No FX gain/loss on settlement** |
| **Material actualization** (`operational-commitment-material.service.ts:337`) | NULL or ≠ commitment currency → nothing actualized | Unchanged |
| **Vendor-invoice actualization** (`operational-commitment-vendor.service.ts:119`) | same | Unchanged |
| **Budget source binding** (`operational-finance-binding.service.ts:251`) | throws on mismatch | Unchanged |
| **Finance aggregation** (`operational-finance-aggregation.service.ts:133`) | `SOURCE_CURRENCY_MISMATCH` exclusion | Unchanged |
| **Operational variance** (`operational-variance.service.ts:127,228`) | `SOURCE_CURRENCY_MISMATCH`; `CURRENCYLESS_COST_AUTHORITY` gap | Unchanged. **FX must not "close" the B-02 gap by converting** |
| **Tenant invoice line aggregation** (`tenant-invoice.repository.ts:125,171`) | `SUM(amount_snapshot)` guarded by single-currency finalize check | Unchanged. **FX must not relax the finalize guard to permit mixed-currency invoices** |
| **Utility tariff → calculation → approval → bill** (`0278`/`0191`/`0279`/`0196`) | exact-equality inheritance chain | Unchanged |
| **Reporting export** (`reporting-export`) | currently **zero** monetary amounts and **zero** currency references | FX-01 adds **no** converted column to any export (CUR-01 EXP-01 boundary) |

**Standing rule:** FX-01 may only **add** a provenanced converted view beside these figures. It may
never relax, replace, or bypass an equality check above. PART 05 exists to prove this by regression
test.

---

## 10. Reporting currency

Three axes, explicitly separated:

| Axis | Meaning | FX-01 treatment |
|---|---|---|
| **Transaction currency** | The immutable `currency_code` snapshot on the record | Always returned, always first, never replaced |
| **Client base currency** | `client_monetary_contexts.base_currency_code` | Partition/default for grouping (CUR-01 §B) |
| **Reporting currency** | The conversion target for consolidated reads | `client_fx_policies.reporting_currency_code`, **required = base currency in FX-01** (§6) |

**Read-model contract (PART 04).** A converted report row returns:

```
{ originalAmount, originalCurrency,          // 1–2: always present, even when conversion failed
  convertedAmount | null,                    // 3: null when no governed rate exists
  reportingCurrency,                         // 4
  fx: { rate, direction, fxRateId, effectiveFrom, source, sourceReference } | null }
```

**Hard rules:**

1. **Never return a mixed-currency grand total without governed conversion.** Where any component
   row has `convertedAmount = null`, the reporting total is returned as **`null` plus an
   explicit `unconvertible` bucket** (`count`, and the per-currency original amounts), never a
   partial sum presented as a total.
2. Per-currency original totals are **always** returned alongside, so a reader can see exactly what
   was and was not converted. This extends — does not replace — the existing
   `getOperationalCurrencySummary` exact-currency shape.
3. **UNKNOWN is never converted and never counted as zero.** It stays in its own gap bucket,
   preserving CUR-02's historical-UNKNOWN data condition.
4. The integration point is the **existing, currently unwired** `currency-reporting` seam (§1.2),
   which FX-01 finally connects — no parallel reporting stack is created.

---

## 11. Reverse pair policy

**Decision: inverse derivation is PERMITTED, but opt-in per Client, and always recorded.**

**Why it must exist.** An IDR-base Client with `{IDR, USD, SGD, MYR, AUD, EUR, GBP, JPY, CNY}`
allowed would need **72 ordered pairs** fully stocked to convert freely, while a treasury publishes
perhaps 8. Requiring every ordered pair would make FX unusable in practice and would invite exactly
the informal hand-rolled `amount / rate` this CR exists to prevent.

**Why it must be governed.** The reciprocal of a *published, rounded* rate is not the published
reciprocal. `1/(16250.0000) = 0.0000615384615…` is a *derived* number with materially different
precision characteristics. Treating it as if it were a sourced rate would be a silent fabrication.

**Rules:**

1. `client_fx_policies.inverse_permitted` defaults to **`false`** → an unpermitted inverse fails
   closed with `FX_INVERSE_NOT_PERMITTED`.
2. An inverse is **never persisted as a rate row**. No `fx_rates` row is ever created from a
   reciprocal. The stored published rate remains the single source of truth.
3. Every inverse result records **`direction = 'INVERSE'`** together with the `fx_rate_id` of the
   **direct** published rate, plus `rateBaseCurrency` / `rateQuoteCurrency` so the reader can see
   that the stored pair is the reverse of the requested pair.
4. Arithmetic: exact decimal reciprocal with guard digits, rounded **once** at the target monetary
   scale. The reciprocal itself is never rounded into storage.
5. `IDENTITY` (same currency) is **not** an inverse and needs no permission.

**Silent inversion is prohibited.** If a caller requests `USD → IDR` and only `IDR → USD` exists,
and the Client has not permitted inverse, the answer is an error — not a quietly flipped number.

---

## 12. Missing rate — fail-closed taxonomy

**No rate = no converted amount. Never assume 1:1.** Every case below returns `convertedAmount:
null` with a machine-readable reason, and never a fabricated figure.

| Case | Error code | Behaviour |
|---|---|---|
| No rate row for either ordering of the pair | `FX_PAIR_NOT_GOVERNED` | Fail closed |
| Rate exists for the pair but no window covers the reference date | `FX_RATE_NOT_EFFECTIVE` | Fail closed; response names the nearest available windows for diagnosis |
| Only non-`ACTIVE` rates exist (`PENDING_APPROVAL`, `REJECTED`, `SUPERSEDED`, `INACTIVE`) | `FX_RATE_INACTIVE` | Fail closed. **An unapproved rate is never usable**, even if it is the only one |
| Only **future-dated** rates exist (`effective_from > referenceDate`) | `FX_RATE_FUTURE_ONLY` | Fail closed. A rate that has not started cannot price the past |
| More than one ACTIVE candidate | `FX_RATE_AMBIGUOUS` | Fail closed (structurally prevented by the `EXCLUDE` constraint; guard retained) |
| No Client policy row, or `fx_enabled = false` | `FX_CLIENT_POLICY_MISSING` / `FX_NOT_ENABLED_FOR_CLIENT` | Fail closed. Absence of policy is not permission |
| Rate source not in `permitted_sources` | `FX_RATE_SOURCE_NOT_PERMITTED` | Fail closed |
| Rate older than `max_staleness_days` | `FX_RATE_STALE` | Fail closed |
| Either currency leg missing or `INACTIVE` in the master | `FX_CURRENCY_INACTIVE_OR_UNKNOWN` | Fail closed |
| Reverse pair exists but inverse not permitted | `FX_INVERSE_NOT_PERMITTED` | Fail closed |
| Target is not the governed reporting currency | `FX_TARGET_NOT_GOVERNED` | Fail closed |
| **Historical UNKNOWN (`NULL`) currency** | `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` | **Never converted.** Not IDR, not base, not zero, not 1:1 — CUR-01 §2 IDR assessment and CUR-02 historical-UNKNOWN policy remain binding |

All codes are registered in `src/shared/errors.ts` `ERROR_CODES` following the CUR-01/02 pattern
(lines 1797–1810 today), returned as HTTP 400/422 via `AppError`, never as an unhandled 500.

---

## 13. Provider boundary

**Provider-neutral by construction. FX-01 implements NO provider.**

| Element | FX-01 decision |
|---|---|
| Canonical authority | `fx_rates` — the **only** table any consumer reads |
| Ingestion | **Not implemented.** No HTTP client, no scheduler job, no credential, no env key is added by FX-01 |
| Discriminator | `fx_rates.source` — a governed `TEXT` + `CHECK`. FX-01 ships exactly **`MANUAL_TREASURY`** |
| Provenance slot | `source_reference` (rate-sheet / bulletin reference) + `ingested_at`, both present from PART 01 so a future provider needs **no schema change** |
| Precedent | `src/shared/provider-result.ts` and the `EMAIL_PROVIDER` / `WHATSAPP_PROVIDER` discriminator pattern |

**The provider boundary rule (frozen):**

> **A provider may PROPOSE, never ACTIVATE.** Any ingested rate must enter as
> `PENDING_APPROVAL` and requires a human approval by a different user to reach `ACTIVE`.
> No automated path may write `status='ACTIVE'`.

This single rule is what keeps ingestion separable from authority: adding Bank Indonesia, an ERP
feed, or an external FX API later means adding one `source` enum value and one adapter that writes
`PENDING_APPROVAL` rows — **zero** change to selection, conversion, snapshot, or audit.

| Future provider | Route into the canonical authority |
|---|---|
| Bank Indonesia / JISDOR | adapter → `source='BANK_INDONESIA'`, `PENDING_APPROVAL` |
| Treasury / manual rate | **`MANUAL_TREASURY` — shipped in FX-01** |
| ERP / accounting source | adapter → new `source` value, `PENDING_APPROVAL` |
| External FX API | adapter → new `source` value, `PENDING_APPROVAL` |

Storing raw provider payloads is a **separate concern** (an `fx_rate_observations` staging table)
and is **explicitly deferred** — FX-01 does not create it.

---

## 14. Audit

### 14.1 Rate lifecycle — `fx_rate_events` (new, append-only)

| Event | Emitted when |
|---|---|
| `FX_RATE_CREATED` | a rate is entered as `PENDING_APPROVAL` |
| `FX_RATE_APPROVED` | `PENDING_APPROVAL` → `ACTIVE` (maker ≠ checker enforced) |
| `FX_RATE_REJECTED` | `PENDING_APPROVAL` → `REJECTED` |
| `FX_RATE_SUPERSEDED` | a correction supersedes an ACTIVE rate |
| `FX_RATE_DEACTIVATED` | `ACTIVE` → `INACTIVE` (withdrawn without replacement) |

**Why a new ledger rather than `recordOperationalEvent`:** `operational_events.client_id` is
`NOT NULL` (verified, `0080`) and `entity_id` is `NOT NULL`. A platform-global rate has no owning
Client. The alternatives were both rejected: relaxing a shared `NOT NULL` used by every module in
the platform (destructive, out of scope), or fabricating a Client attribution (dishonest audit).

### 14.2 Client FX policy — reuse `recordOperationalEvent`

Policy **is** Client-scoped, so `recordOperationalEvent({clientId, ...})` is used directly — the
same authority CUR-01 used for `CLIENT_MONETARY_CONTEXT_SET`:

- `CLIENT_FX_POLICY_SET` / `CLIENT_FX_POLICY_CHANGED` (metadata: enabled flag, reporting currency,
  permitted sources, inverse flag, staleness bound).

### 14.3 Conversion — deliberately **not** an audit event

> *"Avoid generating excessive audit noise for read-only reporting conversions."*

- **TRANSIENT** read-model conversions emit **no** audit event and write **no** row. Their
  provenance travels **inline in the response** (§10). A single management dashboard render could
  otherwise emit thousands of audit rows.
- **MATERIALIZED** conversions are audited by the **`fx_conversions` ledger row itself** — the
  record is the audit. No duplicate event is emitted.
- **No** audit event is emitted for a *failed* conversion in a read path. Failures are surfaced in
  the response's `unconvertible` bucket, which is itself the observable record.

---

## 15. Security, isolation, RBAC

### Client isolation

| Data | Scope | Enforcement |
|---|---|---|
| `fx_rates`, `fx_rate_events` | **Platform-global.** Contain no Client data | Reads gated by `fx_rate.read`; no Client data can leak because none is stored |
| `client_fx_policies` | **Client-scoped** | `contextAccessService.canAccessClient(userId, clientId)` — the same authority `client-monetary-contexts` already uses |
| Converted read models | Client/Building-scoped | Existing `contextAccessService.assertBuildingAccess` / `canAccessClient`, unchanged |

A user who can read the global rate table learns a market fact, never another Client's policy or
balances. Conversely, reading a Client's converted report never exposes rate-maintenance authority.

### RBAC — permission codes (no new roles)

Added to `FOUNDATION_PERMISSIONS` following the verified `snake_case.action` convention:

| Code | Name | Default grant |
|---|---|---|
| `fx_rate.read` | Read FX Rates | PLATFORM_ADMIN |
| `fx_rate.manage` | Manage FX Rates (Maker — propose) | PLATFORM_ADMIN |
| **`fx_rate.approve`** | Approve / Supersede / Deactivate FX Rates (Checker) | **NONE — `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`** |
| `fx_policy.read` | Read Client FX Policy | PLATFORM_ADMIN |
| **`fx_policy.manage`** | Manage Client FX Policy | PLATFORM_ADMIN |

- **`fx_rate.approve` is withheld from PLATFORM_ADMIN**, exactly as `price_catalog.override`,
  `operational_budget.override` and `rfq.award` are today. Setting an exchange rate silently
  re-states every converted figure in the platform; it is an exceptional financial authority that
  must be a deliberate administrative act.
- **Dedicated `fx_policy.*` rather than reusing `client_configuration.manage`**, on the explicit
  precedent of `integration_webhook.*`: reusing a generic configuration code would let any config
  editor switch a Client's conversion behaviour, permitted sources, and inverse rights.
- **No new role is invented.** All five codes attach to the existing `PLATFORM_ADMIN` role and are
  assignable to any existing Client role through the normal role/permission administration surface.

### Maker-checker for manual rates

| Rule | Enforcement layer |
|---|---|
| `approved_by_user_id` required whenever `status='ACTIVE'` | DB CHECK + service |
| `approved_by_user_id <> created_by_user_id` | **DB CHECK** (structural, cannot be bypassed by application code) + service |
| `approved_at` required with the approver | DB CHECK |
| Approver must hold `fx_rate.approve` | `requirePermission('fx_rate.approve')` on the approve/supersede/deactivate routes |
| Maker holds only `fx_rate.manage` | Route-level separation; a maker-only caller receives 403 on approval |
| Self-approval | Impossible: the CHECK rejects the row regardless of caller |
| Every transition | `fx_rate_events` row in the **same transaction** |

Note: this is the repository's **first** structurally-enforced maker-checker. Verified: no
migration anywhere contains a `<>/!= created_by` style segregation CHECK, and the closest existing
control is `permit-approvals/permit-approval.authority.ts:51`
(`approval.approverUserId === actorUserId`), which is an **assigned-approver identity** check — it
verifies *who was nominated*, not that the approver differs from the maker. Procurement and
document approvals have no equivalent control at all. FX establishes segregation at the DB level
because a rate is platform-global in blast radius; it does not retro-fit other domains.

### Who may do what

| Action | Requires |
|---|---|
| Read rates | `fx_rate.read` |
| Propose a rate (maker) | `fx_rate.manage` |
| Approve / supersede / deactivate (checker) | `fx_rate.approve` |
| Read a Client's FX policy | `fx_policy.read` + Client access |
| Set/change a Client's FX policy | `fx_policy.manage` + Client access |
| Obtain a converted figure | Existing read permission of the underlying report — **no separate FX read permission**, so FX cannot become a way to reach data a caller could not already read |

---

## 16. Migration strategy

**Registry inspected:** 332 migrations, highest `0332_add_operational_billing_currency_snapshots`.
**`0333` is the next free number and is NOT consumed by this record.**

| Migration | Content | PART | Status |
|---|---|---|---|
| **`0333_create_fx_rate_authority_and_client_fx_policy`** | `fx_rates` + all CHECKs, immutability trigger, `btree_gist` window-exclusion constraint, lookup index; `fx_rate_events`; `client_fx_policies` + validation trigger | PART 01 | **Required** |
| `0334_create_fx_conversion_ledger` | `fx_conversions` append-only ledger | PART 03 | **Conditional** — created only if a PART actually materializes a converted amount |

**Why one migration, not three.** `0331` established the precedent of shipping a cohesive monetary
authority (`currencies` + `client_monetary_contexts` + `client_allowed_transaction_currencies`) in
a single migration. Splitting `fx_rates` from `client_fx_policies` would create an intermediate
state in which rates exist but no Client can use them — a deployable-but-dead schema. A rate cannot
be selected without a policy, so they ship together.

**Explicitly NOT in any FX-01 migration:**

- No backfill, no `UPDATE` of any existing table.
- No new column on any monetary table (no `converted_amount`, no `fx_rate_id` on
  `purchase_orders`, `vendor_invoices`, `tenant_invoices`, …).
- No `NOT NULL` / `DEFAULT` added to any historical column.
- No relaxation of the legacy nine-code `CHECK` constraints.
- No change to `operational_events`, `authentication_audit_events`, or `currencies`.
- No `NUMERIC` re-scaling.

---

## 17. OpenAPI strategy

**Verified today:** `docs/api/openapi.yaml` (46,532 lines) contains **no** FX path or schema. The
`PriceCatalogCurrency` schema (line 45741) documents its enum as *"Exact-match currency vocabulary;
no FX conversion exists anywhere in the price-authority domain."* Currency Master, Client Monetary
Context and `currency-reporting` have **no HTTP routes at all** (§1.2).

**Rule: document only what FX-01 actually ships. Invent nothing.**

| Surface | PART | Justification |
|---|---|---|
| `GET /fx-rates` (filter: pair, type, window, status, source) | PART 02 | A maker-checker rate authority is unusable without a list/read surface |
| `GET /fx-rates/{id}` | PART 02 | Provenance lookup for `fxRateId` references |
| `POST /fx-rates` | PART 02 | Maker entry (`MANUAL_TREASURY`) |
| `POST /fx-rates/{id}/approve` | PART 02 | Checker approval |
| `POST /fx-rates/{id}/reject` | PART 02 | Checker rejection |
| `POST /fx-rates/{id}/supersede` | PART 02 | Correction lineage |
| `POST /fx-rates/{id}/deactivate` | PART 02 | Withdrawal |
| `GET /clients/{clientId}/fx-policy`, `PUT /clients/{clientId}/fx-policy` | PART 02 | Client policy administration |
| `GET /fx-rates/resolve?base&quote&date` | PART 04 | Lets a UI display *which* rate it used — the provenance requirement is unusable otherwise |
| Existing currency/finance summary read models | PART 04 | Extended **in place** with the §10 contract; no parallel reporting path |

**Deliberately NOT added to OpenAPI:**

- Currency Master / Client Monetary Context routes — **still non-existent at runtime.** Recorded as
  pre-existing whole-API documentation debt, consistent with the CUR-02 PART 06 finding. FX-01 does
  not fabricate them.
- Provider ingestion endpoints — no provider exists (§13).
- Export/report converted columns — prohibited by §9.

---

## 18. PART breakdown

| PART | Title | Deliverables | Migration |
|---|---|---|---|
| **01** | **FX Rate Authority & Data Model** | `0333`; `src/modules/fx-rates/` types, validation, repository; `NUMERIC(24,12)` rate; window-exclusion constraint; immutability trigger; rate + policy read repository. **No HTTP surface** | `0333` |
| **02** | **FX Rate Lifecycle, Client FX Policy & Governance** | `PENDING_APPROVAL → ACTIVE/REJECTED`, supersession, deactivation; DB-level maker-checker CHECKs; `fx_rate_events`; 5 permission codes (+ `fx_rate.approve` in `UNASSIGNED_BY_DEFAULT`); routes; policy command surface | none |
| **03** | **Governed Conversion Service** | `fxConversionService` as the single arithmetic authority; full §6 selection policy; §12 fail-closed taxonomy in `ERROR_CODES`; governed `INVERSE`; `IDENTITY`; decimal half-up rounding | `0334` **only if** materialization is required |
| **04** | **Reporting Currency Integration** | Wire the currently-unwired `currency-reporting` seam; §10 read-model contract (original + converted + inline provenance); `null` total + `unconvertible` bucket instead of a mixed-currency total; `GET /fx-rates/resolve` | none |
| **05** | **Cross-Module FX Safety & Audit** | Regression tests proving every §9 boundary is unchanged; static test forbidding `* rate` / `/ rate` outside `fx-rates`; UNKNOWN-never-converted tests; tenant-invoice mixed-currency guard still fail-closed; conversion-audit noise test | none |
| **06** | **OpenAPI + Closure** | Document exactly the shipped §17 surfaces; governance closure, final review, readiness record | none |

**Adjustment vs. the proposed breakdown:** Client FX Policy moved from PART 03 into **PART 02**,
because the policy is governance (maker-checker, permissions, permitted sources) rather than
conversion mechanics, and PART 03 is cleaner as the single-arithmetic-authority PART. Count stays
at 6. No further adjustment — repository evidence supports the proposed shape.

---

## 19. Non-goals (binding)

FX-01 must **not** become any of the following. Each requires its own CR:

- Treasury management · Hedging · Forex trading · Bank reconciliation
- GL revaluation · Realized/unrealized FX accounting (verified: no GL/journal exists)
- Payment gateway · Automatic repricing
- **Automatic PO / invoice / RFQ / quotation currency conversion**
- Mixed-currency document headers or mixed-currency invoice totals
- Triangular / multi-leg cross rates (§2/D-4)
- Intraday rates, bid/ask spreads, provider margin/fee modelling, rate forecasting
- Provider integration of any kind (§13)
- Historical backfill, rewrite, or destructive normalization (§20)
- Any change to the Currency Master's nine seeded codes or to legacy nine-code `CHECK`s

---

## 20. Historical compatibility

1. **No backfill.** No `UPDATE` touches any existing row.
2. **No historical transaction rewrite.** Every persisted `amount` / `currency_code` snapshot is
   read-only with respect to FX-01.
3. **No destructive normalization.** Legacy nine-code `CHECK` constraints stay. Legacy
   unconstrained `NUMERIC` columns stay. `currencies` is untouched.
4. **Historical UNKNOWN stays UNKNOWN.** A `NULL` `currency_code` row (pre-CUR-02 vendor service
   cost, basic expense, tenant charge/invoice, work-order material usage, legacy utility) is
   **never** converted, never assumed IDR, never assumed base, never counted as zero. It remains
   readable, countable, excluded from currency-dependent arithmetic, and gap-surfaced —
   exactly as CUR-02 closed it.
5. **CUR-02's residual data condition is unchanged.** *"Historical UNKNOWN population not measured
   in this environment"* remains the accurate statement; FX-01 does not measure or resolve it.

---

## 21. Risks and blockers

| ID | Risk / blocker | Severity | Mitigation |
|---|---|---|---|
| R-01 | **Rate precision choice is irreversible.** `NUMERIC(24,12)` is a judgement call; too coarse loses fidelity on directly-published small rates, too wide invites unreviewed input | High | Convention frozen at `1 BASE = RATE × QUOTE` so the *large* direction is the stored one; `CHECK (rate > 0)`; PART 01 tests both an IDR-quote and a small-quote rate |
| R-02 | **Precision loss on the inverse path.** A reciprocal of a rounded published rate is a derived number | Medium | Inverse is opt-in per Client, always labelled `INVERSE`, never persisted as a rate, rounded once at the boundary |
| R-03 | **`operational_events.client_id NOT NULL` blocks platform-global audit** | Resolved | Dedicated `fx_rate_events` ledger; no shared table relaxed |
| R-04 | **Audit/write amplification** if every report render logs a conversion | Medium | TRANSIENT vs MATERIALIZED split (§7); read conversions emit nothing |
| R-05 | **Informal arithmetic creep.** A module quietly writing `amount * rate` would defeat the whole design | High | Single-authority rule + PART 05 static regression test |
| R-06 | **FX silently "fixing" an exact-currency failure** — e.g. converting to close a `CURRENCY_MISMATCH` or the B-02 gap | High | §9 standing rule; PART 05 regression tests assert every existing mismatch still fails |
| R-07 | **Mixed-currency total leak** in a reporting read model | High | §10 hard rule: `null` total + `unconvertible` bucket, never a partial sum |
| R-08 | **`reporting_currency_code` diverging from base** creates a second conversion target | Medium | Trigger-enforced equality in FX-01; decoupling requires its own CR |
| R-09 | **Validation limits of this environment** | Recorded | No `node_modules`, no PostgreSQL, no dependency install permitted. No typecheck, test, or migration could be executed for this record |
| B-01 | **Blocker: none.** CUR-02 is MERGED at baseline; B-02 is CLOSED — CODE-CONTROLLABLE; the Currency Master, Client Monetary Context, command-time authority, and exact-currency read seam all exist | — | FX-01 is **UNBLOCKED** |
| B-02 | **Open decision for PART 01 review:** whether `0334` (conversion ledger) is ever needed, i.e. whether FX-01 materializes any converted amount at all | Low | Default answer is **no** — FX-01's runtime surface is read-side reporting. `0334` stays unconsumed unless a PART proves otherwise |

---

## 22. PART 01 readiness

**PART 01 — FX Rate Authority & Data Model: READY TO START.**

Ready because every dependency is verified present at baseline `a5ae3b0`:

- ✅ Currency Master (`currencies`, `0331`) exists with ACTIVE/INACTIVE and `decimal_precision`
- ✅ Client Monetary Context + allowed currencies (`0331`) exist
- ✅ Command-time currency authority (`assertActiveAllowedCurrency*`) exists with 12 consumers
- ✅ Exact-currency read seam (`currency-reporting`) exists, awaiting PART 04
- ✅ Non-overlapping-window pattern proven by `0278` (`btree_gist` + `EXCLUDE USING gist`)
- ✅ Immutability-trigger pattern proven by `0331` (`prevent_currency_code_change`)
- ✅ Append-only ledger pattern proven by `0312` / `vendor_invoice_history`
- ✅ Permission catalogue + `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` pattern proven
- ✅ Migration number `0333` free
- ✅ Zero conflicting FX code anywhere in `src/` or `docs/api/openapi.yaml`

**PART 01 scope (exactly this, no more):**

1. Migration `0333_create_fx_rate_authority_and_client_fx_policy` (`up` + down-safe `down`).
2. `src/modules/fx-rates/` — `fx-rate.types.ts`, `fx-rate.validation.ts`, `fx-rate.repository.ts`,
   `fx-rate.errors.ts`, `index.ts`.
3. Read/insert repository over `fx_rates` and `client_fx_policies`.
4. Rate + policy read models. **No HTTP routes, no lifecycle transitions, no conversion.**

**Explicitly deferred:** lifecycle state machine and maker-checker (PART 02), conversion service
(PART 03), reporting integration (PART 04), cross-module safety tests (PART 05), OpenAPI (PART 06).

**PART 01 acceptance criteria:**

- A rate cannot be inserted with `base = quote`, `rate <= 0`, or an overlapping ACTIVE window.
- A rate's business columns cannot be updated (trigger rejects); `status` can.
- `client_fx_policies.reporting_currency_code` must be ACTIVE and Client-allowed (trigger).
- `down()` fully reverses `up()` with no residue.
- No existing table is altered. `git diff` touches only the new migration, its registry entry, and
  the new module directory.

---

## 23. Validation performed for this governance record

**Actually run:**

- `git fetch origin main` + `git rev-parse HEAD` / `git rev-parse origin/main` → both
  `a5ae3b03365e07fb6b08e99c3894d1ca51b0fad2`; `git rev-list --count HEAD..origin/main` → `0`.
- Structural inspection of the migration registry, currency/monetary/procurement/budget/commitment/
  invoice/utility/tenant/reporting/audit modules, RBAC middleware and permission seed, OpenAPI
  contract, and `.env.example`.
- `git diff --check` → **PASS** (recorded in the closure note below).

**NOT run (recorded, never reported as passing):**

- `npm run typecheck` — `node_modules` absent; dependency installation prohibited by this record.
- `npm test` / any focused FX test — requires PostgreSQL provisioning and dependencies; prohibited.
- Migration execution — no database provisioned; no migration number consumed.
- CI, PR, merge — all prohibited by this record.

Unavailable local tooling is not an implementation failure, and no check is claimed that was not
executed.

---

## PART 01 implementation notes (2026-08-25)

**Status: PART 01 COMPLETE.** Baseline for this PART: `018dc54` (this governance record).

### Migration

`0333_create_fx_rate_authority_and_client_fx_policy` — created and registered in
`src/database/migrations/index.ts` (registry now 333 migrations = 333 files). **`0334` was NOT
created**; the conversion ledger stays unconsumed. No backfill, no monetary-table rewrite, no
historical currency rewrite.

Verified additive-only: `git diff --stat` on pre-existing files shows `2 files changed, 24
insertions(+)` and **0 deletions** — the registry import + array entry, and 16 new `ERROR_CODES`.
No existing table, route, OpenAPI path or dependency was altered.

### Tables / model

| Table | Scope | Purpose |
|---|---|---|
| `fx_rates` | platform-global | The canonical rate authority. 25 columns: identity, `NUMERIC(24,12)` rate, closed-open window, status, source + provenance (`source_reference`, `ingested_at`), supersession lineage (`supersedes_rate_id`, `superseded_by_rate_id`), maker, and separate approved/rejected/superseded/deactivated attribution + timestamps |
| `fx_rate_events` | platform-global | Append-only rate audit ledger. **No `client_id`**, because `operational_events.client_id` is `NOT NULL` (`0080`) and a platform-global rate has no owning Client. `operational_events` was **not** weakened |
| `client_fx_policies` | Client-scoped | `client_id` PK, `fx_enabled`, `reporting_currency_code`, `permitted_sources TEXT[]`, `inverse_permitted`, `max_staleness_days`, attribution/timestamps. **No Building override** |

The Currency Master is **referenced, never duplicated**: both legs are
`VARCHAR(3) NOT NULL REFERENCES currencies (code)`.

### Canonical convention (frozen, unchanged)

**`1 BASE = RATE × QUOTE`** — `rate` is quote units per one base unit
(`USD`/`IDR`/`16500` ⇒ `1 USD = 16 500 IDR`). Multiplication is the only primitive; no second
convention was introduced. The convention is asserted by test against the module source, and the
tests additionally assert that **no file in `src/modules/fx-rates/` contains `amount * rate` or
`amount / rate`** — PART 01 converts nothing.

### Constraints

- `fx_rates_rate_positive_check CHECK (rate > 0)`
- `fx_rates_pair_distinct_check CHECK (base_currency_code <> quote_currency_code)`
- `fx_rates_rate_type_check CHECK (rate_type IN ('REFERENCE'))` — SPOT/DAILY/MONTH_END/ACCOUNTING/
  CONTRACTUAL are all rejected
- `fx_rates_source_check CHECK (source IN ('MANUAL_TREASURY'))` — no provider ingestion
- `fx_rates_status_check` over the five governed statuses
- `fx_rates_window_order_check CHECK (effective_to IS NULL OR effective_to > effective_from)`
- `fx_rates_maker_checker_check CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id)`
  — self-approval is structurally impossible
- Lifecycle-shape CHECKs: approval / rejection / supersession / deactivation metadata is present
  exactly when its status requires it; `ACTIVE` requires an approver; `SUPERSEDED` requires a
  successor; `PENDING_APPROVAL` carries no governance outcome
- `fx_rates_no_self_lineage_check`; unique partial indexes on both lineage columns so a rate can
  never be superseded twice
- `client_fx_policies`: `permitted_sources <@ ARRAY['MANUAL_TREASURY']`, no NULL array element,
  `max_staleness_days > 0` when set

### Lifecycle foundation (PART 01 = model + invariants only)

`PENDING_APPROVAL → ACTIVE | REJECTED`, `ACTIVE → SUPERSEDED | INACTIVE`, and
`REJECTED`/`SUPERSEDED`/`INACTIVE` are terminal. Enforced twice: as data in
`FX_RATE_TRANSITIONS` (shared by DB and future service guards) and by the
`fx_rates_enforce_immutability()` trigger. **No lifecycle command, route or RBAC surface was
implemented** — those are PART 02.

### Immutability

`fx_rates_enforce_immutability()` (BEFORE UPDATE) rejects any change to `id`, both currency legs,
`rate`, `rate_type`, `effective_from`, `effective_to`, `source`, `source_reference`,
`ingested_at`, `supersedes_rate_id`, `created_by_user_id` and `created_at`; it also rejects any
re-attribution of an already-recorded approval, rejection, supersession or deactivation. Only
`status` and the governance-attribution fields may move. **Corrections are supersession, never
rewriting** — the same mechanism as `prevent_currency_code_change()` (`0331`).

### Effective-window behavior

Closed-open `[effective_from, effective_to)`; `effective_to IS NULL` means still open. Ambiguity
is **structurally impossible**: `fx_rates_active_window_exclusion` reuses the `0278` pattern
(`CREATE EXTENSION IF NOT EXISTS btree_gist` + `EXCLUDE USING gist` over
`base_currency_code`, `quote_currency_code`, `rate_type` and
`tstzrange(effective_from, effective_to, '[)') WITH &&`) with `WHERE (status = 'ACTIVE')`. Only
ACTIVE rows are constrained, so pending proposals and different pairs/windows coexist. A future
`effective_from` is accepted (scheduling is not an error). **No latest-rate fallback exists
anywhere in this PART.**

### Client FX policy

Fail closed on three axes: no policy row means no FX; `fx_enabled` and `inverse_permitted` both
default `FALSE`; an empty `permitted_sources` permits nothing. The deferred constraint trigger
`client_fx_policy_valid` (same shape as `validate_client_monetary_context`, `0331`) requires the
reporting currency to be **ACTIVE**, **Client-allowed**, and **equal to the Client base currency** —
so FX-01 cannot grow a second reporting axis. Only the repository persistence primitive exists; the
governed command surface (Client access check, `CLIENT_FX_POLICY_SET` / `CLIENT_FX_POLICY_CHANGED`
operational events, RBAC, HTTP) is PART 02.

### Domain layer

`src/modules/fx-rates/` — `fx-rate.types.ts`, `fx-rate.validation.ts`, `fx-rate.errors.ts`,
`fx-rate.repository.ts`, `index.ts`. Validation is pure and float-free: rate literals are inspected
as decimal strings (exponent notation, separators and non-finite values rejected; leading zeros do
not consume `NUMERIC(24,12)` capacity) so a JS float can never smuggle a value the database would
round differently. 16 new `ERROR_CODES` were registered — **only those PART 01 can actually
raise**; the §12 missing-rate taxonomy is deliberately deferred to PART 03.

### Historical compatibility

Migration 0333 contains **no** `UPDATE`, `DELETE` or `TRUNCATE`, and its executable SQL references
**no** monetary authority (`vendor_service_costs`, `basic_expenses`, `tenant_charges`,
`tenant_invoices`, `tenant_invoice_lines`, `vendor_invoices`, `purchase_orders`,
`price_catalog_entries`, `operational_budgets`, `operational_commitments`,
`operational_commitment_entries`, `utility_bills`, `utility_calculations`,
`utility_calculation_bases`, `inventory_work_order_material_usages`) — asserted by test against the
migration source with comments stripped. No converted-amount or `fx_rate_id` column was added to
any monetary table. Historical `NULL`/UNKNOWN currency stays UNKNOWN and is **not** convertible;
nothing in this PART makes it convertible.

### Validation actually run

- `tests/fx01-part01-fx-rate-domain.test.ts` — **34 tests, 34 pass, 0 fail, 0 skipped**, executed
  against the real shipped modules (`fx-rate.types.ts`, `fx-rate.validation.ts`) and the real
  migration source. Coverage: canonical convention frozen and no arithmetic present;
  `NUMERIC(24,12)`; valid distinct BASE/QUOTE pair; `BASE = QUOTE` rejection; malformed currency
  codes; `rate > 0` (zero, negative, `0.000000000000`); float/exponent/separator rejection; the
  12+12 digit capacity in both directions; float-free digit inspection; `REFERENCE` only;
  `MANUAL_TREASURY` only; the five statuses; every legal and illegal lifecycle transition including
  resurrection from terminal; the five audit event types; closed-open window validity, future
  `effectiveFrom`, equal/inverted/unparseable bounds; policy inverse and `fx_enabled` defaulting;
  permitted-source de-duplication and rejection; empty permitted set; staleness bounds; and the
  historical-compatibility assertions above.
- `tests/fx01-part01-fx-rate-authority.test.ts` — **27 tests across 6 suites load and register
  cleanly; all 27 SKIPPED** (see NOT RUN). Verified free of parse/structure errors.
- `git diff --check` — **PASS** (working tree, staged, and `a5ae3b0..HEAD`).

### Validation NOT RUN (recorded, never claimed as passing)

- `npm run typecheck` — **NOT RUN.** `node_modules` is absent, no `tsc` exists anywhere on this
  system (`find / -name tsc -type f` returned nothing), and dependency installation is prohibited by
  this PART's instructions. Type errors are therefore **not** machine-verified; the new files were
  hand-reviewed against `tsconfig.json` (`strict`, `lib: ["ES2022"]`, `types: ["node"]`) instead.
- `tests/fx01-part01-fx-rate-authority.test.ts` — **NOT RUN.** PostgreSQL is not provisioned and
  provisioning is prohibited, so every test skipped. The database-enforced invariants it covers
  (Currency Master FK `23503`, CHECK violations `23514`, GiST exclusion `23P01`, the immutability
  and append-only triggers, the deferred policy trigger, `migrateDown`/`migrateUp` reversibility,
  and the "no monetary table gained a converted-amount column" introspection) are **unexecuted**.
- No dependency install, no `npm ci`, no broad regression, no CI, no migration execution.

To execute the skipped suite later: provision PostgreSQL with `DB_NAME=asentra_test` and run
`npm test`. `tests/fx01-part01-fx-rate-domain.test.ts` needs no database and runs anywhere.

### PART 02 readiness

**PART 02 — FX Rate Lifecycle, Client FX Policy & Governance: READY TO START.**

Available to PART 02 without further schema work: the full status vocabulary and transition table,
the maker-checker CHECK, the immutability/terminal guards, `fx_rate_events` (append-only, five event
types), and the `client_fx_policies` persistence primitive.

PART 02 must supply: the approve / reject / supersede / deactivate commands; emission of the five
`fx_rate_events` rows in the same transaction as each transition; the Client policy command surface
with `contextAccessService.canAccessClient` and `CLIENT_FX_POLICY_SET` / `CLIENT_FX_POLICY_CHANGED`
via `recordOperationalEvent`; the five permission codes (`fx_rate.read`, `fx_rate.manage`,
`fx_rate.approve`, `fx_policy.read`, `fx_policy.manage`) with **`fx_rate.approve` in
`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`**; the HTTP routes; and OpenAPI. **No new migration is
expected for PART 02.**

Open item carried forward: PART 02 should decide whether `rejected_by_user_id`,
`superseded_by_user_id` and `deactivated_by_user_id` also need maker-checker segregation. PART 01
enforces segregation **only on `approved_by_user_id`**, exactly as §15 froze, leaving the other
three to PART 02's `requirePermission('fx_rate.approve')` authority boundary rather than inventing
an unfrozen DB constraint.

---

## PART 02 implementation notes (2026-08-25)

**Status: PART 02 COMPLETE.** Baseline for this PART: `4ac5631` (PART 01).

### Migration decision — NO MIGRATION

**No migration was created. `0333` remains the highest migration and `0334` was not consumed.**
The PART 01 schema proved sufficient for the whole PART 02 surface: the status column, the
approved/rejected/superseded/deactivated attribution columns, both lineage columns, the
immutability and lifecycle triggers, the maker-checker CHECK, the GiST window exclusion and the
`fx_rate_events` ledger all already existed. No blocker required reporting.

### Lifecycle commands

`src/modules/fx-rates/fx-rate-lifecycle.service.ts`, each command one transaction:

| Command | Transition | Authority | Event |
|---|---|---|---|
| `createRate` | → `PENDING_APPROVAL` | `fx_rate.manage` | `FX_RATE_CREATED` |
| `approveRate` | `PENDING_APPROVAL` → `ACTIVE` | `fx_rate.approve` | `FX_RATE_APPROVED` |
| `rejectRate` | `PENDING_APPROVAL` → `REJECTED` | `fx_rate.approve` | `FX_RATE_REJECTED` |
| `supersedeRate` | `ACTIVE` → `SUPERSEDED` + new `ACTIVE` successor | `fx_rate.approve` | `FX_RATE_CREATED` (successor) + `FX_RATE_SUPERSEDED` (incumbent) |
| `deactivateRate` | `ACTIVE` → `INACTIVE` | `fx_rate.approve` | `FX_RATE_DEACTIVATED` |

Every transition is applied with an `expectedStatus` predicate (`WHERE id = $1 AND status = $4`),
so a concurrent transition can never be silently overwritten; a missed row raises
`FX_RATE_INVALID_STATUS_TRANSITION`. `REJECTED`, `SUPERSEDED` and `INACTIVE` are terminal —
revival is rejected at the service and again by the PART 01 trigger. **No stored rate value is ever
modified**: a test asserts that no `UPDATE fx_rates` statement in the module assigns the `rate`
column or either currency leg or the window.

### Event-name discrepancy — resolved without a migration

The PART 02 instruction asked for `FX_RATE_ACTIVATED`. **That name does not exist in the frozen
model**: the PART 01 `fx_rate_events_event_type_check` constraint permits only `FX_RATE_CREATED`,
`FX_RATE_APPROVED`, `FX_RATE_REJECTED`, `FX_RATE_SUPERSEDED`, `FX_RATE_DEACTIVATED`, and governance
§14.1 names the `PENDING_APPROVAL → ACTIVE` event `FX_RATE_APPROVED`. Emitting
`FX_RATE_ACTIVATED` would have violated the CHECK and required widening it — i.e. consuming a
migration, which this PART prohibits.

**Resolution: `FX_RATE_APPROVED` is emitted for activation.** It is the same event with the
governed name, and its metadata carries `lifecycleAction: 'ACTIVATE'` so the intent is explicit.
No migration, no schema change. Renaming to `FX_RATE_ACTIVATED` would need its own CR (CHECK
widening plus a data migration of existing rows) and is recorded as an open decision, not silently
done.

### Maker-checker behavior

Approval requires `approvedByUserId <> createdByUserId`. The service checks it first and returns
409 `FX_RATE_SELF_APPROVAL`; the PART 01 `fx_rates_maker_checker_check` constraint remains the
structural backstop. A refused approval writes nothing and emits no event.

**`fx_rate.manage` alone can never activate anything.** That permission split is what makes
maker-checker enforceable rather than advisory: a caller holding only `manage` can propose a rate
but no route reachable with that permission can make it `ACTIVE`.

Per the PART 02 instruction, **reject and deactivate do not add maker-checker** — they require
authorization (`fx_rate.approve`), actor attribution and an audit event, and nothing more. No
additional DB-level segregation was invented for them.

### Supersession behavior

The only sanctioned correction path, and the only place a new `ACTIVE` rate is created outside
`approveRate`. One transaction, in this order:

1. Move the incumbent `ACTIVE` → `SUPERSEDED`. **This must come first** because the GiST exclusion
   is not deferrable — an ACTIVE successor cannot be inserted while the incumbent window is still
   ACTIVE.
2. Insert the successor as `ACTIVE`, born approved, with `supersedes_rate_id` = incumbent id.
3. Set the incumbent's `superseded_by_rate_id` = successor id.

Both links are therefore exact and committed atomically. If step 2 fails (for example the successor
would overlap a *different* ACTIVE rate) the whole transaction rolls back and **the incumbent stays
`ACTIVE`** — never half-superseded.

- The **currency pair is inherited and cannot be changed**; the request parser has no currency
  fields, so supersession cannot be abused to mint a new pair.
- Omitting `rate` performs a window-only correction that copies the incumbent's **exact stored
  decimal** — it is never recomputed or rescaled.
- The successor is authored by the incumbent's maker (`created_by_user_id`) and approved by the
  superseding actor. Maker-checker therefore applies via the **existing** PART 01 invariant: the two
  must differ, else 409 `FX_RATE_SELF_APPROVAL`. That is reuse, not a new segregation rule.

### ACTIVE window behavior on activation

Activation relies entirely on the PART 01 `fx_rates_active_window_exclusion` constraint. A conflict
maps SQLSTATE `23P01` to 409 `FX_RATE_ACTIVE_WINDOW_CONFLICT` (distinct from
`FX_RATE_EFFECTIVE_WINDOW_OVERLAP`, which is a proposal-time conflict). The module never shortens
an incumbent window, never silently supersedes an incumbent, never selects a latest rate, and never
rewrites a window — asserted by a test that re-reads the incumbent after a refused activation and
confirms status, window and rate are unchanged while the rejected candidate stays
`PENDING_APPROVAL`.

### Events

All five events are written to the dedicated append-only `fx_rate_events` ledger **in the same
transaction as the state change**, so a transition can never be recorded without its audit row.
Metadata carries the pair, `rateType`, the rate value **copied at the time of the event**, the
explicit convention string `1 BASE = RATE x QUOTE`, the window, `source` (+ reference), the
resulting status, and the actor/lineage fields relevant to the transition. `request_id` is
propagated from the request context.

`recordOperationalEvent` is deliberately **not** used for rate lifecycle — a platform-global rate
has no Client owner, and no Client ownership is fabricated. The ledger has no `client_id` column,
asserted by test against `information_schema`. UPDATE and DELETE are rejected by the PART 01
triggers.

### Client FX policy

`src/modules/fx-rates/client-fx-policy.service.ts`. Client-scoped, keyed on `client_id` alone —
**no Building override**. Access is enforced with the existing `contextAccessService.canAccessClient`
and `buildingAccessDeniedError()`.

Fail closed on all three axes, exposed as a resolved `fxAvailable` flag so a caller cannot mistake
absence for permission:

- no policy row → `policy: null`, `fxAvailable: false`
- `fxEnabled = false` → `fxAvailable: false`
- empty `permittedSources` → `fxAvailable: false` (the policy itself is still stored truthfully)

**No silent injection.** `reportingCurrencyCode` must be stated explicitly by the caller and must
equal the Client's `base_currency_code`, else 400 `FX_POLICY_REPORTING_CURRENCY_NOT_BASE`. The
base currency is read for validation and display only; the request parser has no access to it at
all, so injection is structurally impossible at that layer. The PART 01 deferred
`client_fx_policy_valid` trigger remains the final authority.

### Client policy audit

One Client-scoped event through the **existing** `recordOperationalEvent` architecture — no
parallel audit system: `CLIENT_FX_POLICY_SET` on first write, `CLIENT_FX_POLICY_CHANGED`
afterwards, `entityType: 'CLIENT_FX_POLICY'`, written in the same transaction as the policy row and
carrying the new values plus the previous values. A test asserts the policy service never touches
`fxRateEventRepository`, and the lifecycle service never touches `recordOperationalEvent`.

### RBAC

Five permission codes added to `FOUNDATION_PERMISSIONS` — **no new role**:

| Code | Grants | Default |
|---|---|---|
| `fx_rate.read` | read rates + audit trail | PLATFORM_ADMIN |
| `fx_rate.manage` | **propose only** (`PENDING_APPROVAL`) | PLATFORM_ADMIN |
| `fx_rate.approve` | approve / reject / supersede / deactivate | **NONE — `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`** |
| `client_fx_policy.read` | read a Client FX policy | PLATFORM_ADMIN |
| `client_fx_policy.manage` | set a Client FX policy | PLATFORM_ADMIN |

Two deliberate adjustments from the PART 02 instruction, both permitted by its "adjust only if
repository conventions require" clause and recorded here:

- **`fx_rate.create` was not created.** This repository registers 441 `.read` and 361 `.manage`
  permissions and **zero** `.create` permissions, so proposing a rate uses the established
  `.manage` verb rather than inventing a new convention. A test asserts no `.create` permission
  exists anywhere in the catalogue.
- **Policy codes are named `client_fx_policy.*`**, matching the existing Client-scoped
  `client_configuration.*` precedent (BE-27A) and the PART 02 instruction. This refines the working
  name `fx_policy.*` used in governance §15 — same authority, same count, same semantics.

`fx_rate.approve` is withheld from PLATFORM_ADMIN, exactly as `price_catalog.override`,
`operational_budget.override` and `rfq.award` are.

### HTTP surface

Ten operations, thin over the services; authorization on the route, never in the handler:

```
GET    /fx-rates                             fx_rate.read
POST   /fx-rates                             fx_rate.manage
GET    /fx-rates/{rateId}                    fx_rate.read
GET    /fx-rates/{rateId}/events             fx_rate.read
POST   /fx-rates/{rateId}/approve            fx_rate.approve
POST   /fx-rates/{rateId}/reject             fx_rate.approve
POST   /fx-rates/{rateId}/supersede          fx_rate.approve
POST   /fx-rates/{rateId}/deactivate         fx_rate.approve
GET    /clients/{clientId}/fx-policy         client_fx_policy.read
PUT    /clients/{clientId}/fx-policy         client_fx_policy.manage
```

**Not implemented:** conversion, quoting, reporting conversion, provider ingestion, FX dashboard.
Request parsing lives in `fx-rate.request-validation.ts`, kept separate from the pure
`fx-rate.validation.ts` so the dependency-free domain test remains executable.

### OpenAPI

Documented exactly the ten implemented operations — no invented endpoints. Added an `FX` tag whose
description states the canonical convention and the truthful lifecycle; 13 schemas
(`FxRate`, `FxRateStatus`, `FxRateType`, `FxRateSource`, `FxRateEventType`, `FxRateEvent`,
`CreateFxRateRequest`, `SupersedeFxRateRequest`, `FxRateReasonRequest`,
`FxRateSupersessionResult`, `ClientFxPolicy`, `SetClientFxPolicyRequest`,
`ClientFxPolicyReadModel`), 6 responses and 2 path parameters. `rate` is documented as a **string**
(NUMERIC(24,12) must not reach a client as a float). **No conversion schema was added.**

### Validation RUN

- `tests/fx02-part02-fx-rate-governance.test.ts` — **36 tests, 36 pass, 0 skipped**, executed
  against the real shipped request validators and the real `FOUNDATION_PERMISSIONS` /
  `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` catalogue. Covers create/supersede/reason/policy/filter
  parsing, fail-closed defaults, the five permissions, absence of any `.create` verb,
  `fx_rate.approve` withheld, no new role, the exact ten-route surface with per-route permission
  gating, mandatory authentication on every route, the five-event vocabulary and its emission
  points, ledger-vs-operational-events separation, a **`0333`-schema cross-check of every
  interpolated lifecycle column**, and the "no conversion / no rate mutation / no new migration"
  static assertions.

**Defect found and fixed by that cross-check.** The lifecycle `UPDATE` interpolates its attribution
column names, and the `0333` schema is not uniformly named: the deactivation reason column is
`deactivation_reason`, **not** `deactivated_reason`, and `ACTIVE` / `SUPERSEDED` have no reason
column at all. Deriving `${status}_reason` produced a column that does not exist, so **every
deactivate call would have failed at runtime**. Replaced with an explicit per-status column map and
covered by a test that was verified to fail when the bug is reintroduced (34 pass) and pass with the
fix (36 pass) — so the guard is not vacuous. This class of bug is invisible to `tsc` and was not
reachable by the database-backed suite here.
- `tests/fx01-part01-fx-rate-domain.test.ts` — re-run after every PART 02 change: **34 tests, 34
  pass**. PART 01 behaviour is unchanged.
- **OpenAPI contract validation** — `docs/api/openapi.yaml` parses as valid YAML (openapi 3.0.3,
  657 paths); **zero unresolved `$ref`s across the entire contract**; all 13 FX schemas, 6
  responses and 2 parameters resolve; the four FX enums match the `0333` CHECK constraints exactly.
- **Route/contract consistency** — the 10 registered Express routes and the 10 documented operations
  are an **exact match** after `:param` → `{param}` normalization, with **zero** permission
  mismatches between `requirePermission(...)` and `x-required-permission`.
- `git diff --check` — **PASS** (unstaged, staged, and `a5ae3b0..HEAD`).

### Validation NOT RUN (recorded, never claimed as passing)

- `npm run typecheck` — **NOT RUN.** `node_modules` is absent, no `tsc` exists anywhere on this
  system, and dependency installation is prohibited by this PART. Type errors are **not**
  machine-verified; the new files were hand-reviewed against `tsconfig.json` instead.
- `tests/fx02-part02-fx-rate-lifecycle.test.ts` — **NOT RUN: 24 tests across 9 suites load and
  register cleanly but all 24 SKIP** (no PostgreSQL, provisioning prohibited). Unexecuted:
  maker-checker against a real row, the ACTIVE window conflict, supersession lineage in both
  directions, transactional rollback on a failed successor, event rows and ledger immutability,
  Client policy isolation, the policy audit event, RBAC denial over HTTP, and the absence of
  conversion endpoints at runtime.
- `tests/fx01-part01-fx-rate-authority.test.ts` — **NOT RUN: 27 tests, all SKIP** (same reason).
- The repository's own OpenAPI contract tests — **NOT RUN** (they need `tsx` + the `yaml` package
  from `node_modules`). The YAML validation above was performed with an out-of-tree Python parser
  installed into `/tmp` only; **nothing was added to `package.json`, `package-lock.json` or
  `node_modules`, and no project dependency was installed.**
- No `npm ci`, no broad regression, no CI, no migration execution, no PR, no merge.

### PART 03 readiness

**PART 03 — Governed Conversion Service: READY TO START.**

Available to PART 03 without further schema work: a governed set of `ACTIVE`, maker-checked,
window-unambiguous rates; a fail-closed Client policy exposing `fxEnabled`,
`reportingCurrencyCode`, `permittedSources`, `inversePermitted` and `maxStalenessDays`; and the
`fxRateRepository.findActiveCovering(base, quote, at)` read primitive already shipped in PART 01.

PART 03 must supply: the single `fxConversionService` arithmetic authority (§7); the ordered
selection policy (§6); the §12 fail-closed error taxonomy and its `ERROR_CODES`; governed `INVERSE`
with `inverse_permitted` and `direction` provenance; `IDENTITY` short-circuit; decimal half-up
rounding to the target currency precision; and the §8 provenance contract.

PART 03 should also decide the open item carried from PART 02: whether the activation event should
be renamed `FX_RATE_APPROVED` → `FX_RATE_ACTIVATED`. Doing so requires widening
`fx_rate_events_event_type_check` (a migration) and migrating existing rows, so it must not be
folded into PART 03 silently.

**`0334` (conversion ledger) remains unconsumed** and is required only if PART 03 materializes a
converted amount rather than returning transient read-model provenance.

---

## PART 03 implementation notes (2026-08-25)

**Status: PART 03 COMPLETE.** Baseline for this PART: `0e3ab10` (PART 02).

> **Baseline recovery note.** The sandbox for this PART was re-cloned with the local branch reset to
> `a5ae3b0`; the PART 01/02 commits existed only on the remote. The branch pointer was restored with
> a mixed reset to the fetched `0e3ab10`, after which `git status` was empty — the working tree
> already matched PART 02 exactly, so **no work was lost and no file was rewritten**.

### Conversion authority

`src/modules/fx-rates/fx-conversion.service.ts` exports **`fxConversionService.convert(request,
gateway)`** — the single governed conversion authority. Three new files:

| File | Role |
|---|---|
| `fx-conversion.service.ts` | Policy, resolution order, direct/inverse decision, provenance. **No database import.** |
| `fx-conversion.gateway.ts` | The only database binding; forwards to the PART 01 repositories. No policy, no arithmetic. |
| `fx-decimal.ts` | Exact decimal arithmetic (`parse`, `multiply`, `divideHalfUp`, `roundHalfUp`, print). |

Splitting the gateway out is dependency inversion, not a second authority: the resolution order, the
arithmetic and the provenance all live only in the service, and that separation is what makes them
executable in tests without PostgreSQL.

Both operations live in exactly one function, **`applyRate`** (§7 rule 1). A test asserts that
`multiply(` and `divideHalfUp(` appear inside `applyRate` and nowhere else in the service except the
import and one non-monetary use (see *Staleness*).

**Anti-duplication guard (§1).** A test scans all 2,825 `.ts` files under `src/` outside `fx-rates` and
asserts that none of them performs FX arithmetic, reads the `fx_rates` table, imports `fx-decimal`,
or imports the conversion service. The last of these also proves PART 03 ships an internal authority
with **no consumer yet** — PART 04 is the first.

### Direct behavior

`source = BASE`, `target = QUOTE` ⇒ `convertedAmount = amount × rate`, computed exactly and rounded
once. Verified: `120 × 16500 = 1 980 000` at IDR's 0 decimals; `0.1 × 3 = 0.3` exactly, where the
JavaScript float path yields `0.30000000000000004` (asserted in the same test as a sanity check).

### Inverse behavior

`source = QUOTE`, `target = BASE` ⇒ `convertedAmount = amount ÷ rate`. Inverse is used **only** when
no DIRECT rate resolves, `inversePermitted` is `true`, and an ACTIVE reverse pair covers the
reference date. The reciprocal is **never persisted**; provenance retains the stored `fxRateId`, the
stored rate and the stored pair, so a reader can see the stored pair is the reverse of the requested
one. Verified: `1 980 000 ÷ 16 500 = 120.00` USD, and `1 ÷ 16 500 = 0.00` at 2 decimals.

If a reverse pair exists but `inversePermitted` is `false`, the result is
`FX_INVERSE_NOT_PERMITTED` — the rate is never silently inverted. If no reverse pair exists either,
the reported reason is the *direct* absence (`FX_PAIR_NOT_GOVERNED` and friends), not a misleading
inverse complaint.

**DIRECT always wins:** a test with both pairs stocked asserts the reverse pair is not even queried.

### Identity behavior

`source === target` returns the amount **unchanged** with `conversionMode: 'IDENTITY'`, **no rate
lookup at all** (asserted: the gateway records zero queries) and **no fabricated `fxRateId` or
`rate`** (both `null`). Identity also requires no Client FX policy. FX invents no rounding for the
identity case — the amount is returned as supplied, and monetary-scale normalisation stays with the
owning module.

### Staleness

Implemented exactly once, centrally, in `assertRateUsable`, shared by DIRECT and INVERSE — no later
module can reinterpret it. Governance §6 step 7 ("fail when `referenceDate − effective_from`
**exceeds** `max_staleness_days`") is applied as an **exact integer-millisecond comparison**:

```
elapsedMs = referenceDate - rate.effectiveFrom        (never negative; window is already checked)
fail when elapsedMs > maxStalenessDays x 86_400_000
```

**Recorded interpretation, not an invented rule:** "exceeds" is a strict greater-than on the elapsed
*duration*, so exactly N days is **not** stale and N days + 1 ms **is**. This is asserted by test.
The comparison is deliberately **not** made after rounding to a day count: an earlier draft did
compare 4-decimal day values, which let a 1 ms excess through — that defect was caught by test and
fixed. The day figure rendered in the error message is still a decimal, but it is cosmetic.

`maxStalenessDays = null` applies no bound beyond the effective window. Governance supplied enough
to implement this deterministically, so the §9 STOP condition was **not** triggered.

### Decimal and rounding authority

The repository has **no** safe decimal authority — existing monetary code uses
`Number(value.toFixed(2))` (`operational-variance.service.ts:51`) and `Math.round(value * 100)`
float tricks, exactly what §7 rule 3 forbids. Per §10 the minimum deterministic arithmetic was
therefore implemented locally in `fx-decimal.ts`: values are `unscaled × 10^(-scale)` held in a
`BigInt`, so every operation is exact integer arithmetic. `Number`, `parseFloat`, `toFixed` and
`Math.round` are never used for a monetary value (asserted by test with comments stripped).

Division needs no guard-digit count to be chosen: the half-up decision is taken from the **exact
remainder** of the BigInt division, so the result equals computing the quotient to unlimited
precision and rounding once. That is what §11 rule 4 means by "exact decimal reciprocal with guard
digits".

**Rounding:** `HALF_UP`, applied once, at the target currency's `decimal_precision` read from the
existing Currency Master (0 for IDR/JPY, 2 for the rest) — never assumed or hardcoded. This mode was
already frozen by §3, so the §11 STOP condition was **not** triggered. `FX_ROUNDING_MODE = 'HALF_UP'`
is exported and recorded in every provenance block.

### Provenance

Every successful result carries `sourceAmount`, `sourceCurrencyCode`, `targetCurrencyCode`,
`convertedAmount`, `referenceDate`, `conversionMode`, `convertedAt`, `purpose`, and a provenance
block with `fxRateId`, `rate` (copied as stored), `rateType`, `rateSource`, `rateSourceReference`,
`rateEffectiveFrom`, `rateEffectiveTo`, `rateIngestedAt`, `rateBaseCurrencyCode`,
`rateQuoteCurrencyCode`, `targetDecimalPrecision`, `roundingMode` and
`unroundedConvertedAmount`.

`unroundedConvertedAmount` is populated for **DIRECT**, where `amount × rate` is finitely
representable, and is `null` for **INVERSE** and **IDENTITY**: an exact quotient need not be finitely
representable, and no approximate "unrounded" figure is claimed. For **IDENTITY** the whole rate
provenance is `null` rather than fabricated.

### Errors

New codes: `FX_NOT_ENABLED_FOR_CLIENT`, `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE`,
`FX_TARGET_NOT_GOVERNED`, `FX_PAIR_NOT_GOVERNED`, `FX_RATE_NOT_EFFECTIVE`, `FX_RATE_INACTIVE`,
`FX_RATE_FUTURE_ONLY`, `FX_RATE_SOURCE_NOT_PERMITTED`, `FX_RATE_STALE`, `FX_RATE_AMBIGUOUS`,
`FX_INVERSE_NOT_PERMITTED`, `FX_CONVERSION_AMOUNT_INVALID`, `FX_REFERENCE_DATE_INVALID`.

**Reused rather than duplicated** (§14): policy missing → `FX_CLIENT_POLICY_NOT_FOUND` (PART 01);
currency leg not ACTIVE → `FX_RATE_CURRENCY_INACTIVE_OR_UNKNOWN` (PART 01); Client allowance →
`CLIENT_CURRENCY_NOT_ALLOWED` (CUR-01).

The missing-rate reason is specific, not generic: `countPairCoverage` distinguishes *no row at all*
(`FX_PAIR_NOT_GOVERNED`) from *rows exist but none ACTIVE* (`FX_RATE_INACTIVE`) from *ACTIVE but
starts later* (`FX_RATE_FUTURE_ONLY`) from *ACTIVE but window expired* (`FX_RATE_NOT_EFFECTIVE`).

Input validation fails closed too: a non-positive, non-decimal or exponent-notation amount →
`FX_CONVERSION_AMOUNT_INVALID`; a missing or unparseable `referenceDate` →
`FX_REFERENCE_DATE_INVALID`. **`created_at` and "now" are never substituted.** An UNKNOWN
(`null`/empty) currency → `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` with **zero** rate lookups.

### No triangulation

At most one authoritative rate row per conversion. Exactly two lookups exist — the direct pair and
its exact reverse — asserted both by count and by recording every pair the gateway is asked for: a
fixture stocking `USD/IDR` and `IDR/EUR` while requesting `USD → EUR` fails closed and the recorded
query set is exactly `{USD/EUR, EUR/USD}`, never IDR as an intermediate. The Client base, IDR and the
reporting currency are never used as a leg.

### Transient only — nothing persisted, nothing audited

Asserted by test: no `INSERT`/`UPDATE`/`DELETE` anywhere in the three PART 03 files; no
`recordOperationalEvent` and no `fxRateEventRepository`; no reference to any monetary transaction
table; no `fx_conversions` table. A read conversion is not a lifecycle event.

### Migration decision

**No migration. `0333` remains the highest migration and `0334` was not consumed.** PART 03 needed
no schema change: rate resolution reads the existing `fx_rates`, the existing
`client_fx_policies`, the existing `currencies` master and the existing
`client_allowed_transaction_currencies`. Because nothing is materialized, the conversion ledger
`0334` remains unnecessary.

### Event vocabulary discrepancy — recorded as governance debt only

Per §16, **`FX_RATE_APPROVED` was NOT renamed to `FX_RATE_ACTIVATED`** and no migration was consumed
for naming. The discrepancy between the PART 02 instruction's requested name and the frozen
`fx_rate_events_event_type_check` vocabulary is recorded here as **governance debt**: renaming would
require widening that CHECK (a migration) plus migrating existing rows, and must be its own decision.
The activation event continues to carry `metadata.lifecycleAction: 'ACTIVATE'`.

### Validation RUN

- `tests/fx03-part03-conversion-service.test.ts` — **47 tests, 47 pass, 0 skipped**, driving the
  **real** `fxConversionService.convert` through an injected gateway. Covers: identity (including
  no-lookup and no-policy), direct arithmetic and target precision at 0 and 2 decimals, the
  `0.1 × 3` float-drift proof, DIRECT preferred over INVERSE, inverse arithmetic and rounding,
  inverse disabled, closed-open window boundaries (inclusive start, just-before-end, exact end
  rejected), superseded not selected, future rate not selected early, pending rate not selected,
  policy missing / disabled / target mismatch / source not permitted / disallowed Client currency,
  UNKNOWN currency with zero lookups, inactive master currency, staleness within / exact-bound /
  one-millisecond-past / unbounded, ambiguity, invalid amount and referenceDate, no triangulation
  (behavioural and static), provenance for all three modes, transient-only assertions, no `0334`,
  no HTTP conversion endpoint, singular `applyRate`, no `toFixed`/`parseFloat`/`Math.round`, and the
  whole-of-`src/` anti-duplication scan.
- **PART 01 + PART 02 dependency-free regression** — `fx01-part01-fx-rate-domain` **34/34 pass** and
  `fx02-part02-fx-rate-governance` **36/36 pass**, re-run after every PART 03 change. Combined:
  **117 pass, 0 fail, 51 skipped** across 168 tests.
- **Barrel integrity** — all 81 re-exported names in `src/modules/fx-rates/index.ts` verified to
  exist in their source modules.
- Exact decimal arithmetic verified independently of the service: half-up boundaries (`100.005 →
  100.01`, `2.5 → 3`, `3.5 → 4`, `1/8 → 0.13`, `3/8 → 0.38`), non-terminating quotients
  (`1/3 → 0.33`, `2/3 → 0.67`, `1/6 → 0.166667`), and exact inverse (`1 950 000 ÷ 16 250 = 120.00`).
- `git diff --check` — **PASS** (unstaged, staged, and `0e3ab10..HEAD`).
- **OpenAPI deliberately untouched** — verified `git diff` on `docs/api/openapi.yaml` is empty. No
  conversion or quote path was documented, because none exists.

### Validation NOT RUN (recorded, never claimed as passing)

- `npm run typecheck` — **NOT RUN.** `node_modules` is absent, no `tsc` exists anywhere on this
  system, and dependency installation is prohibited. Type errors are **not** machine-verified; the
  new files were hand-reviewed against `tsconfig.json` and the barrel's re-exports were checked
  statically instead.
- `tests/fx01-part01-fx-rate-authority.test.ts` (27) and
  `tests/fx02-part02-fx-rate-lifecycle.test.ts` (24) — **NOT RUN: all 51 SKIP** (no PostgreSQL,
  provisioning prohibited). The database-enforced behaviour remains unexecuted.
- **No DB-backed PART 03 test was written**, because there is no PostgreSQL to run it against and a
  skipped suite would prove nothing. The conversion authority's database surface is the PART 01
  read path, which the PART 01 DB suite covers once PostgreSQL is available.
- Repository OpenAPI contract tests — **NOT RUN** (need `tsx` + `yaml` from `node_modules`). The
  YAML tooling used earlier was an out-of-tree parser in `/tmp`; nothing was added to
  `package.json`, `package-lock.json` or `node_modules`, and no project dependency was installed.
- No `npm ci`, no broad regression, no CI, no migration execution, no PR, no merge.

### PART 04 readiness

**PART 04 — Reporting Currency Integration: READY TO START.**

Available to PART 04 without further schema work or migration:

- `fxConversionService.convert(request, databaseFxRateGateway)` — the single conversion authority,
  returning complete inline provenance or a specific fail-closed code.
- Fail-closed semantics that let a reporting read model build the §10 contract directly: a caller
  can distinguish *no rate* (`FX_PAIR_NOT_GOVERNED`), *rate exists but not for this date*
  (`FX_RATE_NOT_EFFECTIVE` / `FX_RATE_FUTURE_ONLY` / `FX_RATE_INACTIVE`), *stale*, *source not
  permitted*, *inverse not permitted*, *target not governed* and *UNKNOWN currency* — which is
  exactly what the "`null` total + `unconvertible` bucket" rule requires.
- The still-unwired `currency-reporting` exact-currency seam (§1.2), which PART 04 connects.

PART 04 must supply: the reporting read models that call the authority per row and aggregate the
per-currency original totals; the **never return a mixed-currency grand total** rule (§10 hard rule
1 — `null` total plus an `unconvertible` bucket when any row fails); keeping UNKNOWN rows out of
converted arithmetic; and the OpenAPI changes for those read models only.

PART 04 must **not** add a public conversion or quote endpoint (§15 keeps the authority internal),
must not reinterpret staleness, and must not touch the exact-currency boundaries in §9.

**`0334` remains unconsumed.** It is required only if PART 04 materializes a converted amount rather
than returning transient read-model provenance; governance §7 expects PART 04 to be TRANSIENT.

---

## PART 04 implementation notes (2026-08-25)

**Status: PART 04 COMPLETE.** Baseline for this PART: `99b7cbd` (PART 03).

### Reporting surfaces inspected, and the selection decision

Every candidate was inspected before anything was written. The result:

| Surface | Monetary? | Currency-grouped? | Per-row business date? | Decision |
|---|---|---|---|---|
| `currency-reporting.getOperationalCurrencySummary` | Yes | **Yes** — `GROUP BY currency_code` + UNKNOWN bucket | Not exposed by the aggregate | **INTEGRATED** |
| `operational-finance-aggregation` | Yes | Single budget currency | Period only | **EXCLUDED** — operational control (§15) |
| `operational-variance` | Yes | Single budget currency | — | **EXCLUDED** — operational control with `failClosed` |
| `management-operational-finance` / `-building-` | Yes | Derived from the above | — | **EXCLUDED** — projection of a control surface |
| `basic-financial-reporting` | Yes | **NO** | Per-source dates exist | **EXCLUDED** — see finding below |
| `reporting-export` (all 12 files) | **No monetary data at all** | n/a | n/a | **NOTHING TO INTEGRATE** |

**`currency-reporting` is the only safe target.** It is the sole monetary read model whose
components are already single-currency, it keeps an explicit UNKNOWN bucket, it was built by CUR-01
for exactly this purpose, and it is still unwired — so integrating it changes no public contract.

**Finding worth surfacing: `basic-financial-reporting` is a pre-existing mixed-currency aggregate.**
Its SQL does `SUM(amount)` / `SUM(bill_amount)` / `SUM(total_amount)` across `tenant_charges`,
`utility_bills`, `tenant_invoices`, `invoice_payment_status`, `vendor_service_costs` and
`basic_expenses` with **no currency filter and no currency grouping**, then computes
`netBilled = billedIncome − operationalCost` across those sources. That is precisely the
mixed-currency grand total governance §10 forbids. Adding a converted view on top of it would
violate PART 04 §5 ("never convert an already mixed-currency aggregate"), and re-grouping every
query by currency is a remediation well outside PART 04. **Recorded as pre-existing debt, not
touched.** This is not new in PART 04 — CUR-01 §2 G-03 and CUR-02 already noted these tables were
currencyless until PART 01/02 added snapshots.

### What was built

| File | Role |
|---|---|
| `src/modules/fx-rates/fx-reporting.service.ts` | `fxReportingService.buildReportingCurrencyView` — the reporting-currency view authority. **No database import.** |
| `src/modules/currency-reporting/reporting-currency-read-model.ts` | Thin adapter: per-row projection of the FINALIZED rows the existing seam aggregates, plus `getOperationalCurrencyReport` returning both views. |
| `fx-decimal.ts` | Added exact `add` (same-currency grouping only — no rate involved). |

`getOperationalCurrencySummary` is left **byte-identical**; a test asserts it still contains
`GROUP BY currency_code` and its UNKNOWN bucket and has gained no FX behaviour. The adapter
**imports** the seam rather than reimplementing its aggregation (also asserted).

The adapter is deliberately **not** re-exported by `currency-reporting/index.ts`, because it
imports the seam from that index — re-exporting would create an import cycle.
`operational-finance` has the same pattern for some of its files.

### Design defect found and fixed

The first draft gave the reporting layer its own `policyReader` alongside the gateway's
`findClientFxPolicy` — **two sources of truth for whether FX is enabled**, exactly what PART 04 §2
forbids. The tests caught it immediately (every conversion failed with
`FX_CLIENT_POLICY_NOT_FOUND` while the reporting layer believed FX was enabled). Fixed by removing
`policyReader` entirely: the policy is now read through the **same** gateway the conversion
authority uses, so the two can never disagree.

### Original-currency preservation

`originalCurrencyTotals` is always returned, converted or not, as exact same-currency groups with
`{ currencyCode, amount, count }`. `currencyCode: null` is the UNKNOWN group. Verified: `IDR
1 000 000` + `USD 100` stay two identifiable groups while `convertedTotal` reads `2 650 000 IDR`
beside them — never instead of them. Same-currency addition is exact decimal
(`10.10 + 20.20 = 30.30`, not `30.299999999999997`).

### Reporting-currency behaviour

The target comes **only** from `client_fx_policies.reporting_currency_code` via the gateway. A test
asserts the module contains no hardcoded `'IDR'`, no `baseCurrencyCode` and no
`defaultTransactionCurrency` reference. No Building, document-type, UI or request-input derivation
exists. When no policy exists or FX is disabled, `reportingCurrencyCode` is `null` and no
conversion is attempted.

### Business-date authority

Each fact carries its **own** business date (`vendor_service_costs.cost_date`,
`basic_expenses.expense_date` — both `DATE NOT NULL`). Conversion happens per fact at that date, so
**different source dates resolve different rates**: a test with March and June windows asserts two
distinct `fxRateId`s and two distinct converted amounts in one report.

A missing or unparseable business date goes to the unconvertible bucket as
`BUSINESS_DATE_MISSING`. **No date is invented.** Report generation time, `created_at` and "now"
are never used — asserted statically (`Date.now(`, `new Date()`, `created_at`/`createdAt` all
absent from the module).

### Unconvertible semantics

Every failure is reported with `sourceType`, `sourceId`, `amount`, `currencyCode`, `businessDate`,
a machine-readable `reason`, the underlying PART 03 `errorCode`, and the message. **No record is
hidden.** Nine reasons: `UNKNOWN_SOURCE_CURRENCY`, `BUSINESS_DATE_MISSING`, `FX_POLICY_UNAVAILABLE`,
`FX_DISABLED`, `RATE_MISSING`, `RATE_STALE`, `RATE_AMBIGUOUS`, `CURRENCY_NOT_ALLOWED`,
`REPORTING_TARGET_MISMATCH`.

PART 03's taxonomy is reused by mapping, not duplication — e.g. `FX_RATE_STALE → RATE_STALE`,
`FX_RATE_AMBIGUOUS → RATE_AMBIGUOUS`, `CLIENT_CURRENCY_NOT_ALLOWED → CURRENCY_NOT_ALLOWED`, and the
six distinct "no usable rate" codes (`FX_PAIR_NOT_GOVERNED`, `FX_RATE_NOT_EFFECTIVE`,
`FX_RATE_INACTIVE`, `FX_RATE_FUTURE_ONLY`, `FX_RATE_SOURCE_NOT_PERMITTED`,
`FX_INVERSE_NOT_PERMITTED`) collapse to `RATE_MISSING` **with the precise code preserved
alongside**. An unmapped code still fails safe as `RATE_MISSING` rather than being dropped.

Policy-level failures (`FX_POLICY_UNAVAILABLE`, `FX_DISABLED`) mark **every** fact unconvertible, so
nothing is silently omitted.

### Completeness semantics

`convertedTotal` is returned **only** when `unconvertible` is empty, as
`{ amount, currencyCode, completeness: 'COMPLETE' }`. Otherwise it is **`null`**. A test proves that
with one convertible and one unconvertible fact the total is `null` while the successful component
is still listed. **No partial subtotal exists** — a test asserts neither `convertedSubtotal` nor
`partialTotal` is present, because governance §9 permits such a field only if already frozen, and it
is not.

### Provenance

Each `convertedComponent` carries `sourceAmount`, `sourceCurrencyCode`, `convertedAmount`,
`targetCurrencyCode`, `referenceDate`, `conversionMode` and the **full PART 03 provenance block**.
The view deliberately has **no** report-level `rate` or `fxRateId` (asserted), so different rates can
never be collapsed into one fake report-level rate — a test with two distinct rates asserts two
distinct `fxRateId`s survive.

Identity components go through the PART 03 authority too, so `IDENTITY` provenance and semantics stay
consistent and no local arithmetic bypasses the authority. A test asserts one report mixing
`IDENTITY` and `DIRECT`.

### Export integration

`reporting-export` contains **zero** `currency` references across all 12 files and no monetary
amounts, so no export dataset feeds from an affected read model and there is nothing to preserve.
The CSV/XLSX/PDF renderers are asserted to contain no FX, no `currency` reference and no call to
either FX service — they remain pure consumers of the canonical snapshot, and FX stays upstream of
renderer dispatch. No renderer arithmetic was modified.

### Operational-control isolation

No FX import exists in `operational-variance`, `operational-finance-binding`,
`operational-finance-aggregation`, `operational-commitment-vendor`,
`operational-commitment-material`, `tenant-invoice` or `price-catalog-entry` services (asserted).
Their fail-closed guards are asserted still present: `SOURCE_CURRENCY_MISMATCH` and
`CURRENCYLESS_COST_AUTHORITY` in variance, `operationalBudgetSourceCurrencyMismatchError` in
binding, `tenantInvoiceCurrencyMismatchError` in tenant invoicing. No FX-based budget eligibility,
commitment matching, actualization matching or variance decision was introduced.

### OpenAPI decision

**No OpenAPI change.** `git diff` on `docs/api/openapi.yaml` is empty, asserted by test.

- `currency-reporting` has **no public route** — it is an internal seam with zero consumers before
  PART 04. Adding one would be inventing a reporting route (§18 forbids it), and documenting an
  internal-only seam as a public API is also forbidden.
- Governance §17 had listed `GET /fx-rates/resolve` for PART 04. It was **deliberately not built**:
  PART 04 §17 prohibits any standalone public conversion/quote endpoint, and a resolve endpoint is
  one. Recorded here as a deliberate narrowing of governance §17, not an omission.
- No already-public reporting response shape changed, so there was nothing to re-document.

### Migration decision

**No migration. `0333` remains the highest migration (333 files) and `0334` was not consumed.**
PART 04 is entirely read-side: nothing is persisted, no `fxRateId` is written to a transaction
table, no conversion ledger exists, and no audit event is emitted per report conversion — all
asserted. Provenance travels with the read result only.

### Validation RUN

- `tests/fx04-part04-reporting-currency.test.ts` — **33 tests, 33 pass, 0 skipped**, driving the real
  `buildReportingCurrencyView`. Covers: separate IDR/USD original groups alongside a converted
  total; exact same-currency grouping and the UNKNOWN group; original view returned even when
  nothing converts; COMPLETE total; IDENTITY + DIRECT in one report; INVERSE where policy permits;
  DIRECT preferred over INVERSE; **no partial grand total**; the nine-reason vocabulary; UNKNOWN
  currency; missing business date; missing / stale / ambiguous rate; FX disabled; missing policy;
  disallowed Client currency; nothing hidden; different source dates resolving different rates;
  report generation date never used; per-component provenance; no report-level rate; policy-only
  reporting currency; operational controls free of FX and still fail-closed; renderers pure;
  read-side only; no `0334`; no public conversion endpoint; and the CUR-01 seam unchanged.
- **PART 01 / 02 / 03 dependency-free regression** — **34/34**, **36/36** and **47/47 pass**. The
  PART 03 suite's "no consumer yet" assertion was updated to assert that the **only** sanctioned
  consumer across all of `src/` is the PART 04 reporting layer.
- Combined: **201 tests → 150 pass, 0 fail, 51 skipped**.
- **Barrel integrity** — all 90 re-exported names in `src/modules/fx-rates/index.ts` verified
  against their source modules.
- `git diff --check` — **PASS** (unstaged, staged, and `99b7cbd..HEAD`).

### Validation NOT RUN (recorded, never claimed as passing)

- `npm run typecheck` — **NOT RUN.** `node_modules` absent, no `tsc` on this system, installation
  prohibited. Types hand-reviewed; barrel re-exports verified statically instead.
- `tests/fx01-part01-fx-rate-authority.test.ts` (27) and
  `tests/fx02-part02-fx-rate-lifecycle.test.ts` (24) — **NOT RUN: all 51 SKIP** (no PostgreSQL).
- **No DB-backed PART 04 test was written.** The adapter's SQL (`listOperationalMonetaryFacts`,
  building → property → client resolution) is therefore **unexecuted**; a skipped suite would prove
  nothing. The view authority above it is fully exercised.
- Repository OpenAPI contract tests — **NOT RUN** (need `tsx` + `yaml`).
- No `npm ci`, no broad regression, no CI, no migration execution, no PR, no merge.

### PART 05 readiness

**PART 05 — Cross-Module FX Safety & Audit: READY TO START.**

Already in place for PART 05 to build on, rather than re-derive:

- The single conversion authority and the single reporting layer, with tests asserting that **only**
  `fx-reporting.service.ts` consumes `fxConversionService` across all of `src/`, that no file
  outside `fx-rates` performs FX arithmetic or reads `fx_rates`, and that `fx-decimal` stays private.
- Static guards proving the operational control surfaces import no FX and keep their fail-closed
  currency guards, and that the export renderers perform no FX.
- Read-side-only assertions (no INSERT/UPDATE/DELETE, no audit emission, no `0334`, no public
  conversion endpoint).

PART 05 should supply: the consolidated cross-module safety regression that governance §7 rule 1
calls for (asserting no `amount * rate` / `amount / rate` anywhere outside `applyRate`); audit
coverage for the rate lifecycle events actually emitted end-to-end; and the historical-UNKNOWN
guarantees restated as executable checks. It should also decide whether the pre-existing
`basic-financial-reporting` mixed-currency aggregate warrants its own CR — **PART 04 deliberately
did not touch it**.

**`0334` remains unconsumed** and stays unnecessary while conversion remains TRANSIENT.

---

## PART 05 implementation notes (2026-08-25)

**Status: PART 05 COMPLETE.** Baseline for this PART: `644315d` (PART 04).

PART 05 is a verification and hardening PART. **No new business capability was added**, because the
review found **no FX-01 safety defect requiring a fix**. The deliverable is the consolidated
cross-module safety suite governance §7 rule 1 assigns to this PART.

### §1 Cross-module safety findings

A repo-wide scan for every FX symbol (`fxConversionService`, `fxReportingService`, `fx-conversion`,
`fx-reporting`, `fx-decimal`, `fx-rates/`, and all six repositories/services) found FX in **exactly
15 files**: 13 inside `src/modules/fx-rates/`, the PART 04 adapter
`currency-reporting/reporting-currency-read-model.ts`, and the router registration in
`src/routes/index.ts`. A test now asserts that exact set.

Every authority listed for review was scanned file-by-file and has **zero** FX imports:

`rfqs` · `vendor-quotations` · `rfq-comparisons` · `rfq-recommendations` · `rfq-po-conversions` ·
`purchase-orders` · `purchase-requests` · `price-catalog-entries` · `vendor-invoices` ·
`invoice-payment-status` · `payment-receipts` · `tenant-charges` · `tenant-invoices` ·
`inventory-work-order-material-usages` · `utility-tariffs` · `utility-calculations` ·
`utility-bills` · `vendor-service-costs` · `basic-expenses` · `operational-finance` (all 27 files) ·
`reporting-export` (all 12 files) · `basic-financial-reporting` (all 7 files).

**Conclusion: FX is not wired into transactional eligibility, matching, approval, actualization or
any lifecycle decision anywhere in the repository.**

### §2 Exact-currency boundaries

Each guard was located and is now asserted present in code (comments stripped), with a further
assertion that none of the guarding files consults FX:

| Guard | Location |
|---|---|
| USD RFQ vs IDR quotation | `vendor-quotation.service.ts` — `currency !== rfq.currency` → `vendorQuotationCurrencyMismatchError` |
| USD quotation vs comparison | `rfq-comparison.service.ts` — `selected.currency !== rfq.currency` → `rfqComparisonCurrencyInvalidError` |
| USD award vs IDR PO | `rfq-po-conversion.service.ts` — `quotation.currency !== rfq.currency` |
| USD PO vs IDR vendor invoice | `vendor-invoice.service.ts` — `purchaseOrder.currency !== invoice.currency` → `CURRENCY_MISMATCH` |
| USD budget vs IDR commitment | `operational-commitment.service.ts` — `input.currency !== locked.currency` → `operationalCommitmentCurrencyMismatchError` |
| USD source vs IDR budget binding | `operational-finance-binding.service.ts` — `operationalBudgetSourceCurrencyMismatchError`; aggregation excludes `SOURCE_CURRENCY_MISMATCH` |
| USD actualization vs IDR commitment | `operational-commitment-vendor.service.ts` and `-material.service.ts` — `outcome: 'CURRENCY_MISMATCH'` |
| USD tenant invoice vs IDR line | `tenant-invoice.service.ts` — `tenantInvoiceCurrencyMismatchError` / `tenantInvoiceSourceCurrencyUnknownError` |
| Price catalog lookup | `price-catalog-lookup.service.ts` — `CURRENCY_INCOMPATIBLE` typed absence |

**No equality check was relaxed, and no conversion can satisfy any of them** — none of these code
paths can reach the conversion authority at all.

### §3 Single conversion authority

A repo-wide scan of `src/` for real arithmetic of the form `operand * rateLike` / `operand /
rateLike` — code only, with string literals blanked so `/migrate` and `/authenticate` cannot
false-positive — returns **zero hits**.

**Two vacuous-guard defects were found by mutation-testing this check, and both are fixed.** A
guard that passes while matching nothing is worse than no guard, so the pattern was deliberately
broken to see whether the test would notice:

1. The first draft skipped every line beginning with `import`/`export`, so a leaked
   `export const f = (amount, rate) => amount * rate` sailed straight past. Injecting exactly that
   into `vendor-invoice.service.ts` produced **0 failures**.
2. The second draft's identifier group required a prefix before `rate`, so the *canonical* bare form
   `amount * rate` never matched. Injecting it again still produced **0 failures**.

Both are fixed: import/export lines are now kept, and the rate-identifier prefix is optional. A
committed **self-test** pins the pattern against six forms it must detect (`amount * rate`,
`amount / rate`, `amount*rate`, the `export const` leak, `amount * fxRate`, `total / tariffRate`)
and four it must not (`a * b`, `amount * 2`, `from './migrate'`, `from '../auth/authenticate'`), so
the guard cannot silently become vacuous again. Re-tested: both injections now fail the suite.

The initial naive pattern also produced 4 false-positive hits from the substring "rate" inside
`migrate`/`authenticate`; blanking string literals removes them without needing the line filter.

Additional assertions: `multiply(` and `divideHalfUp(` appear inside `applyRate` and nowhere else in
the conversion service except the import and the one non-monetary staleness day count; the **only**
consumer of `fxConversionService` across all of `src/` is `fx-reporting.service.ts`; and neither the
reporting layer nor the PART 04 adapter contains rate-selection queries, the `fx_rates` table name,
`maxStalenessDays` or the day constant. **No duplicate FX arithmetic existed, so nothing needed
fixing.** Unrelated historical arithmetic was deliberately not remediated.

### §5 Audit boundary — no flood path

- `fx_rate_events` is written **only** by `fx-rate-lifecycle.service.ts` (asserted by scanning every
  file for `fxRateEventRepository.append`).
- `CLIENT_FX_POLICY_SET` / `CLIENT_FX_POLICY_CHANGED` are emitted **only** by
  `client-fx-policy.service.ts`, through the existing Client-scoped `recordOperationalEvent`.
- The conversion service, its gateway, the reporting service and the PART 04 adapter contain **no**
  `recordOperationalEvent`, no `fxRateEventRepository`, and no `INSERT`/`UPDATE`/`DELETE`.
- Therefore transient conversion emits nothing, and reporting conversion emits nothing per
  component. There is no audit-flood path.

### §6 Materialized conversion decision

**MATERIALIZED FX CONVERSION = NOT REQUIRED IN FX-01.**

No business authority persists a converted monetary amount. Verified: no migration contains
`converted_amount`, `reporting_amount` or `converted_currency`; the only `fx_rate_id` occurrence is
the `fx_rate_events` foreign key in `0333`; `0333` alters only its own `fx_rates` table; and no
`fx_conversion_ledger` / `fx_conversions` reference exists anywhere in `src/`.

Accordingly **`0334` was not created** and no persistence was invented for future readiness.
`0333` remains the highest migration (333 files).

### §7/§8 Rate provenance and supersession safety

The reporting view carries no report-level `rate` or `fxRateId` (asserted), and a two-rate fixture
proves both `fxRateId`s survive distinctly — so no average, fake, latest or Client-default rate can
substitute for per-component provenance.

Supersession is proven safe behaviourally: convert at a date with rate A, retain the result, then
simulate supersession (A → `SUPERSEDED`, B `ACTIVE` over the same window). The retained result is
unchanged (`convertedAmount`, `rate`, `fxRateId` all identical), while a **new** conversion at the
same reference date resolves B. Results are plain values and rates are immutable by the PART 01
trigger, so a retained conversion cannot silently change. No historical transaction data is
rewritten and no rate backfill exists — the conversion and reporting modules contain no
`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`.

### §9 Inverse safety

Inverse remains opt-in (`FX_INVERSE_NOT_PERMITTED` when `inversePermitted` is false, asserted
behaviourally), used only when no direct rate resolves (asserted: DIRECT wins when both exist),
marked `INVERSE` with the **stored** rate and stored pair retained (never a persisted reciprocal),
and bounded to at most one stored rate row — `gateway.findActiveCovering` is called exactly twice
(direct + reverse) with no loop over intermediate currencies, so triangulation is not expressible.

### §10 Unknown currency

UNKNOWN remains non-convertible: `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` for `null`, `undefined` and
blank, never treated as IDENTITY, IDR, base or reporting currency. Through the reporting layer it
lands in `unconvertible` as `UNKNOWN_SOURCE_CURRENCY` with `convertedTotal: null`, while
`originalCurrencyTotals` still reports the UNKNOWN group separately and unchanged.

### §11 basic-financial-reporting remediation debt

**Not repaired in FX-01, by instruction.** Recorded as separate debt:

> **Suggested future CR: `CR-BE-FIN-RPT-01` — Currency-Safe Basic Financial Reporting.**
>
> `basic-financial-reporting` sums `tenant_charges`, `utility_bills`, `tenant_invoices`,
> `invoice_payment_status`, `vendor_service_costs` and `basic_expenses` with no currency filter or
> grouping, then computes `netBilled = billedIncome − operationalCost` across those sources — a
> mixed-currency grand total of the kind governance §10 forbids. It predates FX-01 (CUR-01 §2 G-03
> and CUR-02 already noted these tables were currencyless until PART 01/02 added snapshots).

**FX-01 must not convert on top of that aggregate.** A committed guard test asserts no FX symbol
appears in any `basic-financial-reporting` file, that the aggregate is still ungrouped by currency
(i.e. unchanged by FX-01), and that this governance record names `CR-BE-FIN-RPT-01`. The guard will
fail loudly if anyone integrates FX before the remediation lands.

### §12 Report export safety

All three renderers (`csv-renderer.ts`, `xlsx-renderer.ts`, `pdf-renderer.ts`) are asserted free of
FX symbols **and** of `currency` / `referenceDate` / `fxPolicy` — so no rate lookup, no conversion
arithmetic, no rate-date selection and no policy lookup occurs in a renderer. The entire 12-file
export module is asserted free of FX. Renderers remain pure consumers of the canonical snapshot;
should an export ever carry converted reporting data it must receive the already-governed snapshot.

### §13 Provider boundary

Still `MANUAL_TREASURY` only — in `FX_RATE_SOURCES` and in the `0333`
`source IN ('MANUAL_TREASURY')` CHECK. No file in `src/modules/fx-rates/` contains
`BANK_INDONESIA`, `setInterval`, `due-job-scheduler` or `fetch(`. No ingestion worker, poller or
scheduler registration exists. Provider integration remains a future CR.

### §14 Event vocabulary debt (non-blocking)

`FX_RATE_APPROVED` is **retained** and not renamed to `FX_RATE_ACTIVATED`. No migration was consumed
for vocabulary cleanup. A test asserts the five-event vocabulary is unchanged, that
`FX_RATE_APPROVED` is present and `FX_RATE_ACTIVATED` is absent from both the type union and the
`0333` CHECK. Recorded as **non-blocking governance debt**: renaming would require widening the
CHECK (a migration) plus migrating existing rows.

### §15 Permission safety

- `fx_rate.approve` remains in `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (asserted), alongside
  `operational_budget.override`, `rfq.award` and `price_catalog.override`.
- `fx_rate.manage` and `fx_rate.read` are **not** withheld — proposing and reading are not
  exceptional.
- Exactly five FX permissions exist: `fx_rate.read`, `fx_rate.manage`, `fx_rate.approve`,
  `client_fx_policy.read`, `client_fx_policy.manage` (asserted against the real catalogue).
- **No new role**: the seed still defines exactly one role constant, `PLATFORM_ADMIN`.
- `client_fx_policies` is keyed on `client_id` alone with **no `building_id` column** (asserted
  against the migration DDL), so no Building override exists.

### §16 OpenAPI decision

**No OpenAPI change.** A direct mismatch check was run rather than assumed: the 10 registered FX
routes and the 10 documented operations match exactly after `:param` → `{param}` normalisation, with
**zero** `x-required-permission` mismatches and **zero** unresolved `$ref`s across the whole 657-path
contract. No conversion, quote, reporting or provider endpoint was added.

### Migration decision

**No migration. `0333` remains the highest (333 files); `0334` was not consumed.** PART 05 changed no
schema.

### Validation RUN

- `tests/fx05-part05-cross-module-safety.test.ts` — **44 tests, 44 pass, 0 skipped**, all
  dependency-free. Covers every §17 requirement: FX not imported into RFQ/quotation/comparison/
  award/PO/price-catalog; not into budget/commitment/binding/variance; not into tenant invoice
  equality; not into material or vendor actualization; the exact sanctioned file set; each
  exact-currency guard present and FX-free; zero repo-wide rate arithmetic; `applyRate` exclusivity;
  single consumer; original values authoritative; additive reporting; no partial grand total; no
  audit from transient or reporting conversion; `fx_rate_events` and policy-event writer isolation;
  no converted-amount column; no ledger; no `0334`; supersession safety (behavioural); inverse
  policy-gating and single-rate bound (behavioural); UNKNOWN non-convertible (behavioural and via
  the reporting layer); renderers pure; `basic-financial-reporting` FX-free with the remediation CR
  named; provider `MANUAL_TREASURY` only; `fx_rate.approve` unassigned; single role; Client-scoped
  policy with no Building column; and no new public FX surface.
- **PART 01 / 02 / 03 / 04 dependency-free regression** — **34/34**, **36/36**, **47/47**, **33/33
  pass**. PART 03's conversion tests remain fully passing, as required.
- Combined FX suite: **245 tests → 194 pass, 0 fail, 51 skipped**.
- **Mutation-verified**: the arithmetic guard and the FX-import guard were each broken on purpose
  (hand-rolled `amount * rate` injected into `vendor-invoice.service.ts`, an `fxConversionService`
  import injected into the same file, and arithmetic injected into the reporting layer). All three
  injections fail the suite; all were reverted, and `git diff -- src/` is empty.
- `git diff --check` — **PASS** (unstaged, staged, and `644315d..HEAD`).

### Validation NOT RUN (recorded, never claimed as passing)

- `npm run typecheck` — **NOT RUN.** `node_modules` absent, no `tsc` anywhere on this system,
  installation prohibited.
- `tests/fx01-part01-fx-rate-authority.test.ts` (27) and
  `tests/fx02-part02-fx-rate-lifecycle.test.ts` (24) — **NOT RUN: all 51 SKIP**, no PostgreSQL.
  The database-enforced invariants behind the guards verified statically here remain unexecuted.
- Repository OpenAPI contract tests — **NOT RUN** (need `tsx` + `yaml`). The contract check above
  used an out-of-tree YAML parser in `/tmp`; nothing was added to `package.json`,
  `package-lock.json` or `node_modules`.
- No `npm ci`, no broad repository regression, no CI, no migration execution, no PR, no merge.

### PART 06 readiness

**PART 06 — OpenAPI + Closure: READY TO START.**

PART 06 inherits a verified state rather than having to re-derive it:

- The public FX surface is already complete and contract-consistent (10 routes, 10 documented
  operations, zero permission mismatches, zero unresolved `$ref`s), so PART 06 should need **no new
  paths** — only the closure narrative, the final review and the readiness record.
- The safety invariants are now executable: any future FX wiring into a transactional or control
  module, any duplicate arithmetic, any audit-flood path, any FX integration into
  `basic-financial-reporting`, or any new provider will fail a committed test.
- Two items are carried into PART 06 as recorded debt, neither blocking: the
  `FX_RATE_APPROVED` → `FX_RATE_ACTIVATED` vocabulary question (§14) and
  **`CR-BE-FIN-RPT-01` — Currency-Safe Basic Financial Reporting** (§11).

**`0334` remains unconsumed**, and MATERIALIZED FX CONVERSION remains NOT REQUIRED.

---

## PART 06 implementation notes (2026-08-25)

**Status: PART 06 COMPLETE — CR-BE-FX-01 CLOSED.** Baseline for this PART: `ab8e386` (PART 05).

PART 06 is a closure and contract-verification PART. **No new FX capability was added and no path
change was made**, because the runtime and the contract were already aligned and no defect was found.

### §1 Public surface verified — no path change

Ten registered operations, ten documented operations, exact match:

```
GET    /fx-rates                          fx_rate.read
POST   /fx-rates                          fx_rate.manage
GET    /fx-rates/{rateId}                 fx_rate.read
GET    /fx-rates/{rateId}/events          fx_rate.read
POST   /fx-rates/{rateId}/approve         fx_rate.approve
POST   /fx-rates/{rateId}/reject          fx_rate.approve
POST   /fx-rates/{rateId}/supersede       fx_rate.approve
POST   /fx-rates/{rateId}/deactivate      fx_rate.approve
GET    /clients/{clientId}/fx-policy      client_fx_policy.read
PUT    /clients/{clientId}/fx-policy      client_fx_policy.manage
```

Public capability is exactly **FX rate lifecycle / read + Client FX Policy read/write**. There is
**no** conversion, quote, reporting-conversion, resolve, ingest, provider or dashboard endpoint —
asserted against both the route file and the parsed contract. Because runtime and OpenAPI already
aligned, **no path was added, changed or removed**.

### §2 Contract alignment — verified three ways

Every FX enum was compared across **OpenAPI ↔ runtime TypeScript union ↔ the `0333` CHECK
constraint**, and all four match exactly:

| Enum | Values | OpenAPI == runtime == DB |
|---|---|---|
| `FxRateStatus` | `PENDING_APPROVAL`, `ACTIVE`, `REJECTED`, `SUPERSEDED`, `INACTIVE` | ✅ |
| `FxRateType` | `REFERENCE` | ✅ |
| `FxRateSource` | `MANUAL_TREASURY` | ✅ |
| `FxRateEventType` | `FX_RATE_CREATED`, `FX_RATE_APPROVED`, `FX_RATE_REJECTED`, `FX_RATE_SUPERSEDED`, `FX_RATE_DEACTIVATED` | ✅ |

Schema shapes also match across all three layers: `FxRate` is **26 fields** in the `0333` DDL, the
runtime type and the OpenAPI properties — identical sets, no extras on either side. `ClientFxPolicy`
likewise matches at **10 fields**, including the frozen staleness/effective policy field
`maxStalenessDays`. `SetClientFxPolicyRequest` documents `fxEnabled` and `inversePermitted` with
`default: false`, so the fail-closed behaviour is truthful in the contract. `SupersedeFxRateRequest`
has **no currency fields** and `rate` is optional, truthfully describing the inherited-pair,
window-only-correction semantics.

The canonical convention **`1 BASE = RATE × QUOTE`** appears in the `FX` tag, in the `FxRate`
description ("QUOTE units per ONE unit of BASE"), and `rate` is typed as **`string`** in both
`FxRate` and `CreateFxRateRequest` so a `NUMERIC(24,12)` ratio can never reach a client as a float.

Maker-checker is stated truthfully: the approve operation documents "the approver must not be the
maker, otherwise 409 `FX_RATE_SELF_APPROVAL`", documents `FX_RATE_ACTIVE_WINDOW_CONFLICT` and a `409`
response, and the create operation documents that a proposed rate "is NOT usable by any consumer
until a different authorized user approves it".

### §3 Permission contract

Documented `x-required-permission` values match the runtime `requirePermission(...)` guards
one-for-one, with zero mismatches. Exactly five FX permissions exist
(`fx_rate.read`, `fx_rate.manage`, `fx_rate.approve`, `client_fx_policy.read`,
`client_fx_policy.manage`), all matching `^(fx_rate|client_fx_policy)\.(read|manage|approve)$`.
**`fx_rate.approve` remains in `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`**; `manage` and `read` are
not withheld. **No role was added** — the seed still defines exactly one role constant.

### §4 Conversion authority closure

**`fxConversionService.convert` is the single runtime conversion authority.** It alone owns rate
resolution, the `DIRECT` / `INVERSE` / `IDENTITY` decision, staleness, target precision, `HALF_UP`
rounding and provenance construction. Both arithmetic operations live inside `applyRate`. The only
consumer in the whole repository is `fx-reporting.service.ts`. **No public conversion endpoint
exists.**

### §5 Reporting integration closure

The actual PART 04 integration is **`currency-reporting` only**. Converted reporting is:

- **additive** — `originalCurrencyTotals` is always returned alongside, never replaced;
- **read-side** — no writes, no persistence, no audit emission;
- **original-currency preserving** — the CUR-01 exact-currency seam is byte-identical and still
  groups by `currency_code` with its UNKNOWN bucket;
- **provenance carrying** — full PART 03 provenance per component, with no report-level rate;
- **complete-or-null** — `convertedTotal` is `COMPLETE` or `null`; no partial subtotal exists.

Operational controls remain exact-currency (every guard re-asserted in §7 below), and **no report
renderer performs FX**.

### §6 MATERIALIZED FX CONVERSION = NOT REQUIRED (final decision for FX-01)

Confirmed by direct inspection:

- **no** `fx_conversion_ledger` / `fx_conversions` anywhere in `src/` or `docs/api/`;
- **no** converted monetary persistence — no migration contains `converted_amount`,
  `reporting_amount` or `converted_currency`;
- **no** `0334`;
- **no** transaction-table `fx_rate_id` — the only two occurrences in `0333` are the
  `fx_rate_events` column and its index;
- **no** conversion audit flood — the conversion service, its gateway and the reporting service
  contain no `recordOperitionalEvent`, no `fxRateEventRepository` and no `INSERT`/`UPDATE`/`DELETE`.

**None of these were created in closure.**

### §7 Exact-currency boundaries reconfirmed

PART 05's findings were re-verified in this PART by an independent test. FX does **not** alter:
procurement currency equality (RFQ↔quotation, quotation↔comparison, award↔PO, PO↔vendor invoice),
Price Catalog matching (`CURRENCY_INCOMPATIBLE`), Budget/Commitment matching, actualization currency
matching (vendor and material), tenant invoice currency equality, utility transactional currency, or
payment currency controls. **No transactional conversion is authorized by FX-01.**

### §8 Provider boundary

**`MANUAL_TREASURY` only**, in `FX_RATE_SOURCES` and in the `0333` `source IN ('MANUAL_TREASURY')`
CHECK. No Bank Indonesia integration, no external FX API, no scheduled ingestion, no polling, no
provider worker: no file in `src/modules/fx-rates/` contains `BANK_INDONESIA`, `EXTERNAL_API`,
`setInterval`, `setTimeout`, `due-job-scheduler`, `due-job-dispatcher` or `fetch(`. Future provider
integration requires separate governance.

### §9 Governance debt carried forward (deliberately not fixed)

| # | Debt | Status | Why not fixed here |
|---|---|---|---|
| **A** | `FX_RATE_APPROVED` event vocabulary versus the earlier `FX_RATE_ACTIVATED` wording in the PART 02 instruction | **OPEN, non-blocking** | Renaming requires widening the `0333` `fx_rate_events_event_type_check` CHECK (a migration) plus migrating existing rows. `FX_RATE_APPROVED` is retained and the activation event carries `metadata.lifecycleAction: 'ACTIVATE'`. No migration consumed for vocabulary cleanup. |
| **B** | **`CR-BE-FIN-RPT-01` — Currency-Safe Basic Financial Reporting** | **OPEN, separate CR** | `basic-financial-reporting` is a **pre-existing** mixed-currency aggregate: it sums `tenant_charges`, `utility_bills`, `tenant_invoices`, `invoice_payment_status`, `vendor_service_costs` and `basic_expenses` with no currency filter or grouping, then computes `netBilled = billedIncome − operationalCost` across those sources. It **remains deliberately excluded from FX integration** until remediated; a committed guard fails loudly if FX is wired into it first. |

### §10 Historical compatibility

- Transaction currency snapshots are **untouched** — `0333` contains no `UPDATE`, `DELETE` or
  `TRUNCATE`, and the only `ALTER TABLE` is the window-exclusion constraint on its own `fx_rates`.
- **CUR-02 historical UNKNOWN remains non-convertible**: `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` at the
  authority, `UNKNOWN_SOURCE_CURRENCY` in reporting. Never IDR, never the Client base, never the
  reporting currency, never identity.
- **Rates never rewrite historical transactions** — no FX module performs a write of any kind.
- **Rate supersession does not mutate retained conversion provenance** — provenance copies the rate
  as stored and keeps `fxRateId`; PART 05 proved behaviourally that a retained result is unchanged
  after supersession while a new conversion resolves the current ACTIVE rate.
- **No FX backfill.**

### §11 Final FX-01 migration set

**`0333_create_fx_rate_authority_and_client_fx_policy` only.** Confirmed: `0334` does not exist; the
registry holds 333 migrations with `migration0333CreateFxRateAuthorityAndClientFxPolicy` last and
registered exactly once (import + array entry); no conditional ledger migration was ever needed.
`0331`/`0332` belong to CUR-01 and were not modified by FX-01.

### Final closure matrix

| Area | Authority | FX behavior | Persistence | Audit | Status |
|---|---|---|---|---|---|
| Rate authority | `fx_rates` (`0333`) | Governed lifecycle; `1 BASE = RATE × QUOTE`; immutable business fields; correction by supersession only | Rate rows + append-only `fx_rate_events` | `fx_rate_events`, five event types | **CLOSED** |
| Client policy | `client_fx_policies` (`0333`) | Fail closed; reporting currency must equal the Client base; no Building override | Policy row | `operational_events` (`CLIENT_FX_POLICY_SET` / `_CHANGED`) | **CLOSED** |
| Conversion | `fxConversionService` (PART 03) | Single authority; DIRECT / INVERSE / IDENTITY; staleness; `HALF_UP`; full provenance | **None** (TRANSIENT) | **None** per conversion | **CLOSED** |
| Reporting | `fxReportingService` + `currency-reporting` (PART 04) | Additive reporting-currency view; complete-or-null total; unconvertible reasons | **None** | **None** per component | **CLOSED** |
| Procurement | RFQ / quotation / comparison / award / PO | **Exact-currency only**; FX not imported | Unchanged | Unchanged | **UNCHANGED** |
| Budget / Commitment | `operational-finance` | **Exact-currency only**; no FX-based eligibility, matching or variance decision | Unchanged | Unchanged | **UNCHANGED** |
| Tenant billing | `tenant-charges` / `tenant-invoices` | **Exact-currency only**; header = every line, fail closed | Unchanged | Unchanged | **UNCHANGED** |
| Utility | tariff → calculation → bill | **Exact-currency only**; inherited snapshots | Unchanged | Unchanged | **UNCHANGED** |
| Export | `reporting-export` (12 files) | **No FX at all**; renderers are pure consumers of the canonical snapshot | Unchanged | Unchanged | **UNCHANGED** |
| Provider | `fx_rates.source` | **`MANUAL_TREASURY` only**; provider may propose, never activate | None | None | **CLOSED (future CR)** |
| Materialized conversion | — | **NOT REQUIRED** | **No ledger, no `0334`, no `fx_rate_id` on any transaction table** | **No conversion audit** | **CLOSED — NOT REQUIRED** |

### Final non-goals (binding, unchanged)

FX-01 is **not** and must not become:

- a treasury management platform;
- hedging;
- GL revaluation;
- realized/unrealized FX accounting;
- automatic transaction conversion;
- provider integration;
- a materialized conversion ledger.

Also excluded and recorded: forex trading, bank reconciliation, payment-gateway behaviour, automatic
repricing, automatic PO/invoice currency conversion, triangulation, and any mixed-currency document
header or total.

### §12 Validation

**RUN**

- `tests/fx06-part06-closure.test.ts` — **48 tests, 48 pass, 0 skipped**, dependency-free. Covers the
  public surface, three-way enum alignment (OpenAPI ↔ runtime ↔ `0333`), schema-shape equality for
  `FxRate` and `ClientFxPolicy`, fail-closed documented defaults, supersession contract, the
  permission contract, maker-checker truthfulness, conversion-authority closure, reporting closure,
  materialized-conversion absence, all ten exact-currency guards, the provider boundary, both
  governance-debt items, historical compatibility and the final migration set.
- **FX-01 dependency-free regression, all PARTs** — PART 01 **34/34**, PART 02 **36/36**, PART 03
  **47/47**, PART 04 **33/33**, PART 05 **44/44**, PART 06 **48/48**. Combined **293 tests → 242
  pass, 0 fail, 51 skipped**.
- **OpenAPI structural verification against a real YAML parse** — the contract parses as OpenAPI
  3.0.3 with 657 paths; **8,807 `$ref`s checked, all resolve**; exactly 8 FX paths and 10 operations;
  every FX operation declares a valid permission; 13 schemas, 6 responses and 2 parameters present;
  `rate` typed as `string` in both schemas; no conversion/quote/resolve/ingest path.
- `git diff --check` — **PASS** (unstaged, staged, and `ab8e386..HEAD`).

**NOT RUN** (recorded, never reported as PASS)

- `npm run typecheck` — **NOT RUN.** `node_modules` is absent, no `tsc` exists anywhere on this
  system, and dependency installation is prohibited. Type errors are **not** machine-verified.
- `tests/fx06-part06-openapi-contract.test.ts` — **NOT RUN.** It uses the repository's `yaml`-based
  OpenAPI convention and cannot load without `node_modules`. Every one of its assertions was
  nevertheless executed against a real YAML parse using an out-of-tree parser, and all passed; the
  file is committed so CI runs it. Nothing was added to `package.json`, `package-lock.json` or
  `node_modules`.
- `tests/fx01-part01-fx-rate-authority.test.ts` (27) and
  `tests/fx02-part02-fx-rate-lifecycle.test.ts` (24) — **NOT RUN: all 51 SKIP**, no PostgreSQL. The
  database-enforced invariants behind the statically verified contract remain unexecuted.
- No `npm ci`, no broad repository regression, no CI, no migration execution, no PR, no merge.

### §14 Final review readiness

No direct FX-01 defect remains. Contract and runtime are aligned; no path change was required; all
six PARTs' dependency-free suites pass with zero failures.

**CR-BE-FX-01 = READY FOR FINAL REVIEW.**

No PR created. Two governance-debt items are carried forward as recorded, non-blocking, and
explicitly out of FX-01 scope: **(A)** the `FX_RATE_APPROVED` / `FX_RATE_ACTIVATED` vocabulary
question, and **(B)** `CR-BE-FIN-RPT-01` — Currency-Safe Basic Financial Reporting.

---

## FINAL REVIEW (2026-08-25)

**Result: READY FOR MERGE WITH RECORDED LIMITATIONS.** Scope was CR-BE-FX-01 only — no
whole-repository re-audit and no broad regression. Baseline reviewed: `22122ed` (PART 06).

### Checklist findings

Every item was re-verified independently against source, migration DDL, the permission seed and the
parsed OpenAPI contract — not taken from earlier PART notes.

| # | Check | Result |
|---|---|---|
| 1 | PART 01–06 complete | ✅ All six PART note sections present; PART 06 marked COMPLETE |
| 2 | `0333` registered exactly once | ✅ 1 import + 1 array entry; migration `id` declared once; no duplicate migration ids in the registry |
| 3 | No `0334` | ✅ Absent; 333 migrations, highest `0333` |
| 4 | Canonical convention `1 BASE = RATE × QUOTE` | ✅ Present in the conversion service, lifecycle service and request validation; **no competing convention anywhere in `src/`** |
| 5 | `fx_rates` / `fx_rate_events` / `client_fx_policies` aligned | ✅ All three created by `0333`; all four enums match **OpenAPI ↔ runtime union ↔ DB CHECK** exactly |
| 6 | Maker-checker enforced | ✅ DB CHECK `approved_by_user_id <> created_by_user_id` **plus** two service-level guards (approve, supersede) |
| 7 | Active-window overlap fail-closed | ✅ `EXCLUDE USING gist` over `(base, quote, rate_type, tstzrange('[)'))` `WHERE status='ACTIVE'`; SQLSTATE `23P01` mapped to `FX_RATE_ACTIVE_WINDOW_CONFLICT` |
| 8 | `fx_rate.approve` UNASSIGNED BY DEFAULT | ✅ In `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`; exactly one role (`PLATFORM_ADMIN`) |
| 9 | Single conversion authority | ✅ `fxConversionService`; only consumer is `fx-reporting.service.ts`; `applyRate` is the sole arithmetic site |
| 10 | DIRECT / INVERSE / IDENTITY intact | ✅ All three modes present |
| 11 | No triangulation | ✅ Exactly two `gateway.findActiveCovering` calls (direct + reverse); no intermediate-leg loop |
| 12 | No latest-rate fallback | ✅ No `ORDER BY`/`LIMIT` in the conversion service, and `findAllActiveCovering` has neither |
| 13 | No public conversion/quote endpoint | ✅ Ten routes, none conversion/quote/resolve/ingest; zero such paths in OpenAPI |
| 14 | Reporting integration = `currency-reporting` only | ✅ Only the PART 04 adapter consumes `fxReportingService` |
| 15 | Original-currency outputs preserved | ✅ CUR-01 seam still `GROUP BY currency_code` with its UNKNOWN bucket, byte-identical |
| 16 | `convertedTotal` complete-or-null | ✅ Returned only when `unconvertible.length === 0`; no `convertedSubtotal`/`partialTotal` |
| 17 | UNKNOWN non-convertible | ✅ `FX_UNKNOWN_CURRENCY_NOT_CONVERTIBLE` → `UNKNOWN_SOURCE_CURRENCY` |
| 18 | No FX in transactional exact-currency controls | ✅ Zero FX imports across all 20 reviewed authorities |
| 19 | No conversion persistence | ✅ No `converted_amount`/`reporting_amount`/`converted_currency` in any migration |
| 20 | No `fx_conversion_ledger` | ✅ Absent from `src/` and `docs/api/` |
| 21 | No audit flood | ✅ Conversion service, gateway and reporting service contain no audit call and no SQL write; `fx_rate_events` written only by the lifecycle service |
| 22 | Provider `MANUAL_TREASURY` only | ✅ Type union and `0333` CHECK; no `BANK_INDONESIA`, `EXTERNAL_API`, `setInterval`, `setTimeout`, scheduler or `fetch(` in `src/modules/fx-rates/` |
| 23 | `basic-financial-reporting` excluded from FX | ✅ Zero FX integration; still ungrouped by currency (unchanged, as intended) |
| 24 | `CR-BE-FIN-RPT-01` separate debt | ✅ Recorded 5× in this document |
| 25 | `FX_RATE_APPROVED` debt recorded, not fixed | ✅ Retained in code and DDL; `FX_RATE_ACTIVATED` appears **only** in this document (0 occurrences in `src/`) |

### Fixes

**One direct FX-01 defect found and fixed.**

`src/modules/currency-reporting/reporting-currency-read-model.ts` imported `contextAccessService`
but never called it. This was more than cosmetic: a dead authorization import implies an access
check the file does not itself perform, which is exactly the kind of misleading signal a reviewer
should not have to reason about.

**Verified there was no security gap before removing it.** Authorization *is* enforced — the
function's first statement delegates to `getOperationalCurrencySummary(buildingId, actorUserId)`,
which calls `contextAccessService.assertBuildingAccess(actorUserId, buildingId)` before reading
anything, so no row is read for a Building the caller cannot reach. The import was removed and the
delegation is now spelled out in a comment naming the exact call, so the posture stays explicit
without the dead symbol.

A regression guard was added (`tests/fx01-final-review-dead-imports.test.ts`) because
`npm run typecheck` cannot run in this environment and would otherwise be the only thing catching
this class of defect. **The guard was mutation-verified**: re-adding the dead import fails the suite,
and removing it passes. Writing it also exposed a bug in the guard itself — `[-1]` is `undefined` in
JavaScript (it works in Python, where the original review scan ran), so the first version of the
check threw instead of checking; and the symbol scan initially counted a name mentioned only in a
comment as "used". Both were fixed, and the guard now fails correctly under mutation on both counts.

**Nothing else was changed.** No `0334`, no conversion ledger, no provider integration, no Bank
Indonesia or external API, no scheduler or polling, no public conversion endpoint, no FX wired into
transactional controls, no `basic-financial-reporting` remediation, no `FX_RATE_APPROVED` rename, and
no unrelated CI/KI-003 work.

### Exact tests actually run

| Suite | Tests | Result |
|---|---|---|
| `fx01-part01-fx-rate-domain.test.ts` | 34 | **34 PASS** |
| `fx02-part02-fx-rate-governance.test.ts` | 36 | **36 PASS** |
| `fx03-part03-conversion-service.test.ts` | 47 | **47 PASS** |
| `fx04-part04-reporting-currency.test.ts` | 33 | **33 PASS** |
| `fx05-part05-cross-module-safety.test.ts` | 44 | **44 PASS** |
| `fx06-part06-closure.test.ts` | 48 | **48 PASS** |
| `fx01-final-review-dead-imports.test.ts` | 3 | **3 PASS** (new) |
| **Total** | **296** | **245 pass, 0 fail, 51 skipped** |

Also run: `git diff --check` — **PASS** (unstaged, staged, and `22122ed..HEAD`); and an OpenAPI
structural verification against a real YAML parse (OpenAPI 3.0.3, 657 paths, **8,807 `$ref`s all
resolve**, 8 FX paths / 10 operations, every operation declaring a valid permission).

### Exact tests skipped / NOT RUN

- `tests/fx01-part01-fx-rate-authority.test.ts` — **27 tests, ALL SKIPPED** (no PostgreSQL).
- `tests/fx02-part02-fx-rate-lifecycle.test.ts` — **24 tests, ALL SKIPPED** (no PostgreSQL).
- `tests/fx06-part06-openapi-contract.test.ts` — **NOT RUN** (needs the `yaml` package from
  `node_modules`). Its assertions were executed against a real YAML parse with an out-of-tree parser
  and all passed; the file is committed so CI runs it.
- `npm run typecheck` — **NOT RUN.** `node_modules` absent, no `tsc` anywhere on this system,
  dependency installation prohibited. **Type errors are therefore not machine-verified**; the
  dead-import guard above covers the one failure mode it was most likely to surface.
- No `npm ci`, no dependency install, no PostgreSQL provisioning, no broad repository regression, no
  CI.

**Skipped tests are reported as skipped, never as PASS.** The database-enforced invariants (FK
behaviour, CHECK violations, the GiST exclusion, the immutability and append-only triggers, the
deferred policy trigger, `migrateDown`/`migrateUp` reversibility) remain **unexecuted** in this
environment and are the principal residual risk.

### Migration set

**`0333_create_fx_rate_authority_and_client_fx_policy` only.** Registered exactly once. **No `0334`.**
No conditional ledger migration was ever needed. `0331`/`0332` belong to CUR-01 and were untouched.

### Exact-currency safety

Confirmed unchanged across every reviewed authority: procurement currency equality (RFQ↔quotation,
quotation↔comparison, award↔PO, PO↔vendor invoice), Price Catalog matching, Budget/Commitment
matching, actualization currency matching (vendor and material), tenant invoice currency equality,
utility transactional currency and payment currency controls. **No transactional conversion is
authorized by FX-01**, and no equality check was relaxed at any point in the CR.

### Reporting boundary

`currency-reporting` only. Converted reporting is additive, read-side, original-currency preserving,
provenance carrying, and complete-or-null. No report renderer performs FX; the CSV/XLSX/PDF renderers
remain pure consumers of the canonical snapshot.

### Provider boundary

`MANUAL_TREASURY` only, in both the runtime union and the `0333` CHECK. No ingestion, polling,
scheduler or worker exists. A future provider may propose but never activate. Provider integration
requires separate governance.

### Governance debts carried into merge

| # | Debt | Blocking? | Owner |
|---|---|---|---|
| A | `FX_RATE_APPROVED` versus the earlier `FX_RATE_ACTIVATED` wording | **No** | Renaming needs a CHECK widening (migration) plus row migration; deliberately not done in FX-01 |
| B | **`CR-BE-FIN-RPT-01` — Currency-Safe Basic Financial Reporting** | **No** | `basic-financial-reporting` is a pre-existing mixed-currency aggregate; excluded from FX until remediated, with a committed guard that fails loudly if FX is wired in first |
| C | Database-backed FX suites unexecuted in this environment | **No** (environmental) | Run `tests/fx01-part01-fx-rate-authority.test.ts` and `tests/fx02-part02-fx-rate-lifecycle.test.ts` with PostgreSQL provisioned |

### Merge readiness

**READY FOR MERGE WITH RECORDED LIMITATIONS.**

- All 25 checklist items verified; one direct defect found and fixed with a mutation-verified guard.
- 245 dependency-free tests pass, 0 fail.
- Contract and runtime aligned; no path change required; OpenAPI parses with zero unresolved `$ref`s.
- Limitations: (i) typecheck not run — no compiler available; (ii) 51 database-backed tests skipped —
  no PostgreSQL; (iii) two governance debts (A, B) carried forward, both non-blocking and explicitly
  out of FX-01 scope.

None of these is an FX-01 code defect. **Not merged** — awaiting human review.

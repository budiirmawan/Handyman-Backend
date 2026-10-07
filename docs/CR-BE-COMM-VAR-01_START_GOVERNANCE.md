# CR-BE-COMM-VAR-01 — START GOVERNANCE

**Title:** Budget vs Committed vs Actual (Operational Cost Control & Variance)
**Status:** START GOVERNANCE recorded. **PART 01 implemented** (see §21). PARTs 02–06 not started.
**Inspection date:** 2026-08-23 (UTC)
**Repository:** `budiirmawan/Asentra-Backend`
**Working branch:** `arena/01a02ee6-asentra-backend`
**Authority baseline:** `main` at `f7c54b1dcffd4d2bacafa07cb93a3ffe878df6f4` (merge of PR #60, CR-BE-AUDIT-01)
**Latest migration on baseline:** `0309_add_operational_event_correlation`

> This document records the smallest correct backend extension for
> `Budget → Committed → Actual → Variance`. It is deliberately an extension of
> the already-merged CR-BE-FIN-01 Operational Finance authority, not a new
> finance platform. It does not propose a general ledger, accounts payable,
> FX engine, or ERP replacement.

---

## 0. Decision summary

| # | Decision | Governance position |
|---|---|---|
| 1 | Budget authority | **Reuse** `operational_budgets` + `operational_budget_categories` (migrations 0283/0285). No new budget table, no budget-line model, no client-level budget. |
| 2 | Budget ambiguity | Already structurally solved by the existing GiST exclusion constraint: one live (`DRAFT`/`ACTIVE`) budget period per Building. `(building_id, date)` resolves to at most one budget. **No new selection heuristic.** |
| 3 | Cost category | **Reuse** `operational_budget_categories` (per-budget `category_code`). **No** client-level cost-category master and **no** chart of accounts in this CR. Category is always **explicitly supplied**, never inferred. |
| 4 | Commitment authority | **New** `operational_commitments` header + `operational_commitment_entries` append-only ledger. Single legitimate automatic commitment source = **ISSUED Purchase Order line** (`purchase_order_lines`, the only priced, approved, pre-actual obligation in the repository). A bounded **manual/estimated** commitment is permitted for scopes with no priced authority, and is explicitly marked as such. |
| 5 | Rejected commitment sources | Approved **Material Request** (`material_requests.approved_quantity`) carries **no price** — it is a quantity authority only and **cannot** be a monetary commitment authority. Work Order has **no** estimate/cost column at all. Vendor Work / SPK (`work_contracts`) carry **no amount**. Recorded as gaps, not invented. |
| 6 | Actual authority | **Reuse** the existing CR-BE-FIN-01 PART 04 eligibility rules verbatim: `FINALIZED` `basic_expenses`, `FINALIZED` `vendor_service_costs`, `FINALIZED` **and** `VERIFIED` `vendor_invoices`, costed `inventory_work_order_material_usages`. No new actual table, no estimate-derived actual. |
| 7 | Double counting | A commitment is never counted twice: actual lineage is linked to its commitment (`commitment_id` on the existing `operational_budget_source_bindings`), and the ledger reduces open commitment by the actualized amount. Legacy `PURCHASE_ORDER` / `PO_LINE` source bindings and ledger commitments are **mutually exclusive** per PO/PO line. |
| 8 | Variance formula | `Available Budget = Planned − OpenCommitment − Actual`, where `OpenCommitment = CommittedAmount − ActualizedAmount − ReleasedAmount`. `Variance = Planned − Actual`. |
| 9 | Concurrency / overspend | `withTransaction` + `SELECT ... FOR UPDATE` on the `operational_budgets` row, recheck of available budget inside the lock, **overspend rejected by default (HTTP 409)**. Override only via a new explicit permission plus a mandatory recorded reason. Never silent. |
| 10 | Correction model | No destructive mutation after `COMMITTED`. Correction only via signed **adjustment**, **release**, **reversal** ledger entries. Cancellation forbidden once partially actualized (release the remainder instead). |
| 11 | Monetary model | One currency per budget chain. `NUMERIC(18,2)`, existing 9-code ISO 4217 whitelist, half-up rounding, all ledger arithmetic in SQL `NUMERIC`. **No FX engine, no conversion.** |
| 12 | Read model | Derived read model over budget + ledger + eligible sources. **No materialized balance table.** Existing fail-closed exclusion contract is preserved and extended. |
| 13 | RBAC | Reuse `operational_budget.read` / `operational_budget.manage`. Exactly **one** new permission proposed: `operational_budget.override` (overspend override). Necessity argued in §13. |
| 14 | Audit | Reuse `recordOperationalEvent` and the CR-BE-AUDIT-01 correlation authority (`request_id`, `source`). No second audit store. |
| 15 | Scheduler | **None.** All balances are transaction-driven and read-derived. No timer is added. |
| 16 | Historical data | **No backfill.** Pre-CR POs, material usages and source bindings keep their current read-time semantics. Any adoption is a separate, explicit CR. |

---

## 1. Objective

Provide the smallest correct backend extension for enterprise operational cost
control so that Asentra can answer, per Client / Building / period / cost
category:

1. What budget was approved? → `operational_budgets.planned_amount` (ACTIVE).
2. How much has already been committed? → open commitment from the new ledger.
3. How much has actually been incurred? → eligible authoritative operational
   cost transactions (unchanged authorities).
4. What remains available? → `Planned − OpenCommitment − Actual`.
5. Where is the variance? → per category, per period, per Building.
6. Which Work Order / Vendor / Material / transaction caused it? → existing
   typed lineage (`operational_budget_source_bindings`) plus the new
   commitment→actual link.

This CR is **financial/operational control**, not accounting.

---

## 2. Repository authority map

Every row below was verified in the repository at the baseline commit. Nothing
in this section is assumed.

### 2.1 Tenancy, isolation, context

| Authority | Evidence |
|---|---|
| Client | `0012_create_clients.ts`; `src/modules/clients` |
| Property → Building | `0017_create_properties.ts`, `0018_create_buildings.ts`; `src/modules/buildings`, `src/modules/properties` |
| Building assignment | `0019_create_user_building_assignments.ts`, `0030_create_workforce_building_assignments.ts` |
| Organization / context isolation | `0020_create_organizations.ts`; `src/modules/context-access` (`contextAccessService.assertBuildingAccess`), `src/modules/structure-context`, `docs/data-isolation.md`, `docs/effective-context.md` |
| Client resolution rule | `operational-finance.service.ts::resolveBuildingClient` — Client is derived Building → Property → Client and is **never** caller-supplied. This is the pattern this CR must follow. |
| Management read scope | `src/modules/management-read-scope` (`resolveManagementReadScope`) |

### 2.2 Maintenance / Work Order

| Authority | Evidence |
|---|---|
| Work Request | `0081_create_work_requests.ts` |
| Work Order | `0082_create_work_orders.ts` + `0083`–`0089` (priority/lifecycle, asset/location, assignments, actions, evidence, completion, verification) |
| **Work Order cost/estimate** | **ABSENT.** `grep -i "cost\|amount\|estimat\|price" src/database/migrations/008[2-9]*.ts` returns nothing. Work Order carries no monetary field of any kind. |
| WO ↔ procurement binding | `0183_create_work_order_procurement_bindings.ts`, `0273_add_wo_procurement_spk_binding.ts` |
| WO history / events | `src/modules/work-order-history`, `operational_events` |

### 2.3 Vendor / contractor execution

| Authority | Evidence |
|---|---|
| Vendor master | `0054_create_vendors.ts` (+ `0055`–`0062`) |
| Vendor Work (execution) | `0156_create_vendor_works.ts`, `0163_add_vendor_work_verification.ts`, `0165_add_vendor_work_history.ts` — **no amount column** |
| Vendor completion / service report | `0160`, `0161` — no amount |
| Vendor BAST | `0162`, `0226`, `0259`, `0260` — no amount |
| **Vendor Service Cost** | `0201_create_vendor_service_costs.ts` — `cost_amount NUMERIC`, `cost_date`, free-text `cost_type` / `cost_category`, `status DRAFT → FINALIZED → CANCELLED`, append-only `vendor_service_cost_history`. **No currency column.** |
| **Vendor Invoice** | `0261_create_vendor_invoices.ts` (+ `0262` verification, `0263` payment, `0274` procurement linkage) — `currency`, `invoice_amount NUMERIC(18,2)`, `DRAFT → FINALIZED → CANCELLED`, `verification_status`, generated `outstanding_amount` |
| SPK / Work Contract | `0272_create_work_contracts.ts` — execution mandate off an ISSUED PO. Explicitly **"carries no quantity, no amount ledger"** |

### 2.4 Procurement / purchase

| Authority | Evidence |
|---|---|
| Purchase Request | `0176_create_purchase_requests.ts` — no price |
| Material Request | `0177_create_material_requests.ts` — `quantity`, `uom_id`, **no price**; `0265_add_material_request_approved_quantity.ts` adds `approved_quantity`, `approved_at`, `approved_by_user_id`, status `OPEN → APPROVED → CANCELLED` |
| Service Request | `0178_create_service_requests.ts` — no price |
| Procurement approval binding | `0179_create_procurement_approval_bindings.ts` |
| Vendor selection / PO readiness | `0180`, `0181` |
| **Purchase Order** | `0269_create_purchase_orders.ts` — `currency`, `status DRAFT → ISSUED → CANCELLED`, `purchase_order_history`; `0271_add_purchase_order_issuance.ts` |
| **Purchase Order Line** | `0270_create_purchase_order_lines.ts` — `unit_price NUMERIC(18,2)`, `line_amount NUMERIC(18,2)`, `quantity_snapshot`, one originating `material_request_id` **or** `service_request_id` |
| Receiving | `0182_create_receivings.ts`, `0264_add_receiving_material_request_binding.ts` — **no price** (verified by grep) |

**Conclusion:** the **only** priced, approved, pre-actual obligation in the
repository is the **ISSUED Purchase Order line**.

### 2.5 Inventory / material chain

| Authority | Evidence |
|---|---|
| Item / Warehouse / Balance / Movement | `0166`–`0169`; movement doc states "movement INSERT and balance UPDATE in same transaction with `SELECT FOR UPDATE`" |
| WO material usage | `0174_create_inventory_work_order_material_usages.ts` |
| **WO material operational cost** | `0267_add_wo_material_usage_cost.ts` — `unit_cost`, `total_cost GENERATED ALWAYS AS (quantity * unit_cost) STORED`, `currency` (9-code whitelist), `cost_source`, `cost_reference`. Rows are immutable. Cost is **nullable**; `cost_source` defaults to `'MANUAL'` in `inventory-wo-material-usage.service.ts`. |
| Usage ↔ movement / MR / reservation | `0268`, `0288`, `0290` |
| Material reservation | `0287_create_inventory_material_reservations.ts` — `ACTIVE → RELEASED / CANCELLED`, quantity only, **no money**; `0289_add_material_reservation_consumption.ts` |
| UOM snapshots | `0266_add_operational_uom_snapshots.ts` |

**Conclusion:** the material chain is a **quantity** chain end-to-end. Money
enters at exactly one point: `inventory_work_order_material_usages.unit_cost`
at issue time. There is no item standard cost and no receiving price.

### 2.6 Existing financial / Lite-ERP foundations (CR-BE-FIN-01 — already merged)

This is the single most important inspection result: **a Budget / Committed /
Actual / Variance capability already exists in a manual, binding-driven form.**

| Authority | Evidence |
|---|---|
| `operational_budgets` | `0283_create_operational_budget_foundation.ts` — `client_id`, `building_id`, `period_start`, `period_end`, `currency VARCHAR(3)` (9-code whitelist), `planned_amount NUMERIC(18,2) >= 0`, `status DRAFT/ACTIVE/CLOSED/CANCELLED`, GiST `EXCLUDE` preventing overlapping live periods per Building |
| `operational_budget_categories` | same migration — `budget_id`, `category_code` (`^[A-Z][A-Z0-9_]{0,63}$`), `name`, `planned_amount >= 0`, `UNIQUE (budget_id, category_code)` |
| `operational_budgets.budget_name` | `0285_add_operational_budget_name.ts` |
| `operational_budget_source_bindings` | `0284_create_operational_budget_source_bindings.ts` — typed lineage only (`BASIC_EXPENSE`, `VENDOR_SERVICE_COST`, `VENDOR_INVOICE`, `PURCHASE_ORDER`, `PO_LINE`, `WORK_ORDER_MATERIAL`), exactly-one-source CHECK, composite scope FKs, `currency_status MATCHED/MISSING`, `status ACTIVE/REMOVED`, partial unique index per source type. **Stores no amount.** |
| Budget/category service | `src/modules/operational-finance/operational-finance.service.ts` — lifecycle, Client derivation, period-conflict mapping, `recordOperationalEvent` |
| Binding service | `operational-finance-binding.service.ts` — source eligibility, scope, currency compatibility, lineage duplicate/ambiguity rejection |
| **Read-time aggregation** | `operational-finance-aggregation.{service,repository,types}.ts` — computes `plannedAmount`, `actualAmount`, `committedAmount`, `remainingAmount`, `varianceAmount` per category and in total, with a **fail-closed** exclusion contract (9 reasons) |
| Current committed classification | `COMMITTED_SOURCE_TYPES = { PURCHASE_ORDER, PO_LINE }`; `ACTUAL_SOURCE_TYPES = { BASIC_EXPENSE, VENDOR_SERVICE_COST, VENDOR_INVOICE, WORK_ORDER_MATERIAL }` |
| Current de-duplication | `suppressDirectCostRepresentation`, `rejectAmbiguousVendorLineage`, `suppressOrRejectPoCommitments` (`PO_COMMITMENT_REPLACED_BY_ACTUAL`, `PO_HEADER_SUPERSEDED_BY_PO_LINE`) |
| Management read models | `src/modules/management-operational-finance`, `management-building-operational-finance` (already exposes `budgetUtilizationPercent`), `management-financial-summary`, `basic-financial-reporting` |
| Other money surfaces | `0195_create_tenant_charges`, `0196_create_utility_bills`, `0198_create_tenant_invoices`, `0199`/`0200` payment, `0202_create_basic_expenses`, `0278_add_utility_tariffs` — **receivable/tenant side, out of scope** |

### 2.7 Approval authorities

| Authority | Evidence |
|---|---|
| Procurement approval | `0179_create_procurement_approval_bindings.ts`, `src/modules/procurement-approvals` |
| Material Request approval | `0265` (`approved_quantity` + actor + timestamp) |
| PO issuance | `0271_add_purchase_order_issuance.ts` |
| Document / permit / tenant approvals | `0232`, `0207`, `0194`, `src/modules/management-pending-approval` |
| Finalization as approval-equivalent | `basic_expenses`, `vendor_service_costs`, `vendor_invoices` all use `FINALIZED` + actor + timestamp |
| Budget activation | `POST /operational-budgets/{id}/activate` (`operational_budget.manage`) |

**No generic approval-workflow engine exists.** This CR must not build one.

### 2.8 Events / audit

| Authority | Evidence |
|---|---|
| `operational_events` | `0080_create_operational_events.ts` |
| Correlation (CR-BE-AUDIT-01) | `0309_add_operational_event_correlation.ts` — nullable `request_id`, nullable `source` ∈ `HTTP/SCHEDULER/SYSTEM` |
| Writer | `src/modules/operational-events/index.ts` → `recordOperationalEvent(input, executor)` (scrubs sensitive keys, then the CR-BE-INTEG-01 outbox seam on the same executor) |
| Governance | `docs/CR-BE-AUDIT-01_START_GOVERNANCE.md` |
| Auth audit (separate) | `0011_create_authentication_audit_events.ts`, `src/modules/audit` |
| Domain histories | `vendor_service_cost_history`, `vendor_invoice_history`, `purchase_order_history`, `basic_expense_history` |

### 2.9 Scheduler / dispatcher

| Authority | Evidence |
|---|---|
| Scheduler | `src/modules/due-job-scheduler` — plain `setInterval`, "no cron, no queue, no Redis" |
| Dispatcher | `src/modules/due-job-dispatcher` — bounded `FOR UPDATE SKIP LOCKED` claiming |
| Other loops | `integration-outbox`, `integration-webhook-deliveries`, `evidence-retention-execution`, SLA clocks |

### 2.10 RBAC

| Authority | Evidence |
|---|---|
| Permission catalog | `src/database/seeds/foundation-access.seed.ts` (286 permission codes) |
| Existing finance codes | `operational_budget.read`, `operational_budget.manage` (lines 328–329), `basic_financial_reporting.read` (326), `purchase_order.read/manage` (279–280), `vendor_invoice.read/manage` (285–286), `material_request.read/manage` (262–263) |
| Enforcement | `requirePermission(...)` in `src/modules/auth/rbac.middleware`, plus `contextAccessService.assertBuildingAccess` inside every service |
| Recorded seed defect | comment near line 465: some codes are granted more broadly than intended (same defect class as `vendor_invoice.*`). Relevant to §13. |

### 2.11 Transaction / locking precedents

| Precedent | Evidence |
|---|---|
| Transaction helper | `src/database/transaction.ts` → `withTransaction`, re-exported from `src/database/index.ts` |
| Row-lock-then-decide | `vendor-invoice` payment (KI-001 PART 02 resolution), `bast-document.repository.ts:206,473`, `configuration-version.repository.ts:113/166/192`, `finding-escalation.repository.ts:106`, `corrective-action-responsibility` (documented lock-to-avoid-transient-unique-violation) |
| Claim-style locking | `FOR UPDATE SKIP LOCKED` in dispatcher, outbox, webhook delivery, SLA clocks, evidence retention |
| Generated column as balance authority | `vendor_invoices.outstanding_amount GENERATED ALWAYS AS (invoice_amount - paid_amount) STORED`; `wo_material_usages.total_cost` |

### 2.12 OpenAPI / migrations / CI / tests

| Authority | Evidence |
|---|---|
| OpenAPI | `docs/api/openapi.yaml`; operational-budget paths at lines 4902–5350 (13 paths already documented) |
| Migrations | `src/database/migrations/` — sequential `NNNN_snake_case.ts` exporting a `Migration`, registered in `index.ts`, every migration has `up` **and** `down`. Next free number: **0310** |
| CI | `.github/workflows/ci.yml` (full PostgreSQL regression) |
| Tests | `tests/` (386 suites). Directly relevant: `operational-budget-foundation`, `operational-budget-source-binding`, `operational-budget-aggregation`, `operational-finance-contract-validation`, `management-operational-finance`, `management-building-operational-finance`, `work-order-material-cost`, `work-order-material-issue-control`, `material-request-approved-quantity`, `inventory-material-reservations`, `purchase-order-lines`, `purchase-order-issuance`, `vendor-invoice-*` |
| Known issues | `docs/known-issues.md` — KI-001/KI-002 resolved, **KI-003 open/deferred** (legacy strict `Object.keys()` assertions). Out of scope here. |

---

## 3. Gap analysis

| # | Gap | Severity | Evidence | Resolution in this CR |
|---|---|---|---|---|
| G-01 | Commitment exists only as a **read-time reinterpretation** of a manually created PO/PO-line source binding. There is no commitment record, no lifecycle, no state. | High | `COMMITTED_SOURCE_TYPES` in `operational-finance-aggregation.service.ts` | PART 02 commitment ledger |
| G-02 | Budget consumption is **not enforced**. Nothing rejects an obligation that exceeds remaining budget; the aggregation is purely informational. | High | no `remainingAmount` guard anywhere in `operational-finance*`/`purchase-orders` | PART 02 concurrency + overspend control |
| G-03 | **No concurrency control** over budget consumption. Two concurrent PO issuances can both consume the same remainder. | High | no `FOR UPDATE` on `operational_budgets` anywhere | PART 02 budget row lock |
| G-04 | Commitment → actual conversion is handled by a **best-effort read-time heuristic** which silently drops a commitment as soon as a single actual is linked to the same PO, and rejects (fail-closed) when more than one actual exists. **Partial actualization is unrepresentable.** | High | `suppressOrRejectPoCommitments` | PART 02/03 explicit actualization entries |
| G-05 | Binding is **manual**. A PO line or a costed material usage only affects a budget if a user explicitly POSTs a source binding. Real spend is therefore systematically under-reported. | High | `POST /operational-budgets/{budgetId}/source-bindings` | PART 03/04 transaction-driven commitment; binding stays the lineage record |
| G-06 | **Material Request has no price.** Approved quantity cannot become a monetary commitment. | High | `0177` + `0265` | §8 — MR is *not* a commitment authority; explicit gap |
| G-07 | **Work Order has no estimate.** | Medium | §2.2 | §5 — WO estimate is *not* a commitment authority; explicit gap |
| G-08 | **No authoritative approved vendor amount** before invoice: Vendor Work, SPK, service report and BAST carry no money. `vendor_service_costs` is a *recorded cost*, not an approved obligation, and has **no currency column**. | High | `0156`, `0272`, `0201` | §9 — only a service-request-backed **PO line** may commit vendor spend |
| G-09 | **No cost-category master.** `operational_budget_categories.category_code` is per-budget; `vendor_service_costs.cost_category` and `basic_expenses.expense_category` are free text with no shared vocabulary. | Medium | grep `cost_category` | §6 — explicit category on every commitment; no inference, no master in this CR |
| G-10 | **No immutable financial snapshot.** Every amount is re-read live from mutable master data at every request. | Medium | `operational-finance-aggregation.repository.ts` reads source amounts at read time | §4/§7 — commitment entries are immutable signed snapshots; actual stays derived from immutable finalized rows |
| G-11 | **Float arithmetic in the read path.** `Number(row.sourceAmount)` and JS `+` are used for money. | Medium | `sourceAmount()` and the reducers in the aggregation service | §7 — ledger arithmetic in SQL `NUMERIC`; risk R-08 |
| G-12 | `vendor_service_costs` has **no currency**, so it can never satisfy `currency_status = MATCHED`. Any vendor-service-cost binding is permanently excluded as `SOURCE_CURRENCY_UNPROVEN`. | Medium | `0201` vs `makeCandidate()` | §9 — recorded gap; deliberately **not** repaired by inventing a currency default |
| G-13 | No commitment/variance events; no overspend event. | Low | `grep` of operational event types | §14 |
| G-14 | No trace from a variance figure back to the causing Work Order / Vendor when the causing record was never bound. | Medium | §2.6 | PART 05 read model over ledger + bindings |

---

## 4. Budget authority

### 4.1 Decision

**Reuse `operational_budgets` and `operational_budget_categories` unchanged as
the Budget authority.** No new budget table is created. No separate
budget-line model is created — `operational_budget_categories` already *is* the
minimal line model and no evidence justifies a third level.

Dimensional model (already implemented, confirmed sufficient):

```
operational_budgets(client_id, building_id, period_start..period_end, currency, planned_amount, status)
  └── operational_budget_categories(category_code, name, planned_amount)
```

- **Client** — derived Building → Property → Client, never caller-supplied.
- **Building** — mandatory. Client-level (portfolio) budgets are **out of
  scope**; portfolio figures are obtained by aggregating Building budgets in
  the read model.
- **Period** — arbitrary `DATE` range; no fiscal-calendar entity is introduced.
- **Cost category** — `operational_budget_categories`.
- **Optional operational scope** (Work Order / Vendor) — **not** a budget
  dimension. It is a *commitment* attribute and a *traceability* dimension only.

Budget is **approved spending authority** and is never derived from
transactions: `planned_amount` is only ever set by
`operational_budget.manage` while the budget is `DRAFT`.

### 4.2 Overlap and ambiguity

Already structurally guaranteed:

```sql
EXCLUDE USING gist (building_id WITH =, daterange(period_start, period_end + 1, '[)') WITH &&)
  WHERE (status IN ('DRAFT', 'ACTIVE'))
```

Therefore `(building_id, transaction_date)` resolves to **at most one** live
budget. Governance rules added by this CR:

- **BR-B1** — Budget resolution for a transaction is: the single `ACTIVE`
  budget for the transaction's Building whose period contains the transaction's
  governing date. If none exists → the obligation is **unbudgeted** and is
  rejected for commitment creation (`404 BUDGET_NOT_FOUND` semantics), never
  silently attached elsewhere.
- **BR-B2** — `DRAFT` budgets may not receive commitments. Only `ACTIVE`.
- **BR-B3** — A budget with any non-terminal commitment or any linked actual
  may not be `CANCELLED`. It may be `CLOSED`; closing freezes new commitments
  but preserves reads and permits actualization/release of already-open
  commitments (see §5.4).
- **BR-B4** — Reducing `planned_amount` below current
  `OpenCommitment + Actual` is rejected. (Today `planned_amount` is only
  mutable in `DRAFT`, where both are zero; the rule is stated so a later
  revision capability cannot bypass it.)

### 4.3 Minimal additive change (PART 01)

One column on `operational_budgets`:

- `overspend_policy TEXT NOT NULL DEFAULT 'STRICT' CHECK (overspend_policy IN ('STRICT','ALLOW_WITH_OVERRIDE'))`

> **Vocabulary note (PART 01):** the governed values are `STRICT` and
> `ALLOW_WITH_OVERRIDE`. An earlier draft of this document used
> `OVERRIDE_ALLOWED`; the implemented and authoritative vocabulary is
> `ALLOW_WITH_OVERRIDE` throughout.

Rationale: §10 requires overspend to be either prohibited or permitted only
through an explicit override authority. The policy must be an attribute of the
governed budget, not a per-request flag. `STRICT` default preserves current
behaviour for every existing row (no backfill semantics change, because no
commitment ledger exists yet).

---

## 5. Commitment authority and lifecycle

### 5.1 Definition

A **Commitment** is an approved obligation, denominated in the budget's
currency, that has not yet become actual cost. It consumes available budget the
moment it is approved and stops consuming it as it is actualized, released or
cancelled.

### 5.2 Evaluated candidate authorities

| Candidate | Priced? | Approved? | Verdict |
|---|---|---|---|
| Approved Work Order estimate | **No such field** | n/a | **Rejected** — Work Order has no monetary column (§2.2). Inventing one is a new estimate authority, out of scope. |
| Approved Material Request | **No price** | Yes (`approved_quantity` + actor) | **Rejected as a monetary authority.** Quantity × price is undefined: no item standard cost, no receiving price. |
| Material reservation | No price | Yes | **Rejected** — quantity allocation only. |
| Approved vendor quotation | **Does not exist** | n/a | **Rejected** — no quotation entity in the repository. |
| Vendor Work / SPK (`work_contracts`) | **No amount** | Yes | **Rejected** — explicitly "no amount ledger". |
| **ISSUED Purchase Order line** | **Yes** (`unit_price`, `line_amount`) | **Yes** (`status='ISSUED'`, readiness-gated, `0271`) | **ACCEPTED — primary automatic commitment authority.** |
| ISSUED Purchase Order header | Yes, only when it has exactly one line | Yes | **Accepted as a fallback only**, mirroring the existing `PO_HEADER_SUPERSEDED_BY_PO_LINE` rule; never together with its lines. |
| Vendor Service Cost (`DRAFT`) | Yes | No | **Rejected** — a draft recorded cost is not an approved obligation, and it has no currency (G-12). |
| Vendor Invoice (`DRAFT`) | Yes | No | **Rejected** — pre-actual invoice state, not an obligation authority. |
| Manual/estimated commitment | Caller-supplied | Requires `operational_budget.manage` + explicit reason | **Accepted, bounded** — see §5.3. |

**No double counting rule (BR-C1):** for any Purchase Order, commitment may be
recognised at the **line** level or the **header** level, never both; and a PO
that has a ledger commitment may not simultaneously carry a legacy
`PURCHASE_ORDER`/`PO_LINE` source binding (enforced in PART 03 by a service
check plus a partial unique index).

### 5.3 Manual / estimated commitment (bounded)

Because Work Order, Material Request and Vendor Work carry no amount, a
Building may have real obligations that no priced record represents. Rather
than fabricating prices, the ledger supports a `MANUAL_ESTIMATE` commitment:

- Requires `operational_budget.manage` and a non-empty `reason`.
- Must name an explicit budget category and currency = budget currency.
- Carries an optional typed operational reference
  (`work_order_id` / `vendor_id` / `material_request_id`) for traceability
  **only** — the reference confers no amount authority.
- Is flagged `origin = 'MANUAL'` and reported separately in the read model so a
  reader can always distinguish system-derived from human-asserted commitment.
- **Never becomes Actual by itself.** It must be released (or superseded by a
  PO-line commitment) once the priced authority materialises.

### 5.4 Lifecycle

Evaluated `PROPOSED → COMMITTED → PARTIALLY_ACTUALIZED → ACTUALIZED / RELEASED / CANCELLED`
and adopted it **minus `PROPOSED`**, because no repository authority produces an
unapproved obligation with an amount: a PO line only becomes visible to Finance
when its PO is `ISSUED`, and a manual commitment is created by an authorized
actor. Adding `PROPOSED` would create an approval workflow this CR must not
build (§2.7).

Adopted vocabulary:

```
COMMITTED ─┬─► PARTIALLY_ACTUALIZED ─┬─► ACTUALIZED      (terminal)
           │                         └─► RELEASED        (terminal, remainder released)
           ├─► ACTUALIZED                                (terminal, single full actual)
           ├─► RELEASED                                  (terminal, nothing actualized)
           └─► CANCELLED                                 (terminal, only when actualized = 0)
```

State is **derived from the ledger, not free-form**: header status is a
function of `committed_amount`, `actualized_amount`, `released_amount` and is
recomputed inside the same transaction as the entry that changed them, guarded
by CHECK constraints.

### 5.5 Governed transitions

| Transition | Trigger | Rules |
|---|---|---|
| **Creation** | PO line commitment: PO transitions to `ISSUED` (PART 03/04 seam). Manual: explicit API call. | One transaction. Budget row locked. Available-budget recheck. Currency must equal budget currency. Category explicit. Idempotent on `(source_type, source_id)`. |
| **Approval** | Not a separate step. Creation *is* approval (§5.4). | The approving authority is the PO issuance authority (`purchase_order.manage`) or `operational_budget.manage` for manual. |
| **Increase** | New `ADJUSTMENT_INCREASE` entry (e.g. PO line amount corrected upward before receipt). | Same locking + overspend control as creation. Never edits the original entry. |
| **Decrease** | `ADJUSTMENT_DECREASE` entry. | May not reduce `committed_amount` below `actualized_amount`. |
| **Actualization** | An eligible actual (§6) is linked to the commitment. | `ACTUALIZE` entry with the actual's amount; `actualized_amount += amount`; may not exceed `committed_amount` unless an over-actualization override is recorded (§10.4). |
| **Partial actualization** | Same, when `0 < actualized_amount < committed_amount`. | Status → `PARTIALLY_ACTUALIZED`. Remainder stays open. |
| **Release** | Explicit `RELEASE` entry, or automatic on PO line closure/cancellation. | Releases exactly `committed_amount − actualized_amount − released_amount`. Idempotent. |
| **Cancellation** | `CANCEL` entry. | **Rejected if `actualized_amount > 0`** — use RELEASE. |
| **Idempotency** | Every entry carries a mandatory `idempotency_key` unique per commitment; source-derived entries derive the key from `(source_type, source_id, entry_type, source_version)`. Replays are no-ops returning the existing entry. |
| **Immutability** | `operational_commitment_entries` is append-only: no UPDATE, no DELETE at the application boundary; each entry stores its own signed `amount` snapshot, actor, timestamp, reason, `request_id`. |

### 5.6 No silent historical recomputation

- Commitment amounts are **snapshots** taken at entry time. A later change to a
  PO line, an item, or a vendor never rewrites a past commitment; it can only
  produce a **new** adjustment entry.
- Actual amounts remain derived, but only from **already-immutable** rows
  (`FINALIZED`/`VERIFIED`/`ISSUED`/costed material usage). Any source that
  leaves an eligible state after actualization must produce an explicit
  `REVERSAL` entry (§11), never a silent disappearance. PART 03/04 must make
  the reversal seam explicit in the source modules' cancellation paths.

### 5.7 Proposed schema (PART 02 — for reference, not implemented here)

```
operational_commitments
  id, client_id, building_id, budget_id, budget_category_id,
  origin              ('PO_LINE','PO_HEADER','MANUAL')
  source_type/source_id (typed, nullable for MANUAL, composite-FK scoped like 0284)
  work_order_id, vendor_id, material_request_id   -- traceability only, nullable
  currency VARCHAR(3)                              -- must equal budget currency
  committed_amount   NUMERIC(18,2) NOT NULL CHECK (>= 0)
  actualized_amount  NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (>= 0)
  released_amount    NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (>= 0)
  open_amount        NUMERIC(18,2) GENERATED ALWAYS AS
                       (committed_amount - actualized_amount - released_amount) STORED
  status             ('COMMITTED','PARTIALLY_ACTUALIZED','ACTUALIZED','RELEASED','CANCELLED')
  overspend_override_reason TEXT, overspend_override_by_user_id UUID
  created_by_user_id, created_at, updated_at
  CHECK (actualized_amount + released_amount <= committed_amount)
  CHECK (status consistency with the three amounts)
  UNIQUE (budget_id, source_type, source_id) WHERE status <> 'CANCELLED'
  FK (budget_id, client_id, building_id) → operational_budgets (id, client_id, building_id)
  FK (budget_category_id, budget_id)     → operational_budget_categories (id, budget_id)

operational_commitment_entries            -- append-only
  id, commitment_id, entry_type
    ('CREATE','ADJUST_INCREASE','ADJUST_DECREASE','ACTUALIZE','ACTUALIZE_REVERSAL',
     'RELEASE','CANCEL','OVERRIDE')
  signed_amount NUMERIC(18,2) NOT NULL
  currency VARCHAR(3) NOT NULL
  source_binding_id UUID NULL   -- links an ACTUALIZE entry to its lineage row
  idempotency_key TEXT NOT NULL
  reason TEXT, actor_user_id UUID NOT NULL, request_id UUID, occurred_at, created_at
  UNIQUE (commitment_id, idempotency_key)
```

`open_amount` as a **generated column** follows the existing
`vendor_invoices.outstanding_amount` precedent (and the KI-001 lesson: the
application must never write a generated column).

---

## 6. Actual-cost authority

### 6.1 Decision — reuse, do not redefine

Actual cost authorities are **exactly** those already governed by CR-BE-FIN-01
PART 04. No new actual table, no new cost record type.

| Source | Becomes Actual when | Amount | Currency |
|---|---|---|---|
| `basic_expenses` | `status = 'FINALIZED'` | `amount` | **none on the table** → currency proven only via the binding's `MATCHED` status (today: unprovable → excluded). Recorded as gap G-12-adjacent. |
| `vendor_service_costs` | `status = 'FINALIZED'` | `cost_amount` | **no currency column** (G-12) |
| `vendor_invoices` | `status = 'FINALIZED'` **and** `verification_status = 'VERIFIED'` | `invoice_amount` | `currency` |
| `inventory_work_order_material_usages` | row exists **and** `unit_cost IS NOT NULL` (i.e. `total_cost` materialised) | `total_cost` (generated) | `currency` |
| `purchase_orders` / `purchase_order_lines` | **never** — commitment only | — | — |

Additional governance:

- **BR-A1** — the transaction's *governing date* must fall inside the budget
  period (`expense_date`, `cost_date`, `invoice_date`, `used_at::date`). Outside
  → excluded as `SOURCE_PERIOD_OUTSIDE_BUDGET` (existing behaviour, preserved).
- **BR-A2** — Actual is **never fabricated from an estimate, a quantity, a
  reservation, a PO, or a receiving**.
- **BR-A3** — Actual is recognised **once**, at its authoritative source. A
  vendor invoice and a vendor service cost describing the same obligation must
  not both count; the existing `suppressDirectCostRepresentation` /
  `rejectAmbiguousVendorLineage` / fail-closed rules are retained and are the
  authority for that de-duplication.
- **BR-A4** — Actual recognition against a commitment is an explicit
  `ACTUALIZE` entry, unique per `(commitment_id, source_binding_id)`. Duplicate
  actualization is structurally impossible.
- **BR-A5** — An actual with no commitment (direct spend) is fully valid: it
  consumes budget as Actual with `commitment_id = NULL`.

---

## 7. Monetary and currency rules

| Rule | Position | Basis |
|---|---|---|
| Currency scope | **One currency per governed budget chain.** A commitment's currency must equal its budget's currency; an actual whose proven currency differs is excluded, never converted. | `operational_budgets.currency`; existing `SOURCE_CURRENCY_MISMATCH` |
| Allowed codes | `IDR, USD, SGD, MYR, AUD, EUR, GBP, JPY, CNY` — the existing repository whitelist. No new code. | `0283`, `0261`, `0267`, `0269` |
| Storage type | `NUMERIC(18,2)` for all new money columns. | `0283`, `0261`, `0270` |
| Precision / rounding | Two decimals; **half-up**; rounding performed once, at the boundary where a value is persisted. No rounding inside the ledger — entries are already 2-dp. | existing `NUMERIC(18,2)` convention |
| Arithmetic | **All ledger arithmetic in SQL `NUMERIC`** (generated columns and `UPDATE ... SET x = x + $n`). JavaScript `number` may be used only for the outbound JSON projection. | G-11 |
| Negative values | `committed_amount`, `actualized_amount`, `released_amount`, `open_amount` are `>= 0`. Only `operational_commitment_entries.signed_amount` may be negative (decrease / release / reversal). Budget `planned_amount >= 0` is unchanged. | `0283`, §5.7 |
| Zero | A zero-amount commitment is rejected. A zero-amount adjustment is rejected. | idempotency hygiene |
| Snapshots | Commitment entries are immutable amount snapshots. Budget planned amounts are immutable outside `DRAFT`. | §5.6 |
| Cross-currency | A source with `currency_status <> 'MATCHED'`, a NULL currency, or a mismatched currency is **excluded fail-closed** and reported in `controls.exclusions`. **No conversion, no FX table, no rate, no revaluation.** | existing aggregation contract |
| Currency-less sources | `basic_expenses` and `vendor_service_costs` have no currency column. This CR **does not add one** (that is a change to those authorities, not to cost control). Their contribution stays excluded/unproven and is surfaced as an explicit gap, not silently assumed to be the budget currency. | G-12 |

---

## 8. Material-chain mapping

Chain as implemented:

```
Purchase Request → Material Request (quantity)
      → [approval] approved_quantity            (0265 — quantity authority, NO price)
      → PO line (unit_price, line_amount)       (0270 — PRICE ENTERS HERE, when PO ISSUED)
      → Receiving (quantity, NO price)          (0182/0264)
      → Stock balance / movement (quantity)
      → Reservation (quantity)                  (0287/0289)
      → WO material usage + unit_cost/total_cost (0174 + 0267 — MONEY, immutable)
```

### 8.1 Mapping decision

| Chain step | Cost-control role | Rule |
|---|---|---|
| Material Request (`OPEN`) | none | no amount exists |
| Material Request (`APPROVED`) | **none (monetary)** | **BR-M1** — approved quantity is *demand*, not money. It creates **no** commitment. Recorded as gap G-06. |
| Reservation `ACTIVE` | none | stock allocation, not budget allocation |
| **PO line for that MR, PO `ISSUED`** | **COMMITMENT** | **BR-M2** — the single commitment point of the material chain. `line_amount` is the committed amount; `material_request_id` gives the MR trace. |
| Receiving | none | no price; changes no budget figure |
| **WO material usage with `unit_cost`** | **ACTUAL** | **BR-M3** — `total_cost` at issue time is the Actual. |

### 8.2 Avoiding double counting

**BR-M4** — When a WO material usage becomes Actual, its commitment is resolved
through the MR link, deterministically:

```
usage.material_request_id  →  purchase_order_lines.material_request_id
                           →  the ledger commitment for that PO line
```

- Exactly one open commitment found → `ACTUALIZE` entry for
  `min(usage.total_cost, open_amount)`; any excess is recorded as an
  **uncommitted actual** on the same category (never as a second commitment).
- Zero commitments found (stock consumed from existing inventory, the common
  case) → the usage is a **direct Actual** with `commitment_id = NULL`. This is
  correct: no obligation preceded it.
- More than one candidate commitment → **fail closed**, exclusion reason
  `SOURCE_LINEAGE_AMBIGUOUS` (existing vocabulary), no guessing.

**BR-M5** — Partial issue against a PO-line commitment leaves the commitment
`PARTIALLY_ACTUALIZED`. The remainder stays open until the PO line is closed or
explicitly released.

**BR-M6** — **The material engine is not rewritten.** Reservation, issue,
balance and movement logic are untouched; PART 03 adds only a post-commit
Finance seam invoked inside the existing issue transaction, and it must be
non-blocking for material operations that have no budget (the issue succeeds;
the Finance projection records the actual as unbudgeted rather than failing the
warehouse operation). Overspend control applies to **commitments**, not to
physical material issue — refusing to issue material for a running Work Order
because a budget line is exhausted is an operational-safety hazard and is
explicitly **not** governed here.

**BR-M7** — Material **return / reversal**: there is no return authority in the
repository today (no negative usage, no return table). If a return capability
is added later it must emit an `ACTUALIZE_REVERSAL` entry. Recorded as risk
R-12; no reversal path is invented now.

---

## 9. Vendor / service-cost mapping

### 9.1 Where an approved vendor amount exists

| Record | Amount? | Approved? | Role |
|---|---|---|---|
| Vendor Work (`0156`) | **No** | Yes | Execution only — **no financial role** |
| Work Permit / readiness | No | Yes | none |
| SPK / Work Contract (`0272`) | **No** | Yes | Execution mandate — **no financial role** |
| Vendor Completion / Service Report | No | Yes | none |
| BAST (`0226`/`0259`) | No | Yes | Acceptance gate for invoicing — **no amount** |
| Service Request (`0178`) | No | Yes | none |
| **PO line originating from a Service Request, PO `ISSUED`** | **Yes** | **Yes** | **COMMITMENT** |
| Vendor Service Cost `FINALIZED` (`0201`) | Yes | Finalized | **ACTUAL** (currency unprovable — G-12) |
| Vendor Invoice `FINALIZED` + `VERIFIED` (`0261`–`0263`) | Yes | Yes | **ACTUAL** (authoritative, has currency) |
| Basic Expense `FINALIZED` (`0202`) | Yes | Finalized | **ACTUAL** (currency unprovable) |

### 9.2 Decisions

- **BR-V1** — Vendor commitment is recognised **only** from a service-backed
  **ISSUED PO line**. Vendor Work and SPK do **not** create commitment.
- **BR-V2** — Vendor actual is the **verified Vendor Invoice**. When both a
  vendor invoice and a vendor service cost exist for the same lineage, the
  existing de-duplication authority decides; ambiguity fails closed.
- **BR-V3** — Actualization link: `vendor_invoices.purchase_order_id` (added by
  `0274`) resolves the commitment directly. Absent that, the existing
  `work_order_procurement_bindings` lateral-join lineage is used; more than one
  candidate PO → fail closed.
- **BR-V4 (recorded gap, not filled)** — There is **no authoritative approved
  vendor amount before a Purchase Order**. Vendor work executed without a PO
  (direct assignment, emergency call-out) produces **Actual with no
  Commitment**. This CR **does not** invent a vendor quotation, contract value,
  or SPK amount. If the business requires vendor commitment without a PO, that
  is a separate CR against the Vendor Work / SPK authority.
- **BR-V5 (recorded gap, not filled)** — `vendor_service_costs` and
  `basic_expenses` have **no currency column**, so they cannot prove currency
  and are excluded from budget figures under the existing fail-closed contract.
  Adding a currency to those tables is a change to *their* authority and is
  **out of scope**; it is registered as blocker B-02 for full vendor-actual
  coverage.

---

## 10. Variance read model, concurrency and overspend control

### 10.1 Measures

For a budget, and identically per category:

```
Planned            = operational_budgets.planned_amount        (category: category.planned_amount)
Actual             = Σ eligible actual amounts (§6)
CommittedGross     = Σ commitments.committed_amount   (non-CANCELLED)
Actualized         = Σ commitments.actualized_amount
Released           = Σ commitments.released_amount
OpenCommitment     = Σ commitments.open_amount        = CommittedGross − Actualized − Released
AvailableBudget    = Planned − OpenCommitment − Actual
Variance           = Planned − Actual                  (positive = under budget)
Utilization%       = Actual / Planned * 100                     (NULL when Planned = 0)
CommittedUtil%     = (Actual + OpenCommitment) / Planned * 100  (NULL when Planned = 0)
```

**`Available Budget = Budget − Committed − Actual` is honoured with `Committed`
meaning *open* commitment.** This is the explicit governance answer to §2's
double-counting question: **a commitment that converts to actual MUST be
reduced by the actualized amount**, otherwise the same obligation is counted
twice. Reduction is performed by the `ACTUALIZE` entry, atomically with the
actual link, never by a recomputation job.

### 10.2 Breakdown and traceability

Required read dimensions: Building, period, budget, cost category, commitment
status, origin (`PO_LINE`/`PO_HEADER`/`MANUAL`), Work Order, Vendor, and source
transaction (`source_type` + `source_id` + `binding_id` + `commitment_id`). The
existing fail-closed `controls.exclusions` contract is **preserved and
extended** with commitment-specific reasons.

### 10.3 Derived vs materialized

**Derived.** No aggregate balance table, no cached totals. The commitment header
already carries per-commitment amounts (necessary for locking and constraints);
budget-level totals are `SUM`s over an indexed `(budget_id, budget_category_id,
status)`. Materialization is deferred until profiling evidence exists — recorded
as risk R-14, not pre-optimised.

### 10.4 Concurrency and overspend control

**BR-O1 (transaction)** — Commitment creation, increase, actualization, release
and cancellation each execute inside a single `withTransaction`.

**BR-O2 (budget row lock)** — The transaction begins with
`SELECT ... FROM operational_budgets WHERE id = $1 FOR UPDATE`. The budget row
is the **single serialization point** for a Building's budget; category-level
locking is not used, so two categories of one budget serialize — accepted, as
budget mutation volume is low and correctness dominates.
Lock ordering is fixed: **budget → commitment → source**, to prevent deadlock
with the material/PO transactions that already lock stock balances and PO rows.

**BR-O3 (recheck inside the lock)** — `AvailableBudget` for the target category
**and** for the budget total is recomputed from the ledger *after* acquiring the
lock. Any value read before the lock is discarded.

**BR-O4 (rejection)** — If `requestedAmount > AvailableBudget`, the operation is
**rejected** with a dedicated conflict error carrying `plannedAmount`,
`openCommitment`, `actual`, `availableAmount`, and `requestedAmount`. This is
the default for `overspend_policy = 'STRICT'`.

**BR-O5 (override)** — Only when the budget's `overspend_policy =
'ALLOW_WITH_OVERRIDE'` **and** the actor holds `operational_budget.override`
**and** a non-empty `overrideReason` is supplied may the commitment be created
beyond available budget. The override is persisted on the commitment
(`overspend_override_reason`, `overspend_override_by_user_id`), written as an
`OVERRIDE` ledger entry, and audited as a distinct event. **Overspend is never
silently permitted.**

**BR-O6 (actual overspend)** — An **Actual** that exceeds available budget is
**recorded, not rejected**: cost already incurred is a fact, and refusing to
record it would corrupt the ledger. It surfaces as negative
`AvailableBudget`/`Variance` and raises a `BUDGET_EXCEEDED_BY_ACTUAL` audit
event. Only *commitments* are gated.

**BR-O7 (idempotency under retry)** — Unique `(commitment_id,
idempotency_key)` plus the partial unique `(budget_id, source_type, source_id)`
make concurrent duplicate creation impossible; the loser of the race maps
`23505` to the existing record (precedent:
`corrective-action-responsibility.service.ts`).

---

## 11. Adjustment / reversal rules

**BR-R1** — After `COMMITTED`, a commitment's amounts are **never** edited in
place. `PATCH` on commitment amounts does not exist.

| Situation | Correct mechanism |
|---|---|
| Committed too much | `ADJUST_DECREASE` entry (floor: `actualized_amount`) |
| Committed too little | `ADJUST_INCREASE` entry (subject to §10.4 overspend control) |
| Obligation abandoned before any actual | `CANCEL` entry |
| Obligation partly delivered, remainder abandoned | `RELEASE` of the remainder (**`CANCEL` is rejected**) |
| Actual linked in error | `ACTUALIZE_REVERSAL` entry (positive-open restoring), plus removal of the source binding via the existing `POST /operational-budget-source-bindings/{id}/remove` |
| Source left its eligible state after actualization (e.g. invoice cancelled) | explicit `ACTUALIZE_REVERSAL` emitted by the source module's cancellation path (PART 04 seam). **Never** a silent disappearance from the read model. |
| Wrong budget / wrong category | `RELEASE` (or `CANCEL` when untouched) + **replacement** commitment on the correct target. No cross-budget move, no re-parenting. |
| Budget planned amount wrong | Only while `DRAFT`. Once `ACTIVE`, a revision capability is **out of scope** for this CR (registered as a future need, not implemented). |

**BR-R2** — Every corrective entry requires an actor and a `reason`; the reason
is stored on the entry and echoed into the operational event metadata.

**BR-R3** — `operational_commitment_entries` has no UPDATE/DELETE surface. The
smallest correct model is: mutable derived header + immutable signed entries.

---

## 12. RBAC and isolation

### 12.1 Reuse

| Operation | Permission | Justification |
|---|---|---|
| Read budget, categories, commitments, variance, traceability | **`operational_budget.read`** (existing) | Same semantic surface as the current aggregation endpoint. |
| Create/manage budget, category, manual commitment, adjustment, release, cancellation | **`operational_budget.manage`** (existing) | Same authority that already activates budgets and creates source bindings. |
| Automatic PO-line commitment | none additional | It is a side effect of `purchase_order.manage` PO issuance, already a governed approval of spend (the seed already separates `purchase_order.*` from `vendor_invoice.*` precisely because "committing spend to a vendor is not the same" as recording an invoice). |
| Material actualization | none additional | Side effect of the existing material-issue authority. |

### 12.2 The one new permission

**`operational_budget.override` — "Override Operational Budget Overspend".**

Necessity argument (as required):

1. §10 forbids silent overspend, so an override must be *distinguishable* from
   ordinary management.
2. `operational_budget.manage` is already required for routine budget
   administration and is granted broadly (the seed file itself records a
   defect class of over-broad grants near line 465). Reusing it would make
   "may administer budgets" identical to "may exceed approved spending
   authority" — semantically wrong and audit-hostile.
3. No existing permission expresses a financial-limit override
   (`basic_financial_reporting.read` is read-only; `purchase_order.manage`
   governs procurement, not budget authority).

It is granted to **no role by default**; assignment is a deliberate
administrative act.

### 12.3 Isolation

- **BR-I1** — Client is always derived Building → Property → Client
  (`resolveBuildingClient`). Caller-supplied `clientId`/`buildingId` scope is
  **never** trusted.
- **BR-I2** — Every read and write calls
  `contextAccessService.assertBuildingAccess(actorUserId, buildingId)` before
  returning or mutating anything.
- **BR-I3** — Structural isolation via composite FKs, following `0284`:
  `(budget_id, client_id, building_id) → operational_budgets(id, client_id,
  building_id)` and `(budget_category_id, budget_id) →
  operational_budget_categories(id, budget_id)`. A commitment cannot drift from
  its budget's Client/Building.
- **BR-I4** — A commitment's source transaction must resolve to the **same
  Building** as the budget; cross-Building sources are rejected, not silently
  scoped (existing `operationalBudgetSourceContextInvalidError` precedent).
- **BR-I5** — Portfolio/management reads go through
  `resolveManagementReadScope`; no new scope resolver.

---

## 13. Audit

**Reuse `recordOperationalEvent` and the CR-BE-AUDIT-01 correlation authority.
No second audit store, no new audit table, no signing scheme.**

Every event is written on the **same executor** as its state change (so it
rolls back with a failed transaction), carries `client_id`, `building_id`,
`actor_user_id`, `entity_type`, `entity_id`, and inherits `request_id` /
`source = 'HTTP'` from the AsyncLocalStorage execution context.

| Event type | Entity | When |
|---|---|---|
| `OPERATIONAL_BUDGET_ACTIVATED` / `_CLOSED` / `_CANCELLED` | `OPERATIONAL_BUDGET` | existing (already emitted) |
| `OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED` | `OPERATIONAL_BUDGET` | policy set to `ALLOW_WITH_OVERRIDE` or back |
| `OPERATIONAL_COMMITMENT_CREATED` | `OPERATIONAL_COMMITMENT` | creation (metadata: origin, source, category, amount) |
| `OPERATIONAL_COMMITMENT_ADJUSTED` | `OPERATIONAL_COMMITMENT` | increase / decrease (metadata: delta, reason) |
| `OPERATIONAL_COMMITMENT_ACTUALIZED` | `OPERATIONAL_COMMITMENT` | full or partial (metadata: actual source, amount, remaining open) |
| `OPERATIONAL_COMMITMENT_ACTUALIZATION_REVERSED` | `OPERATIONAL_COMMITMENT` | reversal (metadata: reason) |
| `OPERATIONAL_COMMITMENT_RELEASED` | `OPERATIONAL_COMMITMENT` | release (metadata: released amount) |
| `OPERATIONAL_COMMITMENT_CANCELLED` | `OPERATIONAL_COMMITMENT` | cancellation |
| `OPERATIONAL_BUDGET_OVERSPEND_REJECTED` | `OPERATIONAL_BUDGET` | rejection (metadata: requested, available) |
| `OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN` | `OPERATIONAL_BUDGET` | override (metadata: reason, actor, amounts) |
| `OPERATIONAL_BUDGET_EXCEEDED_BY_ACTUAL` | `OPERATIONAL_BUDGET` | BR-O6 |

**BR-AU1** — `OPERATIONAL_BUDGET_OVERSPEND_REJECTED` is emitted **outside** the
rolled-back transaction (best-effort, like the existing auth-audit pattern), so
a rejected attempt is still visible.
**BR-AU2** — Reads are not audited (per the AUDIT-01 boundary).
**BR-AU3** — No amount is scrubbed; amounts are business data, not secrets. No
sensitive key is added to event metadata.

---

## 14. Scheduler decision

**No scheduler. No timer. No job.**

Justification:

- Every balance is either transaction-driven (commitment amounts, mutated only
  inside the locked transaction that causes them) or read-derived (budget
  totals, variance).
- There is no time-triggered financial state: a period ending does not need a
  job — `CLOSED` is an explicit administrative action, and reads already filter
  by period.
- Adding a timer purely to recompute variance would violate §14 of the CR and
  contradict §5.6 (no silent recomputation).

The existing `due-job-scheduler` / `due-job-dispatcher` remain untouched. If a
future need for automatic period rollover appears, it is a separate CR.

---

## 15. Historical-data decision

**No backfill. No fabricated history.**

| Pre-CR situation | Treatment |
|---|---|
| Existing `operational_budgets` rows | Unchanged. `overspend_policy` defaults to `STRICT`, which is the current de-facto behaviour (no enforcement existed, and no commitment existed to enforce against). |
| Existing `PURCHASE_ORDER` / `PO_LINE` source bindings | **Preserved.** They keep contributing `committedAmount` through the existing read-time rules. They are *legacy commitments*. PART 05 unions legacy-binding commitment with ledger commitment and enforces mutual exclusion per PO/PO line, so no PO is counted twice. |
| Existing actual bindings (`BASIC_EXPENSE`, `VENDOR_SERVICE_COST`, `VENDOR_INVOICE`, `WORK_ORDER_MATERIAL`) | **Preserved**, with `commitment_id = NULL` — i.e. actual without commitment, which is exactly what they are. |
| Pre-CR ISSUED POs never bound to a budget | **Not adopted.** They generate no ledger commitment. |
| Pre-CR costed material usages never bound | **Not adopted.** They remain outside budget figures. |
| Pre-CR Work Orders | No financial state is invented for them. |

**BR-H1** — If the business later requires historical adoption, it must be an
**explicit, separate adoption strategy** (its own CR): an operator-initiated,
dry-run-capable, idempotent, audited adoption of a named set of POs/usages into
a named budget, with an explicit `origin = 'ADOPTED'` marker. It must never run
implicitly at migration time.

**BR-H2** — Every new column added by this CR is nullable or has a
behaviour-preserving default. No migration rewrites an existing row's financial
meaning.

---

## 16. API boundary

Minimum surface (implemented in later PARTs; **not** in this document):

**Budget administration — already exists, reused unchanged**
- `POST/GET /buildings/{buildingId}/operational-budgets`
- `GET/PATCH /operational-budgets/{id}`, `/activate`, `/close`, `/cancel`
- `POST/GET /operational-budgets/{budgetId}/categories`,
  `GET/PATCH/DELETE /operational-budget-categories/{id}`
- *Additive:* `overspendPolicy` on create/patch/read (PART 01)

**Commitment**
- `GET /operational-budgets/{budgetId}/commitments` — filter by category,
  status, origin, work order, vendor
- `GET /operational-commitments/{id}` — header + entries (traceability)
- `POST /operational-budgets/{budgetId}/commitments` — **manual/estimated only**
- `POST /operational-commitments/{id}/adjust` — signed delta + reason
- `POST /operational-commitments/{id}/release` — remainder + reason
- `POST /operational-commitments/{id}/cancel` — reason (rejected if actualized)

**Variance / control read model**
- `GET /operational-budgets/{budgetId}/variance` — totals + per-category
  Planned / Committed / Open / Actual / Available / Variance / Utilization,
  with the fail-closed `controls` block
- `GET /operational-budgets/{budgetId}/aggregation` and `/summary` — existing,
  extended additively (existing fields keep their meaning)
- `GET /operational-budgets/{budgetId}/traceability` — flat source rows:
  `sourceType`, `sourceId`, `bindingId`, `commitmentId`, `workOrderId`,
  `vendorId`, `materialRequestId`, `amount`, `classification`
  (`COMMITTED`/`ACTUAL`/`EXCLUDED`), `exclusionReason`

**Explicitly NOT exposed**
- No endpoint that writes an actual amount.
- No endpoint that edits a commitment amount in place.
- No endpoint that moves a commitment between budgets or categories.
- No endpoint that recomputes or rebuilds balances.
- No endpoint that creates a commitment from a Work Order, Material Request,
  Vendor Work or SPK (no priced authority exists).

**OpenAPI:** documented in **PART 06 only**. This document changes no spec.

---

## 17. Explicit non-goals

Confirmed by inspection that none of the following exists or is implied, and
all remain **out of scope**:

general ledger · chart of accounts · journal entries · double-entry ·
accounts payable · accounts receivable · bank reconciliation · taxation
(PPN/PPh) · PSAK reporting · IFRS reporting · FX engine / rates / revaluation ·
payroll · procurement suite rebuild · invoice OCR · payment gateway · full ERP ·
inventory valuation (FIFO/LIFO/weighted average/standard cost) ·
purchase-price variance · vendor quotation engine · approval-workflow engine ·
budget revision workflow · multi-year capital budgeting · cash flow forecasting.

Additionally out of scope for this CR specifically: adding a currency column to
`basic_expenses` / `vendor_service_costs`; adding an estimate to `work_orders`;
adding a price to `material_requests`; historical adoption; KI-003.

---

## 18. Proposed PART breakdown

The proposed decomposition is retained. Repository evidence changes **PART 01's
content** (budget already exists → PART 01 becomes a small policy + governance
part) but not the sequence.

### PART 01 — Budget + Cost Category Foundation (confirm reuse + control policy)

- **Scope:** confirm `operational_budgets` / `operational_budget_categories` as
  the Budget authority; add `overspend_policy`; codify BR-B1…BR-B4; codify
  category governance (explicit category, no master, no GL mapping); expose
  `overspendPolicy` on the existing budget read/write service and validation.
- **Migration:** `0310_add_operational_budget_control_policy` (one column + CHECK, reversible).
- **Authorities reused:** `operational-finance` module, `context-access`,
  `operational_events`, `operational_budget.read/manage`.
- **Tests:** extend `operational-budget-foundation.test.ts` — default `STRICT`,
  policy transitions audited, invalid value rejected, existing rows unaffected,
  isolation preserved.
- **Dependencies/blockers:** none.

### PART 02 — Commitment Ledger + Concurrency Control

- **Scope:** `operational_commitments` + `operational_commitment_entries`;
  lifecycle engine; manual commitment API; adjust/release/cancel; budget row
  locking; available-budget recheck; overspend rejection/override;
  `operational_budget.override` permission; commitment audit events.
- **Migrations:** `0311_create_operational_commitments`,
  `0312_create_operational_commitment_entries`, and a seed addition for the new
  permission (following the existing `foundation-access.seed.ts` pattern).
- **Authorities reused:** `withTransaction`, `FOR UPDATE` precedent (KI-001
  PART 02, BAST, configuration versions), composite-FK scoping pattern (`0284`),
  generated-column precedent (`vendor_invoices.outstanding_amount`),
  `recordOperationalEvent` + AUDIT-01 correlation, `contextAccessService`.
- **Tests:** new `operational-commitment-ledger.test.ts` +
  `operational-commitment-concurrency.test.ts` — lifecycle matrix, immutability
  of entries, idempotent replay, cancel-after-partial rejected, release
  arithmetic, **two concurrent commitments cannot both consume the same
  remainder**, strict rejection, override path (permission + reason + event),
  cross-Building rejection, currency mismatch rejection.
- **Dependencies:** PART 01.

### PART 03 — Material Commitment / Actual Integration

- **Scope:** PO-line commitment creation at PO issuance for material lines;
  `commitment_id` on `operational_budget_source_bindings`; actualization of
  material usage via `material_request_id → purchase_order_lines`; partial
  actualization; ambiguity fail-closed; legacy-binding mutual exclusion.
- **Migration:** `0313_add_budget_binding_commitment_link` (nullable
  `commitment_id` + FK + partial unique preventing duplicate actualization).
- **Authorities reused:** `purchase-orders`, `purchase-order-lines`,
  `material-requests`, `inventory-work-order-material-usages`,
  `inventory-material-reservations`, existing binding service.
- **Tests:** extend `work-order-material-cost.test.ts`,
  `work-order-material-issue-control.test.ts`,
  `operational-budget-source-binding.test.ts`; new
  `operational-commitment-material-chain.test.ts` — MR approval creates **no**
  commitment; PO issuance does; issue partially actualizes; over-issue records
  uncommitted actual; duplicate actualization impossible; ambiguous lineage
  fails closed; **material issue never blocked by budget** (BR-M6).
- **Dependencies:** PART 02. **Blocker:** none.

### PART 04 — Vendor / Operational Cost Integration

- **Scope:** service-backed PO-line commitment; verified-vendor-invoice
  actualization via `purchase_order_id` / procurement-binding lineage;
  reversal seam on invoice/cost cancellation; explicit recording of the
  no-PO-vendor-work gap and the currency-less-source gap.
- **Migration:** none expected (uses `0274` linkage). Any need discovered
  during implementation must be re-governed before adding one.
- **Authorities reused:** `vendor-invoices`, `vendor-invoice-verification`,
  `vendor-service-costs`, `basic-expenses`, `work-order-procurement-bindings`,
  `work-contracts` (read-only trace).
- **Tests:** extend `vendor-invoice-*` suites; new
  `operational-commitment-vendor-chain.test.ts` — unverified invoice does not
  actualize; verified invoice actualizes exactly once; invoice cancellation
  reverses; vendor work without PO yields actual-without-commitment;
  currency-less sources stay excluded with the correct reason.
- **Dependencies:** PART 02. **Blocker B-02** (no currency on
  `vendor_service_costs` / `basic_expenses`) limits achievable coverage; it is
  documented, not worked around.

### PART 05 — Variance + Traceability Read Model

- **Scope:** `/variance` and `/traceability`; additive extension of
  `/aggregation` and `/summary`; legacy-binding + ledger union with mutual
  exclusion; breakdowns by category / Work Order / Vendor / origin;
  utilization; extended fail-closed exclusion vocabulary; management read-model
  pass-through (`management-operational-finance`,
  `management-building-operational-finance`).
- **Migration:** none (derived read model).
- **Authorities reused:** existing aggregation service/repository and its
  exclusion contract, `management-read-scope`.
- **Tests:** extend `operational-budget-aggregation.test.ts`,
  `management-operational-finance.test.ts`,
  `management-building-operational-finance.test.ts`; new
  `operational-budget-variance-read-model.test.ts` — no double counting across
  legacy + ledger, `Available = Planned − Open − Actual`, utilization with zero
  planned → `null`, breakdown correctness, traceability completeness,
  Client/Building isolation of every row.
- **Dependencies:** PARTs 02–04.

### PART 06 — OpenAPI + Cross-Module Validation + Governance Closure

- **Scope:** OpenAPI paths/schemas for all new surfaces (following the existing
  splice-script convention in `scripts/`); contract validation test;
  cross-module regression of the affected suites; governance closure section
  appended to this document; `docs/known-issues.md` updated **only** if a new
  defect is genuinely found.
- **Migration:** none.
- **Tests:** extend `operational-finance-contract-validation.test.ts`; new
  `operational-commitment-openapi.test.ts`.
- **Dependencies:** PARTs 01–05. **Blocker:** KI-003 may surface unrelated
  legacy strict-key assertion failures — those remain deferred debt and must
  not be folded into this CR.

---

## 19. Risk register

| ID | Risk | Likelihood | Impact | Control |
|---|---|---|---|---|
| **R-01** | **Double counting committed + actual** — the same obligation counted as both. | High | Critical | Explicit `ACTUALIZE` entries reduce `open_amount` atomically; `open_amount` is a generated column; `commitment_id` on the actual binding; legacy PO bindings and ledger commitments mutually exclusive per PO/PO line (BR-C1); PART 05 union test. |
| **R-02** | **Concurrent overspend** — two approvals consume the same remainder. | High | Critical | `FOR UPDATE` on the budget row, recheck inside the lock, fixed lock ordering budget→commitment→source, dedicated concurrency test (BR-O2/O3). |
| **R-03** | **Mutable source transactions** — a PO line or invoice changes after contributing. | Medium | High | Commitment amounts are immutable snapshots; sources only contribute in immutable states (`ISSUED`/`FINALIZED`/`VERIFIED`); post-hoc state loss requires an explicit reversal entry (PART 04 seam). |
| **R-04** | **Historical adoption** — pressure to backfill pre-CR POs/usages. | Medium | High | BR-H1: no implicit adoption; explicit separate CR with dry-run, idempotency, `origin='ADOPTED'`, audit. |
| **R-05** | **Missing vendor actual-cost authority before PO** — vendor work without a PO produces actual with no commitment. | High | Medium | Recorded as gap BR-V4; surfaced in the read model as uncommitted actual rather than hidden; not invented. |
| **R-06** | **Ambiguous budget selection.** | Low | High | Structurally prevented by the existing GiST exclusion; BR-B1 resolution rule; unbudgeted transactions rejected for commitment, never reassigned. |
| **R-07** | **Currency mismatch / currency-less sources** (`basic_expenses`, `vendor_service_costs` have no currency). | High | Medium | One currency per chain; fail-closed exclusion with an explicit reason; no default assumed; blocker B-02 recorded. |
| **R-08** | **Rounding / float drift** — existing read path uses JS `number` arithmetic. | Medium | Medium | All ledger arithmetic in SQL `NUMERIC`; generated columns; `NUMERIC(18,2)`; half-up at persistence only; JS numbers confined to JSON projection. Improving the legacy aggregation reducer is in PART 05 scope. |
| **R-09** | **Cross-Building / cross-Client leakage.** | Medium | Critical | Composite FKs (BR-I3), `assertBuildingAccess` on every path, Client derived not supplied, isolation tests per PART. |
| **R-10** | **Duplicate actualization** — retry or replay counts an actual twice. | Medium | Critical | Unique `(commitment_id, source_binding_id)`, unique `(commitment_id, idempotency_key)`, existing per-source-type partial unique indexes on bindings. |
| **R-11** | **Cancellation after partial actualization** leaving orphaned actual. | Medium | High | `CANCEL` rejected when `actualized_amount > 0`; `RELEASE` is the only path (BR-R1). |
| **R-12** | **Material return / reversal** — no return authority exists; a future return could silently overstate actual. | Low | Medium | BR-M7: reversal entry required if a return capability is ever added; no reversal path invented now. |
| **R-13** | **Audit completeness** — a financial transition without an event. | Medium | High | Events written on the same executor as the state change (rollback-consistent); rejection events best-effort outside the transaction; per-PART audit assertions. |
| **R-14** | **Read-model performance** at high source volume (the aggregation query already uses two lateral joins). | Medium | Medium | Indexes on `(budget_id, budget_category_id, status)`; derived-first with materialization deferred pending profiling evidence. |
| **R-15** | **Scope creep toward ERP** — pressure to add GL/AP/FX during implementation. | Medium | High | §17 non-goals are binding on every PART; any deviation requires re-governance before code. |
| **R-16** | **Blocking operations on budget exhaustion** — refusing material issue or PO issuance could halt facility operations. | Medium | High | BR-M6/BR-O6: only commitment creation is gated; physical material issue and actual recording are never blocked. |
| **R-17** | **KI-003 legacy assertion drift** surfacing during PART 06 regression. | Medium | Low | Out of scope; remains deferred debt; must not be folded into this CR. |
| **R-18** | Over-broad grant of the new override permission (existing seed defect class near line 465). | Medium | High | `operational_budget.override` granted to **no** role by default; grant is a deliberate administrative act; PART 02 test asserts no default grant. |

**Blockers**

- **B-01** — None blocking PART 01/02.
- **B-02** — `vendor_service_costs` and `basic_expenses` have no currency
  column, capping vendor/expense actual coverage. Repair is a change to those
  authorities and requires its own CR.
- **B-03** — No priced obligation exists for Work Order, Material Request,
  Vendor Work or SPK. Automatic commitment coverage is therefore limited to the
  PO chain; everything else is manual-estimate or actual-only, by design.

---

## 20. Implementation readiness

| Check | State |
|---|---|
| Repository inspected at baseline `f7c54b1` | ✅ |
| Budget authority identified and reused (no duplicate authority) | ✅ `operational_budgets` / `operational_budget_categories` |
| Commitment authority determined from evidence | ✅ ISSUED PO line (+ bounded manual estimate) |
| Rejected commitment candidates documented with evidence | ✅ MR / WO / Vendor Work / SPK / quotation |
| Actual authority determined from evidence | ✅ existing PART 04 eligibility rules, unchanged |
| Double-counting rule defined | ✅ open-commitment reduction + mutual exclusion |
| Monetary rules defined; no FX | ✅ |
| Concurrency/overspend rule defined with locking precedent | ✅ |
| Correction model defined (no destructive mutation) | ✅ |
| RBAC decided; exactly one new permission justified | ✅ `operational_budget.override` |
| Audit reuses `recordOperationalEvent` + AUDIT-01 correlation | ✅ |
| Scheduler decision recorded | ✅ none |
| Historical-data decision recorded | ✅ no backfill |
| API boundary bounded; OpenAPI deferred to PART 06 | ✅ |
| Non-goals recorded | ✅ |
| PART breakdown with scope/migrations/authorities/tests/dependencies | ✅ 6 PARTs |
| Risk register | ✅ 18 risks, 3 blockers |
| Runtime code / migrations / routes / OpenAPI / CI changed | ❌ none — governance only |

**PART 01 readiness: READY.** It has no blocker, one reversible single-column
migration, a clearly bounded service/validation change, and an existing test
suite to extend.

**PART 02 readiness: READY on paper**, pending PART 01 merge. Schema, lifecycle,
locking strategy, idempotency keys, constraints and audit vocabulary are all
specified above.

---

*End of CR-BE-COMM-VAR-01 START GOVERNANCE. No implementation is authorised by
this document beyond PART 01, which must be requested explicitly.*

---

## 21. PART 01 implementation notes — Budget + Cost Category Foundation

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope actually delivered:** the additive overspend-control attribute on the
existing CR-BE-FIN-01 budget authority — nothing else.

### 21.1 Migration

`src/database/migrations/0310_add_operational_budget_overspend_policy.ts`
(registered in `migrations/index.ts` after `0309`).

```sql
ALTER TABLE operational_budgets
  ADD COLUMN overspend_policy TEXT NOT NULL DEFAULT 'STRICT',
  ADD CONSTRAINT operational_budgets_overspend_policy_check
    CHECK (overspend_policy IN ('STRICT', 'ALLOW_WITH_OVERRIDE'));
```

- Reversible: `down` drops the constraint and the column.
- `NOT NULL DEFAULT 'STRICT'` means every pre-existing row safely becomes
  `STRICT` without a data-migration step and without rewriting any historical
  financial meaning (no commitment authority exists yet, so `STRICT` is exactly
  the current behaviour).
- No other table was created or altered. **No new budget table, no cost-category
  master, no commitment/actual/variance structure.**

### 21.2 Budget authority reused (unchanged)

`operational_budgets` + `operational_budget_categories`, the Building → Property
→ Client derivation (`resolveBuildingClient`), the DRAFT/ACTIVE/CLOSED/CANCELLED
lifecycle, the currency whitelist, the `NUMERIC(18,2)` planned amounts, the
category-total ≤ / = planned-amount rules, the GiST live-period exclusion, the
`operational_budget.read` / `operational_budget.manage` permissions, and
`recordOperationalEvent`. None of these were modified.

### 21.3 Final cost-category decision

**Re-inspected `operational_budget_categories` and confirmed it is sufficient.
No enterprise cost-category master is created.**

Evidence supporting reuse:

- `category_code` is already a governed, constrained identifier
  (`^[A-Z][A-Z0-9_]{0,63}$`) and is unique per budget
  (`operational_budget_categories_budget_code_unique`).
- The composite key `(id, budget_id)` already exists
  (`operational_budget_categories_budget_unique`, migration `0284`) and is
  already the FK target used by `operational_budget_source_bindings`. The
  PART 02 commitment ledger can therefore reference a category with the same
  structural guarantee, with **no schema change to the category authority**.
- Category is immutable after creation (`code` is rejected on update) and
  category deletion is already blocked once source bindings reference it, so a
  commitment link cannot be orphaned by an ordinary category edit.
- The alternative — a client-level master — would add a cross-budget dimension
  that no repository authority consumes today and would create a second
  classification vocabulary next to the free-text `vendor_service_costs.cost_category`
  and `basic_expenses.expense_category` fields. Rejected as unjustified.

Governance position confirmed: **cost category is always explicitly supplied on
a commitment; it is never inferred, and it is not a GL account.**

### 21.4 Overspend-policy behaviour delivered

| Aspect | Behaviour |
|---|---|
| Vocabulary | `STRICT` \| `ALLOW_WITH_OVERRIDE`; exported as `OPERATIONAL_BUDGET_OVERSPEND_POLICIES` with an `isOperationalBudgetOverspendPolicy` guard and `DEFAULT_OPERATIONAL_BUDGET_OVERSPEND_POLICY = 'STRICT'`. |
| Default | Omitted on create → `STRICT` (service default **and** DB default). |
| Create | `POST /buildings/{buildingId}/operational-budgets` accepts optional `overspendPolicy`. |
| Update | `PATCH /operational-budgets/{id}` accepts `overspendPolicy` through the **existing** governed management surface, under the **existing** DRAFT-only rule. No status semantics were changed and no new endpoint was added. |
| Read | `overspendPolicy` is returned additively on every budget read (get, list, building list). Existing fields are untouched. |
| Validation | Exact match, no case coercion — `strict`, `allow_with_override`, `OVERRIDE_ALLOWED`, `ALLOW`, `''`, numbers, `null`, `true`, objects are all rejected with a `VALIDATION_ERROR` (HTTP 400). |
| DB enforcement | Independent `CHECK` constraint; a direct SQL write of an unknown value fails with `23514`, and `NULL` fails with `23502`. |
| Control effect | **None yet, by design.** PART 01 stores a declaration of intent. No consumption check, no budget-row overspend gate, no override transaction, no `operational_budget.override` permission. |

### 21.5 Audit

Reuses `recordOperationalEvent` only — no new audit mechanism.

- `OPERATIONAL_BUDGET_CREATED` metadata gains `overspendPolicy`.
- `OPERATIONAL_BUDGET_UPDATED` continues to list `changedFields`.
- **New:** `OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED` is emitted **only when
  the stored value actually changes**, with
  `{ fromOverspendPolicy, toOverspendPolicy }`. Re-asserting the same value is a
  no-op and emits no policy event. The event inherits the CR-BE-AUDIT-01
  `request_id` / `source` correlation from the request execution context.

### 21.6 RBAC / isolation

No new permission. Reads remain `operational_budget.read`; the policy is set
only under `operational_budget.manage`. `contextAccessService.assertBuildingAccess`
still guards every path, and Client is still derived, never caller-supplied.
Verified: `PERMISSION_DENIED` for a permissionless session and
`BUILDING_ACCESS_DENIED` for a cross-Building admin, in both cases with no state
change. `operational_budget.override` remains a **PART 02** concern.

### 21.7 Preserved behaviour

Unchanged and re-verified by their own suites: the aggregation formulas, the
committed classification (`PURCHASE_ORDER`/`PO_LINE`), the actual classification,
the exclusion/fail-closed contract, source bindings, the material chain, PO
behaviour, vendor-invoice behaviour, the scheduler, OpenAPI (**no spec change —
PART 06**), CI, and KI-003.

### 21.8 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ clean |
| `tests/operational-budget-overspend-policy.test.ts` (new, focused) | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/management-operational-finance.test.ts` | ✅ 6/6 |
| `tests/management-building-operational-finance.test.ts` | ✅ 8/8 |
| `git diff --check` | ✅ clean |
| Broad regression | ❌ not run (out of scope) |

New-suite coverage: default = `STRICT` (API + stored row), DB vocabulary
constraint (`23514`) and `NOT NULL` (`23502`), legacy-shaped insert defaults to
`STRICT`, create/read with `STRICT`, create/read with `ALLOW_WITH_OVERRIDE`,
policy update + revert, no-op re-assert emits no event, invalid policy rejected
on create and update with no mutation, live-period overlap protection intact,
RBAC + Building isolation intact, category authority unchanged and no
cost-category master table present, activation semantics unchanged.

One pre-existing strict column-set assertion in
`tests/operational-budget-foundation.test.ts` was drifted by the additive
column and was **aligned additively** (the new column name was added to the
expected list). This is the repair pattern CR-BE-CI-01 established for drift
**caused by the change itself**; no assertion was weakened or removed, and the
deferred KI-003 backlog was not otherwise touched.

### 21.9 PART 02 extension points

1. `operational_budgets.overspend_policy` is the control switch PART 02 reads
   **inside** the `SELECT ... FOR UPDATE` budget-row lock.
2. `operational_budget.override` permission + `overspendOverrideReason` /
   `overspendOverrideByUserId` on the commitment, plus the `OVERRIDE` ledger
   entry, all land in PART 02.
3. `OPERATIONAL_BUDGET_OVERSPEND_REJECTED` and
   `OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN` events land in PART 02; the
   `OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED` event already exists.
4. Commitment rows attach to `(budget_id, client_id, building_id)` and
   `(budget_category_id, budget_id)` — both composite keys already exist, so
   PART 02 needs **no** change to the budget or category tables.
5. **Known limitation, deliberately deferred:** the policy is editable only
   while the budget is `DRAFT`, consistent with every other budget field. If an
   `ACTIVE` budget must be switched to `ALLOW_WITH_OVERRIDE`, PART 02 should add
   a dedicated, separately audited policy transition alongside the override
   authority — not a widening of the generic `PATCH`.
6. The read model (`/aggregation`, `/summary`) is untouched; PART 05 remains the
   place where `overspendPolicy` may surface in variance responses.

---

## 22. PART 02 implementation notes — Commitment Ledger + Concurrency Control

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope delivered:** the commitment ledger, its deterministic lifecycle, the
concurrency-safe approval path, overspend control, and the separate override
authority. **No** material integration, vendor integration, source-driven
actualization, variance read-model change, or OpenAPI change.

### 22.1 Migrations and model

| Migration | Content |
|---|---|
| `0311_create_operational_commitments` | Commitment header. Immutable snapshots (`client_id`, `building_id`, `budget_id`, `budget_category_id`, `origin`, typed source, `currency`). Amounts `committed/actualized/released` as `NUMERIC(18,2)`, with `open_amount` as a **generated** column (`committed − actualized − released`), following the `vendor_invoices.outstanding_amount` precedent. Composite FKs `(budget_id, client_id, building_id)` and `(budget_category_id, budget_id)` reuse the `0284` keys, so a commitment can never drift from its budget's scope. `UNIQUE (budget_id, idempotency_key)`. Partial unique indexes on `purchase_order_id` / `purchase_order_line_id` for non-cancelled rows — the structural no-double-counting guard for PART 03/04, populated by nothing in PART 02. |
| `0312_create_operational_commitment_entries` | Append-only ledger. `signed_amount` is always the effect on the OPEN amount, so `SUM(signed_amount) = open_amount` holds at all times (asserted by test). Sign is constrained per `entry_type`; corrective and override entries must carry a reason; `UNIQUE (commitment_id, idempotency_key)`; partial unique `(commitment_id, source_binding_id) WHERE entry_type = 'ACTUALIZE'` makes duplicate actualization of one authoritative lineage row structurally impossible. |

Both migrations are reversible and additive; no existing table was altered.
The permission catalogue gained one code (below).

### 22.2 Lifecycle

```
COMMITTED ─┬─► PARTIALLY_ACTUALIZED ─┬─► ACTUALIZED   (terminal)
           │                         └─► RELEASED     (terminal)
           ├─► ACTUALIZED                             (terminal)
           ├─► RELEASED                               (terminal)
           └─► CANCELLED                              (terminal)
```

- `PROPOSED` was **not** implemented: no repository authority produces an
  unapproved obligation carrying an amount, and adding one would require the
  approval-workflow engine this CR must not build. Creation **is** approval.
- Status is never free-form: it is recomputed from the three amounts in the
  same `UPDATE` that changes them, and a database CHECK rejects every
  inconsistent combination.
- **Release always frees exactly the remaining open amount** and is therefore
  terminal. **Cancellation is rejected once anything is actualized** — release
  is the only correct path. Decrease below the actualized amount is rejected.
- Only `MANUAL` origin is reachable from the service layer in PART 02. The PO
  origins exist in the schema so later PARTs extend this ledger instead of
  inventing a second commitment authority.

### 22.3 Concurrency and overspend control

Every financial decision runs in **one** `withTransaction`, opened with
`SELECT ... FROM operational_budgets WHERE id = $1 FOR UPDATE`. Lock order is
fixed **budget → commitment**. Availability is re-read inside the lock by a
single SQL statement; nothing read before the lock is used.

```
consumed  = SUM(committed_amount - released_amount)  -- non-cancelled commitments
available = planned_amount - consumed                -- checked per CATEGORY and per BUDGET
```

Actualization deliberately does **not** reduce `consumed`: moving value from
open to actualized must never free budget, otherwise one obligation could be
spent twice. This is the no-double-counting foundation PART 03+ builds on, and
it is asserted by test (a fully committed budget stays full after partial
actualization; it frees only on release/cancel).

**Overspend behaviour**

| Budget policy | Request exceeds available |
|---|---|
| `STRICT` | **409 `OPERATIONAL_BUDGET_OVERSPEND_REJECTED`**, with `scope`, `plannedAmount`, `consumedAmount`, `availableAmount`, `requestedAmount` in the error details. A supplied override reason is itself rejected (`OPERATIONAL_BUDGET_OVERSPEND_OVERRIDE_NOT_ALLOWED`) — a STRICT budget cannot be overridden by anyone. |
| `ALLOW_WITH_OVERRIDE` | Still rejected unless the caller supplies an explicit `overspendOverrideReason` **and** holds `operational_budget.override`. Then the commitment is created, the override provenance is persisted on the header, an `OVERRIDE` ledger entry is written, and a distinct audit event is emitted. |

Concurrency is proven by test: two parallel approvals of 60,000 against a
100,000 budget produce exactly one `201` and one `409`, and total consumption
is exactly `60000.00`.

### 22.4 Override permission

`operational_budget.override` — *Override Operational Budget Overspend*.

- Registered in `foundation-access.seed.ts` and **excluded** from the default
  PLATFORM_ADMIN grant through a new, exported
  `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` set. Being a platform administrator
  must not silently confer the authority to exceed approved spending;
  assignment is a deliberate administrative act.
- `tests/seeds.test.ts` was updated to assert exactly that (the catalogue count
  minus the exclusion set, plus a positive assertion that no role holds the
  excluded code). The assertion was strengthened, not weakened.
- Read stays `operational_budget.read`; all commitment writes stay
  `operational_budget.manage`. `assertBuildingAccess` guards every path and
  Client/Building remain derived, never caller-supplied.

### 22.5 ACTIVE-budget policy transition seam

`POST /operational-budgets/{id}/overspend-policy` (`operational_budget.manage`
**and** `operational_budget.override`) closes the PART 01 deferred limitation:
the policy of a **DRAFT or ACTIVE** budget can be changed with a mandatory
reason, audited through the existing
`OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED` event (now carrying
`budgetStatus` and `reason`). `CLOSED`/`CANCELLED` budgets are rejected. The
generic budget `PATCH` remains DRAFT-only and unchanged.

### 22.6 Audit and idempotency

Events (all written on the **same executor** as their state change, so they
roll back with a failed transaction, and all inheriting the CR-BE-AUDIT-01
`request_id`/`source` correlation):
`OPERATIONAL_COMMITMENT_CREATED`, `_ADJUSTED`, `_ACTUALIZED`, `_RELEASED`,
`_CANCELLED`, `OPERATIONAL_BUDGET_OVERSPEND_OVERRIDDEN`,
`OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED`, and
`OPERATIONAL_BUDGET_OVERSPEND_REJECTED` (emitted best-effort **after** the
rolled-back transaction, so a rejected attempt is still visible). Ledger
entries additionally carry their own actor, reason and `request_id`.

Idempotency: creation is keyed by `(budget_id, idempotency_key)`; every
transition is keyed by `(commitment_id, idempotency_key)`. A replay returns the
current state and writes nothing — verified for both create and adjust.

### 22.7 Monetary handling

All ledger arithmetic and every availability comparison happen in SQL
`NUMERIC`; amounts cross the repository boundary as strings and are converted
to `number` only in the JSON projection. Input is validated as a finite
positive amount with at most two decimals; zero amounts are rejected.
Commitment currency must equal the budget currency — there is no conversion.

### 22.8 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `tests/operational-commitment-ledger.test.ts` (new) | ✅ 14/14 |
| `tests/operational-budget-overspend-policy.test.ts` | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/management-operational-finance.test.ts` | ✅ 6/6 |
| `tests/management-building-operational-finance.test.ts` | ✅ 8/8 |
| `tests/seeds.test.ts` | ✅ 1/1 (run against a real PostgreSQL, not skipped) |
| `tests/permissions.test.ts` | ✅ 27/27 |
| `tests/operational-permission-contract.test.ts` | ✅ 5/5 |
| `tests/finding-authority-permissions.test.ts` | ✅ 4/4 |
| `git diff --check` | ✅ clean |
| Broad regression / CI / KI-003 | ❌ not run, not touched (out of scope) |

New-suite coverage: ledger creation and entry immutability, non-ACTIVE budget
rejection, currency and foreign-category rejection, STRICT overspend rejection
with audited rejection and zero writes, STRICT never overridable,
`ALLOW_WITH_OVERRIDE` requiring both reason and permission, override entry +
event, create/transition idempotency, adjust/release/cancel through entries
only, `SUM(signed_amount) = open_amount`, closed commitments frozen, partial
and full actualization, budget not freed by actualization, cancel-after-partial
rejected, decrease-below-actualized rejected, over-actualization rejected,
release/cancel freeing budget, concurrent approval serialization, database-level
sign/type/idempotency/consistency constraints, the duplicate-actualization
guard index, the ACTIVE-budget policy transition, RBAC/isolation, and input
validation with no ledger writes.

### 22.9 PART 03 extension points

1. `actualizeOperationalCommitment(commitmentId, { amount, sourceBindingId,
   idempotencyKey, actorUserId })` is the ready seam PART 03/04 call from
   inside their own source transaction. It is deliberately **not** routed over
   HTTP.
2. `operational_commitments.purchase_order_line_id` / `purchase_order_id` plus
   their partial unique indexes are the PO-line commitment slot; PART 03 adds
   the creation path (a source-derived variant of `insertCommitment`) and the
   legacy-binding mutual-exclusion check.
3. `operational_commitment_entries.source_binding_id` is the actual-to-ledger
   link; the partial unique index already prevents duplicate actualization.
4. `work_order_id` / `vendor_id` / `material_request_id` traceability columns
   and their indexes are in place for the PART 05 read model.
5. `ACTUALIZE_REVERSAL` is defined and constrained in the schema but has no
   service path yet — PART 04 wires it to source cancellation.
6. Known boundary, unchanged by PART 02: available budget currently subtracts
   ledger consumption only. Direct actuals that are not linked to a commitment
   (the existing binding-based actual figures) are not yet subtracted; that
   union lands with PART 03/05, as governed in §10.

---

## 23. PART 03 implementation notes — Material Commitment / Actual Integration

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope delivered:** the governed material chain only —
`ISSUED PO line → Commitment` and `WO material usage total_cost → Actual`.
**No** migration was required. **No** vendor/service commitment, vendor invoice,
basic-expense or vendor-service-cost change, variance read-model closure, or
OpenAPI change.

### 23.1 Material commitment authority

The ISSUED Purchase Order line remains the only priced, approved, pre-actual
obligation in the repository, and it is now wired:

`POST /operational-budgets/{budgetId}/commitments/from-purchase-order-line`
(`operational_budget.manage`) with only `purchaseOrderLineId`,
`budgetCategoryId`, `idempotencyKey` and an optional override reason.

Everything financial is **derived** from the authoritative line and rejected if
supplied by the caller: amount (`line_amount`), currency (PO currency), Client,
Building, `vendor_id` and `material_request_id` lineage. Preconditions, all
checked inside the budget row lock: PO `ISSUED`, same Building as the budget,
currency equal to the budget currency, category belongs to the budget, budget
`ACTIVE`, and normal PART 02 overspend control.

**Explicitly not commitment authorities (asserted by test):** an approved
Material Request (`APPROVED` with `approved_quantity` but no price), a
reservation, a receiving, and PO issuance itself — issuing a PO creates no
commitment, so procurement can never be blocked or surprised by Finance.

Commitment creation stays an explicit, categorised financial act, which is what
keeps the governed "category is always explicit, never inferred" rule intact.

### 23.2 PO-line mapping and mutual exclusion

- `origin = 'PO_LINE'`, `source_type = 'PO_LINE'`, `purchase_order_line_id` set.
  The PART 02 partial unique index gives one live commitment per PO line;
  a replay of the same `idempotencyKey` returns the same commitment.
- A PO (or line) already carried by a legacy CR-BE-FIN-01 `PO_LINE` /
  `PURCHASE_ORDER` source binding is **refused**
  (`OPERATIONAL_COMMITMENT_SOURCE_ALREADY_COMMITTED`), so the read-time legacy
  commitment and the ledger commitment can never both count the same
  obligation.

### 23.3 Actualization behaviour

Seam: `operationalCommitmentMaterialService.tryActualizeWorkOrderMaterialUsage`,
invoked from the existing material-issue transaction in
`inventory-wo-material-usage.service.ts` immediately after the usage row and
its `WORK_ORDER_MATERIAL_ISSUED` event.

Mapping: `usage.material_request_id → purchase_order_lines.material_request_id →
the open commitment on that line` (candidate rows locked `FOR UPDATE`).

| Case | Behaviour |
|---|---|
| usage has no cost | nothing happens — actual is never fabricated |
| no candidate commitment | usage is an **uncommitted actual** (see §23.5) |
| **more than one candidate** | **fail closed** — nothing actualized, no guess, `OPERATIONAL_COMMITMENT_MATERIAL_LINEAGE_AMBIGUOUS` recorded with the candidate ids |
| currency ≠ commitment currency | fail closed, `OPERATIONAL_COMMITMENT_MATERIAL_CURRENCY_MISMATCH` recorded, **no conversion** |
| exactly one candidate | `min(total_cost, open_amount)` actualized through the shared PART 02 primitive; excess stays an uncommitted actual and never creates a second commitment |

Traceability is preserved: the seam ensures the CR-BE-FIN-01
`WORK_ORDER_MATERIAL` source binding for the usage (reusing the existing ACTIVE
row when present, `currency_status = 'MATCHED'`) on the commitment's own budget
and category, and links it to the `ACTUALIZE` entry via `source_binding_id`.

**The material engine is untouched.** Reservation, demand, movement and balance
logic are unchanged; the seam only appends. It runs inside a **SAVEPOINT**, so a
finance-side failure rolls back the seam alone and the material issue still
succeeds — proven by test, including a fully exhausted budget where the issue,
the stock movement and the balance all complete normally.

### 23.4 Idempotency and duplicate-actualization prevention

- Entry key `WO_MATERIAL_USAGE:{usageId}` per commitment.
- PART 02's partial unique index on
  `(commitment_id, source_binding_id) WHERE entry_type = 'ACTUALIZE'`.
- One ACTIVE binding per usage (existing CR-BE-FIN-01 index).

Three independent guards; a usage can actualize its commitment exactly once.

### 23.5 No double counting, and the availability change

Two rules, both asserted:

1. **Actualization never frees budget.** Consumption stays
   `SUM(committed − released)`, so a partially or fully actualized commitment
   still consumes its full committed amount.
2. **Uncommitted material actuals now consume budget.** The availability probe
   gained one term (the only change required by this integration): costed
   usages in the budget's Building, period and currency, **minus** the portion
   already actualized against a commitment. A partially matched usage therefore
   contributes only its uncommitted remainder — never twice.

The term is **BUDGET scope only**: an unmatched usage carries no cost category,
and inventing one would violate the explicit-category rule. Category
availability remains ledger-only. All probe amounts are now normalised to
`numeric(18,2)` so reported figures have a stable scale.

### 23.6 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `tests/operational-commitment-material-chain.test.ts` (new) | ✅ 10/10 |
| `tests/operational-commitment-ledger.test.ts` | ✅ 14/14 |
| `tests/operational-budget-overspend-policy.test.ts` | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/management-building-operational-finance.test.ts` | ✅ 8/8 |
| `tests/work-order-material-cost.test.ts` | ✅ 7/7 |
| `tests/work-order-material-issue-control.test.ts` | ✅ 19/19 |
| `tests/inventory-material-reservations.test.ts` | ✅ 13/13 |
| `tests/material-request-approved-quantity.test.ts` | ✅ 8/8 |
| `tests/material-requests.test.ts` | ✅ 24/24 |
| `tests/purchase-order-lines.test.ts` | ✅ 19/19 |
| `tests/purchase-order-issuance.test.ts` | ✅ 22/22 |
| `tests/purchase-orders.test.ts` | ✅ 16/16 |
| `tests/receiving-material-request-binding.test.ts` | ✅ 10/10 |
| `tests/seeds.test.ts` | ✅ 1/1 |
| `git diff --check` | ✅ clean |
| Broad regression / CI / KI-003 | ❌ not run, not touched |

No existing test needed modification in this PART.

### 23.7 PART 04 extension points

1. `createPurchaseOrderLineCommitment` already accepts a **service**-backed PO
   line (`service_request_id`); PART 04 only needs the vendor-side eligibility
   rules and its own tests — no new commitment path.
2. The vendor actual link is the mirror of the material seam:
   `vendor_invoices.purchase_order_id` (migration `0274`), then the
   `work_order_procurement_bindings` lineage, with the same fail-closed rule on
   more than one candidate.
3. `applyCommitmentActualization` and the binding helper are source-agnostic —
   PART 04 reuses both with a `VENDOR_INVOICE` binding type.
4. `ACTUALIZE_REVERSAL` remains schema-only, awaiting the PART 04 invoice/cost
   cancellation seam.
5. The uncommitted-actual consumption term currently covers material usages
   only. Vendor invoices, vendor service costs and basic expenses are **not**
   included — deliberately out of PART 03 scope, and blocked for the latter two
   by the missing currency column (blocker B-02).

---

## 24. PART 04 implementation notes — Vendor / Operational Cost Integration

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope delivered:** `Service-backed ISSUED PO → Commitment` and
`Verified Vendor Invoice → Actual`, plus the first governed actualization
reversal. **No migration was required.** No variance/read-model closure, no
cost-category redesign, no invoice/accounting/AP/payment change, no OpenAPI
change.

### 24.1 Vendor commitment authority

**Reused unchanged** — the PART 03 PO-line authority already accepts a
service-backed line, because a service line is simply a line whose originating
request is a Service Request. No second commitment path was created and the
endpoint is the same:
`POST /operational-budgets/{budgetId}/commitments/from-purchase-order-line`.

Amount (`line_amount`), currency (PO currency), Client, Building and `vendor_id`
are derived from the authoritative line; a service line simply carries no
`material_request_id`. Eligibility is unchanged: PO `ISSUED`, same Building,
matching currency, category in budget, budget `ACTIVE`.

**Vendor Work, SPK/`work_contracts`, completion/service reports and BAST create
no commitment** — none of them carries an amount (verified again at this
baseline). The governance gap BR-V4 therefore stands: vendor work executed
without a Purchase Order produces **actual with no commitment**, which is
visible rather than hidden (§24.5). No priced vendor authority was invented.

### 24.2 Invoice → commitment mapping

Deterministic, in this order:

1. `vendor_invoices.purchase_order_id` (migration `0274`) — the invoice's own
   Purchase Order.
2. Otherwise, when the invoice carries a `work_order_id`, the existing BE-17H
   `work_order_procurement_bindings` lineage to the ISSUED Purchase Orders
   raised for the same purchase/service request.

Candidate commitments are the **open** commitments raised on those Purchase
Orders (by line or by header), locked `FOR UPDATE`, in the invoice's Building.

Eligibility for actual is exactly the governed rule: `status = 'FINALIZED'`
**and** `verification_status = 'VERIFIED'`. A DRAFT, PENDING, DISCREPANCY or
CANCELLED invoice is never actual. Applied amount is
`min(invoice_amount, open_amount)`; any excess remains an uncommitted actual and
never creates a second commitment.

The seam is invoked from the existing Vendor Invoice verification path, after
the authoritative state change, in its own transaction. It never rejects the
invoice command: a failure is conservative, not lossy — the invoice still
consumes budget as an uncommitted actual and its commitment stays open, so
available budget can only be understated, never overstated.

### 24.3 Ambiguity, idempotency and reversal

| Case | Behaviour |
|---|---|
| no candidate | uncommitted actual (consumes budget through §24.5) |
| **> 1 candidate** | **fail closed** — nothing actualized, `OPERATIONAL_COMMITMENT_VENDOR_LINEAGE_AMBIGUOUS` recorded with the candidate ids, no guess |
| currency ≠ commitment currency | fail closed, `OPERATIONAL_COMMITMENT_VENDOR_CURRENCY_MISMATCH`, **no conversion, no FX** |
| replay / re-verify | idempotent: entry key `VENDOR_INVOICE:{id}` plus the `(commitment_id, source_binding_id)` unique index; a still-matched VERIFIED invoice is already a no-op upstream |

**Governed reversal** (`ACTUALIZE_REVERSAL`, the first use of the PART 02
vocabulary) is triggered **only** by an existing authoritative invoice state
change: cancellation of a previously actualized invoice, or a re-verification
that returns `DISCREPANCY`. It is append-only — the original `ACTUALIZE` entry
is never edited or deleted — it restores `open_amount`, reopens a commitment
that had been closed by that actualization, and marks the lineage row `REMOVED`
with actor and timestamp so history stays queryable. A commitment already
`RELEASED` or `CANCELLED` is deliberately **not** reversible: its remainder was
formally given back and must not be resurrected.

### 24.4 Excluded authorities and gaps (unchanged)

- **`vendor_service_costs`** and **`basic_expenses`** stay out of the ledger and
  out of budget consumption: neither has an authoritative currency column, and
  this CR does not invent a currency, a default or an FX rate (**blocker
  B-02**). A test asserts both that the columns are still absent and that
  neither appears in the commitment `source_type` vocabulary.
- **No approved vendor amount exists before a Purchase Order** (**blocker
  B-03**): Vendor Work, SPK, reports and BAST remain amount-free.
- Payment, settlement and AP behaviour are untouched.

### 24.5 No double counting

1. Actualization still never frees budget (PART 02/03 rule, re-asserted here).
2. A verified invoice already actualized against a commitment is **not** counted
   again: the new uncommitted-invoice consumption term subtracts the portion
   already actualized (net of reversals) for that invoice.
3. Uncommitted verified invoices **do** consume budget at BUDGET scope — the
   mirror of the PART 03 material term, and the reason a missed seam is safe.
   Category scope stays ledger-only because an unmatched invoice carries no cost
   category.
4. A Purchase Order already represented by a legacy CR-BE-FIN-01 source binding
   is still refused a ledger commitment.
5. A cancelled invoice stops consuming budget in both places at once: the
   reversal releases the ledger, and the consumption term excludes non-verified
   invoices.

### 24.6 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `tests/operational-commitment-vendor-chain.test.ts` (new) | ✅ 9/9 |
| `tests/operational-commitment-material-chain.test.ts` | ✅ 10/10 |
| `tests/operational-commitment-ledger.test.ts` | ✅ 14/14 |
| `tests/operational-budget-overspend-policy.test.ts` | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/management-building-operational-finance.test.ts` | ✅ 8/8 |
| `tests/vendor-invoice-verification.test.ts` | ✅ 23/23 |
| `tests/vendor-invoices.test.ts` | ✅ 17/17 |
| `tests/vendor-invoice-consistency.test.ts` | ✅ 24/24 |
| `tests/vendor-invoice-procurement-linkage.test.ts` | ✅ 25/25 |
| `tests/vendor-invoice-payment.test.ts` | ✅ 31/31 |
| `tests/vendor-invoice-settlement-readiness.test.ts` | ✅ 18/18 |
| `tests/vendor-work.test.ts` | ✅ 22/22 |
| `tests/vendor-service-costs.test.ts` | ✅ 10/10 |
| `tests/basic-expenses.test.ts` | ✅ 8/8 |
| `tests/work-contracts.test.ts` | ✅ 23/23 |
| `tests/purchase-order-lines.test.ts` | ✅ 19/19 |
| `tests/purchase-order-issuance.test.ts` | ✅ 22/22 |
| `tests/purchase-orders.test.ts` | ✅ 16/16 |
| `git diff --check` | ✅ clean |
| Broad regression / CI / KI-003 | ❌ not run, not touched |

No existing test needed modification in this PART.

### 24.7 PART 05 extension points

1. The read model can now report, per budget: planned, ledger commitment
   (`committed − released`), open commitment, actualized, uncommitted material
   actual, uncommitted verified-invoice actual, and legacy source-binding
   contributions — all already computed or trivially derivable from
   `operational_commitments`, `operational_commitment_entries` and the existing
   bindings.
2. Traceability is complete for both chains: `source_binding_id` on every
   actualization entry, plus `work_order_id` / `vendor_id` /
   `material_request_id` / `purchase_order_line_id` on the commitment.
3. PART 05 must union the ledger with the legacy read-time commitment while
   honouring the mutual-exclusion rule already enforced at write time, and
   surface the fail-closed exclusion reasons introduced by PARTs 03–04
   (`…MATERIAL_LINEAGE_AMBIGUOUS`, `…VENDOR_LINEAGE_AMBIGUOUS`,
   `…CURRENCY_MISMATCH`).
4. Still deliberately outside the model, to be reported as gaps rather than
   numbers: `vendor_service_costs` and `basic_expenses` (B-02), and vendor work
   without a Purchase Order (B-03).

---

## 25. PART 05 implementation notes — Variance + Traceability Read Model

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope delivered:** the derived variance and traceability read model.
**No migration was required.** No new financial authority, no cost-category
change, no FX, no GL/AP/ERP, no scheduler, no OpenAPI change.

### 25.1 Aggregation model

Fully **derived at read time** — no materialized balance, no cached total, no
job. The existing CR-BE-FIN-01 aggregation remains the authority for the
fail-closed source-eligibility contract, and its exclusion list is surfaced
(not re-derived) by the new model.

New read surface (all `operational_budget.read`, all read-only):

| Endpoint | Purpose |
|---|---|
| `GET /operational-budgets/{budgetId}/variance` | Full variance for one budget with per-category breakdown |
| `GET /operational-budget-variance` | Portfolio breakdown across accessible budgets (filters: `buildingId`, `status`, `periodFrom`, `periodTo`) |
| `GET /buildings/{buildingId}/operational-budget-variance` | The same, scoped to one Building |
| `GET /operational-budgets/{budgetId}/traceability` | Flat source-transaction rows with classification and lineage keys |

Ledger and legacy contributions are reported **separately as well as combined**
(`ledgerCommittedAmount`, `ledgerOpenAmount`, `ledgerActualizedAmount`,
`ledgerReleasedAmount`, `legacyCommittedAmount`,
`uncommittedMaterialActualAmount`, `uncommittedInvoiceActualAmount`), so a
reader can always see which authority produced a figure.

### 25.2 Formulas

```
openCommitment  = ledgerOpen + eligibleLegacyCommitment
unallocatedActual = uncommittedMaterialActual + uncommittedInvoiceActual
consumed        = (ledgerCommitted − ledgerReleased) + eligibleLegacyCommitment
                  + unallocatedActual
actual          = ledgerActualized + unallocatedActual
available       = planned − consumed
variance        = planned − actual                (positive = under budget)
utilization%    = actual / planned × 100                       (null when planned = 0)
committedUtil%  = (actual + openCommitment) / planned × 100    (null when planned = 0)
```

Actualization never reduces `consumed`, so an obligation is consumed once from
creation until it is released or cancelled. Per-category figures use the same
formulas with the category's own plan; `unallocatedActual` is **budget scope
only** and the response says so explicitly
(`controls.categoryScopeIncludesUnallocatedActual = false`), because an
unmatched source carries no cost category and none is inferred.

**One consumption definition.** The PART 02–04 write-time overspend gate was
extended with the same eligible-legacy-commitment term, so what the variance
report shows is exactly what the overspend check enforces — verified by a test
that compares the rejection payload against the report.

### 25.3 Legacy / ledger mutual exclusion

- A `PO_LINE` / `PURCHASE_ORDER` binding contributes **only** while no
  non-cancelled ledger commitment references the same Purchase Order. Otherwise
  it is dropped and reported as an exclusion
  (`SOURCE_REPRESENTED_BY_DOWNSTREAM_ACTUAL`) and counted in
  `controls.legacyCommitmentSupersededCount`.
- A PO-header binding is valued only when the Purchase Order has exactly one
  line (the existing PART 04 rule); otherwise `SOURCE_LINEAGE_AMBIGUOUS`.
- Non-`ISSUED` source → `SOURCE_NOT_ELIGIBLE`; wrong currency →
  `SOURCE_CURRENCY_MISMATCH`. No conversion, ever.
- Legacy **actual** bindings for material usages and vendor invoices are
  superseded by the direct source terms, which already cover every eligible
  usage/invoice in scope net of the actualized portion — so those sources are
  counted exactly once whether bound or not.

### 25.4 Traceability and breakdowns

`/traceability` returns one row per contributing (or excluded) source with
`classification` ∈ `COMMITMENT | LEGACY_COMMITMENT | ACTUAL | EXCLUDED`, plus
`commitmentId`, `bindingId`, `budgetCategoryId`, amounts, currency, status and
the lineage keys `purchaseOrderId`, `purchaseOrderLineId`, `vendorId`,
`workOrderId`, `materialRequestId`, `vendorInvoiceId`,
`workOrderMaterialUsageId`, and `exclusionReason`.

Breakdowns supported: **Building** and **period** (the portfolio endpoints —
both are the budget's own dimensions, so no new aggregation axis is invented),
**budget** and **cost category** (the per-category array), **Work Order /
material source** and **Vendor / PO / invoice** (the traceability rows and the
commitment lineage columns).

### 25.5 Exclusions and gaps

The fail-closed contract is preserved and extended: `controls.failClosed`,
`excludedContributionCount` and the full `exclusions` array, now including the
PART 03/04 reasons and the legacy-suppression reason.

Gaps are **described, never valued** — the response carries a `gaps` array with
no amount field:

- `CURRENCYLESS_COST_AUTHORITY` (**B-02**) — `vendor_service_costs` /
  `basic_expenses` have no authoritative currency and are excluded everywhere.
- `VENDOR_ACTUAL_WITHOUT_COMMITMENT` (**B-03**) — verified invoices with no
  preceding commitment, because no approved vendor amount exists before a PO.

### 25.6 Correction folded in (governance rule BR-A1)

Implementing the read model exposed that the PART 03/04 actualization seams did
not enforce the governed budget-period rule: a usage or invoice dated outside a
commitment's budget period could still actualize it. Both candidate lookups now
require the governing date (`used_at`, `invoice_date`) to fall inside the
commitment's budget period, matching BR-A1 and the read model's own scope
filter. Regression-covered by the new suite and by the PART 03/04 suites.

### 25.7 Precision

All aggregation is done in SQL `NUMERIC(18,2)`; amounts cross the boundary as
strings and are converted to `number` only for the JSON projection, then
rounded once to two decimals. A test asserts exact behaviour on a
non-round amount (`9,999.99` committed → `990,000.01` available).

### 25.8 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `tests/operational-budget-variance-read-model.test.ts` (new) | ✅ 9/9 |
| `tests/operational-commitment-material-chain.test.ts` | ✅ 10/10 |
| `tests/operational-commitment-vendor-chain.test.ts` | ✅ 9/9 |
| `tests/operational-commitment-ledger.test.ts` | ✅ 14/14 |
| `tests/operational-budget-overspend-policy.test.ts` | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/management-operational-finance.test.ts` | ✅ 6/6 |
| `tests/management-building-operational-finance.test.ts` | ✅ 8/8 |
| `tests/work-order-material-cost.test.ts` | ✅ 7/7 |
| `tests/work-order-material-issue-control.test.ts` | ✅ 19/19 |
| `tests/vendor-invoice-verification.test.ts` | ✅ 23/23 |
| `tests/vendor-invoices.test.ts` | ✅ 17/17 |
| `tests/vendor-invoice-procurement-linkage.test.ts` | ✅ 25/25 |
| `tests/vendor-invoice-payment.test.ts` | ✅ 31/31 |
| `tests/purchase-order-lines.test.ts` | ✅ 19/19 |
| `tests/purchase-orders.test.ts` | ✅ 16/16 |
| `tests/material-requests.test.ts` | ✅ 24/24 |
| `git diff --check` | ✅ clean |
| Broad regression / CI / KI-003 | ❌ not run, not touched |

No existing test needed modification in this PART.

### 25.9 PART 06 readiness

1. The API surface is complete and stable: budget + category (PART 01),
   commitments and the policy transition (PART 02), PO-line commitment
   (PART 03/04), variance, portfolio variance and traceability (PART 05).
   PART 06 documents exactly these paths — no new endpoint should be needed.
2. Response contracts are fully typed in
   `operational-variance.types.ts`, `operational-commitment.types.ts` and the
   existing finance types; the OpenAPI schemas can be derived directly from
   them.
3. Cross-module validation for PART 06 should assert: the ledger/legacy
   mutual-exclusion invariant, `SUM(signed_amount) = open_amount`, the shared
   consumption definition between the write gate and the read model, and the
   B-02/B-03 gap reporting.
4. Still deliberately out of the model: `vendor_service_costs`,
   `basic_expenses` (B-02) and vendor work without a Purchase Order (B-03) —
   reported as gaps, never as numbers.

---

## 26. PART 06 implementation notes — OpenAPI + Cross-Module Validation

**Status:** implemented on `arena/01a02ee6-asentra-backend`.
**Implementation date:** 2026-08-23 (UTC).
**Scope delivered:** contract documentation for everything PARTs 01–05 built,
one cross-module validation suite, and governance closure. **No migration, no
runtime capability, no cost authority, no FX, no GL/AP/ERP, no scheduler, no
backfill, no CI change, no unrelated refactoring.**

### 26.1 OpenAPI closure

Spliced by `scripts/splice-commitment-variance-openapi.py` — an idempotent,
anchored script following the existing repository convention, so the contract is
regenerated rather than hand-edited.

**Documented paths (12 new):**

| Path | Method | Permission |
|---|---|---|
| `/operational-budgets/{id}/overspend-policy` | POST | `operational_budget.override` |
| `/operational-budgets/{budgetId}/commitments` | POST / GET | `manage` / `read` |
| `/operational-budgets/{budgetId}/commitments/from-purchase-order-line` | POST | `manage` |
| `/operational-commitments/{id}` | GET | `read` |
| `/operational-commitments/{id}/adjust` · `/release` · `/cancel` | POST | `manage` |
| `/operational-budgets/{budgetId}/variance` | GET | `read` |
| `/operational-budget-variance` · `/buildings/{buildingId}/operational-budget-variance` | GET | `read` |
| `/operational-budgets/{budgetId}/traceability` | GET | `read` |

**Documented schemas:** `OperationalBudgetOverspendPolicy` (added to
`OperationalBudget`, `CreateOperationalBudgetRequest`,
`UpdateOperationalBudgetRequest`), `OperationalCommitment`,
`OperationalCommitmentEntry`, `OperationalCommitmentDetail`,
`OperationalCommitmentStatus` / `Origin` / `EntryType`,
`OperationalCommitmentOverride`, the four request bodies, the policy-transition
request/result, `OperationalBudgetVariance(+Totals, +Category, +Gap, +Summary)`,
`OperationalBudgetTraceability(+Row)`, plus their envelopes and responses.

The **override boundary is contract-visible**: the policy transition documents
that it needs `operational_budget.override`, and every override reason field
documents that it is honoured only under `ALLOW_WITH_OVERRIDE` by a holder of
that permission. `UpdateOperationalBudgetRequest` documents that it stays
DRAFT-only. Gap objects carry no amount field, so a gap cannot be mistaken for a
value even in the contract.

### 26.2 Cross-module invariants proven

`tests/operational-commitment-openapi.test.ts` (10/10) confirms:

| # | Invariant | Result |
|---|---|---|
| 1 | Every runtime operation is documented with its exact enforced permission, `x-building-scoped`, 401/403 (and 409 on writes) | ✅ |
| 2 | Overspend/ledger/variance schemas exist, every `$ref` resolves, and no `exchangeRate`/`fxRate`/`journalEntry`/`generalLedger`/`glAccount` token exists anywhere in the contract | ✅ |
| 3 | No double counting between ledger and legacy sources (duplicate commitment refused; one actualization entry per usage) | ✅ |
| 4 | `SUM(commitment_entries.signed_amount) = open_amount` for every non-cancelled commitment after create/adjust±/release/cancel/actualize | ✅ |
| 5 | Write-side gate and read-side consumption use ONE definition (rejection payload equals the report; spending exactly the reported availability succeeds and drives it to zero) | ✅ |
| 6 | Material actualization respects the budget period | ✅ |
| 7 | Vendor-invoice actualization respects the budget period | ✅ |
| 8 | Currency mismatch stays fail-closed, never converted | ✅ |
| 9 | B-02 / B-03 remain explicit gaps, never fabricated values | ✅ |
| 10 | `operational_budget.override` is registered but granted to no role; STRICT rejects and is not overridable; `ALLOW_WITH_OVERRIDE` still rejects without the separate authority | ✅ |
| 11 | Client/Building isolation across every read and write of the surface | ✅ |

### 26.3 Gap and deferred boundary (unchanged, re-confirmed)

- **B-02** — `vendor_service_costs` and `basic_expenses` have no authoritative
  currency; they enter no figure and no `source_type`. Repair belongs to those
  authorities, not to this CR.
- **B-03** — no approved vendor amount exists before a Purchase Order; vendor
  work without a PO is actual with no commitment, reported as a gap.
- Historical adoption remains explicitly out of scope (no backfill).
- KI-003 untouched.
- **Pre-existing contract drift observed, not repaired:** 14 SLA operations in
  `docs/api/openapi.yaml` carry no `operationId`, which fails the global
  duplicate-id assertion in `attendance-contract`, `mobile-cross-contract`,
  `mobile-cr-regression-contract` and `mobile-cr-mob-05-regression-contract`.
  Verified identical at the PART 06 base commit with the unmodified spec, so it
  is **not caused by this CR**; it is KI-003-class drift owned by the SLA CR and
  repairing it here would be unrelated refactoring.

### 26.4 Validation results

| Check | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `tests/operational-commitment-openapi.test.ts` (new) | ✅ 10/10 |
| `tests/operational-finance-contract-validation.test.ts` | ✅ 4/4 |
| `tests/operational-budget-variance-read-model.test.ts` | ✅ 9/9 |
| `tests/operational-commitment-ledger.test.ts` | ✅ 14/14 |
| `tests/operational-commitment-material-chain.test.ts` | ✅ 10/10 |
| `tests/operational-commitment-vendor-chain.test.ts` | ✅ 9/9 |
| `tests/operational-budget-overspend-policy.test.ts` | ✅ 9/9 |
| `tests/operational-budget-foundation.test.ts` | ✅ 8/8 |
| `tests/operational-budget-aggregation.test.ts` | ✅ 11/11 |
| `tests/operational-budget-source-binding.test.ts` | ✅ 6/6 |
| `tests/material-chain-openapi.test.ts` | ✅ 10/10 |
| `tests/audit-part05-openapi.test.ts` | ✅ 4/4 |
| `tests/error-contract.test.ts` | ✅ 4/4 |
| `tests/integration-webhook-deliveries-read.test.ts` | ✅ 7/7 |
| `tests/mobile-context-contract.test.ts` | ✅ 13/13 |
| Pre-existing SLA `operationId` drift suites | ⚠️ unchanged (see §26.3) |
| `git diff --check` | ✅ clean |
| Broad regression / CI | ❌ not run |

No existing test needed modification in this PART.

---

## 27. CR-BE-COMM-VAR-01 — GOVERNANCE CLOSURE

**Closed:** 2026-08-23 (UTC) · **Branch:** `arena/01a02ee6-asentra-backend` ·
**Base:** `main` @ `f7c54b1`.

### 27.1 What was delivered

| PART | Delivered | Migrations |
|---|---|---|
| 01 | Budget + cost-category foundation confirmed; `overspend_policy` (`STRICT` default) | `0310` |
| 02 | Commitment ledger, append-only entries, lifecycle, budget-row locking, overspend control, `operational_budget.override`, ACTIVE-budget policy transition | `0311`, `0312` |
| 03 | ISSUED PO-line commitment; material actualization via `material_request_id`; uncommitted material actual | — |
| 04 | Service-backed PO-line commitment; verified-invoice actualization; governed reversal; uncommitted invoice actual | — |
| 05 | Derived variance + traceability read model; unified consumption definition | — |
| 06 | OpenAPI contract; cross-module validation; closure | — |

Three migrations in total; every other PART was purely additive service code
over existing authorities.

### 27.2 Governance decisions honoured end to end

- Budget authority **reused** (`operational_budgets` / `operational_budget_categories`); no second budget table, no cost-category master, no chart of accounts.
- The **ISSUED Purchase Order line** is the only automatic commitment authority; Material Request quantity, reservations, receivings, Work Orders, Vendor Work and SPK create none.
- Actual is only `FINALIZED`/`VERIFIED`/costed authoritative transactions; never fabricated from an estimate.
- **Actualization never frees budget** — the single rule that makes double counting impossible.
- Overspend is **never silent**: rejected by default, override needs policy + separate permission + recorded reason + audit event.
- Corrections are append-only (adjust / release / reversal); nothing financial is edited or deleted.
- One currency per chain; **no FX, no conversion, no invented currency**.
- Audit reuses `recordOperationalEvent` + CR-BE-AUDIT-01 correlation; no second audit store.
- **No scheduler. No backfill.** All balances transaction-driven and read-derived.
- Client/Building isolation derived, never caller-supplied, on every path.

### 27.3 Non-goals confirmed absent

General ledger, journal entries, AP/AR, bank reconciliation, taxation, PSAK/IFRS
reporting, FX engine, payroll, procurement rebuild, invoice OCR, payment
gateway, ERP, inventory valuation — none introduced. Verified for the contract
by an explicit token check in the PART 06 suite.

### 27.4 Open items carried forward

| Item | Owner |
|---|---|
| **B-02** currency on `vendor_service_costs` / `basic_expenses` | separate CR against those authorities |
| **B-03** priced vendor obligation before a PO (quotation/SPK value) | separate CR against Vendor Work / SPK |
| Historical adoption of pre-CR POs and material usages | separate, explicit adoption CR (dry-run, idempotent, audited, `origin = 'ADOPTED'`) |
| Legacy source bindings still creatable for a PO the ledger does not yet hold | acceptable today (read model suppresses the overlap); could be write-gated by a follow-up |
| Pre-existing SLA `operationId` contract drift | SLA CR / KI-003 backlog |
| Broad regression and CI execution | FINAL REVIEW |

### 27.5 Readiness

**CR-BE-COMM-VAR-01 is implementation-complete and ready for FINAL REVIEW.**
All six PARTs are merged into the working branch, every PART's targeted suite
passes, the runtime and the OpenAPI contract are aligned and asserted, and the
remaining gaps are recorded as gaps rather than as numbers.

---

## 28. FINAL REVIEW — verification record

**Reviewed:** 2026-08-23 (UTC) · **Branch:** `arena/01a02ee6-asentra-backend`
(7 commits ahead of `main` @ `f7c54b1`) · **Result: PASS — no CR defect found,
no corrective code change required.**

### 28.1 Chain confirmed

`Budget → Commitment → Actualization → Variance / Traceability` is complete and
closed end to end, with each step owned by exactly one authority.

### 28.2 Invariant verification

| # | Invariant | Evidence |
|---|---|---|
| 1 | CR-BE-FIN-01 budget authority remains authoritative | No budget or category table added; `0311`/`0312` create only `operational_commitments` and `operational_commitment_entries`; commitments attach through the existing composite keys |
| 2 | No second budget / cost-category authority | Verified by schema inspection and by the PART 04 assertion that no `cost_categories` / `operational_cost_categories` table exists |
| 3 | PO line is the only automatic priced commitment authority | Only two origins are service-reachable: `PO_LINE` (from an ISSUED line) and `MANUAL` (explicitly reasoned). `PO_HEADER` exists in the schema for legacy representation and has no service path |
| 4 | Material Request / receiving never commit | PART 03 test: approved MR (with `approved_quantity`) and PO issuance both leave the ledger empty; receiving carries no price and no path |
| 5 | Governed actual sources only | `unit_cost IS NOT NULL` material usages and `FINALIZED` + `VERIFIED` invoices, in code and in both consumption terms |
| 6 | No silent double counting with legacy bindings | Write-time refusal of a ledger commitment for a bound PO, read-time suppression of a binding superseded by the ledger, and direct source terms net of the actualized portion |
| 7 | Actualization never frees consumed budget | Consumption is `committed − released` in both the probe and the read model; asserted in PARTs 03, 05 and 06 |
| 8 | One consumption definition write-side and read-side | PART 06 asserts the rejection payload equals the report and that spending exactly the reported availability drives it to zero |
| 9 | STRICT vs ALLOW_WITH_OVERRIDE correct | STRICT rejects and refuses an override outright; ALLOW_WITH_OVERRIDE still rejects without reason + permission |
| 10 | Override needs separate permission + explicit reason | Enforced in `decideCommitmentOverspend`, persisted on the commitment, written as an `OVERRIDE` entry and a distinct audit event |
| 11 | Override permission not granted by default | Registered in the catalogue, excluded from the PLATFORM_ADMIN grant, asserted in `seeds` and PART 06 |
| 12 | Concurrency cannot overspend the same remainder | Budget-row `FOR UPDATE` + in-lock recheck; PART 02 concurrent-approval test |
| 13 | Currency mismatch fail-closed | Rejected on write, excluded on read, never converted |
| 14 | Actualization respects the budget period | Both candidate lookups constrain the governing date to the budget period (BR-A1); asserted in PART 06 |
| 15 | Reversal / adjustment append-only | No update or delete surface on entries; corrections are new signed entries |
| 16 | B-02 / B-03 remain gaps | Reported with counts and no amount, in the runtime response and in the contract schema |
| 17 | Isolation and audit correlation intact | Client derived, `assertBuildingAccess` on every path, events on the same executor with CR-BE-AUDIT-01 correlation |
| 18 | Runtime / OpenAPI / governance aligned | PART 06 contract suite asserts documented-vs-enforced parity for all 12 operations |

### 28.3 Migration verification

`0310`, `0311`, `0312` are imported and appended in ascending order in
`migrations/index.ts`; the whole registry is verified sorted; each migration id
matches its filename and each defines `down()`. Applied against a clean database
and then cycled `down 0312 → 0311 → 0310` and `up 0310 → 0311 → 0312`: both
directions succeed and the schema is fully restored. **No historical migration
was modified.**

### 28.4 Targeted consolidated validation (explicit file-based, no broad run)

`npm run typecheck` ✅ · `git diff --check` ✅

| Suite | Result |
|---|---|
| PART 01 `operational-budget-overspend-policy` | ✅ 9/9 |
| PART 02 `operational-commitment-ledger` | ✅ 14/14 |
| PART 03 `operational-commitment-material-chain` | ✅ 10/10 |
| PART 04 `operational-commitment-vendor-chain` | ✅ 9/9 |
| PART 05 `operational-budget-variance-read-model` | ✅ 9/9 |
| PART 06 `operational-commitment-openapi` | ✅ 10/10 |
| `operational-budget-foundation` | ✅ 8/8 |
| `operational-budget-source-binding` | ✅ 6/6 |
| `operational-budget-aggregation` | ✅ 11/11 |
| `operational-finance-contract-validation` | ✅ 4/4 |
| `management-operational-finance` | ✅ 6/6 |
| `management-building-operational-finance` | ✅ 8/8 |
| `work-order-material-cost` | ✅ 7/7 |
| `work-order-material-issue-control` | ✅ 19/19 |
| `inventory-material-reservations` | ✅ 13/13 |
| `material-request-approved-quantity` | ✅ 8/8 |
| `vendor-invoice-verification` | ✅ 23/23 |
| `vendor-invoices` | ✅ 17/17 |
| `vendor-invoice-procurement-linkage` | ✅ 25/25 |
| `vendor-invoice-payment` | ✅ 31/31 |
| `purchase-order-lines` | ✅ 19/19 |
| `purchase-order-issuance` | ✅ 22/22 |
| `purchase-orders` | ✅ 16/16 |
| `seeds` | ✅ 1/1 |
| `permissions` | ✅ 27/27 |

**Total: 25 suites, 322 tests, 0 failures.** No broad regression, no CI run.

### 28.5 Deferred, unchanged

B-02 currency authorities, B-03 pre-PO vendor commitment authority, historical
adoption/backfill, FX, GL, AP/AR, accounting/ERP expansion, scheduler, the
legacy SLA `operationId` debt, and CI/KI-003 — all remain out of scope and were
not touched.

**FINAL REVIEW verdict: the CR is complete, internally consistent, and ready for
pull request. Merge is not performed.**

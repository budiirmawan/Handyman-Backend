# CR-BE-PRICE-01 — START GOVERNANCE

## Price Catalog / Price Authority

**Inspection date:** 2026-08-24 (UTC)
**Stage:** START GOVERNANCE only
**Implementation status:** none — this document creates no migrations, runtime
code, routes, OpenAPI changes, or tests
**Repository:** `budiirmawan/Asentra-Backend`

This document defines the smallest correct enterprise price authority for
Asentra: a governed reference price that procurement can compare a Vendor
quotation against, that preserves historical price authority, and that never
becomes a second commitment, quotation, actual-cost, FX, or accounting
engine.

---

## 1. Repository baseline / branch / main commit

| Item | Verified value |
|---|---|
| Arena branch | `arena/01a0314b-asentra-backend` |
| Branch base / main commit after CR-BE-PRO-02 merge | `ac36b5b496b0a760524a93cb1bb24238e208ef07` (merge PR #62) |
| `origin/HEAD` at inspection | `ac36b5b4` — identical to branch base; tree clean |
| Latest applied migration | `0318_create_rfq_award_po_provenance` |
| Next free migration number | **0319** (then 0320, 0321 … in order) |
| Migration runner | `src/database/migrations/index.ts`, records in `schema_migrations`; applied migrations are never edited |
| Permission catalogue | `src/database/seeds/foundation-access.seed.ts`, **289 codes** (`grep -c "code: '"`); `tests/seeds.test.ts` asserts against `FOUNDATION_PERMISSIONS.length`, so catalogue growth is seed-relative, not a hardcoded count |
| Audit authority | `recordOperationalEvent` (`src/modules/operational-events`), AUDIT-01 correlation columns (`0309_add_operational_event_correlation`), integration-outbox seam |
| Isolation authority | BE-02G `ContextAccessService` (`src/modules/context-access`) + `docs/data-isolation.md` + `docs/effective-context.md` |
| OpenAPI | `docs/api/openapi.yaml` (hand-maintained, per-milestone contract tests such as `tests/rfq-openapi.test.ts`) |
| Open known issues | KI-003 (legacy strict-key assertion debt, deferred, explicitly out of scope for this CR) |

### Corrected assumptions from the request

Repository evidence confirms the following; none of the request's candidate
authorities was assumed before inspection:

1. **There is no existing reference/catalog/master price anywhere.** Neither an
   item standard price (`inventory_items` has no price columns, `0166`), nor a
   historical price table, nor a vendor catalog price (`vendors`,
   `vendor_categories`, `vendor_capabilities`, `vendor_building_relationships`
   carry no commercial amount).
2. **PRO-02 is fully implemented.** RFQ (`0313`), invitations/sessions
   (`0314`), quotations (`0315`), comparisons/evaluations (`0316`),
   recommendations/approvals/awards (`0317`), award→PO conversion provenance
   (`0318`) all exist and are live authorities. Quotation prices are immutable
   submitted commercial evidence.
3. **UOM conversion authority does not exist.** `units_of_measure` (`0071`) is
   a Client-scoped code/name/symbol/category master with `ACTIVE`/`INACTIVE`;
   no conversion factor table or ratio exists in migrations or modules (grep-
   verified). Therefore cross-UOM price comparison is structurally impossible
   today and must not be invented.
4. **A proven effective-dating + overlap-prevention pattern exists** in the
   utility-tariff authority (`0278_add_utility_tariffs`): `EXCLUDE USING gist`
   over `tstzrange(effective_from, effective_to, '[)')` on a scope key,
   restricted to `ACTIVE` rows, plus snapshot-on-use (`tariff_id`,
   `tariff_rate`, `currency` frozen into `utility_calculations`). A second
   exclusion precedent exists on `operational_budgets` (`0283`).
5. **Currency is an exact-match, nine-code whitelist** (`IDR`, `USD`, `SGD`,
   `MYR`, `AUD`, `EUR`, `GBP`, `JPY`, `CNY`) shared by PO, vendor invoice,
   budget, commitment, RFQ, and quotation authorities. Currency mismatch is an
   explicit non-comparable outcome with an audit event
   (`OPERATIONAL_COMMITMENT_MATERIAL_CURRENCY_MISMATCH`,
   `OPERATIONAL_COMMITMENT_VENDOR_CURRENCY_MISMATCH`); no FX authority exists.
6. **There is no service catalog/master.** `service_requests.service_type`
   (`0178`) is a data-driven free-text code with no governed vocabulary table;
   `vendor_capabilities` are Vendor-scoped capability codes. This is decisive
   for the service-price decision (§6).
7. **Sensitive financial authorities are seeded but unassigned by default**:
   `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES = { 'operational_budget.override',
   'rfq.award' }`; PLATFORM_ADMIN does not receive them. This is the precedent
   for price-override authority (§13).
8. **The only priced automatic operational-commitment source is an ISSUED PO
   line** (`operational_commitments.origin IN ('MANUAL','PO_HEADER',
   'PO_LINE')`; COMM-VAR-01 services). A reference price must never become a
   commitment origin.

---

## 2. Authority map (verified)

### 2.1 Vendor foundation

| Concern | Existing authority | Verified result | PRICE-01 treatment |
|---|---|---|---|
| Vendor master | `vendors` (`0054`) / `src/modules/vendors` | Client-scoped, `vendor_code` unique per Client, `ACTIVE`/`INACTIVE`; no portal identity, no price | FK target for optional Vendor-specific price tier |
| Vendor category | `vendor_categories` (`0055`/`0056`) | Client-scoped classification, optional on Vendor | Not a price anchor |
| Vendor/Building relationship | `vendor_building_relationships` (`0058`) | Many-to-many, `effective_from`/`effective_until` optional window, active/inactive history; grants no data access | Optional validation signal only; a Vendor-specific price does not require this relationship |
| Vendor capability | `vendor_capabilities` (`0059`) | Vendor capability code, optionally narrowed to a relationship | Not a price anchor (capability ≠ priceable subject) |
| Vendor compliance/license | `vendor_compliance_documents` (`0061`), `vendor_licenses_certifications` (`0062`) | Status/expiry authorities | Reused only by PRO-02 eligibility; untouched here |
| Vendor service cost | `vendor_service_costs` (`0201`) | Operational cost record: `cost_amount NUMERIC`, **no currency**, DRAFT/FINALIZED/CANCELLED + history; per docs "not an approved commitment" | Classified **informational/operational cost**; never a reference price source |
| Vendor invoice | `vendor_invoices` (`0261`+`0262`+`0263`+`0274`) | Payable authority: `invoice_amount NUMERIC(18,2)`, `currency`, PO/SPK linkage, verification, payment status | Classified **actual cost**; never a reference price source |

### 2.2 Item / UOM foundation

| Concern | Existing authority | Verified result | PRICE-01 treatment |
|---|---|---|---|
| Item master | `inventory_items` (`0166`) | Client-scoped; `code` unique per Client; `item_type IN (SPARE_PART, MATERIAL, CONSUMABLE)`; optional `uom_id`; `ACTIVE`/`INACTIVE`; **no price columns** | Sole material price subject |
| UOM master | `units_of_measure` (`0071`) | Client-scoped; `code` unique per Client; category/symbol; `ACTIVE`/`INACTIVE`; **no conversion authority** | Exact UOM identity for material price entries and comparisons |
| UOM usage convention | `material_requests.uom_id` (derived from and validated against the item's UOM, `0177`), `receivings.uom_id` (`0266`), `inventory_stock_movements.uom_id`, PO lines `uom_id` | Stable FK snapshot convention; no conversion engine anywhere | Price comparison requires exact UOM equality |

### 2.3 Demand / sourcing foundation (PRO-02 era)

| Concern | Existing authority | Verified result | PRICE-01 treatment |
|---|---|---|---|
| Purchase Request | `purchase_requests` (`0176`) | Client/Building-scoped demand container; **no price** | Untouched |
| Material Request | `material_requests` (`0177`, `0265`) | One item line; `quantity`, `approved_quantity`; `uom_id` validated against item; **no price** | RFQ line quantity/UOM lineage stays here |
| Service Request | `service_requests` (`0178`) | `service_type` free code string, `title`/description/date/location, optional `vendor_id`; OPEN/CANCELLED; **no quantity, no price, no service master** | Service-price gap evidence (§6) |
| Procurement approvals | `procurement_approval_bindings` (`0179`) | Typed request binding; append-only terminal decision; extended to RFQ by `0317` | Reuse only if a later PART adds price-change approval — not assumed now |
| Vendor selection readiness | `vendor_selection_readiness` (`0180`) | Eligibility snapshot, not a quote/award | Untouched |
| PO readiness | `purchase_order_readiness` (`0181`) | Sole PO precondition authority | Untouched |
| RFQ | `rfqs` + `rfq_lines` (`0313`) | Typed `source_mode MATERIAL/SERVICE`; RFQ carries `currency`; lines snapshot item/UOM/quantity from MR/SR; **no price** | Reference price resolves per RFQ line at comparison time |
| Invitations/sessions | `rfq_vendor_invitations`, `rfq_vendor_access_sessions` (`0314`) | Token-hash external Vendor boundary; separate from internal Users | Vendors never gain internal price visibility through this boundary (§16) |
| Vendor quotations | `vendor_quotations`, `vendor_quotation_revisions`, `vendor_quotation_lines` (`0315`) | Submitted revisions immutable; `unit_price NUMERIC(18,2) >= 0`, generated `line_total`, `required_uom_id` snapshot, revision `currency` | Classified **vendor quotation price** — comparison counterparty to the reference price |
| Comparisons | `rfq_comparison_runs`, `rfq_comparison_evidence`, `rfq_comparison_lines`, `rfq_comparison_evaluations` (`0316`) | Immutable, append-only per run; quote currency must equal RFQ currency (`rfqComparisonCurrencyInvalidError`); evidence `total_amount`; line unit/line totals snapshotted | Additive nullable reference-price snapshot columns arrive in PART 04 |
| Recommendations/awards | `rfq_recommendations`, `rfq_awards` (`0317`) | Human recommendation → approval binding → award; `rfq.award` unassigned by default | Untouched; no price gate |
| Award→PO provenance | `rfq_award_po_conversions`, `rfq_award_po_line_provenance` (`0318`) | Typed lineage; conversion creates an existing DRAFT PO | Untouched; PO prices remain the awarded quotation snapshot |

### 2.4 Commercial / financial foundation

| Concern | Existing authority | Verified result | PRICE-01 treatment |
|---|---|---|---|
| Purchase Order | `purchase_orders` (`0269`, `0271`) | Client/Building/Vendor derived from readiness; `currency` whitelist; DRAFT/ISSUED/CANCELLED; issuance explicit with row lock | Warn-only deviation read model (PART 05); never blocked silently |
| PO line | `purchase_order_lines` (`0270`) | `unit_price NUMERIC(18,2) >= 0`, `line_amount NUMERIC(18,2) >= 0`, frozen `quantity_snapshot`, `uom_id` snapshot; DRAFT-only edit; append-only `purchase_order_line_history`; for a SERVICE line the unit price IS the line amount | Classified **committed PO price**; never mutated by catalog changes |
| WO material usage cost | `inventory_work_order_material_usages` (`0267`) | Optional `unit_cost`, generated `total_cost`, optional `currency`, `cost_source`/`cost_reference`; rows immutable; explicitly **operational, not procurement price authority** (its own audit found "no price data anywhere in the chain") | Classified **actual cost** (operational); read-only comparator context only |
| Operational budgets | `operational_budgets`, `operational_budget_categories` (`0283`) | Building-scoped period; explicit `currency`; `planned_amount`; live-period exclusion constraint | Reference price is **not** a budget amount and never feeds one |
| Commitments | `operational_commitments` (`0311`), `operational_commitment_entries` (`0312`) | Immutable monetary snapshot; `origin IN ('MANUAL','PO_HEADER','PO_LINE')`; append-only signed ledger; currency exact-match actualization with mismatch events | Price Catalog adds **no new origin**; never a commitment authority (§12) |
| Currency convention | Nine-code whitelist in PO/invoice/budget/commitment/RFQ/quotation | Exact match only; mismatch = explicit non-comparable + event | Reused unchanged (§9) |
| Decimal convention | `NUMERIC(18,2)` money; SQL-generated amounts; API boundary converts | No floating-point money authority | `unit_price` follows `NUMERIC(18,2)`, `>= 0` (PO convention) |

### 2.5 Cross-cutting foundation

| Concern | Existing authority | PRICE-01 reuse |
|---|---|---|
| Audit | `recordOperationalEvent` (`src/modules/operational-events`): typed input, sensitive-key scrubbing (`password`, `token`, `secret`, `apiKey`, …), AUDIT-01 `request_id`/`source` correlation (`0309`), integration-outbox hook | All price lifecycle events recorded through it; no parallel audit |
| RBAC | `permissions`/`roles` + foundation seed; `requirePermission` default-deny middleware; `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` | New codes registered in the seed; override joins the unassigned set (§13) |
| Isolation | BE-02G `ContextAccessService.getAccessibleBuildingIds` / `assertBuildingAccess` | All price reads/writes scope-checked; caller can never widen Client/Building |
| Effective dating | `vendor_building_relationships` window; **tariff exclusion constraint (`0278`)**; budget live-period exclusion (`0283`); `btree_gist` extension already installed | Structural template for price overlap prevention (§10) |
| Scheduler | Single due-job scheduler (reminders/escalations), env-gated, disabled in tests | Not reused — no scheduler added (§18) |
| OpenAPI | `docs/api/openapi.yaml` + per-milestone contract tests | Changed only in PART 06 |

### 2.6 Existing price / amount inventory and classification

Every money-bearing field found by inspection (migration-verified), classified
per this CR's taxonomy:

| Field | Authority | Classification |
|---|---|---|
| `vendor_quotation_lines.unit_price` / generated `line_total` | `0315` | **Vendor quotation price** (immutable commercial evidence) |
| `vendor_quotation_revisions.currency` | `0315` | Quotation price context |
| `rfq_comparison_evidence.total_amount`; `rfq_comparison_lines.unit_price`/`line_total` | `0316` | **Quotation-derived evidence snapshot** (not a master price) |
| `purchase_order_lines.unit_price` / `line_amount` (+history copies) | `0270` | **Committed PO price** |
| `inventory_work_order_material_usages.unit_cost` / generated `total_cost` | `0267` | **Actual cost** (operational material actual; optional, snapshot-on-use) |
| `vendor_invoices.invoice_amount`; paid/outstanding | `0261`/`0263` | **Actual cost** (payable actual) |
| `vendor_service_costs.cost_amount` (+history) | `0201` | **Informational / operational vendor cost** — no currency, not an approved commitment; **non-authoritative as a price reference** |
| `basic_expenses.amount` | `0202` | Informational operational expense; non-authoritative |
| `utility_calculation_bases` rate (+ `utility_calculations.tariff_*` snapshot) | UTL-01 (`0278`) | Utility tariff reference **rate in the utility domain only** — structurally exemplary (exclusion window + snapshot-on-use), semantically out of scope (tenant-billing, not procurement) |
| `operational_budgets/.categories.planned_amount` | `0283` | Budget plan amount — not a price |
| `operational_commitments.*` + entries | `0311`/`0312` | Commitment amounts — derived from ISSUED PO lines, not prices |
| `tenant_charges`/`tenant_invoices`/`utility_bills`/`payment_receipts`/`invoice_payment_status` amounts | `0195`–`0200` | Tenant-side receivables; out of procurement scope entirely |
| `inventory_items` (any price) | `0166` | **None exists** — verified gap |
| Any historical/reference price table | — | **None exists** — verified gap |

**Governance rule:** no transactional price (quotation, PO line, usage cost,
invoice, vendor service cost) may be repurposed, auto-copied, or silently
synchronized into the Price Catalog. Adoption of an existing commercial fact
as a reference price is only ever an explicit, human, provenance-recorded act
(§19).

---

## 3. Verified gaps

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G-01 | No governed reference/catalog price exists | §2.6 inventory | This CR defines it; today "no reference price" is the only possible comparison outcome |
| G-02 | No service catalog/master identity | `service_requests.service_type` free text (`0178`); `vendor_capabilities` are Vendor-scoped | SERVICE price entries are deferred (§6); cannot anchor price to an ungoverned free-text code |
| G-03 | No UOM conversion authority | `0071` master only; zero conversion tables (grep-verified) | Price comparison requires exact UOM match; mismatched UOM = explicit not-comparable (§9) |
| G-04 | No price-history preservation mechanism | No effective-dated price table at all | This CR introduces effective dating + overlap prevention (§10) |
| G-05 | Quotation comparisons currently carry no reference dimension | `0316` schema has quote facts only | PART 04 adds additive nullable reference snapshots to `rfq_comparison_lines` |
| G-06 | No item default/purchase UOM distinction beyond one optional item UOM | `inventory_items.uom_id` optional (`0166`); MR validates against it | The price entry carries its own explicit UOM; an item without a priceable UOM entry yields NO_REFERENCE_PRICE, not a guess |
| G-07 | KI-003 legacy strict-key assertion debt remains open | `docs/known-issues.md` | Out of scope; PART 06 records any intersections without fixing KI-003 |
| G-08 | No permission codes for price governance | Seed has 289 codes; none price-related | PART 01 registers `price_catalog.read` / `.manage` / `.override` (§13) |

---

## 4. Price-authority decision

### 4.1 Decision: ONE shared, flat, tenant-isolated price authority

Asentra needs **one** price authority, not separate material/service masters:

- PRO-02 already proved the single-table typed-subject pattern: `rfqs` and
  `rfq_lines` serve MATERIAL and SERVICE demand through a `source_mode`
  discriminator with mutually-exclusive typed references (`0313`). The same
  discriminator keeps both subjects under one lifecycle, one audit vocabulary,
  one isolation model, one selection algorithm.
- A SERVICE master price cannot be activated today at all (§6), so building a
  second material-grade master table now would create dead governance surface.

**Rejected alternatives, with reasons:**

| Candidate | Verdict | Reasoning |
|---|---|---|
| `price_catalogs` header + `price_catalog_entries` detail | **Rejected (header)** | No repository precedent: `vendors`, `inventory_items`, tariffs, budgets are flat tables with scope columns. A grouping header confers no extra authority, no extra invariant, and only adds join and lifecycle complexity. The "catalog" concept is the table itself plus query filters |
| Separate `material_prices` + `service_prices` tables | **Rejected** | Duplicates lifecycle/exclusion/audit/selection logic for a SERVICE lane that cannot be activated yet (G-02) |
| Repurposing PO-line history or quotation history as "price history" | **Rejected** | Those are transactional commercial evidence with different provenance and mutability semantics; §2.6 classification keeps them distinct |
| Extending `inventory_items` with price columns | **Rejected** | An item master mutation-per-price-change cannot express effective windows, Vendor/Building tiers, or history without becoming a second ledger inside the master |
| Extending `utility_calculation_bases` | **Rejected** | Tariffs are a utility-billing-domain authority with its own CHECK shape (`utility_type IN ('ELECTRICITY','WATER')` for tariff rows); widening it into procurement would couple two unrelated governance domains |

### 4.2 Governed model (definition, not implementation)

Proposed canonical name: **`price_catalog_entries`** (exact table/column names
are finalized by PART 01's migration review; semantics in this section are the
governance contract).

| Dimension | Decision | Repository justification |
|---|---|---|
| `client_id` | NOT NULL, FK `clients` | Every authority is Client-scoped |
| `building_id` | NULLABLE FK `buildings` — NULL = Client-wide | Tariff precedent (`0278`): Building-scoped specialization of a Client-wide base |
| `source_mode` | `MATERIAL` \| `SERVICE`; **v1 DB CHECK allows `MATERIAL` only** | Typed discriminator from `0313`; SERVICE widening is a deliberate future migration once G-02 closes (fail closed, mirroring how `0315` widened the `supporting_documents` CHECK) |
| `item_id` | NOT NULL FK `inventory_items` for MATERIAL | Sole material subject (§5) |
| Future service subject | No column in v1 beyond the discriminator | A governed service identity does not exist; nullable placeholder columns invite misuse |
| `vendor_id` | NULLABLE FK `vendors` — NULL = general reference; NOT NULL = Vendor-specific governed commercial reference | Vendor tier mirrors `rfq_vendor_invitations`/`vendors` scope; optional per CR objective |
| `entry_kind` | `REFERENCE` \| `VENDOR_CONTRACT`, CHECK-consistent with `vendor_id` nullness | Makes the two v1 price classes explicit and auditable without a second table |
| `uom_id` | NOT NULL FK `units_of_measure` (MATERIAL) | Exact UOM identity; no conversion (§9) |
| `currency` | `VARCHAR(3)` NOT NULL, nine-code whitelist CHECK | Existing currency authority reused verbatim |
| `unit_price` | `NUMERIC(18,2)` NOT NULL, `>= 0` per **1 UOM unit** | PO/quotation decimal convention |
| `effective_from` / `effective_to` | `TIMESTAMPTZ` NOT NULL / NULL; half-open `tstzrange '[)'`; `effective_to > effective_from` when set | Tariff window precedent (`0278`) |
| `status` | `DRAFT` → `ACTIVE` → `INACTIVE` (terminal); state actor/timestamp correlation columns following the `rfqs` state-check pattern | Existing lifecycle vocabulary |
| Replacement | New entry + predecessor closed (`replaced_by_entry_id` nullable self-FK + deactivation actor/time on the old row) | Quotation-revision supersession precedent (`0315` `superseded_at`) generalized |
| Provenance | `source_type` CHECK IN (`'MANUAL'`) in v1; `source_reference` TEXT NULL; `notes` | No silent adoption; future governed adoption adds new `source_type` values by migration (§19) |
| Approval metadata | `approved_by_user_id`, `approved_at` NULLABLE; v1 approval is optional human attribution, not an engine | Keeps door open for PART 05 without inventing a second approval engine |
| Idempotency | `idempotency_key` + `idempotency_fingerprint` (sha-256 hex), unique per Client | `rfqs`/quotations precedent |
| Scope proving | Composite `UNIQUE (id, client_id)`; PART 01 may add composite `UNIQUE (id, client_id)` to `inventory_items` / `vendors` / `units_of_measure` following the `0313` scope-FK precedent, so child rows can prove Client scope structurally |

**Overlap prevention (structural fail-closed):** one exclusion constraint in
the tariff pattern (`btree_gist` already installed by `0278`):

```text
EXCLUDE USING gist (
  client_id   WITH =,
  item_id     WITH =,
  uom_id      WITH =,
  currency    WITH =,
  building_id WITH =,      -- nullable: NULL (Client-wide) never conflicts with a Building row, enabling tiers
  vendor_id   WITH =,      -- nullable: NULL (general) never conflicts with a Vendor row, enabling tiers
  tstzrange(effective_from, effective_to, '[)') WITH &&
)
WHERE (status = 'ACTIVE')
```

Consequences verified against the nullable-GiST semantics already relied on by
`0278`: rows whose key differs by NULL cannot conflict, so the four scope
tiers (§8) may coexist; within one tier, overlapping ACTIVE windows for the
same (item, UOM, currency, building key, vendor key) are **structurally
rejected** — concurrent creation, activation, or replacement cannot produce
two equally-applicable rows.

### 4.3 What the authority deliberately is NOT

Not a commitment origin, not a budget amount, not an actual-cost record, not
inventory valuation, not a quotation, not a PO, not FX, not accounting (§21).

---

## 5. Material price model

| Question | Governed answer | Evidence |
|---|---|---|
| Item authority | `inventory_items` (`0166`) — the only material master | Verified: code unique per Client, typed, ACTIVE/INACTIVE |
| UOM authority | `units_of_measure` (`0071`); service-layer validation (same Client, ACTIVE) follows the `inventory_items` convention | The item itself carries only one *optional* base UOM; MR/RFQ/PO lines snapshot `uom_id` |
| Price basis | Price per **1 unit of the entry's explicit UOM** — same semantic as `vendor_quotation_lines.unit_price` against its `required_uom_id` snapshot and PO line `unit_price` against its `uom_id` snapshot | `0315`, `0270` |
| Is the entry UOM the item base UOM or a purchase UOM? | **Specified per entry**; it only participates in comparison when it *exactly equals* the RFQ-line required UOM. There is no conversion authority (G-03), so a price in "BOX" can never answer a quotation in "EACH" | G-03; inventing ratios is prohibited |
| Client/Building applicability | Four tiers via nullable `building_id`/`vendor_id` (§8) | Tariff/budget Building-scoping precedents |
| Vendor-specific pricing | Optional tier (`entry_kind = VENDOR_CONTRACT`) | Justified: quotations are per-Vendor; governance keeps it an *option*, not a requirement |
| Effective period | Mandatory `effective_from`, optional `effective_to`, `[)` half-open | Tariff precedent |
| Overlaps | Structurally rejected within a tier by the exclusion constraint (§4.2) | `0278`/`0283` precedents |
| Deriving price from stock valuation | **Prohibited** — no valuation authority exists (moving average/FIFO/standard are explicit non-goals) and `0267` documents "no price data anywhere in the chain" | §21 non-goals |

An item with **no** applicable ACTIVE entry yields `NO_REFERENCE_PRICE` — a
valid, non-blocking comparison outcome (§11), never an inferred price.

---

## 6. Service-price decision (gap recorded)

**Finding:** no stable, governed service identity exists in the repository:

- `service_requests.service_type` (`0178`) is a free, data-driven code string
  with no vocabulary table, no uniqueness, no lifecycle — two Clients (or two
  typists) may write "CLEANING", "cleaning", "Cleaning Svc" for the same
  thing, and nothing governs the difference.
- `vendor_capabilities` (`0059`) are Vendor-scoped capability codes (eligibility
  data), not a priceable service catalog.
- No other service master was found (module + migration sweep).

**Decision — fail closed:**

1. CR-BE-PRICE-01 **does not activate** SERVICE price entries. The v1 schema
   CHECK constrains `source_mode = 'MATERIAL'`; a future migration widens it
   only alongside a governed service identity FK.
2. Free-text service-price master rows are **not invented** — a reference
   price anchored to ungoverned text would be a false authority.
3. Per-`service_request_id` ad-hoc anchoring is also rejected for the catalog:
   a one-off demand row is not a master identity; a per-request expected cost
   belongs to the request's own governance, not to a reusable price catalog.
4. Consequence for PRO-02 flows: SERVICE RFQ lines compare on quotation facts
   alone (current `0316` behavior); PART 04's reference column simply records
   `NOT_REQUESTED`/no-reference for SERVICE lines. **Nothing breaks and
   nothing is blocked.**
5. Blocker B-01 (§23): a separate "Service Catalog / Service Master" CR must
   propose the governed service identity before SERVICE price tiers can be
   governed. This CR records the gap and provides the seam (`source_mode`,
   tier machinery, selection, audit) so adoption later is additive, not a
   rebuild.

---

## 7. Price classifications (governed distinctions)

| Class | Authority | Mutability | May it feed reference comparison? |
|---|---|---|---|
| **Reference Price** (general, `entry_kind=REFERENCE`) | `price_catalog_entries` (this CR) | Effective-dated, non-destructive replacement; ACTIVE windows immutable | Yes — advisory only |
| **Vendor Contract/Catalog Price** (`entry_kind=VENDOR_CONTRACT`) | `price_catalog_entries` (this CR) | Same lifecycle; Vendor tier | Yes — highest-precedence advisory reference |
| **Quotation Price** | `vendor_quotation_revisions`/`_lines` (`0315`) | Immutable once SUBMITTED | It is the *compared* fact, not a reference |
| **PO Price** | `purchase_order_lines` (`0270`) | DRAFT-only edit; IS ISSUED-effective forever after; history append-only | Never a reference source |
| **Actual Cost** | `inventory_work_order_material_usages` (`0267`); `vendor_invoices` (`0261`+); `vendor_service_costs` (`0201`, informational) | Immutable / lifecycle-locked | Never a reference source |
| **Budget plan** | `operational_budgets(.categories)` (`0283`) | Period authority | No |
| **Commitment** | `operational_commitments(_entries)` (`0311`/`0312`) | Ledger append-only | No |

**Synchronization rule:** these classes never silently synchronize. Changing a
catalog price does not touch any quotation, PO, comparison run, usage cost,
invoice, budget, or commitment — and vice versa.

---

## 8. Scope / precedence (deterministic selection)

For a given comparison/lookup context — item, required UOM, currency, Client,
Building, optional Vendor, as-of timestamp `T` — an entry is **applicable**
iff:

```text
s.status = 'ACTIVE'
AND s.source_mode = 'MATERIAL' AND s.item_id = :item
AND s.currency   = :currency                     -- §9
AND s.uom_id     = :required_uom                 -- §10
AND (s.building_id IS NULL OR s.building_id = :building)
AND (s.vendor_id   IS NULL OR s.vendor_id   = :vendor)
AND s.effective_from <= T < COALESCE(s.effective_to, 'infinity')
```

**Precedence (most-specific first; fixed order, never arbitrary):**

1. `vendor_id NOT NULL AND building_id NOT NULL` — Vendor + Building
2. `vendor_id NOT NULL AND building_id IS NULL` — Vendor, Client-wide
3. `vendor_id IS NULL AND building_id NOT NULL` — general, Building-specific
4. `vendor_id IS NULL AND building_id IS NULL` — general, Client-wide

The exclusion constraint (§4.2) guarantees **at most one applicable row per
tier** for the identity key (+ UOM + currency), so the first non-empty tier
yields exactly one winner. There is therefore **no ID/date tie-break for
equally applicable records** — such pairs cannot exist; `effective_from DESC`
is never used to adjudicate equals (it is irrelevant once uniqueness per tier
is structural).

**Fail-closed outcomes** (resolver returns a typed result, never a guess):

| Outcome | Meaning |
|---|---|
| `MATCHED` | Exactly one winner; returns entry ID + full snapshot |
| `NO_REFERENCE_PRICE` | No tier holds an applicable ACTIVE row |
| `UOM_INCOMPATIBLE` | Entries exist for the item but none in the required UOM (no conversion attempted) |
| `CURRENCY_INCOMPATIBLE` | Entries exist but none in the requested currency (no FX attempted) |
| `AMBIGUOUS` | Defensive: more than one row remains after precedence (structurally impossible; if ever observed — e.g., constraint altered — resolution **fails closed**, emits an audit event, and the caller treats it as an error, not a null) |

---

## 9. Currency rules

1. Exact nine-code whitelist reused verbatim (`IDR`,`USD`,`SGD`,`MYR`,`AUD`,
   `EUR`,`GBP`,`JPY`,`CNY`) — same CHECK text as PO/quotation/budget/
   commitment authorities.
2. Every entry carries its own explicit `currency`; the comparison context
   (RFQ currency) is matched by equality only.
3. **No FX conversion, rate table, or inferred rate** — in this CR or by
   implication.
4. Mismatch is explicit and non-comparable (`CURRENCY_INCOMPATIBLE`,
   §8) — mirroring `OPERATIONAL_COMMITMENT_*_CURRENCY_MISMATCH` behavior in
   the commitment services (exact-match, event, no conversion).
5. Because `currency` is part of the exclusion key, multi-currency price
   maintenance for one item/UOM/period is legal and unambiguous: each
   currency is selected only by an explicit same-currency request.

## 10. UOM rules

1. `units_of_measure` (`0071`) is the only UOM authority; entries reference it
   by stable FK, Client-validated and ACTIVE-validated at write time
   (following the `inventory_items` service convention).
2. Comparison requires **exact UOM equality** between the entry and the RFQ
   line's required UOM snapshot (`rfq_lines.source_uom_id` /
   `vendor_quotation_lines.required_uom_id`).
3. No conversion: no ratio table exists (G-03); this CR does not create one
   and does not infer ratios from names/symbols/categories.
4. `UOM_INCOMPATIBLE` is a first-class, non-blocking comparison outcome — the
   UI/read model can show "reference unavailable (UOM)" without pretending a
   conversion happened.
5. A future UOM-conversion authority CR may add an *opt-in* conversion lane;
   until then any cross-UOM comparison is a governance violation.

---

## 11. Lifecycle / effective dating

| Rule | Decision | Precedent |
|---|---|---|
| History preservation | Entries are never updated in place once `ACTIVE`; change = **replace** (new entry + predecessor closed with actor/time + `replaced_by_entry_id`) | Quotation supersession (`0315`); PO-line history (`0270`) |
| DRAFT mutability | DRAFT rows are editable by `price_catalog.manage`; DRAFT has no effectiveness (never selected, never exclusion-constrained) | `rfqs` DRAFT state |
| Activation | Explicit command; sets `effective_from`/`effective_to` window; exclusion constraint enforces non-overlap within the tier at activation instant | Tariff activation (`0278`) |
| Future activation | Supported — `effective_from` in the future is a normal ACTIVE window; selection as-of `T` simply ignores it until `T` arrives. **No scheduler** flips status (§18) | Tariff future windows |
| Open-ended windows | `effective_to IS NULL` = infinite; closed by replacement/deactivation | `tstzrange '[)'` handles NULL as infinity |
| Mid-flight correction | An ACTIVE window already entered cannot be silently shortened into the past; retroactive correction requires `price_catalog.override` + mandatory reason (§13) and is recorded as an event | Budget-override governance (COMM-VAR-01) |
| Deactivation | Explicit terminal command (`INACTIVE`), actor/time recorded; historical snapshots referencing the entry remain valid (§14) | `vendors`/`inventory_items` INACTIVE preservation |
| Destructive overwrite | Prohibited: no UPDATE of price facts on ACTIVE/INACTIVE rows; no DELETE of non-DRAFT rows | Append-only ledger philosophy (`0312`) |
| Overlap | Rejected structurally (exclusion) and mapped to a 409-class domain error with reason | `0283` live-period exclusion error handling |

---

## 12. RFQ / quotation integration (PRO-02 as authority)

Reference price enters the procurement flow **only** as advisory comparison
evidence:

**Integration point — comparison run creation (`0316` service).** When PART 04
integrates, run creation additionally resolves the reference price per MATERIAL
RFQ line (as-of = run `snapshot_at`, context = RFQ Client/Building/currency,
line's required UOM, and — per comparison line *within each Vendor's evidence
row* — that Vendor's ID so the Vendor tier can apply) and **snapshots** the
result into new **additive nullable columns on `rfq_comparison_lines`**:

| Column (proposed) | Content |
|---|---|
| `reference_price_entry_id` UUID NULL FK | Exact price-authority row used (traceability) |
| `reference_unit_price` / `reference_currency` / `reference_uom_id` | Frozen price facts at comparison time |
| `reference_scope_vendor` / `reference_scope_building` BOOLEAN | Tier provenance of the selected entry |
| `reference_effective_from` TIMESTAMPTZ | Window provenance |
| `reference_resolution` CHECK (`'MATCHED','NO_REFERENCE_PRICE','UOM_INCOMPATIBLE','CURRENCY_INCOMPATIBLE','NOT_REQUESTED'`) | Explicit outcome incl. SERVICE (`NOT_REQUESTED`) and missing cases |
| `reference_total` NUMERIC(18,2) NULL | `reference_unit_price × required_quantity_snapshot` when MATCHED (SQL-derived or service-computed per PART 04 review, following the generated-column convention) |
| `unit_variance` / `total_variance` NUMERIC(18,2) NULL | Quotation minus reference (unit / extension), only when MATCHED |
| `variance_percent` NUMERIC NULL | `(unit_variance / reference_unit_price) × 100`; NULL when reference is 0 or not matched — no divide-by-zero fiction |
| `position_vs_reference` CHECK (`'ABOVE','BELOW','EQUAL'`) NULL | Coarse advisory indicator when MATCHED |

Nullable-only columns mean: existing runs stay byte-compatible historical
evidence; pre-PART-04 runs simply have NULL reference columns.

**Hard rules (governance of meaning):**

1. Reference price is **advisory**. A quotation above reference is *flagged*,
   never auto-rejected (PRO-02 already governs rejection reasons; none is
   "above reference price" and none may be added silently).
2. **No automatic winner selection** — comparison remains evidence;
   recommendation remains the human act (`0317`).
3. Missing reference (`NO_REFERENCE_PRICE`, UOM/currency-incompatible) is a
   recorded, displayable condition — never an error that invalidates a run.
4. The resolver never opens sessions or visibility to Vendors (§16); it runs
   inside the internal comparison service.
5. Metrics are derived at snapshot time and stored; re-derivation later is
   prohibited (§14).

---

## 13. PO / award interaction

**Preserved chain:** `Award → DRAFT PO → ISSUED PO Line → Commitment`
(`0318` → `0269`/`0270` → `0271` → `0311`/`0312`). The Price Catalog is not a
node in that chain:

1. **No commitment origin.** `operational_commitments.origin` remains
   `MANUAL|PO_HEADER|PO_LINE`; no `PRICE_CATALOG` origin may be added. The
   sole priced automatic commitment source stays the ISSUED PO line.
2. **PO conversion unchanged.** PART 06-of-PRO-02 provenance stays the only
   award→PO authority; conversion copies awarded quotation prices to PO lines
   exactly as today; currency-equality guards stay where they are.
3. **Advisory deviation visibility (PART 05):** an internal **read model**
   (computed, not persisted, or persisted only as nullable informational
   columns — decided at PART 05 design review) may show, for a DRAFT PO line,
   "unit price vs current applicable reference" with the same outcome
   vocabulary as §8. It warns; it does not stop issuance.
4. **No silent blocking of governed awards.** An award already passed PRO-02's
   approval chain (`0317` recommendation → approval binding → `rfq.award`).
   This CR establishes **no price-based issuance gate** in v1. If a later
   PART proposes a deviation threshold gate, it must first define the
   approving authority, the override reason vocabulary, and the exact
   fail-open/closed posture — and obtain separate governance review.

---

## 14. Override / governance permissions

### 14.1 New permission codes (PART 01 seed registration)

| Code | Purpose | Default assignment |
|---|---|---|
| `price_catalog.read` | Internal read of catalog entries, lookups, and reference columns on comparison read models | No broad automatic grant; assign to procurement/finance reader roles by Client policy |
| `price_catalog.manage` | Create DRAFT, edit DRAFT, activate, replace, deactivate entries within caller's scope | No broad automatic grant; assign to designated price administrators |
| `price_catalog.override` | Retroactive correction of an already-entered ACTIVE window; ambiguity/incident repairs; any future deviation-gate override | **Unassigned by default** — added to `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` beside `operational_budget.override` and `rfq.award`; explicit administrative assignment only; **PLATFORM_ADMIN does not receive it by default** (verified seed precedent) |

Rules:

- Only three codes — semantically necessary and each maps to a distinct risk
  class (visibility / stewardship / exceptional authority). No
  `price_catalog.approve` in v1: approval metadata (§4.2) is optional
  attribution until a PART demonstrates a two-person-rule need.
- Every `.override` use requires a **mandatory reason** (non-empty, length-
  checked) and emits `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED` (§17).
- `.manage` does not imply `.override`; `.read` does not imply either.
- Vendor actors: **none** of these codes is ever grantable to an RFQ Vendor
  session; the session model (`0314`) has no role/permission binding at all,
  so this is structurally excluded, and PART 04 tests must assert that
  reference columns are absent from any vendor-facing projection.

### 14.2 Who may do what (default posture)

| Act | Authority |
|---|---|
| See reference prices & deviations | Internal user + `price_catalog.read` + in-scope Building |
| Maintain prices | Internal user + `price_catalog.manage` + in-scope scope |
| Retroactive correction / exceptional repair | `.override` holder + reason + audit event |
| Award an RFQ | `rfq.award` (unchanged; no price gate) |
| Issue a PO | `purchase_order.manage` + existing readiness (unchanged) |
| Override budget overspend | `operational_budget.override` (unchanged; unrelated to price authority) |

---

## 15. Historical snapshot behavior

1. **Comparisons are immutable evidence** (`0316` design): PART 04 snapshots
   entry ID + price facts + tier + outcome per line at run creation. Editing,
   replacing, or deactivating catalog entries later **never** rewrites a
   historical run — there is no recompute path, and none may be added.
2. **Snapshot sufficiency rule:** even if the catalog row itself were later
   corrected under `.override`, the snapshot columns alone reproduce what the
   evaluator saw (price, currency, UOM, window, tier, entry ID).
3. **PO historical behavior:** PO lines remain the awarded quotation snapshot
   (`0318` provenance). Later catalog changes must never mutate PO line
   prices, commitment amounts (`0311`/`0312`), or actual costs (`0261`,
   `0267`). The Price Authority is **not** a retroactive financial rewrite
   mechanism.
4. **Award/evaluation history:** evaluations, recommendations, approvals, and
   awards keep their `0317` semantics; reference-price edits after an award
   have no effect on it (at most they appear in subsequent runs).

---

## 16. Concurrency governance

All mechanisms reuse patterns already proven in this repository:

| Hazard | Mechanism | Proven at |
|---|---|---|
| Concurrent duplicate creation | Client-unique `idempotency_key` + fingerprint; service recomputes fingerprint and replays the stored row on retry | `rfqs`, `vendor_quotations` (`0313`/`0315`) |
| Concurrent overlapping activation | `EXCLUDE … tstzrange` rejects the second commit; mapped to a 409-class structured error | `0278`, `0283` |
| Simultaneous replace/activate on one subject | Single transaction: lock the tier's ACTIVE rows (`SELECT … FOR UPDATE` on the keyed candidate set), close predecessor, insert successor under the exclusion constraint | PO issuance (`0271`), invoice payment (KI-001 PART 02) |
| Duplicate Vendor/item price | The exclusion key includes `vendor_id`/`item_id` per tier — duplicates with overlapping windows cannot commit at all | §4.2 |
| Concurrent override vs normal replacement | Both take the same tier lock; `.override`-corrected rows emit a distinct event; first committer wins; loser gets the constraint error | Row-lock-then-event pattern (KI-001 resolution) |
| Read-time races (resolver) | Selection is a pure `SELECT` against committed ACTIVE rows; ambiguity is defensive-fail-closed (§8) | `0283` reads under budget lock philosophy |

Serialization failure / constraint violation mapping follows existing error
modules (`*.errors.ts` with stable `ERROR_CODES`).

---

## 17. Audit

Reuse `recordOperationalEvent` + AUDIT-01 correlation (`0309`) — HTTP request
context wins automatically; the sensitive-key scrubber already blocks
credentials/tokens (`password`, `token`, `secret`, `apiKey`, …). No parallel
audit, no raw payload storage.

Proposed event vocabulary (final names fixed in PART reviews; `entity_type`
=`PRICE_CATALOG_ENTRY`, `entity_id` = entry ID; Client/Building from the
entry):

| Event | When | Metadata (non-sensitive) |
|---|---|---|
| `PRICE_CATALOG_ENTRY_CREATED` | DRAFT created | source_mode, item_id, tier flags, currency, uom_id, window, source_type, idempotency digest |
| `PRICE_CATALOG_ENTRY_ACTIVATED` | DRAFT → ACTIVE | window, tier, approved_by presence (boolean, not payload) |
| `PRICE_CATALOG_ENTRY_REPLACED` | Successor activated; predecessor closed | predecessor/successor IDs, closed window end |
| `PRICE_CATALOG_ENTRY_DEACTIVATED` | Terminal deactivation without successor | reason |
| `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED` | `.override` retroactive correction | reason summary, affected window, permission code used |
| `PRICE_CATALOG_AMBIGUITY_REJECTED` | §8 `AMBIGUOUS` defensive trip | candidate count, scope hash — signal to investigate constraints |
| `RFQ_COMPARISON_REFERENCE_RESOLVED`* | PART 04, per line | comparison run/line IDs, resolution outcome, entry ID or absence reason |

\* May be recorded as one summary event per run instead of per line if volume
warrants — PART 04 decision, documented in its review.

Never stored in events: file contents, session tokens, invitation payloads,
other Vendors' prices in any vendor-reachable projection (§19 isolation).

---

## 18. Scheduler decision

**No scheduler is added.** Rationale:

- Effective-date selection is evaluated **at read/command time** (resolver
  as-of `T`), so activation/deactivation needs no wall-clock worker.
- The only scheduler in the repository exists because reminders/escalations
  are inherently time-triggered side effects; price windows are pure data.
- Avoiding a scheduler avoids a second activation authority (skipped-tick
  drift, retry semantics) that would need its own governance.

PART reviews must reject any reintroduction of a "price activation job."

---

## 19. Historical adoption / backfill

1. **No silent backfill.** Nothing in this CR converts existing quotation,
   PO-line, usage-cost, invoice, or vendor-service-cost amounts into catalog
   prices.
2. `source_type` admits exactly `'MANUAL'` in v1; every v1 entry is an
   explicit human act with actor provenance.
3. If an organization later wants to seed reference prices from historical
   awards ("adopt last PO price as reference"), that is a **separate governed
   adoption process** (new `source_type` values such as `ADOPTED_PO_LINE`
   added by migration, copied-from lineage recorded, human confirmation),
   requiring explicit approval — and is **out of scope** for CR-BE-PRICE-01
   unless separately instructed.

---

## 20. API boundary (definition only — OpenAPI lands in PART 06)

Minimum internal surface (all versioned `/api/v1`, all under existing auth +
isolation middleware):

| Route (proposed) | Verb | Purpose | Permission |
|---|---|---|---|
| `/price-catalog/entries` | POST | Create DRAFT (idempotent) | `price_catalog.manage` |
| `/price-catalog/entries` | GET | List with filters (item, vendor, building in-scope, status, currency, window overlap) | `price_catalog.read` |
| `/price-catalog/entries/{id}` | GET | Read one entry | `price_catalog.read` |
| `/price-catalog/entries/{id}` | PATCH | Edit DRAFT fields only | `price_catalog.manage` |
| `/price-catalog/entries/{id}/activate` | POST | Activate with window | `price_catalog.manage` |
| `/price-catalog/entries/{id}/replace` | POST | Atomic successor + predecessor close | `price_catalog.manage` |
| `/price-catalog/entries/{id}/deactivate` | POST | Terminal close | `price_catalog.manage` |
| `/price-catalog/entries/{id}/correct` | POST | Retroactive correction, mandatory reason | `price_catalog.override` |
| `/price-catalog/lookup` | GET | Resolver probe (item, building, vendor?, currency, uom, asOf) → §8 outcome | `price_catalog.read` |
| `/rfqs/{id}/comparisons/...` (existing family) | GET | Read-model extended with §12 reference fields | `rfq.read` (+ reference fields visible under `price_catalog.read` — PART 04 decides the conjunctive rule; default: both required for reference fields) |
| `/purchase-orders/{id}/price-deviation` | GET | PART 05 advisory read model | `purchase_order.read` + `price_catalog.read` |

**Vendor sessions (`0314`) receive no route in this family** — no reference
prices, no tier visibility, no deviation data in any vendor-facing payload
(default: internal-only Price Authority).

---

## 21. Explicit non-goals

Kept out of CR-BE-PRICE-01 regardless of convenience (repository inspection
found no contradicting authority needing them):

- FX engine / exchange rates / cross-currency comparison
- Market-price scraping, supplier web pricing integration, price prediction/AI
- Accounting GL, AP/AR, tax engine, payment terms engine
- Inventory valuation (moving average/FIFO/LIFO), standard costing engine
- Discount engine, rebate/promotion modeling
- Contract management rebuild (Vendor contract price here is a *price tier*,
  not a contract document system)
- Full procurement rebuild; changes to PRO-02 workflows, award logic, or PO
  issuance semantics
- Automatic Vendor selection, scoring, weighted evaluation
- UOM conversion engine
- A second readiness/commitment/budget authority of any kind
- New schedulers; silent backfill/adoption of historical prices
- Any vendor-facing price endpoint or visibility
- KI-003 remediation (tracked separately)

---

## 22. Proposed PART breakdown (smallest safe sequence)

Sequencing follows repository evidence: material-only foundation first (G-02
defers SERVICE), integration after the authority is provably stable. Sequenced
PARTs after PART 01 unlock in order; each PART ships with focused tests and
its own review section appended to this document (PRO-02 convention).

### PART 01 — Price Authority Foundation

| Aspect | Content |
|---|---|
| Migration | `0319_*` — `price_catalog_entries` (MATERIAL-only CHECK), composite scope uniques on referenced masters (per `0313` precedent), exclusion constraint + indexes, state-check constraints |
| Runtime/module | `src/modules/price-catalog-entries/` (controller/service/repository/validation/errors/types/routes following module convention); create/edit-DRAFT/activate/replace/deactivate commands; list/read; idempotency; mounting in `src/routes/index.ts` |
| Seed | Register `price_catalog.read/.manage/.override`; add `.override` to `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`; `tests/seeds.test.ts` passes via length-relative assertions |
| Audit | CREATED/ACTIVATED/REPLACED/DEACTIVATED + correlation |
| Authorities reused | Clients/Buildings isolation (`ContextAccessService`), `inventory_items`, `units_of_measure`, `vendors`, currency whitelist, `recordOperationalEvent`, `requirePermission` |
| Tests | `tests/price-catalog-entries.test.ts` — schema shape, lifecycle transitions, overlap rejection (incl. concurrent activation), tier coexistence, idempotency replay, isolation denial, permission denials, event emission |
| Blockers | none |

### PART 02 — Material Price + UOM/Scope Selection

| Aspect | Content |
|---|---|
| Migrations | none expected (resolver is runtime over PART 01 schema) |
| Runtime | Deterministic resolver (§8) with typed outcomes; `/price-catalog/lookup`; future-window selection semantics; `UOM_INCOMPATIBLE`/`CURRENCY_INCOMPATIBLE` detection |
| Authorities reused | §5 item/UOM authorities; exact-match currency rule |
| Tests | `tests/price-catalog-selection.test.ts` — full precedence matrix (4 tiers × windows), as-of boundaries `[)`, NO_REFERENCE_PRICE, both incompatibility outcomes, AMBIGUOUS defensive path (constraint-simulated), item-UOM validation denial |
| Blockers | PART 01 |

### PART 03 — Vendor-Specific Price + Effective Precedence

| Aspect | Content |
|---|---|
| Migrations | none expected (vendor tier exists in PART 01 schema); a migration appears only if PART 01 review defers any vendor-tier constraint |
| Runtime | Hardened `VENDOR_CONTRACT` governance: creation validation (Vendor ACTIVE + same Client), cross-tier replacement rules (replacing a general price does not disturb vendor rows and vice versa), precedence proof under all tier mixes |
| Isolation tests | Vendor-specific terms never leak across Client/Building boundaries; never appear in vendor-session projections (asserted structurally) |
| Tests | `tests/price-catalog-vendor-tier.test.ts` |
| Blockers | PART 02 |

### PART 04 — RFQ Comparison Reference-Price Integration

| Aspect | Content |
|---|---|
| Migration | `0320_*` — additive **nullable** columns on `rfq_comparison_lines` (§12) with CHECKs and FK; no backfill (existing runs stay NULL) |
| Runtime | Run-creation integration (per-line resolution + snapshot), extended comparison read model, `RFQ_COMPARISON_REFERENCE_RESOLVED` event(s); SERVICE lines recorded `NOT_REQUESTED` |
| Hard rules asserted | Advisory-only; no auto-reject; no winner logic; missing reference never invalidates a run; run immutability re-verified with catalog edits after run creation |
| Authorities reused | `0313`–`0316` authorities unchanged |
| Tests | `tests/rfq-comparison-reference-price.test.ts` (+ vendor-projection absence assertions reusing `tests/vendor-quotations.test.ts` patterns) |
| Blockers | PART 01–03; PRO-02 (satisfied) |

### PART 05 — Deviation / Override Governance

| Aspect | Content |
|---|---|
| Migrations | none expected; PART 05 review decides computed-vs-persisted PO deviation indicator |
| Runtime | `/price-catalog/entries/{id}/correct` (`.override` + reason + event); PO advisory deviation read model (§13.3); documentation of non-gating posture |
| Tests | `tests/price-catalog-override.test.ts`, `tests/purchase-order-price-deviation.test.ts` — override authorization matrix, mandatory reason, event, award/issuance/commitment flows provably unchanged |
| Blockers | PART 04 |

### PART 06 — Read API + OpenAPI + Cross-Module Validation + Closure

| Aspect | Content |
|---|---|
| Runtime | API hardening pass on §20 surface; OpenAPI additions in `docs/api/openapi.yaml`; contract validation |
| Tests | `tests/price-catalog-openapi.test.ts` (mirroring `rfq-openapi.test.ts` convention); focused cross-module regression set (RFQ, PO, commitments, budgets, vendor quotation) — **not** broad regression (KI-003 posture respected) |
| Closure | FINAL REVIEW section appended here; readiness statements for a future Service Catalog CR (B-01) and a future governed adoption CR (§19) |
| Blockers | PART 01–05 |

---

## 23. Risk register

| # | Risk | Mitigation in this governance |
|---|---|---|
| R-01 | **Ambiguous effective price** / overlapping periods | Exclusion constraint per tier (`0278` pattern) + deterministic tier precedence + AMBIGUOUS defensive fail-close with audit (§8, §11, §16) |
| R-02 | Currency mismatch compared as if equal | Equality-only selection; `CURRENCY_INCOMPATIBLE` first-class outcome; no FX anywhere (§9) |
| R-03 | UOM mismatch compared as if equal | Exact UOM equality; `UOM_INCOMPATIBLE` outcome; no conversion authority permitted (§10) |
| R-04 | **Vendor commercial leakage** — one Vendor's tier price visible to another Vendor or to Vendor sessions | Internal-only authority; vendor sessions structurally lack permission bindings; PART 03/04 isolation + projection-absence tests (§14, §16, §20) |
| R-05 | Stale / mutated price snapshots in comparisons | Snapshot-on-run in PART 04; no recompute path; run immutability from `0316` (§15) |
| R-06 | Authority duplication with quotation/PO | Class taxonomy (§7); synchronization prohibited (§7); reference columns marked `reference_*` and nullable |
| R-07 | Retroactive commercial changes (catalog edit rewrites history / finances) | Replace-not-update lifecycle; PO/commitment/actual untouched by law (§13, §15); retroactive correction gated by unassigned-by-default `.override` + reason + event (§14) |
| R-08 | Concurrency: duplicate/overlap/racing override | Idempotency + tier locks + exclusion constraint + 409 mapping (§16) |
| R-09 | Override abuse | Sensitive code unassigned by default (verified seed precedent); mandatory reason; distinct audit event; PLATFORM_ADMIN exclusion (§14) |
| R-10 | Missing service master causing false service-price authority | SERVICE activation prohibited in v1 DB CHECK; gap recorded; B-01 tracked (§6) |
| R-11 | Historical adoption pressure ("just import PO prices") | `source_type='MANUAL'` only; adoption is a separate approved process (§19) |
| R-12 | Performance / index growth on exclusion + window queries | Keyed partial GiST index (`WHERE status='ACTIVE'`) as in `0278`; additional btree resolution index `(client_id, item_id, currency, uom_id, building_id, vendor_id, effective_from)`; PART 06 measures lookup on realistic volume |
| R-13 | Cross-tenant leakage | All reads/writes through BE-02G scope; Client-proof composite FKs (`0313` precedent); isolation tests per PART (§16, §20) |
| R-14 | CI / KI-003 strict-key assertion drift when read models gain fields | PART 04/06 extend rather than widen existing payload keys where possible; any drift is recorded as KI-003-class alignment debt, fixed additively, never by weakening assertions; no broad regression promised by this document |
| R-15 | Reference price mistaken for commitment/budget by consumers | §12/§13 semantics documented; column names carry `reference_` prefix; no new commitment origin; API descriptions in PART 06 state "advisory, non-financial" |
| R-16 | Zero reference price division in `variance_percent` | NULL when reference = 0 (§12); CHECK forbids negative |

### Blockers

- **B-01** — SERVICE price tiers require a governed **Service Catalog /
  Service Master** authority (new CR; closes G-02). Not started by
  CR-BE-PRICE-01.
- **B-02** — Any future PO **price-deviation issuance gate** requires a
  separately approved authority + override posture (§13.4). Not in v1.
- **B-03** — Governed **price adoption/backfill** tooling is a separate
  approved process (§19). Not in v1.
- **B-04** — UOM conversion (if ever wanted for materially equivalent
  quantities) is a separate UOM-authority CR (§10.5). Not in v1.

---

## 24. Implementation readiness

| Question | Answer |
|---|---|
| Is the baseline verified? | Yes — inspection at `ac36b5b` on `arena/01a0314b-asentra-backend`; all cited migrations/modules/tests read directly |
| Is the price-authority shape decided? | Yes — one flat, Client-scoped, effective-dated, overlap-excluded `price_catalog_entries` authority; header/detail and split-master models rejected with reasons (§4) |
| Is the material subject decided? | Yes — `inventory_items` + explicit UOM + per-UOM pricing + exact-match comparison (§5) |
| Is the service subject decided? | Yes — deferred with recorded gap B-01; fail-closed at DB CHECK (§6) |
| Are classifications frozen? | Yes — §7; synchronization prohibited |
| Are scope/precedence and lifecycle frozen? | Yes — §8 tier order; §11 replace-not-update; structural fail-closed |
| Are currency/UOM rules frozen? | Yes — §9/§10 equality only, explicit not-comparable outcomes |
| Is RFQ integration defined? | Yes — §12 additive snapshot columns on `rfq_comparison_lines`, advisory-only |
| Is PO/award interaction bounded? | Yes — §13 no gate, no new commitment origin, advisory deviation read model only in PART 05 |
| Are permissions decided? | Yes — §14 three codes; `.override` unassigned by default |
| Are audit/isolation/scheduler/backfill decided? | Yes — §17 reuse `recordOperationalEvent` + AUDIT-01; §20 internal-only API; §18 no scheduler; §19 no backfill |
| Are PARTs sequenced with tests and blockers? | Yes — §22 six PARTs, next migrations 0319/0320 |
| **PART 01 readiness** | **READY** — PART 01 (§22) may begin on this branch: migration `0319`, module `price-catalog-entries`, three seed codes, focused suite `tests/price-catalog-entries.test.ts` |
| Explicit exclusions from readiness | No SERVICE activation (B-01); no PO gating (B-02); no adoption tooling (B-03); no UOM conversion (B-04); no OpenAPI/CI/broad-regression changes before their PARTs |

---

## Validation record for this stage

Governance-only stage. Per instructions, this stage did **not**: create
migrations, implement runtime code, create routes, change OpenAPI, run broad
regression, run CI, or touch KI-003. Verification was repository inspection
only (git, grep, file reads); no database was migrated and no test suite was
executed. Files changed in this stage: **`docs/CR-BE-PRICE-01_START_GOVERNANCE.md`**
(this document) only.

STOP — START GOVERNANCE ends here. Implementation begins only at PART 01 under
this document's governance.

---

# PART 01 — Price Authority Foundation (implementation notes)

**Status:** complete
**Branch:** `arena/01a0314b-asentra-backend`
**Migration consumed:** `0319_create_price_catalog_entries` (next free: **0320**)

## P1.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0319_create_price_catalog_entries.ts` — `price_catalog_entries` table, composite scope uniques on `inventory_items` / `units_of_measure` (`vendors` already carried one from `0314`), `btree_gist` reuse, ACTIVE-window exclusion constraint, successor partial-unique index, lifecycle/state CHECKs, idempotency uniques, resolution/list indexes |
| Module | `src/modules/price-catalog-entries/` — types / errors / validation / repository / service / controller / routes / index, mounted in `src/routes/index.ts` immediately after the PRO-02 router family |
| Error codes | 18 `PRICE_CATALOG_*` codes appended to `src/shared/errors.ts` |
| Permissions | `price_catalog.read`, `price_catalog.manage`, `price_catalog.override` seeded; `.override` joined `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` (catalogue 289 → **292** codes); `tests/helpers/access.ts` mirrors the default grant (read/manage only) |
| Tests | `tests/price-catalog-entries.test.ts` — 16 focused tests in 5 suites, self-provisioning embedded PostgreSQL (`ASENTRA_USE_EMBEDDED_POSTGRES=true`, port 55494) with local-server fallback |
| Routes (internal only) | `POST/GET /price-catalog/entries`, `GET/PATCH /price-catalog/entries/{id}`, `POST .../{id}/activate`, `POST .../{id}/replace`, `POST .../{id}/deactivate` |

## P1.2 Model as implemented

- v1 fail-closed: `source_mode = 'MATERIAL'` DB CHECK (SERVICE widening is a
  future migration, governance §6). Guard-tested with a direct forbidden
  insert.
- Subject/tiers: `item_id` NOT NULL (+ composite `(item_id, client_id)` FK),
  `uom_id` NOT NULL (+ composite FK), nullable `vendor_id` (+ composite FK
  reusing the `0314` scope unique), nullable `building_id` (plain FK; the
  Building→Client rule is service-enforced via `properties` join because
  `buildings` carries no `client_id` column). `entry_kind` CHECK-consistent
  with `vendor_id` nullness.
- Money: `unit_price NUMERIC(18,2)` with `CHECK (unit_price > 0)`.
  **Refinement recorded:** the START GOVERNANCE sketch said `>= 0` following
  the PO convention; the PART 01 instruction freezes "positive". This is
  semantically stronger for a *reference* price (zero carries no information
  and would poison variance-% semantics in PART 04) and was adopted.
  Input validation additionally caps at the `NUMERIC(18,2)` range (< 1e16)
  and rejects > 2 decimal places instead of letting the DB silently round.
- Currency: nine-code whitelist CHECK, byte-identical to PO/quotation.
- Window: `effective_from` NOT NULL, `effective_to` NULL-open,
  `effective_to > effective_from` CHECK; half-open `[)` semantics enforced by
  the exclusion range and proven by the adjacency test.
- Provenance: `source_type = 'MANUAL'` only; `source_reference`,
  `notes`, optional `approved_by_user_id`/`approved_at` (both-set-or-both-null
  CHECK; approver must be an existing ACTIVE User).

## P1.3 Lifecycle as implemented

Exactly `DRAFT → ACTIVE → INACTIVE`, with state/actor correlation CHECK:

- `activate` — DRAFT only (`PRICE_CATALOG_NOT_DRAFT` otherwise); sets
  `activated_*`; the exclusion constraint overlaps-guards at this instant.
- `deactivate` — ACTIVE only (`PRICE_CATALOG_NOT_ACTIVE`); terminal.
  **Recorded decision:** a DRAFT-discard (`DRAFT → INACTIVE`) transition was
  deliberately not added: obsolete DRAFTs are inert (never selected, never
  exclusion-constrained), so no new transition is needed in v1.
- `update` (PATCH) — DRAFT-only full-field editing with reference
  revalidation; emits `PRICE_CATALOG_ENTRY_UPDATED`.
- `replace` — ACTIVE only; one transaction: lock predecessor → replay lookup →
  close predecessor (`INACTIVE` + `replaced_by_entry_id`) → insert already
  ACTIVE successor inheriting item/UOM/currency/tier keys (only price,
  window, provenance change). Successor window may not start before the
  predecessor window (retroactive correction is PART 05
  `price_catalog.override` territory). One successor per predecessor via
  partial-unique index. The self-FK is `DEFERRABLE INITIALLY DEFERRED` because
  close precedes insert inside the transaction.
- No DELETE exists anywhere; ACTIVE/INACTIVE rows are never updated in place.

## P1.4 Test-driven corrections (recorded)

1. **Sentinel keys in the exclusion constraint.** First implementation used
   plain nullable columns (`building_id WITH =`, `vendor_id WITH =`) following
   the tariff precedent — but the tariff scope key is NOT NULL. Under GiST
   equality, `NULL = NULL` is not true, so same-tier rows whose tier keys are
   NULL (Client-wide, Vendor) could overlap freely — i.e., the most common
   tier had **no** structural overlap prevention. Tests caught it. Fix:
   `COALESCE(building_id|vendor_id, '00000000-…'::uuid)` expression keys:
   NULL tiers collide with themselves (exactly the required semantics), and
   each populated tier remains a distinct key space. This is the correct
   generalization of the `0278` pattern to nullable tier keys and supersedes
   the naive sketch in §4.2.
2. **Replace idempotency replay ordering.** The first implementation checked
   `NOT_ACTIVE` before the replay lookup, so a network-retry of a successful
   replace got 409 instead of its own successor. Reordered to replay-first
   (load → replay match → then ACTIVE guard), matching the create-command
   semantics. Tests caught it.

Both corrections are inside PART 01 scope; no governance meaning changed.

## P1.5 Overlap / concurrency behavior as proven

- Same exact tier + overlapping window → 409 `PRICE_CATALOG_WINDOW_OVERLAP`
  (single and concurrent activation; concurrent pair settles as exactly
  one 200 + one 409).
- Adjacent `[from, to)` + `[to, ∞)` windows activate cleanly (half-open).
- Six distinct key spaces (4 tiers + foreign currency + foreign UOM) coexist
  over identical windows; overlap still binds per key space.
- Idempotent create/replace replay returns the original row; mismatched reuse
  of a key → 409 `PRICE_CATALOG_IDEMPOTENCY_CONFLICT`.
- HISTORY: predecessor keeps price/window forever; direct DB guards prove
  `unit_price > 0` and MATERIAL-only at the constraint level.

## P1.6 Isolation / RBAC as proven

- Writes and single reads: Building-scoped rows require
  `assertBuildingAccess`; Client-wide rows require `canAccessClient` (403
  `BUILDING_ACCESS_DENIED` otherwise). A caller can never mint or widen a
  scope they cannot reach (cross-Client Building → 403 without assignment,
  400 `PRICE_CATALOG_BUILDING_INVALID` with assignment).
- Lists are bound to the caller's accessible Client/Building sets; an
  out-of-reach `clientId` filter returns an empty page (no existence oracle).
- Permission matrix: plain session → 403 everywhere; `price_catalog.read`
  alone → cannot create/activate; unauthenticated → 401.
- Seed contract: the three codes exist; `price_catalog.override` is granted
  to **no** role by the seed (including PLATFORM_ADMIN); read/manage are on
  PLATFORM_ADMIN. `tests/seeds.test.ts` passes unchanged (dynamic length
  assertions).

## P1.7 Audit as implemented

Through `recordOperationalEvent` (AUDIT-01 HTTP correlation; sensitive-key
scrubber in place), in the same transaction as the mutation:
`PRICE_CATALOG_ENTRY_CREATED`, `PRICE_CATALOG_ENTRY_UPDATED` (DRAFT edits),
`PRICE_CATALOG_ENTRY_ACTIVATED`, `PRICE_CATALOG_ENTRY_DEACTIVATED`,
`PRICE_CATALOG_ENTRY_REPLACED` (predecessor, with `successorEntryId`), plus
CREATED+ACTIVATED for the successor (with `predecessorEntryId`). Metadata
carries price facts and tier identity needed for traceability, nothing more —
Vendor commercial sensitivity is bounded by the internal-only surface (PART 04
will assert absence from every vendor-facing projection).

## P1.8 Targeted validation evidence (PART 01 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/price-catalog-entries.test.ts` (16 tests / 5 suites) | 16/16 pass |
| `tests/seeds.test.ts` (permission contract) | 1/1 pass |
| `tests/rfq-openapi.test.ts` + `tests/openapi-contract.test.ts` + `tests/material-chain-openapi.test.ts` + `tests/audit-part05-openapi.test.ts` (prove OpenAPI untouched/by-design divergence absent) | 22/22 pass |
| `git diff --check` | clean |

No CI run; KI-003 untouched; no broad regression executed (per scope).

## P1.9 Files changed in PART 01

- `src/database/migrations/0319_create_price_catalog_entries.ts` (new)
- `src/database/migrations/index.ts` (register 0319)
- `src/modules/price-catalog-entries/` (new module, 8 files)
- `src/routes/index.ts` (mount)
- `src/shared/errors.ts` (18 codes)
- `src/database/seeds/foundation-access.seed.ts` (3 codes + unassigned set)
- `tests/helpers/access.ts` (default-grant mirror: read/manage only)
- `tests/price-catalog-entries.test.ts` (new)
- `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` (these notes)

## P1.10 PART 02 readiness

**READY.** PART 02 (Material price + UOM/scope selection) may build directly
on this foundation:

- Resolver candidates/tiers/windows/NULL semantics are already structural;
  PART 02 implements §8 selection (typed outcomes, fail-closed AMBIGUOUS
  defensive path) as runtime logic + the `/price-catalog/lookup` read.
- No migration is anticipated for PART 02 (documented decision there if one
  becomes necessary; next free number is **0320**).
- DoD additions expected: full precedence matrix, `[)` boundary selection,
  NO_REFERENCE_PRICE / UOM_INCOMPATIBLE / CURRENCY_INCOMPATIBLE outcomes,
  concurrency-at-read safety, and the no-extra-permission posture
  (`price_catalog.read` covers lookup).

---

# PART 02 — Material Price + UOM/Scope Selection (implementation notes)

**Status:** complete
**Branch:** `arena/01a0314b-asentra-backend`
**Migration consumed:** none (resolver is runtime over the PART 01 schema —
next free number remains **0320**)

## P2.1 What was built

| Surface | Artifact |
|---|---|
| Resolver | `src/modules/price-catalog-entries/price-catalog-lookup.service.ts` — deterministic §8 resolution with typed outcomes (`lookupPriceCatalogEntry(input, actorUserId)`) |
| Resolver types | `price-catalog-lookup.types.ts` — `PRICE_CATALOG_LOOKUP_RESOLUTIONS` (`MATCHED` / `NO_REFERENCE_PRICE` / `UOM_INCOMPATIBLE` / `CURRENCY_INCOMPATIBLE` / `AMBIGUOUS`) and `PRICE_CATALOG_SCOPE_TIERS` (`VENDOR_BUILDING` / `VENDOR` / `BUILDING` / `CLIENT_WIDE`) |
| Repository reads | `listResolutionCandidates` (full §8 applicability predicate), `listResolutionDiagnostics` (scope/window-identical, UOM/currency-agnostic diagnosis set), `loadBuildingById` (pool-based scope-anchor loader) added to the PART 01 repository |
| Read API | `GET /api/v1/price-catalog/lookup` (query: `itemId`, `uomId`, `currency`, `buildingId`, optional `vendorId`, `asOf`) under `price_catalog.read` — no additional permission introduced |
| Error code | one new code: `PRICE_CATALOG_LOOKUP_AMBIGUOUS` (409-class, defensive only) |
| Audit | `PRICE_CATALOG_AMBIGUITY_REJECTED` on the defensive trip only (§17 vocabulary), auto-committed on the shared pool so incident evidence survives a caller rollback |
| Tests | `tests/price-catalog-selection.test.ts` — 16 focused tests in 6 suites, self-provisioning embedded PostgreSQL (port 55496) with local-server fallback |
| Internal seam | `priceCatalogLookupService` exported from the module index for PART 04's comparison integration; it receives the typed `AMBIGUOUS` outcome and must treat it as an error (§8) |

## P2.2 Selection algorithm as implemented

1. **Context anchoring.** The probe's required `buildingId` is the scope
   anchor: the Building row derives the governed Client via the
   `buildings → properties` join (a Client is never taken from the caller),
   and `assertBuildingAccess(actor, buildingId)` is the isolation checkpoint.
   Unknown Building → 404 `PRICE_CATALOG_BUILDING_NOT_FOUND`.
2. **Candidate read (single SELECT, never locks).** Exactly the §8 predicate:
   `status='ACTIVE' AND source_mode='MATERIAL' AND item_id=:item AND
   currency=:currency AND uom_id=:uom AND (building_id IS NULL OR
   building_id=:building) AND (vendor_id IS NULL OR vendor_id=:vendor) AND
   effective_from <= T AND (effective_to IS NULL OR effective_to > T)`.
3. **Fixed precedence.** Candidates are grouped by tier rank (1 Vendor+Building,
   2 Vendor, 3 Building, 4 Client-wide). The first non-empty tier wins. There
   is **no** ID/date tie-break: inside the winning tier, exactly one row is
   expected *structurally* (PART 01 exclusion constraint with sentinel keys).
4. **Defensive trip.** A winning group of >1 rows is the §8 AMBIGUOUS case —
   resolution fails closed, `PRICE_CATALOG_AMBIGUITY_REJECTED` is recorded
   (entity `PRICE_CATALOG_LOOKUP` / `itemId`, metadata: candidate count,
   candidate entry IDs, scope tier, full context), and the typed `AMBIGUOUS`
   outcome is returned to the caller. The HTTP probe maps it to 409
   `PRICE_CATALOG_LOOKUP_AMBIGUOUS`; no price is ever picked.
5. **Fail-closed classification (no winner).** A scope- and window-identical
   diagnosis set (UOM/currency-agnostic) is read; if empty →
   `NO_REFERENCE_PRICE`; else if no row carries the required UOM →
   `UOM_INCOMPATIBLE`; else → `CURRENCY_INCOMPATIBLE`. Because the diagnosis
   set obeys the same scope/window filters, an out-of-scope or not-yet-
   effective price is never revealed by producing a different outcome.

## P2.3 Overlap / effective-date behavior as proven

- Full precedence matrix passes: each of the four tiers wins exactly when
  every higher tier is absent or inapplicable; vendor tiers are excluded
  entirely without a vendor context and when the context vendor differs;
  per-tier future windows stay invisible until T arrives and then win.
- `[)` half-open boundaries: `T = effective_from` matches, `T = effective_to`
  does not; adjacent windows hand T over at the boundary instant; open-ended
  successors select from their start.
- DRAFT and terminally-deactivated rows are never applicable — even as-of a
  timestamp inside their former window (the §8 predicate requires ACTIVE;
  historical evidence fidelity lives in PART 04 snapshots, §15, not here).

## P2.4 Scope / isolation as proven

- The Client is always derived from the Building context; a lookup can
  address no second Client by construction.
- Scope-filtered diagnostics: a price scoped only to another Building or to
  a non-context Vendor yields `NO_REFERENCE_PRICE` — the probe does not leak
  even the *existence* of out-of-scope prices through its outcome type.
- Unknown Building → 404; unauthenticated → 401; no permission → 403
  `PERMISSION_DENIED`; `price_catalog.read` alone passes the permission gate
  and a reader without a Building assignment is denied 403
  `BUILDING_ACCESS_DENIED` (read covers lookup; scope still governs).

## P2.5 UOM / currency rules as implemented

- Exact UOM equality only; no conversion factor is consulted or inferred
  (§10). `UOM_INCOMPATIBLE` when in-scope in-window ACTIVE prices exist for
  the item but none in the required UOM.
- Exact currency equality only against the nine-code whitelist; no FX (§9).
  `CURRENCY_INCOMPATIBLE` when UOM-matching prices exist but none in the
  requested currency.
- Diagnosis order locked by test: UOM is checked before currency, so a mixed
  gap (right-UOM/wrong-currency plus wrong-UOM/right-currency rows) is
  deterministically `CURRENCY_INCOMPATIBLE` — quantity semantics dominate.

## P2.6 Ambiguity / fail-closed behavior as proven (constraint-simulated)

- With the exclusion constraint dropped and two overlapping same-tier ACTIVE
  rows staged directly, the internal seam returns typed `AMBIGUOUS` and the
  HTTP probe returns 409 `PRICE_CATALOG_LOOKUP_AMBIGUOUS`; each trip records
  `PRICE_CATALOG_AMBIGUITY_REJECTED` with candidate count/IDs and context.
  The test restores the staged rows and the constraint (verified identical
  presence afterwards), and a final probe confirms a clean catalog.
- Read determinism under races: two concurrent activations of overlapping
  same-tier DRAFTs settle 1×200 + 1×409 (PART 01 exclusion), and every
  subsequent lookup resolves exactly the surviving winner — concurrency at
  read can never fabricate a second applicable row.

## P2.7 Read/API seam notes for PART 04

- The resolver result is the snapshot source PART 04 will freeze onto
  `rfq_comparison_lines`: `entry` carries entry ID, unit price, currency,
  UOM, item, tier keys, and window; `scopeTier` carries tier provenance;
  `resolution` maps onto the §12 `reference_resolution` vocabulary (PART 04
  adds `NOT_REQUESTED` for SERVICE lines — the v1 catalog stays MATERIAL-only
  so this resolver never emits it).
- Internal callers receive the typed `AMBIGUOUS` outcome and **must** treat
  it as an error (§8); the module index exports the service for exactly one
  future consumer (comparison-run creation). The resolver opens nothing to
  Vendor sessions and records no per-lookup audit on ordinary outcomes —
  §17 audits the defensive trip only; PART 04 owns run-level events.

## P2.8 Targeted validation evidence (PART 02 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/price-catalog-selection.test.ts` (16 tests / 6 suites, port 55496) | 16/16 pass |
| `tests/price-catalog-entries.test.ts` (directly affected PART 01 suite) | 16/16 pass |
| `tests/openapi-contract.test.ts` + `tests/rfq-openapi.test.ts` + `tests/material-chain-openapi.test.ts` + `tests/audit-part05-openapi.test.ts` (OpenAPI untouched per PART 06 boundary) | 22/22 pass |
| `git diff --check` | clean |

No CI run; KI-003 untouched; no broad regression executed (per scope). Seeds
unchanged in PART 02 (no new permission), so `tests/seeds.test.ts` is
unaffected (last green at PART 01).

## P2.9 Files changed in PART 02

- `src/modules/price-catalog-entries/price-catalog-lookup.types.ts` (new)
- `src/modules/price-catalog-entries/price-catalog-lookup.service.ts` (new)
- `src/modules/price-catalog-entries/price-catalog-entry.repository.ts`
  (resolver reads + pool-based building loader)
- `src/modules/price-catalog-entries/price-catalog-entry.service.ts`
  (`toPublic` exported as `toPublicPriceCatalogEntry` — snapshot reuse only)
- `src/modules/price-catalog-entries/price-catalog-entry.validation.ts`
  (lookup query parse)
- `src/modules/price-catalog-entries/price-catalog-entry.controller.ts`
  (lookup handler incl. AMBIGUOUS → 409 mapping)
- `src/modules/price-catalog-entries/price-catalog-entry.routes.ts` (mount)
- `src/modules/price-catalog-entries/price-catalog-entry.errors.ts`
  (lookup-ambiguous error)
- `src/modules/price-catalog-entries/index.ts` (seam exports)
- `src/shared/errors.ts` (one code)
- `tests/price-catalog-selection.test.ts` (new)
- `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` (these notes)

## P2.10 PART 03 readiness

**READY.** PART 03 (Vendor-specific price + effective precedence hardening)
may build directly on this resolver:

- All four tiers already resolve through one governed path; PART 03 adds
  `VENDOR_CONTRACT` creation governance and cross-tier replacement rules on
  top of the proven precedence, without touching the selection contract.
- The vendor-tier invisibility posture (no leak through outcome types) is
  already test-locked and may be extended by PART 03's vendor-session
  projection assertions.
- Reminder: no migration is expected for PART 03 either; the next free
  number stays **0320** and is reserved for PART 04's nullable
  `reference_*` columns on `rfq_comparison_lines` (§12).

---

# PART 03 — Vendor-Specific Price Governance Hardening (implementation notes)

**Status:** complete
**Branch:** `arena/01a0314b-asentra-backend`
**Migration consumed:** none (next free number remains **0320**, reserved for
PART 04 per §22)

## P3.1 Runtime delta (recorded)

**One small delta, no more.** Inspection confirmed PART 01–02 already satisfy
the governed Vendor tier (eligibility checks in `validateReferences`, tier
structure and exclusion in `0319`, precedence + typed outcomes in the PART 02
resolver, tier-key inheritance in replacement). Exactly one hardening gap was
found and fixed:

- **`entry_kind` re-derivation on DRAFT tier edits.** PART 01's PATCH path
  allows editing `vendorId` on a DRAFT but never re-derived `entry_kind`, so
  re-scoping a DRAFT into/out of the Vendor tier crashed on the
  `price_catalog_entries_kind_vendor_check` constraint (raw 500) instead of
  producing a governed row. Fix: `updateDraft` now always sets the kind
  derived from the final merged Vendor key (`REFERENCE` ⇔ `VENDOR_CONTRACT`);
  the kind stays derived state, never caller-editable. Locked by test; no
  schema, route, permission, or resolver change.

## P3.2 Vendor/Building eligibility behavior (as proven)

- Write-time gates (unchanged PART 01 logic, now locked vendor-side):
  unknown Vendor → 404 `PRICE_CATALOG_VENDOR_NOT_FOUND`; cross-Client or
  INACTIVE Vendor → 400 `PRICE_CATALOG_VENDOR_INVALID`; cross-Client Building
  (with assignment) → 400 `PRICE_CATALOG_BUILDING_INVALID`. Revalidation runs
  on every DRAFT edit touching merged references.
- **`vendor_building_relationships` is not required** for the Vendor+Building
  tier — governance §2.1 freezes that table as "optional validation signal
  only"; the test creates, activates, and resolves a V+B price with no
  relationship row present.
- **Recorded selection posture:** Vendor master status is a *write-time*
  gate only. The §8 applicability predicate contains no vendor-status clause,
  so an already-governed ACTIVE contract price keeps resolving after the
  Vendor master is deactivated (history-derived contexts must not silently
  re-price). Changing that is a separate governance decision; the posture is
  now test-locked and documented here.
- Kind discipline is structural: direct INSERT with `vendor_id` +
  `entry_kind='REFERENCE'` is rejected by the CHECK (guard-tested).

## P3.3 Precedence preservation (as proven)

- All **15 non-empty tier mixes** resolve the highest present tier
  (V+B → V → B → CW) with the exact entry expected — the full matrix, not a
  ladder sample.
- Cross-tier replacement rules: replacing a Vendor-tier entry closes only
  that row; Building/Client-wide siblings stay ACTIVE and keep winning their
  contexts (and vice versa — general replacement never disturbs Vendor rows).
  Successor always inherits tier keys + `VENDOR_CONTRACT` kind; a
  Client-wide successor stays `REFERENCE` with `vendor_id` NULL.
- Exact UOM/currency/`[)` window behavior is the PART 02 path, untouched;
  vendor contexts exercise it through the same resolver.

## P3.4 Commercial isolation (as proven)

- Each Vendor context resolves **its own** contract price (A gets A's V+B
  price, B gets B's V price, no-vendor gets Client-wide) — never another
  Vendor's row.
- An exclusive Vendor tier is invisible to other Vendor contexts **even as an
  outcome type**: the diagnosis set is scope-filtered, so the probe returns
  `NO_REFERENCE_PRICE`, never an incompatibility that would reveal the
  contract's existence.
- Cross-Client/listing scope: an out-of-scope reader (permissions, no
  assignment) sees an empty list and 403 on single reads of contract prices.
- **RFQ Vendor access sessions are structurally excluded**: a real PRO-02
  invitation→exchange session token receives 401 from lookup, list, single
  read, and create — rejection happens in authentication (no role/permission
  binding exists for vendor sessions, §14), before any price logic.

## P3.5 History + audit (as proven)

- Vendor price versions are preserved and enumerable: predecessor INACTIVE
  with original price/window + `replaced_by_entry_id`, successor ACTIVE;
  `?vendorId=` list shows both versions with distinct prices.
- Lifecycle events carry tier identity: `PRICE_CATALOG_ENTRY_UPDATED`
  metadata includes the derived `entryKind`/`vendorId`; `REPLACED` (with
  `successorEntryId`) and successor `CREATED` (with `predecessorEntryId`)
  events carry `vendorId`. The PART 02 `PRICE_CATALOG_AMBIGUITY_REJECTED`
  defensive event applies unchanged to vendor tiers (same resolver path).

## P3.6 Targeted validation evidence (PART 03 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/price-catalog-vendor-tier.test.ts` (11 tests / 4 suites, port 55497) | 11/11 pass |
| `tests/price-catalog-entries.test.ts` (PART 01, directly affected by the edit-path delta) | 16/16 pass |
| `tests/price-catalog-selection.test.ts` (PART 02, resolver untouched but re-verified) | 16/16 pass |
| `git diff --check` | clean |

No CI run; KI-003 untouched; no broad regression executed (per scope).

## P3.7 Files changed in PART 03

- `src/modules/price-catalog-entries/price-catalog-entry.repository.ts`
  (`entry_kind` re-derivation parameter on `updateDraft`)
- `src/modules/price-catalog-entries/price-catalog-entry.service.ts`
  (derived kind passed for every DRAFT update)
- `tests/price-catalog-vendor-tier.test.ts` (new)
- `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` (these notes)

## P3.8 PART 04 readiness

**READY.** PART 04 (RFQ Comparison Reference-Price Integration) may proceed:

- The Vendor-tier contract surface is fully hardened and test-locked:
  precedence matrix, per-Vendor contexts, replacement history, and the
  vendor-session exclusion the comparison read model must preserve.
- The resolver seam (`priceCatalogLookupService.lookupPriceCatalogEntry`)
  and its outcome vocabulary are stable; PART 04 adds the `NOT_REQUESTED`
  SERVICE outcome at the comparison layer (never here), consumes the typed
  `AMBIGUOUS` as an error, and freezes snapshots at run creation.
- Migration `0320` is reserved for the additive **nullable** `reference_*`
  columns on `rfq_comparison_lines` (§12); per-line resolution uses
  as-of = run `snapshot_at`, context = RFQ Client/Building/currency, line
  required UOM, and the Vendor of each comparison line's evidence row.

---

# PART 04 — RFQ Comparison Reference-Price Integration (implementation notes)

**Status:** complete
**Branch:** `arena/01a0314b-asentra-backend`
**Migration consumed:** `0320_add_rfq_comparison_reference_price` (next free:
**0321**)

## P4.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0320_add_rfq_comparison_reference_price.ts` — 13 additive **nullable** columns on `rfq_comparison_lines` + resolution/position/currency CHECKs + one shape-correlation CHECK |
| Runtime | Run-creation integration inside `createSnapshotEvidence`: per MATERIAL comparison line the PART 02 resolver runs with exact context and its outcome is **frozen** with the line; SERVICE lines record `NOT_REQUESTED` without touching the resolver |
| Read model | Comparison line offers carry an optional `reference` object, present only when the caller holds both `rfq.read` and `price_catalog.read` (conjunctive default, §20) |
| Audit | One `RFQ_COMPARISON_REFERENCE_RESOLVED` summary event per run (§17 decision recorded below) + the resolver's auto-committed `PRICE_CATALOG_AMBIGUITY_REJECTED` on the defensive path |
| Error code | one new code: `RFQ_COMPARISON_REFERENCE_AMBIGUOUS` (409, fail-closed) |
| Tests | `tests/rfq-comparison-reference-price.test.ts` — 10 tests / 4 suites, embedded PostgreSQL (port 55498) |

## P4.2 Snapshot fields as implemented (§12 realized)

`reference_price_entry_id` (FK), `reference_unit_price` / `reference_currency`
/ `reference_uom_id` (frozen facts), `reference_scope_vendor` /
`reference_scope_building` (tier provenance booleans), `reference_effective_from`
(window provenance), `reference_resolution` (five-outcome vocabulary incl.
`NOT_REQUESTED`), `reference_total` (= reference unit price ×
`required_quantity_snapshot`), `unit_variance` / `total_variance` (quotation
minus reference), `variance_percent` ((unit variance / reference price) × 100),
`position_vs_reference` (`ABOVE` / `BELOW` / `EQUAL`).

**Variance derivation (§12 review decision):** service-computed at 2dp via
the module's existing `roundMoney` convention — not SQL-generated — so the
stored numbers are exactly what the domain rules state, with no silent
numeric widening. `variance_percent` is required non-NULL under MATCHED:
catalog prices are `> 0` by CHECK, so the division is structurally safe
(R-16) and a NULL base can never hide. The shape CHECK enforces: MATCHED ⇔
complete snapshot; every other outcome — and legacy pre-PART-04 rows
(`reference_resolution IS NULL`) — ⇔ all fact columns NULL. Guard-tested in
both directions by direct SQL.

## P4.3 Lookup integration as implemented

- Context is exact: `loadCanonicalLines` now also projects the RFQ line's
  immutable `source_item_id`; resolution input = run's Building (→ Client),
  run currency, the line's required-UOM snapshot, the **evidence row's
  Vendor**, and as-of = run `snapshot_at` (governance §12 verbatim).
- Per-Vendor tiering works inside a single run: Vendor A's offer froze its
  contract price (scope flags `(true,false)`) while Vendor B's froze the
  general price for the identical line.
- Recorded defensive edge: a MATERIAL line can structurally lack a required
  UOM (`rfq_lines` shape CHECK admits it). Such a line can never satisfy §10
  exact equality, so it records `UOM_INCOMPATIBLE` without calling the
  resolver — fail closed, never fabricated.

## P4.4 Fail-closed / no-reference behavior (§12.3 honored)

- `NO_REFERENCE_PRICE`, `UOM_INCOMPATIBLE`, `CURRENCY_INCOMPATIBLE`,
  `NOT_REQUESTED` are **recorded outcomes, never run errors** — runs
  complete with NULL fact columns and enumerable `unmatchedLines` in the
  summary event.
- `AMBIGUOUS` fails the whole run creation (typed outcome → 409
  `RFQ_COMPARISON_REFERENCE_AMBIGUOUS`): constraint-simulated duplicates
  prove **zero** run/evidence/line rows persist, no CREATED/RESOLVED events
  fire, the incident itself is durably audited (the resolver auto-commits it
  by design so it survives this rollback), and after cleanup the same RFQ
  compares normally.

## P4.5 Historical immutability (§15) as proven

- Replacing the catalog entry after a run leaves the frozen snapshot
  byte-stable through the read model **and** at storage level (original
  entry id + price 100 retained); a new run then freezes the successor
  authority (200). No recompute path exists anywhere in the module.

## P4.6 Vendor visibility boundary (§14/§20) as proven

- RFQ Vendor access session tokens receive 401 from comparison list/single
  reads (authentication layer, before any logic).
- The vendor-facing quotation projection contains no reference artifacts
  (`reference_`, `priceEntryId`, variance/position keys asserted absent).
- Conjunctive read: an internal reader with `rfq.read` but without
  `price_catalog.read` receives the identical comparison with the
  `reference` key **omitted** from every offer — masking is additive and
  never widens pre-existing fields (R-14 posture; no KI-003-class drift —
  the existing comparison suite passes unmodified).

## P4.7 Targeted validation evidence (PART 04 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/rfq-comparison-reference-price.test.ts` (10 / 4 suites, port 55498) | 10/10 pass |
| `tests/rfq-comparisons.test.ts` (directly affected PRO-02 suite) | 5/5 pass |
| `tests/price-catalog-selection.test.ts` (PART 02 seam consumers) | 16/16 pass |
| `tests/price-catalog-entries.test.ts` / `tests/price-catalog-vendor-tier.test.ts` (PART 01/03 shared module) | 16/16, 11/11 pass |
| `tests/rfq-openapi.test.ts` (comparison route documentation, spec untouched) | 2/2 pass |
| `git diff --check` | clean |

Test-driven corrections recorded: `ALTER TABLE` table-constraints require
`ADD CONSTRAINT` (migration syntax), and SERVICE quotations require
`serviceTerms` (fixture correctness) — both caught by the suite, neither
changes governed meaning. No CI run; KI-003 untouched; no broad regression.

## P4.8 Files changed in PART 04

- `src/database/migrations/0320_add_rfq_comparison_reference_price.ts` (new)
- `src/database/migrations/index.ts` (register 0320)
- `src/modules/rfq-comparisons/rfq-comparison.types.ts` (reference
  resolutions/positions, line record + public offer extension, empty snapshot)
- `src/modules/rfq-comparisons/rfq-comparison.repository.ts` (extended line
  select/insert/mapping; money converted at the boundary as before)
- `src/modules/rfq-comparisons/rfq-comparison.service.ts` (resolution at run
  creation, per-run summary event, conjunctive read masking)
- `src/modules/rfq-comparisons/rfq-comparison.errors.ts` + `src/shared/errors.ts`
  (one code)
- `src/modules/price-catalog-entries/index.ts` (export `PriceCatalogCurrency`
  type — additive surface only)
- `tests/rfq-comparison-reference-price.test.ts` (new)
- `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` (these notes)

## P4.9 PART 05 readiness

**READY.** PART 05 (Deviation / Override Governance) may proceed:

- The advisory reference snapshot is frozen and read-model-visible under the
  conjunctive rule; PART 05's PO deviation read model can mirror the same
  resolver seam (as-of = then-current `NOW()` decision at its own design
  review) without touching comparison history.
- `/price-catalog/entries/{id}/correct` builds on the PART 01 lifecycle +
  the unassigned-by-default `price_catalog.override` seed; mandatory-reason
  + `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED` event vocabulary is frozen in
  §17 and unimplemented so far.
- No migration is expected for PART 05 (per §22; any computed-vs-persisted
  PO deviation indicator is its own design-review decision). Next free
  migration number: **0321**.

---

# PART 05 — Override / Corrective Command (implementation notes)

Status: **IMPLEMENTED on `arena/01a0314b-asentra-backend`** under the PART 05
instruction "Reference Price Override & Corrective Command". The instruction
scoped this PART to the governed override/corrective command; see P5.7 for
the recorded design-review deferred items.

## P5.1 What was built

`POST /api/v1/price-catalog/entries/{id}/correct` — the governed retroactive
correction lane from §11 (mid-flight correction), §14 (override authority),
§17 (`PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED`) and §20 (API boundary):

| Aspect | Content |
|---|---|
| Route | `POST /price-catalog/entries/:id/correct`, fenced by `requirePermission('price_catalog.override')` — the **only** route in the surface using that code; `.manage` and `.read` never imply it |
| Parser | `parseCorrectPriceCatalogEntryBody` — same facts as a replacement (`unitPrice`, `effectiveFrom`, `effectiveTo?`, `sourceReference?`, `notes?`, `approvedByUserId?`) plus the **mandatory `reason`**: required, trimmed non-blank, length-checked (≤ 1000 chars); `Idempotency-Key` header required as for all commands |
| Service | `priceCatalogEntryService.correctPriceCatalogEntry` in `price-catalog-entry.service.ts`, one transaction |
| Types | `CorrectPriceCatalogEntryInput = ReplacePriceCatalogEntryInput & { reason: string }` |
| Migration | **None.** §22's "none expected" confirmed at design review: the reason is governance evidence and lives in the audit event metadata (§17), the command reuses PART 01 replace-not-update mechanics and constraints, and no persisted override columns are required. Next free migration number remains **0321** |
| Tests | `tests/price-catalog-override.test.ts` (9 tests / 6 suites, embedded PG port 55499) |

## P5.2 Correction semantics as implemented (§11 realized)

1. **Target must be ACTIVE.** DRAFT is freely editable under `.manage`;
   INACTIVE is terminal history. Any other state → `409
   PRICE_CATALOG_NOT_ACTIVE` (invalid lifecycle transition rejected).
2. **No silent overwrite / no destructive history rewrite.** The predecessor
   is closed exactly like a replacement (`status → INACTIVE`, actor/time +
   `replaced_by_entry_id` linkage). Its price facts, window, scope, UOM and
   currency are never updated in place and the row stays queryable via the
   ordinary read endpoints. This is the same mutation envelope §11 already
   sanctions for `replace` — lifecycle linkage only, never fact rewrite.
3. **The correction is a NEW governed authority state.** The successor is
   inserted ACTIVE, inheriting client/building/vendor/item/UOM/currency/
   entry-kind/source-mode from the predecessor — a correction can never
   silently re-scope, re-denominate or re-subject an authority. Only price
   facts, window, optional provenance fields and attribution change.
4. **Retroactive window capability is the override lane's defining power.**
   The `effectiveFrom >= predecessor.effectiveFrom` guard remains on
   `replace` (PART 01 semantics unchanged, re-asserted in the PART 05
   suite); `correct` deliberately omits it, so — under reason + audit — a
   successor window may open **before** the predecessor's window start
   (§11: repairing an already-entered window is exactly the exceptional
   authority `.override` exists for).
5. **Effective-date semantics preserved.** The corrected authority resolves
   only under its own new window (`[`)` as-of rules, `status='ACTIVE'` only).
   Between the predecessor close and a future-dated successor window there
   is simply no tier authority (`NO_REFERENCE_PRICE`) — identical close
   semantics to PART 01 replacement; nothing is "pre-applied".
6. **Currency/UOM controls inherited.** The successor cannot change currency
   or UOM (they are inherited); validation keeps `unitPrice > 0` at ≤2dp and
   `effectiveTo > effectiveFrom`; exact-match selection rules are untouched.
7. **Fail-closed overlap protection preserved.** The successor INSERT passes
   through the same partial exclusion constraint; a corrective window
   overlapping another ACTIVE same-tier window → `23P01` → mapped `409
   PRICE_CATALOG_WINDOW_OVERLAP` with full rollback (proven: no close, no
   successor, no event).
8. **Idempotency.** Key required; fingerprint covers the predecessor, all
   corrected facts **and the reason** — a replayed key with a different
   reason is evidence tampering and conflicts (`409
   PRICE_CATALOG_IDEMPOTENCY_CONFLICT`); an exact replay returns the same
   successor (201).

## P5.3 Authorization boundary as proven (§14)

- Plain user → 403 `PERMISSION_DENIED`.
- Broad test administrator (holds `price_catalog.read` + `.manage` but
  `.override` is unassigned-by-default even for the platform admin role) →
  403 `PERMISSION_DENIED`.
- Price steward (`.read`+`.manage`, in scope) → 403 on `/correct`, while the
  same steward's `/replace` succeeds — `.manage` does not imply `.override`.
- `.override` holder outside the entry's Building scope → 403
  `BUILDING_ACCESS_DENIED` (scope gate, not permission).
- `.override` alone (no read/manage) in scope → 201 — the single code
  authorizes the command; and it grants **no** steward powers (`create` and
  `replace` by the same user → 403), keeping the three code classes distinct.
- Vendor sessions: structurally no role/permission binding, so the route
  fence can never pass for them (PART 03/04 structural posture unchanged).

## P5.4 Evidence as implemented (§17)

- `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED` emitted exactly once per accepted
  correction, on the **predecessor** entity (the corrected authority of
  record), inside the same transaction as the close+insert. Metadata:
  `reason` (the mandatory evidence, already length-checked), `permissionCode:
  'price_catalog.override'`, `successorEntryId`, `correctedUnitPrice`,
  `correctedEffectiveFrom/To`, plus the predecessor's own facts (window,
  price, tier keys) via the shared `entryMetadata` helper — "reason summary,
  affected window, permission code used" per §17.
- The successor receives the ordinary `PRICE_CATALOG_ENTRY_CREATED` +
  `PRICE_CATALOG_ENTRY_ACTIVATED` trail (with `predecessorEntryId`), so each
  entity's event log reads as a complete governed history.
- No `PRICE_CATALOG_ENTRY_REPLACED` fires: the correction vocabulary is
  distinct on purpose (§17), so audit consumers can distinguish an
  exceptional-authority act from ordinary stewardship.

## P5.5 History, snapshots, and non-interference as proven

- Historical authority remains queryable: predecessor GET returns the
  original price facts/window byte-intact with lifecycle closure fields.
- **RFQ comparison snapshots are byte-stable**: a frozen run captured before
  a retroactive correction (100→95) is identical after it — full read-model
  deep-equal plus storage-level check (`reference_price_entry_id` still cites
  the now-INACTIVE predecessor, `reference_unit_price` = 100,
  `reference_resolution` = MATCHED, `position_vs_reference` = ABOVE). A **new**
  run independently resolves the corrected authority (95, successor ID) —
  history and currency of truth coexist without rewriting each other (§15).
- No procurement award/winner logic was touched: PART 05 changes are confined
  to the price-catalog module (one route, one parser, one service command,
  one type); zero edits under `rfqs`, `vendor-quotations`, `rfq-awards`,
  `purchase-orders`, `operational-commitments` or any actual-cost surface.

## P5.6 Precedence preservation as proven (§8/§10)

- Retroactively correcting the Client-wide tier does not disturb an ACTIVE
  Vendor-tier row for the same subject: vendor lookups keep resolving the
  vendor tier; non-vendor lookups resolve the corrected general authority.
- Correcting the Vendor tier leaves the corrected general row intact.
- Tier precedence (`VENDOR+BUILDING > VENDOR > BUILDING > CLIENT_WIDE`),
  exact-match UOM/currency selection, and the AMBIGUOUS defensive trip are
  untouched — the correction lane shares the PART 01 mechanics the PART 02
  resolver reads.

## P5.7 Design-review decisions recorded (PART 05 review)

1. **§13.3 PO advisory deviation read model — deferred.** The PART 05
   instruction ("Reference Price Override & Corrective Command") scoped this
   PART to the corrective command; its validation plan contains no PO
   read-model item. Recorded here as the PART 05 review posture: the §13.3
   advisory (warn-only, computed) read model remains a **pending** item to be
   scheduled by explicit instruction (candidate: folded into PART 06 or a
   follow-on PART), with its own computed-vs-persisted decision at that
   review. Until then: no PO deviation surface exists and none is promised;
   the non-gating stance of §13.4 stands (no price-based issuance gate in
   v1, no deviation threshold gate without separate governance review).
2. **Reason persistence = event metadata, not a column.** §22 expected "no
   migration"; storing the mandatory reason in `operational_events.metadata`
   (JSONB, transaction-atomic with the correction) satisfies "reason summary"
   evidence without widening the authority table's mutation surface. The
   reason also joins the idempotency fingerprint (P5.2.8).
3. **Event placement on the predecessor** mirrors the `REPLACED` precedent:
   the event documents the act performed *on* the corrected entry; the
   successor link travels in metadata.

## P5.8 Targeted validation evidence (PART 05 scope; no broad regression)

| Check | Command | Result |
|---|---|---|
| Type safety | `npm run typecheck` | clean |
| PART 05 suite | `tests/price-catalog-override.test.ts` | **9/9 pass** (6 suites) |
| PART 01 regression | `tests/price-catalog-entries.test.ts` | 16/16 pass |
| PART 02 regression | `tests/price-catalog-selection.test.ts` | 16/16 pass |
| PART 03 regression | `tests/price-catalog-vendor-tier.test.ts` | 11/11 pass |
| PART 04 regression | `tests/rfq-comparison-reference-price.test.ts` | 10/10 pass |
| Whitespace/patch hygiene | `git diff --check` | clean |

Suites run self-provisioned (embedded PostgreSQL, suite-isolated ports
55494–55499) with no local server dependency. KI-003 untouched; no broad
regression claimed or performed (§22/R-14 posture).

## P5.9 Files changed in PART 05

| File | Change |
|---|---|
| `src/modules/price-catalog-entries/price-catalog-entry.types.ts` | `CorrectPriceCatalogEntryInput` |
| `src/modules/price-catalog-entries/price-catalog-entry.validation.ts` | `parseCorrectPriceCatalogEntryBody` + mandatory/length-checked reason bound |
| `src/modules/price-catalog-entries/price-catalog-entry.service.ts` | `correctPriceCatalogEntry` + `correctFingerprint`; override event trail |
| `src/modules/price-catalog-entries/price-catalog-entry.controller.ts` | `correctPriceCatalogEntryHandler` (201) |
| `src/modules/price-catalog-entries/price-catalog-entry.routes.ts` | `/correct` route behind `price_catalog.override`; header comment updated |
| `src/modules/price-catalog-entries/index.ts` | type export |
| `tests/price-catalog-override.test.ts` | **new** — 9 tests: lifecycle+retroactive correction, effective-window gating, idempotency/conflict, authorization matrix, reason evidence, transition guards, vendor/general precedence, fail-closed overlap, RFQ snapshot byte-stability |
| `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` | this section |

No migration files added or touched; no edits outside the price-catalog
module and its tests.

## P5.10 PART 06 readiness (with P5.7 deferred item)

**READY, with a carried item.** PART 06 (Read API + OpenAPI + Cross-Module
Validation + Closure) may proceed on this branch:

- The `/correct` route needs its §20 OpenAPI entry (PART 06 family task);
  the response/error vocabulary is frozen by the PART 05 suite.
- **Carried item:** the §13.3 PO advisory deviation read model (and its
  `/purchase-orders/{id}/price-deviation` route) is unimplemented per the
  P5.7 deferral; place it explicitly — either inside PART 06 or a
  renumbered instruction — before FINAL REVIEW closure claims delivery of
  §13.3.
- Next free migration number: **0321** (unused so far).

---

# PART 06 — PO Price Deviation Advisory + OpenAPI & Integration Closure (implementation notes)

Status: **IMPLEMENTED on `arena/01a0314b-asentra-backend`** under the PART 06
instruction "PO Price Deviation Advisory + OpenAPI & Integration Closure".
This is the closure PART; FINAL REVIEW follows below (P6.9).

## P6.1 PO advisory deviation read model (§13.3) as implemented

`GET /api/v1/purchase-orders/{id}/price-deviation` — a **computed,
read-only** advisory projection. No persistence: **no migration** (§22's
"PART 05 review decides computed-vs-persisted" is hereby resolved as
*computed*; 0321 remains unused). Per PO line, resolved through the frozen
PART 02 §8 seam at request time (`asOf` = now, one instant for the whole
projection, echoed in the payload) with the **PO's own Vendor** as tier
context:

| Field group | Content |
|---|---|
| Outcome | `resolution` — the §8 vocabulary plus `NOT_REQUESTED` (SERVICE lines); facts are null unless `MATCHED` (`PurchaseOrderPriceDeviationResolution` is a runtime const pinned against OpenAPI) |
| Authority | `priceEntryId`, reference `unitPrice`, `currency`, `uomId`, `effectiveFrom/To` (effective authority context), `scopeTier` + `scopeVendor`/`scopeBuilding` provenance flags (PART 04 snapshot vocabulary) |
| PO facts | `unitPrice`, `lineAmount`, frozen `quantitySnapshot` — echoed, never recomputed |
| Deviation | `unitVariance`, `referenceTotal`, `totalVariance` (PO − reference, `roundMoney` 2dp), `variancePercent`, `position` (`ABOVE`/`BELOW`/`EQUAL`) |

Non-goal posture (all structural): service performs **no transaction, no
locks, no writes, no events** of its own; it is never consulted by
creation/approval/acknowledgement/issuance paths; it is not a commitment
origin and not settlement behavior. No-reference outcomes are explicit typed
classifications. `AMBIGUOUS` is reported per line as a typed outcome with
null facts — the fail-closed requirement ("never fabricate a price; audit
the incident") is preserved: the resolver still auto-commits
`PRICE_CATALOG_AMBIGUITY_REJECTED`. (Recorded decision: unlike the PART 04
write path, this projection persists nothing, so there is no evidence row to
protect by rejecting the request — a 409 there, a typed 200 here.)

## P6.2 Permission boundary (§20 realized, carried masking decision)

The route chains `requirePermission('purchase_order.read')` and
`requirePermission('price_catalog.read')` **conjunctively** — §20's
"`purchase_order.read` + `price_catalog.read`" cell is implemented as
route-level gating: the whole payload is price-authority data, so a caller
lacking either code receives 403 `PERMISSION_DENIED`, never a degraded
variant (recorded reasoning: a masked variant would carry strictly less
than the already-readable PO line payload; hiding the endpoint entirely is
the only non-oracle posture). Building scope (BE-02G) is asserted
afterwards. PO and PO-line read models grow **no** reference/deviation
keys — the masking surface for `purchase_order.read`-only callers is
unchanged (asserted key-absence in the PART 06 suite and documented in
OpenAPI). Vendor sessions: structural exclusion unchanged.

## P6.3 Design-review items resolved (P5.7 / P5.10 carried items)

1. **§13.3 PO advisory deviation read model — DELIVERED** (P6.1/P6.2). The
   P5.7 deferral is closed. Status posture: §13.3 frames the DRAFT-PO-line
   warning; the projection is served for any PO status with the status
   echoed (pure derived read data — for an ISSUED PO it reports committed
   price vs current authority, still non-gating; recorded in the PART 06
   review; no settlement semantics invented).
2. **`/correct` OpenAPI — DELIVERED.** `/price-catalog/entries/{id}/correct`
   is fully documented: `CorrectPriceCatalogEntryRequest` (required
   `unitPrice`, `effectiveFrom`, `reason`), the reusable required
   `IdempotencyKeyHeader` parameter (new to the contract, applied to all
   three price-catalog commands), 201 + 400/401/403/404/409 responses, and
   the `price_catalog.override` boundary in `x-required-permission` +
   description.
3. **Migration decision — none.** Computed read model; OpenAPI is
   documentation; 0321 unused.

## P6.4 OpenAPI completeness as implemented

- **Paths (8 new):** `/price-catalog/lookup`; `/price-catalog/entries`
  (POST/GET); `/price-catalog/entries/{id}` (GET/PATCH);
  `/{id}/activate|replace|correct|deactivate` (POST);
  `/purchase-orders/{id}/price-deviation` (GET). All carry
  `operationId`, `x-required-permission`, `x-building-scoped`, tags,
  `bearerAuth` and the envelope/error contract conventions.
- **Schemas (17 new):** currency/status/kind/scope-tier/lookup-resolution
  enums, entry + create/update/replace/correct requests + lookup result,
  deviation resolution/position/reference/line/projection, and
  `RfqComparisonLineReference` — every enum pinned against the runtime
  constants in `tests/price-catalog-openapi.test.ts`.
- **PART 04 extension closed:** `RfqComparisonLineOffer.reference`
  documented as optional, conjunctively masked (`rfq.read` +
  `price_catalog.read`), never in vendor-facing payloads.
- **New tag declared:** `Price Catalog` (only the pre-existing
  `Configuration` undeclared-tag debt remains, which predates this CR —
  see P6.8).
- The generated `openapi-contract.test.ts` still proves every documented
  route is registered (no invented endpoints); `rfq-openapi.test.ts` and
  `r2p-openapi-contract.test.ts` behavior unchanged (baseline-failing
  suites recorded in P6.8).

## P6.5 Cross-module integration validation as proven

- PO line → item/UOM/currency reference integrity: fixture-level MR → PO
  line snapshots resolve exactly through the catalog authority (items with
  UOM snapshots; SERVICE → NOT_REQUESTED; legacy UOM-less line →
  UOM_INCOMPATIBLE without resolver).
- MATCHED advisory math: reference totals, PO-minus-reference variance
  (2dp), percent, ABOVE/BELOW/EQUAL on one projection.
- Vendor precedence + general fallback: VENDOR_BUILDING > VENDOR > BUILDING
  > CLIENT_WIDE all active in one PO.
- AMBIGUOUS: constraint-simulated duplicate → typed outcome, null facts,
  one incident event, PO untouched.
- Historical immutability: PO header+line rows byte-identical across catalog
  replace **and** override-correct while the projection re-resolves current
  authority (100→200→90 flips ABOVE/BELOW/ABOVE only in the read model);
  information_schema proves zero deviation/reference-prefixed columns on the
  PO tables (computed, not persisted).
- RFQ comparison snapshots: full-table row capture byte-stable across
  repeated deviation reads; read-model deep-equal unchanged.
- Non-gating: an ABOVE-reference (+150%) DRAFT PO issues normally (200,
  ISSUED) and the projection stays advisory after issuance.
- No procurement award/winner logic was touched (zero edits under `rfqs`,
  `vendor-quotations`, `rfq-awards`, `rfq-po-conversions`).

## P6.6 Targeted validation evidence (PART 06 + PART 01–05 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/purchase-order-price-deviation.test.ts` (new, port 55500) | **8/8 pass** (4 suites) |
| `tests/price-catalog-openapi.test.ts` (new) | **5/5 pass** |
| PART 01–05 regression: price-catalog-entries | 16/16 |
| PART 02 regression: price-catalog-selection | 16/16 |
| PART 03 regression: price-catalog-vendor-tier | 11/11 |
| PART 04 regression: rfq-comparison-reference-price | 10/10 |
| PART 05 regression: price-catalog-override | 9/9 |
| Cross-module: purchase-orders / -lines / -readiness / -issuance | 16/16, 19/19, 18/18, 22/22 |
| Cross-module: rfq-comparisons | 5/5 |
| OpenAPI family: contract / rfq / material-chain / audit-part05 / operational-commitment / sla / utility-13/14 | all pass |
| `git diff --check` | clean |

## P6.7 Files changed in PART 06

| File | Change |
|---|---|
| `src/modules/purchase-orders/purchase-order-price-deviation.types.ts` | **new** — read-model vocabulary + DTOs |
| `src/modules/purchase-orders/purchase-order-price-deviation.service.ts` | **new** — computed advisory projection |
| `src/modules/purchase-orders/purchase-order.controller.ts` | deviation handler |
| `src/modules/purchase-orders/purchase-order.routes.ts` | conjunctive `/price-deviation` route |
| `src/modules/purchase-orders/index.ts` | exports |
| `docs/api/openapi.yaml` | 8 paths, 17 schemas, `IdempotencyKeyHeader` + `PriceCatalogEntryIdPath` params, `Price Catalog` tag, comparison `reference` documentation |
| `tests/purchase-order-price-deviation.test.ts` | **new** — 8 tests |
| `tests/price-catalog-openapi.test.ts` | **new** — 5 tests |
| `docs/CR-BE-PRICE-01_START_GOVERNANCE.md` | this section |

No migration files added or touched; no edits to the rfq/vendor-quotation/
commitment/budget modules.

## P6.8 Known pre-existing debt (not introduced, not worsened, untouched)

The following suite failures exist identically at the PART 05 baseline
(`2fe9fb7`, verified by stash-and-rerun) and are **unchanged** by PART 06 —
recorded here so FINAL REVIEW does not misread them as CR regressions:

| Suite | Baseline | After PART 06 | Cause (pre-existing) |
|---|---|---|---|
| `tests/r2p-openapi-contract.test.ts` | 21 pass / 2 fail | 21 pass / 2 fail | undeclared `Configuration` tag; 13 legacy duplicate operationIds |
| `tests/mobile-openapi-completeness.test.ts` | 3 pass / 2 fail | 3 pass / 2 fail | same debt classes (mobile side) |
| `tests/utility-part15-openapi.test.ts` | 2 pass / 1 fail | 2 pass / 1 fail | same debt classes |
| `tests/utility-part16-openapi.test.ts` | 2 pass / 1 fail | 2 pass / 1 fail | same debt classes |

PART 06 additions are contract-clean (all new operationIds unique; the new
`Price Catalog` tag is declared; every new `$ref` resolves). This debt is
KI-003-adjacent openapi drift; remediating it is out of CR-BE-PRICE-01
scope (owned by the docs owners of those CRs).

## P6.9 FINAL REVIEW — CR-BE-PRICE-01 closure statement

**All six PARTs delivered; the frozen governance surface is fully realized
on `arena/01a0314b-asentra-backend`.**

| Frozen governance area | Delivery |
|---|---|
| §4/§7 model + §11 lifecycle | PART 01 (`0319`, module, DRAFT→ACTIVE→INACTIVE, replace-not-update) |
| §5/§10 UOM + §9 currency | PART 01 CHECKs + PART 02 exact-match resolver with typed outcomes |
| §8 selection semantics | PART 02 deterministic tier precedence + AMBIGUOUS fail-closed audit |
| Vendor-tier hardening | PART 03 (eligibility, cross-tier isolation, commercial isolation) |
| §12 RFQ comparison evidence | PART 04 (`0320` additive nullable snapshot columns, advisory-only) |
| §11 mid-flight correction + §14 override | PART 05 (`/correct`, mandatory reason, `PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED`) |
| §13.3 PO advisory deviation | PART 06 (computed conjunctive projection, non-gating proven) |
| §13.4 no silent blocking | Proven: ABOVE-reference PO issues normally; no gate exists anywhere |
| §15 snapshot immutability | Proven byte-stable across replace/correct/deviation reads |
| §16/§20 API + isolation | Internal-only; vendor sessions structurally excluded; OpenAPI closed PART 06 |
| §17 audit vocabulary | All seven events implemented and pinned by tests |
| §18/§19 scheduler/backfill | None introduced (non-goals respected end to end) |

**Readiness statements:**

- **B-01 (future Service Catalog CR):** SERVICE tiers stay fail-closed at
  the DB CHECK (`source_mode = 'MATERIAL'`); every SERVICE-line touchpoint
  reports the explicit, non-blocking `NOT_REQUESTED` outcome. The new CR can
  lift the CHECK deliberately and extend the vocabularies
  (`PRICE_CATALOG_SOURCE_MODES`, resolver diagnostics) without reworking the
  model.
- **§19 (future governed adoption CR):** `source_type = 'MANUAL'` only;
  adoption requires separately approved governance (approval binding is
  already optional metadata; no adoption lane exists to abuse).
- **B-02 (future deviation gate):** §13.4 requires a separate governance
  review (approving authority, reason vocabulary, fail-open/closed posture)
  before any price-based issuance gate; the PART 06 projection is the
  read-only seam such a proposal would build on.
- **Remaining gap:** none against the frozen CR. Only pre-existing,
  CR-external debt remains open (P6.8 openapi drift; KI-003 assertion debt
  tracked in `docs/known-issues.md`).

**CR-BE-PRICE-01 is READY FOR FINAL REVIEW SIGN-OFF.**

# CR-BE-SVC-01 — START GOVERNANCE

## Governed Service Catalog & Service Identity

**Inspection date:** 2026-08-24 (UTC)
**Stage:** START GOVERNANCE only
**Implementation status:** none — this document creates no migrations, runtime
code, routes, OpenAPI changes, or tests
**Repository:** `budiirmawan/Asentra-Backend`

This document defines the smallest correct governed **Service Catalog** (a
Service master identity) for Asentra: a Client-scoped reference authority that
gives the service concept a stable identity and code where today only
free-text/code strings exist. It exists to (a) replace the ungoverned
`service_requests.service_type` string with a governed anchor, (b) become the
explicit SERVICE subject that CR-BE-PRICE-01 deliberately deferred (blocker
B-01), and (c) give Vendor capability matching a governed vocabulary target —
**without** introducing quantity/UOM into the SERVICE demand lineage, **without**
implementing SERVICE pricing, and **without** modifying completed PRICE-01 or
PRO-02 behavior.

This is a **governance-only** stage. No migrations, no runtime code, no routes,
no OpenAPI, no CI, no backfill, no historical data changes (see §22 validation
record).

---

## 1. Repository baseline / branch / main commit

| Item | Verified value |
|---|---|
| Arena branch | `arena/01a0324c-asentra-backend` |
| Branch base / main commit | `21ebcd4277722769505a14e51e40245b629fa54e` (merge PR #63) — **matches the expected main HEAD** |
| Working tree at inspection | clean (governance-only) |
| Latest applied migration | `0320_add_rfq_comparison_reference_price` |
| Next free migration number | **0321** (then 0322, 0323 … in order) |
| Migration runner | `src/database/migrations/index.ts`, records in `schema_migrations`; applied migrations are never edited |
| Permission catalogue | `src/database/seeds/foundation-access.seed.ts`, **292 codes** (`grep -c "code: '"`); `tests/seeds.test.ts` asserts against `FOUNDATION_PERMISSIONS.length`, so catalogue growth is seed-relative, not a hardcoded count |
| Audit authority | `recordOperationalEvent` (`src/modules/operational-events`), AUDIT-01 correlation columns (`0309_add_operational_event_correlation`), sensitive-key scrubber, integration-outbox seam |
| Isolation authority | BE-02G `ContextAccessService` (`src/modules/context-access`) + `docs/data-isolation.md` + `docs/effective-context.md` |
| OpenAPI | `docs/api/openapi.yaml` (hand-maintained, per-milestone contract tests) |
| PRICE-01 status | **complete** — all six PARTs delivered on the merged main (PART 06 FINAL REVIEW sign-off recorded in `docs/CR-BE-PRICE-01_START_GOVERNANCE.md`). SERVICE price tiers remain fail-closed at the DB level (`price_catalog_entries.source_mode = 'MATERIAL'`, `0319`) pending exactly this CR |
| Open known issues | KI-003 (legacy strict-key assertion debt, deferred, explicitly out of scope for this CR) |

### Independent verification of the "next capability" conclusion

The request asks this governance to **independently verify** that Service
Catalog / governed service identity is the next justified backend capability.
Inspection confirms it is, on three converging grounds:

1. **PRICE-01 closed with an explicit open blocker.** PRICE-01 §6 and FINAL
   REVIEW record B-01: *"SERVICE tiers stay fail-closed at the DB CHECK
   (`source_mode = 'MATERIAL'`); every SERVICE-line touchpoint reports the
   explicit, non-blocking `NOT_REQUESTED` outcome. The new CR can lift the
   CHECK deliberately …"* — i.e. PRICE-01 itself names a governed service
   identity as the precondition for SERVICE pricing and refuses to invent one.
2. **PRO-02 named the same gap.** PRO-02 §7.2 states the SERVICE PO-line
   convention (`unit_price` is the line amount) *"must be preserved **unless a
   separately governed service-unit authority is introduced**"* — a direct
   pointer at the missing master.
3. **The free-text string is load-bearing across the procurement chain** (§2),
   with no vocabulary table anywhere (grep-verified). It is the root cause of
   both the ungoverned SERVICE price subject and the string-equality Vendor
   capability match.

Nothing in the repository contradicts this sequencing: there is no competing
half-built service master, and every adjacent authority (RFQ, quotation, PO,
comparison, price catalog) already carries a deliberate SERVICE seam that
returns a non-blocking `NOT_REQUESTED`/null outcome precisely so this CR can
fill the identity gap later without breaking anything.

---

## 2. Authority map (verified)

### 2.1 The service-identity surface today (the problem statement)

Every place a "service" identity appears today, it is a **free-text/code
string with no governed vocabulary table, no lifecycle, and no uniqueness**:

| Concern | Existing authority | Verified free-text evidence | SVC-01 treatment |
|---|---|---|---|
| Service demand identity | `service_requests.service_type` (`0178`) | `TEXT NOT NULL`, normalized to uppercase at write time (`normalizeServiceType`, `src/modules/service-requests/service-request.validation.ts`), pattern `/^[A-Z][A-Z0-9_-]*$/`, 2–64 chars; **no FK, no vocabulary table, two clients/typists may write the same concept differently** | Primary governed anchor (§6) |
| Vendor capability code | `vendor_capabilities.code` (`0059`) | `TEXT NOT NULL`, `UNIQUE (vendor_id, code)` — unique **per Vendor**, not per Client; a free capability code, optionally narrowed to a `vendor_building_relationship` | Governed match target (§7) |
| Capability-match snapshot | `vendor_selection_readiness.service_type` (`0180`) | `TEXT NOT NULL`, a snapshot of the request's free-text code; `capability_match` is computed by `vendor-selection.service.ts` as `cap.code === target.serviceType` — **string equality between two free-text codes** | Governed match (§7) |
| PO readiness demand label | `purchase_order_readiness` projection | surfaces `sr.service_type` as `serviceType` (`purchase-order-readiness.repository.ts`) | Display only; benefits from governed code |

**Decisive finding (grep-verified):** there is **no** `service_catalog`,
`service_master`, `services`, `service_definitions`, `service_categories`, or
`service_types` table anywhere in `src/`. The only `service_catalog`-
adjacent name in the codebase is `price_catalog_entries` (the MATERIAL-only
price authority). A Service master does not exist.

### 2.2 Procurement lineage (PRO-02 + R2P-01, the governed chain SERVICE travels)

The SERVICE lineage is fully built and **typed**, but the typed subject is
*blank*: a SERVICE line carries no item, no UOM, no quantity anywhere in the
chain. This is the exact shape the governed service identity must slot into
**additively**, never by reintroducing item/UOM/quantity.

| Node | Authority | SERVICE shape (verified CHECK) | SVC-01 treatment |
|---|---|---|---|
| Service Request | `service_requests` (`0178`) | `service_type TEXT`, `title`, `description`, dates, optional `vendor_id`/`functional_location_id`; `status OPEN/CANCELLED`; **no quantity, no item, no price** | Add nullable governed `service_catalog_id` (§6) |
| RFQ | `rfqs` (`0313`) | `source_mode IN ('MATERIAL','SERVICE')`; `currency`; immutable scope snapshots; **no price** | Untouched at header |
| RFQ line | `rfq_lines` (`0313`) | `rfq_lines_service_shape_check`: for SERVICE `source_item_id IS NULL AND source_uom_id IS NULL AND quantity_snapshot IS NULL`; exactly one typed source FK; `source_claim_status ACTIVE/RELEASED` | Optional additive `source_service_id` snapshot (§9) |
| Vendor quotation line | `vendor_quotation_lines` (`0315`) | for SERVICE `required_quantity_snapshot IS NULL AND quoted_quantity IS NULL AND required_uom_id IS NULL`; `unit_price >= 0`; `line_total = unit_price` (no quantity extension) | Preserved exactly; optional identity snapshot |
| Comparison line | `rfq_comparison_lines` (`0316`) + `0320` | SERVICE lines resolve `reference_resolution = 'NOT_REQUESTED'` without touching the resolver (`rfq-comparison.service.ts` `resolveLineReference`) | The `NOT_REQUESTED` outcome is the seam SVC-01 PART 05 lifts (§10) |
| Recommendation / Award | `rfq_recommendations`, `rfq_awards` (`0317`) | Human recommendation → approval binding → award; `rfq.award` unassigned by default; **no price gate, no service-type gate** | Untouched |
| Award → PO provenance | `rfq_award_po_conversions`, `rfq_award_po_line_provenance` (`0318`) | Typed lineage; conversion copies awarded quotation facts to a DRAFT PO | Untouched |
| PO line | `purchase_order_lines` (`0270`) | `request_line_type SERVICE_REQUEST`; `purchase_order_lines_service_shape_check`: `item_id IS NULL AND quantity_snapshot IS NULL AND uom_id IS NULL`; `unit_price`/`line_amount`; append-only history; **unit price IS the line amount** | Preserved; optional identity snapshot |
| Operational commitment | `operational_commitments(_entries)` (`0311`/`0312`) | `origin IN ('MANUAL','PO_HEADER','PO_LINE')`; immutable ledger | Untouched; SVC-01 adds no origin |

**Lineage rule (frozen):** the governed Service Catalog identity is a
**traceability anchor** that may be *snapshotted* into the SERVICE chain. It
does **not** change the SERVICE shape constraints (no item/UOM/quantity),
which are PRO-02/R2P-01 invariants and must stay byte-identical.

### 2.3 Classification / reference-master idioms (the design precedent)

Asentra already has a consistent idiom for Client-scoped code/name/status
reference masters. A Service Catalog is the same idiom one more time:

| Master | Migration | Shape | Note |
|---|---|---|---|
| `room_types` | `0039` | Client-scoped, `code UNIQUE (client_id, code)`, `name`, `status ACTIVE/INACTIVE` | "classification/reference data, not hierarchy" |
| `skills` | `0025` | Client-scoped, `code UNIQUE (client_id, code)`, `name`, `category` CHECK whitelist, `status ACTIVE/INACTIVE` | closest *category-classified* precedent |
| `vendor_categories` | `0055` | Client-scoped, `code UNIQUE (client_id, code)`, `name`, `status ACTIVE/INACTIVE` | classification referenced by `vendors` |
| `units_of_measure` | `0071` | Client-scoped, `code UNIQUE (client_id, code)`, `name`, `symbol`, `category`, `status ACTIVE/INACTIVE` | **price-catalog UOM subject authority** |
| `inventory_items` | `0166` | Client-scoped, `code UNIQUE (client_id, code)`, `item_type` classifier, optional `uom_id`, `status ACTIVE/INACTIVE` | **price-catalog MATERIAL subject authority** |

**This is the decisive precedent:** the price catalog's MATERIAL subject is
`inventory_items` (0166), a Client-scoped code-classified reference master.
The SERVICE subject must be the **same shape** — a Client-scoped code-classified
reference master — so that PRICE-01's subject/tier/exclusion machinery can
extend to it by analogy, not by reinvention.

### 2.4 Cross-cutting foundation (reused, not rebuilt)

| Concern | Existing authority | SVC-01 reuse |
|---|---|---|
| Audit | `recordOperationalEvent` + AUDIT-01 correlation (`0309`); sensitive-key scrubber | All lifecycle events recorded through it; no parallel audit |
| RBAC | `permissions`/`roles` + foundation seed; `requirePermission` default-deny; `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` | New `service_catalog.*` codes registered in the seed (§12) |
| Isolation | `ContextAccessService.getAccessibleBuildingIds` / `assertBuildingAccess` / `canAccessClient` | All reads/writes Client-scoped-checked (§13) |
| Effective dating / windowing | tariff `0278`, budget `0283`, price catalog `0319` exclusion | **Not** reused for the catalog master itself — a reference master uses the simpler ACTIVE/INACTIVE idiom (§11); windowing is a PRICE concern, owned by PRICE-01 PART 05 |
| Currency convention | Nine-code whitelist | Reused unchanged when SERVICE pricing lands (PART 05), never before |
| Scheduler | Single due-job scheduler, env-gated | Not reused — no scheduler added (the catalog is reference data) |
| OpenAPI | `docs/api/openapi.yaml` + per-milestone contract tests | Changed only in the API/closure PART (§18) |

---

## 3. Verified gaps

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G-01 | **No governed Service master identity** | §2.1 grep; no `service_*` master table | This CR defines it; SERVICE pricing is structurally blocked (PRICE-01 B-01) |
| G-02 | `service_requests.service_type` is free text with no vocabulary | `0178` + `service-request.validation.ts` (`normalizeServiceType`, no FK) | Ungoverned identity; capability match and price anchoring impossible to do correctly |
| G-03 | Vendor capability match is string equality between two free-text codes | `vendor-selection.service.ts`: `cap.code === target.serviceType` | Two rows meaning the same thing can silently fail to match; no governance of the vocabulary |
| G-04 | SERVICE has no governed price subject | `price_catalog_entries` is `item_id NOT NULL`/`uom_id NOT NULL`/`source_mode='MATERIAL'` (`0319`) | SERVICE price tiers cannot be activated; PART 05 closes this after the master exists |
| G-05 | The SERVICE demand lineage carries no identity snapshot | `rfq_lines`/`vendor_quotation_lines`/`purchase_order_lines` SERVICE shapes have no service master FK | Sourcing/commit history cannot trace which governed service a line sourced |
| G-06 | No permission codes for service-catalog governance | Seed has 292 codes; none `service_catalog.*` | PART 01 registers `service_catalog.read/.manage` (§12) |
| G-07 | No audit vocabulary for service identity lifecycle | — | PARTs register `SERVICE_CATALOG_*` events through `recordOperationalEvent` |
| G-08 | KI-003 legacy strict-key assertion debt remains open | `docs/known-issues.md` | Out of scope; API/closure PART records intersections without fixing KI-003 |

---

## 4. Service-Catalog authority decision

### 4.1 Decision: ONE Client-scoped reference master, classification via a category column

Asentra needs **one** governed Service master, mirroring `inventory_items` —
the established subject-master shape the price catalog already treats as
canonical.

- It is the SERVICE analog of `inventory_items` (0166): Client-scoped,
  code-unique-per-Client, classifier-typed, ACTIVE/INACTIVE, soft-deleted by
  deactivation.
- Classification is a **`category` column** in v1 (the `skills` `0025`
  precedent), not a separate Service-Category master. A separate category
  master is a documented future promotion, not a v1 requirement (§4.3).

**Rejected alternatives, with reasons:**

| Candidate | Verdict | Reasoning |
|---|---|---|
| Repurpose `vendor_capabilities` as the service master | **Rejected** | `vendor_capabilities` are Vendor-scoped eligibility data (`UNIQUE (vendor_id, code)`), unique **per Vendor**; a service master must be unique **per Client** and must outlive any one Vendor. Reusing it would couple a Client-wide identity to Vendor lifecycle. |
| Repurpose `service_requests.service_type` in place (add a CHECK whitelist) | **Rejected** | A demand-line table cannot be a master: it would carry one row per request, not one row per service concept, and could not be referenced as a stable FK by price/RFQ/PO. |
| A `service_catalogs` header + `service_catalog_items` detail | **Rejected** | No repository precedent; `inventory_items`, `skills`, `room_types` are flat masters with a scope column. A header confers no invariant and only adds lifecycle/join complexity (same verdict PRICE-01 §4.1 reached for the catalog header). |
| Build `material_prices`-and-`service_prices` as two masters | **Rejected** | PRICE-01 already proved the single-table typed-subject pattern (`rfqs`/`rfq_lines`, `0313`). The Service master is the **subject**; SERVICE **price** lives in `price_catalog_entries` by widening, not in a second price table (§10). |
| A Building-scoped service master | **Rejected** | A service *concept* (e.g. `DAILY_CLEANING`) is Client-wide; Building-level commercial specialization belongs at the price/contract tier (`price_catalog_entries.building_id`) and the vendor relationship (`vendor_building_relationships`), not at the definition. Matches `inventory_items`/`skills`/`room_types` Client scoping. |
| Free `service_type` string kept, governed only by convention | **Rejected** | This is the status quo and is exactly the gap. Conventions without a table cannot enforce uniqueness, lifecycle, or FK integrity. |

### 4.2 Governed model (definition, not implementation)

Proposed canonical name: **`service_catalog`** (exact table/column names are
finalized by PART 01's migration review; semantics below are the governance
contract).

| Dimension | Decision | Repository justification |
|---|---|---|
| `client_id` | NOT NULL, FK `clients`; `code` `UNIQUE (client_id, code)` | Every reference master is Client-scoped (`0166`, `0025`, `0039`, `0055`, `0071`) |
| `code` | TEXT NOT NULL, normalized uppercase `/^[A-Z][A-Z0-9_-]*$/`, 2–64 chars, immutable once referenced | Matches the **existing** `service_request.service_type` validation pattern exactly (`service-request.validation.ts`) — this is the migration bridge: today's accepted codes are tomorrow's catalog codes |
| `name` | TEXT NOT NULL, trimmed, ≤ 200 | `inventory_items.name`/`rfqs.title` convention |
| `description` | TEXT NULL, ≤ 1000 | Reference-master convention |
| `category` | TEXT NOT NULL (free, documented convention; no CHECK whitelist in v1) | `skills.category` precedent allows a CHECK whitelist; **v1 keeps it free** so cross-Client category vocabulary is not prematurely frozen (a future governed Service-Category master is §4.3) |
| `status` | `ACTIVE` / `INACTIVE` (terminal) | Reference-master idiom (`0166`, `0025`, `0039`, `0055`, `0071`); **not** the price catalog's DRAFT/ACTIVE/INACTIVE — see §11 |
| Effective window | **None on the master** | A reference concept has no effective-dated validity; commercial windows live on the price entry (PRICE-01 §4.2), not the subject |
| Replacement / rename | `code` is immutable once any line references it; correction = new entry + deactivate predecessor (soft) | `inventory_items`/`vendors` INACTIVE-retention convention |
| Provenance / actor | `created_by_user_id` (audit); no idempotency-key machinery | A reference master is not a transactional command surface; idempotency belongs to the price/command layer |
| Scope proving | Composite `UNIQUE (id, client_id)` (PART 01 may add it, following the `0313`/`0319` scope-FK precedent) so child rows can prove Client scope structurally when referenced |

### 4.3 Service Category — governed promotion (future, not v1)

`category` is a free column in v1. If cross-service classification governance
becomes necessary (a reusable, deactivatable category vocabulary referenced
by many services), the promotion is **additive**: introduce a
`service_categories` master (the `vendor_categories` `0055` idiom) and an
optional FK `service_category_id` on `service_catalog`, leaving the free
column for back-compat. This is recorded as a non-goal for v1 (§20) and is
**not** assumed by any other PART.

### 4.4 What the authority deliberately is NOT

Not a Vendor capability, not a demand line, not a price, not a quantity/UOM
authority, not a work-order/execution authority, not a contract, not a tenant
service request, and not a second price table (§20).

---

## 5. Service identity and code rules

| Question | Governed answer | Evidence |
|---|---|---|
| Identity authority | `service_catalog` (this CR) | §4 |
| Code grammar | `/^[A-Z][A-Z0-9_-]*$/`, 2–64 chars, normalized to uppercase at write | Byte-identical to existing `service_request.service_type` validation → today's accepted free-text codes are valid catalog codes (zero grammar migration friction) |
| Uniqueness | `UNIQUE (client_id, code)` — one governed service concept per Client | `inventory_items`/`skills`/`vendor_categories` precedent |
| Code immutability | Immutable once referenced by any governed child (service_request, price entry, capability, lineage snapshot); rename = new code + deactivate | Prevents silent identity drift across the procurement chain |
| Normalization | Server normalizes (trim + uppercase) exactly as `service_requests` does today | `normalizeServiceType` is reused, not reinvented |
| Free-text coexistence | The free `service_type` string on `service_requests` is **kept** during migration; the governed `service_catalog_id` FK is added **nullable** alongside it (§6) | No backfill; no breaking change; governed anchor is opt-in then becomes required by Client policy |
| Display name | `name` is human-readable and editable while `code` is immutable | Separates identity from label |

---

## 6. Client vs Building scope

| Question | Governed answer | Evidence |
|---|---|---|
| Master scope | **Client-scoped**, never Building-scoped | A service concept is Client-wide; matches `inventory_items` (0166), `skills` (0025), `room_types` (0039) |
| Building specialization | Lives on the **commercial tier** (`price_catalog_entries.building_id`, PRICE-01 §8) and the **vendor tier** (`vendor_building_relationships` `0058`), **not** on the catalog definition | PRICE-01 §8 four-tier model already separates subject (Client) from applicability (Building) |
| Isolation on writes/reads | `canAccessClient(actor, clientId)` (Client-scoped, since the catalog has no `building_id`); a caller can never read/write another Client's catalog | BE-02G; `ContextAccessService` Client-scoped path |
| Listing scope | Bound to the caller's accessible Client set; an out-of-reach `clientId` filter returns an empty page (no existence oracle) | PRICE-01 PART 01 isolation precedent |

---

## 7. Relationship to Vendor capabilities

**Today (verified):** the Vendor capability match is
`cap.code === target.serviceType` (`vendor-selection.service.ts`) — string
equality between `vendor_capabilities.code` (Vendor-scoped, unique per Vendor)
and `service_requests.service_type` (free text). Two rows meaning the same
service can silently fail to match, and nothing governs the vocabulary on
either side.

**Governed model:**

| Aspect | Decision | Reasoning |
|---|---|---|
| Is `service_catalog` the Vendor capability authority? | **No.** Vendor capabilities remain Vendor-scoped eligibility data. The catalog is the **Client-wide concept**; capabilities are a Vendor's claim to deliver it | Different scoping (`UNIQUE (client_id, code)` vs `UNIQUE (vendor_id, code)`); coupling them would tie Client identity to Vendor lifecycle |
| Optional governed link | `vendor_capabilities` may gain a **nullable** `service_catalog_id` FK (PART 03) that points at the Client's governed service, while keeping its free `code` for back-compat | Additive; the free code is the migration seam; the FK is the governed match target |
| Governed match (future) | When both a request's `service_catalog_id` and a capability's `service_catalog_id` are set, match on governed identity (stable, unambiguous); otherwise fall back to normalized-code equality (today's behavior) | Fail-open to current behavior; governed match is a strict improvement, never a regression |
| `vendor_selection_readiness.service_type` | Remains a snapshot string for evidence; PART 03 may additionally snapshot the governed `service_catalog_id` so the historical readiness row names the governed service | Snapshot-on-evaluate precedent (0180 already snapshots `service_type`) |
| Required relationship? | **No.** A service concept exists in the catalog independently of any Vendor; a Vendor may claim a capability that no Client request has ever used | Master vs eligibility separation |

**Rule:** the Service Catalog **enables** governed capability matching; it does
not **absorb** vendor capabilities. The link is optional and additive.

---

## 8. Relationship to Service Requests

**Today:** `service_requests.service_type` (`0178`) is a free `TEXT NOT NULL`
string. It is the demand identity but is ungoverned.

**Governed model (PART 02):**

| Aspect | Decision | Reasoning |
|---|---|---|
| New column | Add **nullable** `service_catalog_id UUID REFERENCES service_catalog (id)` (+ composite scope FK `(service_catalog_id, client_id)` per `0319` precedent) | Additive; no backfill; existing rows keep `service_type` |
| Free `service_type` column | **Kept** (`NOT NULL` unchanged). Becomes the human/historical demand label | Zero breaking change; the governed FK is the new authority, the string is the back-compat label |
| Validation | If `service_catalog_id` is supplied, it must be ACTIVE and same-Client; the catalog's `code` should equal the (normalized) `service_type` string when both are present (service-layer consistency check, warn-or-reject per PART 02 review) | Prevents a request from citing a governed service whose code disagrees with its label |
| Future requiredness | A Client may **policy-require** `service_catalog_id` at request creation once its catalog is populated; the column is nullable at the DB level so the requirement is enforceable in the service layer, not frozen in the schema | `inventory_items`-style service-layer validation (same-Client, ACTIVE) is the precedent |
| Effect on demand lineage | None — `service_requests` still carries no quantity/item/price; the governed FK is an identity anchor only | `0178` shape preserved |

---

## 9. RFQ / quotation / award / PO lineage (SERVICE traceability)

The governed service identity may be **snapshotted** into the SERVICE lineage
for traceability. This is **additive and optional** — it does not change any
SERVICE shape constraint.

| Node | Snapshot column (proposed, PART 04) | Mutability | Effect on existing shape |
|---|---|---|---|
| `rfq_lines` (`0313`) | nullable `source_service_id UUID REFERENCES service_catalog (id)` (+ scope FK) | Immutable sourcing-time snapshot (set at line creation, never edited) | `rfq_lines_service_shape_check` unchanged (still no item/UOM/quantity); the snapshot is identity-only |
| `vendor_quotation_lines` (`0315`) | nullable service identity snapshot | Immutable once SUBMITTED | SERVICE shape unchanged |
| `rfq_comparison_lines` (`0316`) | identity carried via the rfq-line snapshot; no new resolution outcome until PART 05 | — | `reference_resolution` unchanged until PART 05 |
| `purchase_order_lines` (`0270`) | nullable service identity snapshot | Frozen at commit | `purchase_order_lines_service_shape_check` unchanged |
| Award / provenance (`0317`/`0318`) | Identity flows through the awarded snapshot; no new field required | — | Untouched |

**Lineage rules (frozen):**

1. A SERVICE snapshot is **identity only**. It never introduces `item_id`,
   `uom_id`, or `quantity_snapshot` — those remain NULL for SERVICE by the
   existing CHECKs (PRO-02/R2P-01 invariants).
2. Snapshots are taken from the request's governed `service_catalog_id` when
   present; if a request has no governed anchor, the snapshot is NULL and the
   line behaves exactly as today (no regression, no blocking).
3. The governed snapshot is **frozen** like every other sourcing snapshot
   (`source_item_id`, `quantity_snapshot`) — editing the catalog later never
   rewrites a frozen line (PRICE-01 §15 immutability posture, reused).

---

## 10. PRICE-01 integration model (the future SERVICE price subject)

> **Critical PRICE-01 constraint (from the request):** *"Do NOT assume SERVICE
> pricing can be enabled by only changing `source_mode`. Current
> `price_catalog_entries` requires MATERIAL item/UOM authority. Govern the
> future SERVICE subject model explicitly."*

This section governs that model explicitly. It is a **design contract**; it is
**not** implemented in START GOVERNANCE and SERVICE pricing is **not**
implemented by any PART of this CR until PART 05, and even then only after
PART 01–04 (the identity exists and is referenced). The constraint is honored
exactly: widening is far more than flipping a CHECK.

### 10.1 Why "just change source_mode" is wrong (verified)

`price_catalog_entries` (`0319`) is MATERIAL-by-construction:

```text
source_mode  TEXT NOT NULL  CHECK (source_mode = 'MATERIAL')   -- fail-closed
item_id      UUID NOT NULL                                    -- material subject
uom_id       UUID NOT NULL                                    -- priced per UOM
```

plus the ACTIVE-window exclusion constraint whose key is
`(client_id, item_id, uom_id, currency, building_key, vendor_key, window)` and
the resolver/§8 applicability predicate that requires exact `item_id`,
`uom_id`, `currency` equality and computes `reference_total =
reference_unit_price × required_quantity_snapshot` (PART 04 §12).

A SERVICE price subject shares **none** of the material subject's cardinality:

- A service has **no item** (it is itself the subject).
- A service has **no required UOM** (SERVICE lines are unit-price = line-amount;
  PRO-02 §7.2).
- A service line has **no quantity** (`rfq_lines_service_shape_check`,
  `vendor_quotation_lines` SERVICE shape, `purchase_order_lines` SERVICE shape).
- Therefore `reference_total` for a service = `reference_unit_price` (no
  extension), and `UOM_INCOMPATIBLE` is not a SERVICE outcome (no UOM).

Flipping `source_mode = 'MATERIAL'` to allow `'SERVICE'` while keeping
`item_id NOT NULL`/`uom_id NOT NULL` is **structurally impossible** — there is
no item or UOM to populate.

### 10.2 Governed SERVICE subject model (the contract)

| Dimension | MATERIAL (today) | SERVICE (governed, realized PART 05) |
|---|---|---|
| Subject column | `item_id UUID NOT NULL` | new `service_id UUID` (nullable; NOT NULL when `source_mode='SERVICE'`) FK `service_catalog` (+ composite `(service_id, client_id)` scope FK) |
| UOM | `uom_id UUID NOT NULL` (priced per UOM) | **NULL** (service unit price is the amount; no UOM) |
| `source_mode` | `MATERIAL` | widened CHECK to admit `SERVICE` |
| Shape CHECK | MATERIAL requires item+uom | new discriminated-union CHECK: `(MATERIAL ⇒ item_id NOT NULL ∧ uom_id NOT NULL ∧ service_id IS NULL) ∧ (SERVICE ⇒ service_id NOT NULL ∧ item_id IS NULL ∧ uom_id IS NULL)` |
| Exclusion key | `(client, item, uom, currency, building, vendor, window)` | **`(client, service, currency, building, vendor, window)` — no uom** |
| Exclusion structure | one constraint | **two partial constraints** (one per `source_mode`) because the identity keys genuinely differ (§10.3) |
| `unit_price` | per 1 UOM unit | per 1 service (the service amount) |
| `reference_total` | `unit_price × required_quantity_snapshot` | `= reference_unit_price` (no quantity) |
| Resolver outcomes | `MATCHED/NO_REFERENCE_PRICE/UOM_INCOMPATIBLE/CURRENCY_INCOMPATIBLE/AMBIGUOUS` | `MATCHED/NO_REFERENCE_PRICE/CURRENCY_INCOMPATIBLE/AMBIGUOUS` (**no `UOM_INCOMPATIBLE`**) |
| Comparison `reference_resolution` | `MATCHED/.../UOM_INCOMPATIBLE/...` | `MATCHED/NO_REFERENCE_PRICE/CURRENCY_INCOMPATIBLE` (the `NOT_REQUESTED` SERVICE outcome is **replaced** by resolution once SERVICE pricing is active) |
| PO deviation | per-line unit + extension variance | unit-vs-unit only (no extension); `position_vs_reference` still applies |

### 10.3 Exclusion constraint split (the key structural decision)

The single ACTIVE-window exclusion constraint in `0319` cannot be "widened" to
SERVICE, because a SERVICE row has no `uom_id` and a MATERIAL row has no
`service_id`. A single GiST key containing both nullable columns would not
separate the two identity spaces correctly (the sentinel-COALESCE trick from
PRICE-01 PART 01 works for tier nullability, not for discriminated identity).

**Decision:** **two partial exclusion constraints**, each scoped to its
`source_mode`:

```text
-- MATERIAL (existing, unchanged)
EXCLUDE USING gist (
  client_id, item_id, uom_id, currency,
  COALESCE(building_id, sentinel) WITH =,
  COALESCE(vendor_id,   sentinel) WITH =,
  tstzrange(effective_from, effective_to, '[)') WITH &&
) WHERE (status = 'ACTIVE' AND source_mode = 'MATERIAL')

-- SERVICE (new, PART 05)
EXCLUDE USING gist (
  client_id, service_id, currency,
  COALESCE(building_id, sentinel) WITH =,
  COALESCE(vendor_id,   sentinel) WITH =,
  tstzrange(effective_from, effective_to, '[)') WITH &&
) WHERE (status = 'ACTIVE' AND source_mode = 'SERVICE')
```

Consequences:

- MATERIAL pricing is **byte-identical** to today (the existing constraint is
  narrowed only by adding `AND source_mode = 'MATERIAL'`, which excludes zero
  rows today because all rows are MATERIAL — PRICE-01 behavior is not modified).
- SERVICE pricing gets its own structurally-correct key space (no UOM, by
  definition).
- The four tier coexistence semantics (PRICE-01 §8) carry over unchanged for
  both modes via the COALESCE sentinel keys.

### 10.4 Resolver / comparison / deviation extension (contract)

- The PART 02 resolver gains a SERVICE branch: identity key is `service_id`
  (no UOM), outcomes drop `UOM_INCOMPATIBLE`; `AMBIGUOUS` defensive trip and
  fail-closed posture are reused verbatim.
- The PART 04 comparison integration stops short-circuiting SERVICE to
  `NOT_REQUESTED` for lines whose RFQ carries a governed `service_id` snapshot;
  it resolves a SERVICE reference price instead (advisory-only, no auto-reject
  — PRICE-01 §12.1 preserved).
- The PART 06 PO deviation projection gains a SERVICE branch comparing
  `unit_price` to the SERVICE reference `unit_price` directly (no extension).

### 10.5 Compatibility posture (what is NOT modified)

- PRICE-01 MATERIAL pricing, lifecycle, override, vendor-tier, and deviation
  behavior are **untouched** (the MATERIAL exclusion constraint keeps its exact
  key and effect; only an additive `WHERE source_mode='MATERIAL'` qualifier is
  added, which is a no-op against today's all-MATERIAL data).
- PRO-02 typed-lineage invariants and SERVICE shape CHECKs are **untouched**
  (SERVICE lines still carry no item/UOM/quantity).
- Currency rules, `NUMERIC(18,2)` money, idempotency, and the
  `entry_kind`/tier machinery are **reused unchanged**.

### 10.6 Sequencing dependency (readiness gate)

PART 05 (PRICE-01 SERVICE subject widening) is **blocked** until PART 01–04
land: the price entry's `service_id` FK must point at a populated, governed
`service_catalog` that the request and lineage snapshots already reference.
START GOVERNANCE implements none of it; this section is the frozen contract
that later PARTs realize.

---

## 11. Lifecycle / effective dating

| Rule | Decision | Precedent |
|---|---|---|
| Lifecycle | `ACTIVE` → `INACTIVE` (terminal). **No DRAFT state.** | Reference-master idiom (`inventory_items` `0166`, `skills` `0025`, `room_types` `0039`, `vendor_categories` `0055`); the DRAFT/ACTIVE/INACTIVE lifecycle belongs to transactional authorities (`price_catalog_entries`, `rfqs`), not to a master |
| Activation | Created ACTIVE (or created then activated in the same act); no scheduler | A master has no effective-dated validity to schedule |
| Deactivation | Explicit command; `INACTIVE` rows retained for history; deactivated concepts stop being assignable to new requests/entries but existing references stay valid (historical fidelity) | `inventory_items`/`vendors` INACTIVE preservation; PRICE-01 §15 snapshot sufficiency |
| Destructive overwrite | Prohibited: no DELETE; no UPDATE of `code` once referenced | PRICE-01 replace-not-update philosophy; append-only master preservation |
| Rename | New `code` (new row) + deactivate the old; references to the old code remain historically accurate (governed snapshots/labels) | `inventory_items` code immutability |
| Effective window | **None on the master.** Commercial effective windows live on the price entry (PRICE-01 §4.2), not the service concept | PRICE-01 owns windowing; SVC-01 owns identity |
| `category` edits | Allowed on ACTIVE rows (classification label, not identity) | `skills.category` is editable |

---

## 12. RBAC

### 12.1 New permission codes (PART 01 seed registration)

| Code | Purpose | Default assignment |
|---|---|---|
| `service_catalog.read` | Internal read of catalog entries, governed-code lookups | Granted to reader/procurement roles; on `PLATFORM_ADMIN` |
| `service_catalog.manage` | Create, edit non-identity fields, activate/deactivate catalog entries within the caller's Client | Granted to designated catalog stewards; on `PLATFORM_ADMIN` |

Rules:

- **Two codes only.** A reference master does not need an exceptional-authority
  `.override` (that risk class belongs to the price window, owned by PRICE-01's
  unassigned-by-default `price_catalog.override`). No `service_catalog.override`
  is created.
- `.manage` does not imply any price authority; `price_catalog.*` codes are
  separate and unchanged.
- Neither code is grantable to RFQ Vendor sessions (the `0314` session model has
  no role/permission binding at all) — structurally excluded.
- `tests/helpers/access.ts` mirrors the default grant (read/manage).

### 12.2 Who may do what (default posture)

| Act | Authority |
|---|---|
| Read / look up governed service codes | Internal user + `service_catalog.read` + in-scope Client |
| Maintain the catalog | Internal user + `service_catalog.manage` + in-scope Client |
| Cite a governed service on a request | `service_request.manage` (unchanged) + the cited service is ACTIVE + same-Client |
| Price a SERVICE subject (future) | `price_catalog.manage` (unchanged) + a governed service exists (PART 05) |
| Override a price window | `price_catalog.override` (unchanged; PRICE-01) |

---

## 13. Audit / isolation

| Concern | Decision | Evidence |
|---|---|---|
| Audit channel | `recordOperationalEvent` + AUDIT-01 correlation (`0309`); sensitive-key scrubber; transaction-atomic with the mutation | PRICE-01 §17 precedent |
| Event vocabulary | `SERVICE_CATALOG_ENTRY_CREATED`, `SERVICE_CATALOG_ENTRY_UPDATED`, `SERVICE_CATALOG_ENTRY_DEACTIVATED`; `entity_type=SERVICE_CATALOG_ENTRY`; Client from the entry | Final names fixed in PART reviews |
| Isolation | Client-scoped via `ContextAccessService.canAccessClient` / `assertBuildingAccess`-equivalent Client check; the catalog carries no `building_id`, so isolation is Client-wide | BE-02G; reference masters are Client-scoped |
| Caller widening | A caller can never mint or widen a Client scope they cannot reach (cross-Client read/write → 403) | PRICE-01 PART 01 isolation precedent |
| Vendor leakage | The catalog is internal reference data; Vendor sessions never see it; governed match happens inside the internal selection service | PRICE-01 §16/§20 internal-only posture |
| Never stored in events | File contents, tokens, other Clients' catalog rows | PRICE-01 §17 |

---

## 14. Migration / adoption strategy (free-text → governed)

Governance follows PRICE-01's adoption posture (no silent backfill) exactly.

| Step | Decision |
|---|---|
| 1. Master exists | `service_catalog` (PART 01) — empty until a Client populates it |
| 2. Governed anchor added | nullable `service_catalog_id` on `service_requests` (PART 02) and optionally on `vendor_capabilities`/lineage snapshots (PART 03/04) — **additive, no backfill** |
| 3. New requests opt-in | New `service_requests` *may* cite a governed service; the free `service_type` string remains required for back-compat |
| 4. Client policy tightening | A Client may, by configuration/policy, **require** `service_catalog_id` at request creation once its catalog is populated — enforced in the service layer, not frozen in the schema |
| 5. Legacy mapping (future) | Mapping historical free-text codes to governed entries is a **separate governed adoption process** (new `source_*`/adoption provenance if it ever touches price), requiring explicit approval — **out of scope** (PRICE-01 §19 posture). No historical `service_type` strings are rewritten. |
| 6. Free `service_type` column | Retained indefinitely as a human/historical label; never dropped in this CR |

**Hard rules:**

- **No silent backfill.** Nothing in this CR invents catalog rows from existing
  free-text codes. Catalog entries are explicit human acts (PART 01).
- **No historical rewrite.** Existing `service_requests.service_type` values
  are never mutated; only new/edited rows may gain a governed FK.
- **Governed match is fail-open.** Until both sides cite a governed service,
  capability matching keeps today's normalized-code behavior (§7).

---

## 15. Lifecycle gating across the chain (readiness ladder)

```
PART 01  service_catalog master exists (identity)
   │
   ▼
PART 02  service_requests can cite a governed service (demand anchor)
   │
   ▼
PART 03  vendor_capabilities can link to a governed service (governed match)
   │
   ▼
PART 04  SERVICE lineage snapshots carry governed identity (traceability)
   │
   ▼
PART 05  PRICE-01 SERVICE price subject (closes PRICE-01 B-01)
   │
   ▼
PART 06  API + OpenAPI + closure
```

Each rung is independently shippable and independently valuable; PART 05 is
the rung that unblocks SERVICE pricing and is gated on all prior rungs.

---

## 16. API boundary (definition only — OpenAPI lands in the closure PART)

Minimum internal surface (all versioned `/api/v1`, all under existing auth +
isolation middleware):

| Route (proposed) | Verb | Purpose | Permission |
|---|---|---|---|
| `/service-catalog/entries` | POST | Create entry (idempotent) | `service_catalog.manage` |
| `/service-catalog/entries` | GET | List with filters (category, status, search) in-scope | `service_catalog.read` |
| `/service-catalog/entries/{id}` | GET | Read one entry | `service_catalog.read` |
| `/service-catalog/entries/{id}` | PATCH | Edit non-identity fields (`name`, `description`, `category`); `code` immutable | `service_catalog.manage` |
| `/service-catalog/entries/{id}/deactivate` | POST | Terminal deactivation | `service_catalog.manage` |
| `/service-catalog/lookup` | GET | Resolve a free-text code → governed entry (migration helper) | `service_catalog.read` |
| `/service-requests/...` (existing) | unchanged | gains optional `serviceCatalogId` (PART 02) | `service_request.manage` |

**Vendor sessions receive no route in this family** — the catalog is internal
reference data; governed capability matching happens inside the internal
selection service (§7, §13).

---

## 17. Concurrency governance

| Hazard | Mechanism | Proven at |
|---|---|---|
| Concurrent duplicate creation | `UNIQUE (client_id, code)` rejects the second; mapped to a 409-class structured error | `inventory_items`, `skills` Client-code uniqueness |
| Concurrent rename (new code + deactivate) | Two transactions cannot create the same `code`; the deactivated predecessor stays queryable | Append-only master preservation |
| Code immutability under edit | Service layer refuses `code` edits on existing rows; direct DB guard may enforce an immutable-after-referenced rule in PART 01 review | PRICE-01 direct-DB-guard precedent |
| Read-time races | Selection/lookup is a pure `SELECT` against committed rows | PRICE-01 PART 02 read determinism |

Serialization failure / constraint violation mapping follows existing error
modules (`*.errors.ts` with stable `ERROR_CODES`).

---

## 18. Proposed PART breakdown (smallest safe sequence)

Sequencing follows repository evidence: the identity master first, then demand
anchoring, then vendor linking, then lineage traceability, then the PRICE-01
SERVICE subject (the rung that closes B-01), then API/OpenAPI closure. Each
PART ships with focused tests and its own review section appended here.

### PART 01 — Service Catalog Foundation

| Aspect | Content |
|---|---|
| Migration | `0321_*` — `service_catalog` table (Client-scoped, `code UNIQUE (client_id, code)`, `category`, `status ACTIVE/INACTIVE`), scope-FK uniques/conventions per `0319` precedent, indexes |
| Runtime/module | `src/modules/service-catalog/` (types/errors/validation/repository/service/controller/routes following module convention); create/edit-non-identity/deactivate/list/read; code-immutability; mounting in `src/routes/index.ts` |
| Seed | Register `service_catalog.read/.manage` (both on `PLATFORM_ADMIN`); `tests/seeds.test.ts` passes via length-relative assertions |
| Audit | CREATED/UPDATED/DEACTIVATED + correlation |
| Authorities reused | Clients isolation (`ContextAccessService` Client path), `recordOperationalEvent`, `requirePermission` |
| Tests | `tests/service-catalog.test.ts` — schema shape, code uniqueness, code immutability, deactivation retention, isolation denial, permission denials, event emission |
| Blockers | none |

### PART 02 — Service Request Governed Anchor

| Aspect | Content |
|---|---|
| Migration | `0322_*` — additive nullable `service_catalog_id` on `service_requests` (+ composite scope FK); free `service_type` retained NOT NULL |
| Runtime | Create/update accept optional `serviceCatalogId`; same-Client + ACTIVE validation; consistency check vs `service_type` code |
| Tests | `tests/service-catalog-request-anchor.test.ts` — nullable-additive, governed validation, back-compat (free-text still works), isolation |
| Blockers | PART 01 |

### PART 03 — Vendor Capability Governed Link

| Aspect | Content |
|---|---|
| Migration | `0323_*` — additive nullable `service_catalog_id` on `vendor_capabilities` (+ scope FK) and optional snapshot on `vendor_selection_readiness` |
| Runtime | Optional link; governed match (identity when both set, else normalized-code fallback); readiness snapshot |
| Tests | `tests/service-catalog-capability-match.test.ts` — governed match vs fallback, eligibility behavior unchanged when no link, isolation |
| Blockers | PART 01 |

### PART 04 — SERVICE Lineage Identity Snapshots

| Aspect | Content |
|---|---|
| Migration | `0324_*` — additive nullable `source_service_id` on `rfq_lines`; identity snapshot columns on `vendor_quotation_lines`/`purchase_order_lines` (additive, nullable) |
| Runtime | Snapshot governed service at line creation/commit; frozen; no shape-CHECK change |
| Tests | `tests/service-catalog-lineage-snapshot.test.ts` — snapshot immutability, SERVICE shape constraints unchanged, NULL when no anchor |
| Blockers | PART 01–02 |

### PART 05 — PRICE-01 SERVICE Price Subject (closes B-01)

| Aspect | Content |
|---|---|
| Migration | `0325_*` — `price_catalog_entries` SERVICE widening: nullable `service_id` (+ scope FK), `source_mode` CHECK widened, discriminated-union shape CHECK, **split** the ACTIVE exclusion into two partial constraints (`MATERIAL`/`SERVICE`); `item_id`/`uom_id` made nullable with the shape CHECK enforcing mode-correct nullness; add `UNIQUE(id, client_id)` on `service_catalog` for the scope FK |
| Runtime | Resolver SERVICE branch (no UOM outcome); comparison SERVICE resolution (replaces `NOT_REQUESTED` for governed lines); PO deviation SERVICE branch |
| Hard rules asserted | MATERIAL pricing byte-identical; no auto-reject; no winner logic; PRO-02 SERVICE shapes untouched; currency/exclusion/tier semantics reused |
| Tests | `tests/price-catalog-service-subject.test.ts` — SERVICE entries, two partial exclusions, no-UOM resolver outcomes, comparison/PO deviation SERVICE branches, MATERIAL regression byte-identical |
| Blockers | PART 01–04; PRICE-01 complete (satisfied) |

### PART 06 — Read API + OpenAPI + Cross-Module Validation + Closure

| Aspect | Content |
|---|---|
| Runtime | API hardening pass on §16 surface; OpenAPI additions in `docs/api/openapi.yaml`; contract validation |
| Tests | `tests/service-catalog-openapi.test.ts` (mirroring `price-catalog-openapi.test.ts` convention); focused cross-module regression (service-requests, vendor-capabilities, rfq, PO, price catalog) — **not** broad regression (KI-003 posture respected) |
| Closure | FINAL REVIEW section appended here; readiness statement that PRICE-01 B-01 is closed by PART 05 |
| Blockers | PART 01–05 |

---

## 19. Risk register

| # | Risk | Mitigation in this governance |
|---|---|---|
| R-01 | **Governed price subject fabricated by "just flipping source_mode"** | §10 explicitly forbids it; PART 05 owns the structural widening (split exclusions, nullable item/uom, discriminated-union CHECK); PRICE-01 §6 fail-closed CHECK stays until PART 05 |
| R-02 | Free-text → governed migration breaks historical data | No backfill; additive nullable FKs; free `service_type` retained (§14) |
| R-03 | Governed match regresses today's capability matching | Governed match is fail-open (identity when both set, else normalized-code); existing behavior preserved when no link (§7) |
| R-04 | Coupling Client identity to Vendor lifecycle (reusing capabilities as master) | Rejected (§4.1); capabilities stay Vendor-scoped; link is optional FK |
| R-05 | Service concept scoped to Building instead of Client | Rejected (§4.1/§6); Building specialization lives on the price/vendor tier |
| R-06 | Introducing item/UOM/quantity into the SERVICE lineage | §9 forbids it; SERVICE shape CHECKs are PRO-02/R2P-01 invariants and stay untouched |
| R-07 | PRICE-01 MATERIAL behavior altered by SERVICE widening | §10.5: MATERIAL exclusion keeps its exact key + effect (only an additive no-op `source_mode='MATERIAL'` qualifier); MATERIAL regression asserted byte-identical in PART 05 |
| R-08 | Two partial exclusions interact incorrectly | §10.3: each is mode-scoped (`WHERE source_mode=…`); identity key spaces are disjoint by construction |
| R-09 | Code immutability not enforced | §5/§11/§17: service-layer refusal + optional direct-DB immutable-after-referenced guard in PART 01 |
| R-10 | Premature category whitelist freezes cross-Client vocabulary | §4.2: `category` is free in v1; governed promotion is §4.3 future |
| R-11 | Cross-tenant catalog leakage | All reads/writes Client-scoped via `ContextAccessService`; Client-proof composite FKs (§13) |
| R-12 | CI / KI-003 strict-key assertion drift when read models gain fields | API/closure PART extends rather than widens existing payload keys; drift recorded as KI-003-class debt, fixed additively; no broad regression promised |
| R-13 | Adoption pressure ("just import all free-text codes as catalog rows") | No silent backfill; adoption is a separate approved process (§14) |

### Blockers

- **B-01 (PRICE-01)** — SERVICE price tiers require this governed Service
  Catalog. Closed by SVC-01 PART 05.
- **B-02** — Governed **price adoption/backfill** tooling (free-text →
  catalog, or historical price adoption) is a separate approved process
  (PRICE-01 §19 / SVC-01 §14). Not in any PART.
- **B-03** — Governed **Service Category master** promotion (free `category`
  → `service_categories` master) is a future additive CR (§4.3). Not in v1.

---

## 20. Explicit non-goals

Kept out of CR-BE-SVC-01 regardless of convenience:

- **Implementing SERVICE pricing** (only PART 05 governs-then-later-realizes it;
  START GOVERNANCE implements nothing)
- Modifying completed **PRICE-01** MATERIAL pricing / lifecycle / override /
  deviation behavior (PART 05 keeps it byte-identical)
- Modifying **PRO-02** typed-lineage invariants or SERVICE shape CHECKs
- Introducing **quantity / UOM / item** into the SERVICE demand lineage
- A second price table; SERVICE price lives in `price_catalog_entries` by widening
- Absorbing `vendor_capabilities` into the catalog (link only)
- Building-level service master scoping
- A `service_catalogs` header/detail grouping
- Silent backfill / historical rewrite of free-text `service_type`
- A governed Service Category master in v1 (future, §4.3)
- UOM conversion, FX, contract management, scoring/weighted evaluation
- New schedulers; vendor-facing catalog endpoints
- KI-003 remediation (tracked separately)

---

## 21. Implementation readiness

| Question | Answer |
|---|---|
| Is the baseline verified? | Yes — inspection at `21ebcd4` on `arena/01a0324c-asentra-backend`; all cited migrations/modules/tests read directly; main HEAD matches expected |
| Is the "next capability" conclusion independently verified? | Yes — PRICE-01 B-01 + PRO-02 §7.2 + §2 grep evidence converge (§1) |
| Is the master shape decided? | Yes — one flat, Client-scoped, code-unique, category-classified, ACTIVE/INACTIVE `service_catalog` (§4); alternatives rejected with reasons |
| Is the code rule decided? | Yes — §5; grammar byte-identical to today's `service_type` (zero grammar migration friction) |
| Is Client/Building scope decided? | Yes — Client-scoped master; Building specialization on the price/vendor tier (§6) |
| Is the Vendor capability relationship decided? | Yes — optional governed link, fail-open match (§7) |
| Is the Service Request relationship decided? | Yes — nullable governed FK, free text retained (§8) |
| Is the lineage snapshot model decided? | Yes — additive nullable identity-only snapshots, shape CHECKs untouched (§9) |
| Is the PRICE-01 SERVICE subject model governed explicitly? | Yes — §10; far more than flipping `source_mode` (split exclusions, discriminated-union CHECK, no-UOM resolver/comparison/deviation) |
| Is the migration/adoption strategy decided? | Yes — §14; no backfill, additive nullable, fail-open match |
| Is lifecycle decided? | Yes — §11; ACTIVE/INACTIVE reference-master idiom, no DRAFT, no scheduler |
| Is RBAC decided? | Yes — §12; two codes, no `.override`, on `PLATFORM_ADMIN` |
| Is audit/isolation decided? | Yes — §13; `recordOperationalEvent` + AUDIT-01; Client-scoped |
| Are PARTs sequenced with tests and blockers? | Yes — §18 six PARTs, next migrations 0321–0325 |
| **PART 01 readiness** | **READY** — PART 01 (§18) may begin on this branch: migration `0321`, module `service-catalog`, two seed codes, focused suite `tests/service-catalog.test.ts` |
| Explicit exclusions from readiness | No SERVICE pricing before PART 05; no PRO-02/PRICE-01 modification; no OpenAPI/CI/broad-regression before their PARTs; no backfill; no historical rewrite |

---

## 22. Validation record for this stage

Governance-only stage. Per instructions, this stage did **not**: create
migrations, implement runtime code, create routes, change OpenAPI, run broad
regression, run CI, implement service pricing, backfill historical data, or
touch PRICE-01/PRO-02 behavior. Verification was repository inspection only
(git, grep, file reads); no database was migrated and no test suite was
executed.

Files changed in this stage: **`docs/CR-BE-SVC-01_START_GOVERNANCE.md`** (this
document) only.

STOP — START GOVERNANCE ends here. Implementation begins only at PART 01 under
this document's governance. No PR, no merge.

---

# PART 01 — Service Catalog Foundation (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** `0321_create_service_catalog` (next free: **0322**)

## P1.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0321_create_service_catalog.ts` — `service_catalog` table, Client-scoped `code UNIQUE (client_id, code)`, scope-FK `UNIQUE (id, client_id)` precedent (`0313`/`0319`), category/description/name/code CHECKs, ACTIVE/INACTIVE status, indexes |
| Module | `src/modules/service-catalog/` — types / errors / validation / repository / service / controller / routes / index, mounted in `src/routes/index.ts` immediately after the PRICE-01 router |
| Error codes | 5 `SERVICE_CATALOG_*` codes appended to `src/shared/errors.ts` |
| Permissions | `service_catalog.read`, `service_catalog.manage` seeded; both granted to `PLATFORM_ADMIN` (no `.override` — a reference master has no exceptional authority); catalogue 292 → **294** codes; `tests/helpers/access.ts` mirrors the default grant |
| Tests | `tests/service-catalog.test.ts` — 13 focused tests in 5 suites, self-provisioning embedded PostgreSQL (port 55501) |
| Routes (internal only) | `POST/GET /service-catalog/entries`, `GET /service-catalog/entries/{id}`, `PATCH /service-catalog/entries/{id}`, `POST .../{id}/deactivate` |

## P1.2 Model as implemented (§4/§5 realized)

- **Client-scoped reference master** — the SERVICE analog of `inventory_items`
  (`0166`): `client_id NOT NULL REFERENCES clients`, `code UNIQUE (client_id,
  code)`. `UNIQUE (id, client_id)` follows the `0313`/`0319` scope-FK precedent
  so future child rows (service_requests, price entries, lineage snapshots)
  can prove Client scope structurally when they reference this master.
- **Code grammar** — `code ~ '^[A-Z][A-Z0-9_-]*$'`, 2–64 chars, normalized to
  uppercase at write time (`normalizeServiceCatalogCode`). Byte-identical to
  the existing `service_request.service_type` validation pattern → today's
  accepted free-text codes are valid catalog codes with zero grammar friction
  (the migration bridge).
- **Classification** — free `category TEXT NOT NULL` (the `skills` `0025`
  precedent); no governed Service-Category master in v1 (§4.3 future).
- **Lifecycle** — `ACTIVE` / `INACTIVE` only (reference-master idiom), **not**
  the price catalog's DRAFT/ACTIVE/INACTIVE. Created `ACTIVE`; no scheduler;
  no effective window on the master (commercial windows live on the price
  entry, PRICE-01 §4.2).
- **No demand/price/quantity/UOM surface** — the table is identity only; it
  creates no Service Request, RFQ, quotation, PO, commitment, price, quantity,
  or UOM behavior.

## P1.3 Lifecycle as implemented (§11 realized)

- `create` — validates Client exists + ACTIVE, asserts caller Client access,
  pre-checks code uniqueness, inserts ACTIVE, records
  `SERVICE_CATALOG_ENTRY_CREATED` transaction-atomically; concurrent duplicate
  caught at the `UNIQUE (client_id, code)` constraint → 409.
- `update` (PATCH) — editable non-identity fields only (`name`, `description`,
  `category`); `code` and `clientId` immutable; `status` not editable here;
  records `SERVICE_CATALOG_ENTRY_UPDATED`. **Recorded decision:** `code` in a
  PATCH body is a governed 400 (`VALIDATION_ERROR`) rather than a silent
  ignore, so immutability is a messageable outcome.
- `deactivate` — `ACTIVE → INACTIVE` terminal; re-deactivation is a governed
  409 `SERVICE_CATALOG_NOT_ACTIVE`. **Recorded decision:** there is **no
  reactivation lane in v1** (governance §11 "terminal"); INACTIVE rows are
  retained for history and stay queryable by in-scope callers. Because
  `UNIQUE (client_id, code)` spans all rows, a deactivated code is never
  silently reused — recovery is a future governed reactivation decision, not
  an implicit status toggle.
- No DELETE exists anywhere; no UPDATE of `code`/`clientId`/`status` outside
  the governed deactivate path.

## P1.4 Client isolation as proven (§6/§13 realized)

- Catalog entries are Client-scoped (no `building_id`); isolation is
  per-Client via `contextAccessService.canAccessClient` (a user reaches a
  Client through their building assignments).
- Writes and single reads: `assertClientAccess` → 403
  `BUILDING_ACCESS_DENIED` when the caller cannot reach the entry's Client.
- Lists are bound to `getAccessibleClientIds(actor)`; an out-of-reach
  `clientId` filter returns an empty page (no existence oracle, no-leak
  posture — same as PRICE-01 PART 01).
- A caller can never mint or widen a Client scope they cannot reach
  (cross-Client create → 403).

## P1.5 Uniqueness / concurrency as proven

- Duplicate `code` within one Client → 409 `SERVICE_CATALOG_CODE_ALREADY_EXISTS`
  (pre-check + DB `UNIQUE (client_id, code)` race-catch).
- Same `code` across different Clients → 201 (Client scoping is correct).
- Invalid code grammar / status / blank name rejected at the DB CHECK even
  bypassing the API (direct-INSERT guards).
- Concurrent create of the same `(client_id, code)` settles exactly one 201 +
  one 409 (constraint-mediated).

## P1.6 RBAC as implemented (§12 realized)

- Two codes only: `service_catalog.read` (reads/lookup), `service_catalog.manage`
  (create/update/deactivate). Both granted to `PLATFORM_ADMIN` by default (no
  `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` entry — a reference master has no
  exceptional authority; that risk class belongs to the price window via
  PRICE-01's unassigned-by-default `price_catalog.override`).
- `.manage` does not imply any price authority; `price_catalog.*` codes are
  separate and unchanged. `.read` does not imply `.manage`.
- Permission matrix: plain session → 403 everywhere; `service_catalog.read`
  alone → cannot create/update/deactivate; unauthenticated → 401.
- Seed contracts: both codes exist and are granted to `PLATFORM_ADMIN`;
  `tests/seeds.test.ts` passes unchanged (dynamic length assertions).

## P1.7 Audit as implemented (§13 realized)

Through `recordOperationalEvent` (AUDIT-01 HTTP correlation; sensitive-key
scrubber in place), in the **same transaction** as the mutation:
`SERVICE_CATALOG_ENTRY_CREATED`, `SERVICE_CATALOG_ENTRY_UPDATED`,
`SERVICE_CATALOG_ENTRY_DEACTIVATED` (`entity_type = SERVICE_CATALOG_ENTRY`,
`entity_id` = entry id). Metadata carries code/name/category/status/clientId
for traceability — nothing sensitive (catalog rows carry no commercial or
credential data).

## P1.8 Targeted validation evidence (PART 01 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/service-catalog.test.ts` (13 tests / 5 suites, port 55501) | 13/13 pass |
| `tests/seeds.test.ts` (permission/seed contract — directly affected) | 1/1 pass |
| `git diff --check` | clean |

Suites run self-provisioned (embedded PostgreSQL, suite-isolated port 55501)
with no local server dependency. No CI run; KI-003 untouched; no broad
regression executed (per scope). SERVICE pricing, Service Request
integration, Vendor capability linking, RFQ/quotation/PO linkage, and
OpenAPI are all deliberately out of scope for PART 01.

## P1.9 Files changed in PART 01

- `src/database/migrations/0321_create_service_catalog.ts` (new)
- `src/database/migrations/index.ts` (register 0321)
- `src/modules/service-catalog/` (new module, 8 files)
- `src/routes/index.ts` (import + mount)
- `src/shared/errors.ts` (5 codes)
- `src/database/seeds/foundation-access.seed.ts` (2 codes)
- `tests/helpers/access.ts` (default-grant mirror: read/manage)
- `tests/service-catalog.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (these notes)

## P1.10 PART 02 readiness

**READY.** PART 02 (Service Request governed anchor) may build directly on this
foundation:

- The master exists and is Client-scoped with a stable immutable code and
  `UNIQUE (id, client_id)` scope-FK target; PART 02 adds a **nullable**
  `service_catalog_id` (+ composite `(service_catalog_id, client_id)` scope
  FK) on `service_requests`, keeping the free `service_type` string required
  and NOT NULL for back-compat (no backfill, no breaking change — governance
  §8/§14).
- The governed anchor is opt-in; existing service requests keep their free-text
  label; a Client may policy-require the FK once its catalog is populated.
- No migration is expected to touch the catalog itself; the next free
  migration number is **0322**.
- DoD additions expected: additive nullable FK, same-Client + ACTIVE
  validation, free-text/code consistency check, back-compat (free-text still
  works), and isolation unchanged.

---

# PART 02 — Service Request Catalog Adoption (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** `0322_add_service_request_catalog_anchor` (next free:
**0323**)

## P2.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0322_add_service_request_catalog_anchor.ts` — nullable `service_catalog_id` on `service_requests`, composite Client-scoped FK `(service_catalog_id, client_id) → service_catalog (id, client_id)` (the `0313`/`0319` scope-FK precedent), partial index |
| Service Request module | `src/modules/service-requests/` — types/errors/validation/repository/service carry the additive anchor end-to-end; governed create/update adoption; `serviceCatalogId` exposed on every read |
| Error codes | 4 `SERVICE_REQUEST_CATALOG_*` codes appended to `src/shared/errors.ts` |
| Tests | `tests/service-request-catalog-adoption.test.ts` — 13 focused tests in 3 suites (embedded PG port 55502) |
| Directly affected test | `tests/service-requests.test.ts` — one additive key (`serviceCatalogId`) added to `PUBLIC_SERVICE_REQUEST_KEYS`; no assertion weakened |

## P2.2 Schema as implemented (additive only)

- `service_requests.service_catalog_id UUID` — **nullable**; NULL = free-text
  only (historical / un-governed requests). Existing rows keep working exactly
  as before.
- The free-text `service_type` column is **retained, NOT NULL, unchanged** —
  never removed, renamed, grammar-changed, or rewritten.
- Composite FK `(service_catalog_id, client_id) REFERENCES service_catalog (id,
  client_id)` — a governed anchor proves Client scope **structurally**; a NULL
  anchor simply does not participate. Verified by a direct cross-Client INSERT
  guard (rejected) and a same-Client INSERT (accepted).

## P2.3 Adoption behavior (create + update)

Governed validation fires **only when `service_catalog_id` is supplied**
(governance §8 / COMPATIBILITY). The anchor must, in order:

1. resolve to an existing catalog entry → 404 `SERVICE_REQUEST_CATALOG_NOT_FOUND`
2. belong to the same Client as the request → 400 `SERVICE_REQUEST_CATALOG_CLIENT_MISMATCH`
3. be `ACTIVE` → 400 `SERVICE_REQUEST_CATALOG_INACTIVE`
4. have `code` equal to the request's (normalized) `service_type` → 400
   `SERVICE_REQUEST_CATALOG_CODE_MISMATCH`

On **update**, consistency uses the *effective* `service_type` (the new value if
`serviceType` is also being changed, else the existing one), so a combined
`serviceType` + `serviceCatalogId` change is validated against the new pair.
A supplied `null` clears the anchor (no validation). When `service_catalog_id`
is **not** supplied, the existing anchor is untouched and no consistency check
runs — `serviceType`-only changes on an anchor-less request behave exactly as
before PART 02 (verified).

## P2.4 Compatibility behavior (proven)

- A request created/updated **without** `serviceCatalogId` resolves to a NULL
  anchor and works byte-identically to pre-PART-02 behavior (free-text
  `serviceType`, lowercase normalization, all existing fields).
- **Historical rows** inserted directly with no anchor are readable and
  updatable exactly as before (OPEN rows still editable).
- `serviceType` is **never rewritten**: when an anchor is supplied the catalog
  `code` must already equal the supplied `serviceType`; nothing is inferred or
  auto-created.
- The additive `serviceCatalogId` field appears on every public read (single,
  list, create, update) without widening or weakening any existing field.

## P2.5 Client isolation / lifecycle validation

- The catalog is resolved within the request's existing **Client/Building
  context**: `client_id`/`building_id` stay derived from the Purchase Request
  (create) or immutable (update). A cross-Client catalog is rejected at the
  service layer (400) and again structurally by the composite FK (DB guard).
- An **INACTIVE** catalog cannot be assigned to a new or changed request (400)
  — governed lifecycle (PART 01 §11) is enforced at adoption time. (A request
  that already references a catalog which is later deactivated keeps its
  anchor for historical fidelity; deactivation is soft and references are
  preserved — PART 01 retention posture.)

## P2.6 Audit behavior

Service Request has **no existing operational-event audit authority**
(verified: `recordOperationalEvent` is not used by the module). Per the
instruction ("audit … where required by existing Service Request audit
authority"), **no new audit authority was introduced** in PART 02 — the
catalog assignment/change is governed by the same validation + DB FK as the
rest of the request, and existing Service Request behavior is preserved. No
parallel audit channel was created.

## P2.7 Targeted validation evidence (PART 02 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/service-request-catalog-adoption.test.ts` (13 tests / 3 suites, port 55502) | 13/13 pass |
| `tests/service-requests.test.ts` (directly affected existing suite) | 26/26 pass |
| `tests/service-catalog.test.ts` (PART 01 sanity — catalog module reused, unchanged) | 13/13 pass |
| `git diff --check` | clean |

Suites run self-provisioned (embedded PostgreSQL) with no local server
dependency. No CI run; KI-003 untouched; no broad regression executed.
Vendor capabilities, RFQ/quotation/comparison/award/PO behavior, SERVICE
pricing, OpenAPI, and backfill are all deliberately out of scope for PART 02.

## P2.8 Files changed in PART 02

- `src/database/migrations/0322_add_service_request_catalog_anchor.ts` (new)
- `src/database/migrations/index.ts` (register 0322)
- `src/modules/service-requests/service-request.types.ts` (additive anchor
  field on record / public / create / new / update inputs)
- `src/modules/service-requests/service-request.repository.ts` (select / map /
  insert / details / update carry the column)
- `src/modules/service-requests/service-request.validation.ts` (parse optional
  anchor on create + update)
- `src/modules/service-requests/service-request.service.ts` (governed anchor
  resolution on create + update; public mapping)
- `src/modules/service-requests/service-request.errors.ts` (4 catalog errors)
- `src/shared/errors.ts` (4 codes)
- `tests/service-requests.test.ts` (one additive expected key — exact stale
  assertion updated, not weakened)
- `tests/service-request-catalog-adoption.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (these notes)

## P2.9 PART 03 readiness

**READY.** PART 03 (Vendor capability governed link) may build on this
foundation:

- The governed `service_catalog` master is referenced and proven as a
  Client-scoped, ACTIVE-validated, code-consistent anchor.
- PART 03 adds an optional nullable `service_catalog_id` on
  `vendor_capabilities` (Vendor-scoped; the governed link) and an optional
  snapshot on `vendor_selection_readiness`, with governed matching
  (identity when both sides cite a governed service, else normalized-code
  fallback — fail-open to today's behavior). The next free migration number
  is **0323**.
- DoD additions expected: additive nullable link, governed match vs fallback,
  eligibility behavior unchanged when no link, isolation unchanged.

---

# PART 03 — Vendor Capability Service Identity Adoption (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** `0323_add_vendor_capability_service_identity` (next free:
**0324**)

## P3.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0323_add_vendor_capability_service_identity.ts` — nullable `service_catalog_id` on `vendor_capabilities` (plain FK; the table carries no `client_id`, so Client scope is enforced at the service layer via the Vendor) and on `vendor_selection_readiness` (composite scope-FK `(service_catalog_id, client_id)`, the `0313`/`0319`/`0322` precedent); partial index |
| Vendor Capability module | `src/modules/vendor-capabilities/` — types/errors/validation/repository/service carry the additive link; governed create/update/read; `serviceCatalogId` exposed |
| Vendor Selection Readiness module | `src/modules/vendor-selection-readiness/` — governed demand identity snapshot + the governed matching precedence; `serviceCatalogId` exposed |
| Error codes | 3 `VENDOR_CAPABILITY_CATALOG_*` codes appended to `src/shared/errors.ts` |
| Tests | `tests/vendor-capability-identity.test.ts` — 14 tests / 2 suites (embedded PG port 55503) proving all 8 required proofs |
| Directly affected test | `tests/vendor-capabilities.test.ts` — one additive key (`serviceCatalogId`) added to `PUBLIC_CAPABILITY_KEYS`; no assertion weakened |

## P3.2 Schema as implemented (additive only)

- `vendor_capabilities.service_catalog_id UUID` — **nullable**, plain FK to
  `service_catalog(id)`. The existing `code` column is retained, NOT NULL,
  unchanged — never removed, renamed, or rewritten. `vendor_capabilities`
  carries no `client_id` (Client is derived through the Vendor), so the
  composite scope-FK pattern is not applicable here; Client scope (catalog
  belongs to the Vendor's Client) is enforced in the service layer — consistent
  with how the module already validates Vendor relationships.
- `vendor_selection_readiness.service_catalog_id UUID` — **nullable** snapshot
  of the request's governed demand identity at evaluation time (paralleling the
  existing `service_type` snapshot). This table DOES carry `client_id`, so the
  composite scope-FK `(service_catalog_id, client_id) → service_catalog(id,
  client_id)` applies.

## P3.3 Vendor capability adoption

When `service_catalog_id` is supplied (create or update), the link must:

1. resolve to an existing catalog entry → 404 `VENDOR_CAPABILITY_CATALOG_NOT_FOUND`
2. belong to the Vendor's Client → 400 `VENDOR_CAPABILITY_CATALOG_CLIENT_MISMATCH`
3. be `ACTIVE` for a new/changed assignment → 400 `VENDOR_CAPABILITY_CATALOG_INACTIVE`

The capability `code` is **never rewritten** (it is immutable). The governed
link is the new authority for governed matching; the legacy `code` is preserved
unchanged. A supplied `null` clears the link. Existing/legacy capabilities keep
a NULL link and behave exactly as before.

## P3.4 Readiness identity propagation

- `RequestContext` gains `serviceCatalogId` (the request's governed anchor),
  resolved from `service_requests.service_catalog_id` for `SERVICE_REQUEST`
  (PART 02) and `null` for `PURCHASE_REQUEST` (purchase requests carry no
  governed service identity).
- The evaluation snapshots `service_catalog_id` into the readiness row
  alongside the existing `service_type` snapshot (governed demand identity of
  record at evaluation time).

## P3.5 Exact matching precedence (the critical rule)

`capabilityMatches(cap, target)` implements governance §7 / the PART 03
MATCHING RULE:

```
if cap is not ACTIVE → false
if BOTH target.serviceCatalogId and cap.serviceCatalogId are set
    → return target.serviceCatalogId === cap.serviceCatalogId   // ID-only, NO string fallback
else
    → return cap.code === target.serviceType                    // legacy normalized-code equality
```

Proven by the 8 required proofs (P3.8). The decisive case (#2): a capability
whose `code` matches the demand `serviceType` but whose governed
`serviceCatalogId` **differs** → `capabilityMatch = false` (NOT_READY), with
**no** fallback to the matching legacy codes. A governed identity mismatch is
never silently converted into a legacy match. One-sided adoption falls back to
normalized-code equality (no inventing, no auto-linking); neither-governed is
byte-identical to pre-PART-03 behavior.

## P3.6 Legacy compatibility / lifecycle

- Legacy capabilities (NULL link) and legacy/un-governed requests match on
  normalized code exactly as before (proven: legacy↔legacy READY, and the full
  existing 13-suite selection suite passes unchanged).
- A governed capability link survives a later catalog **deactivation** (soft;
  PART 01 retention): the capability stays readable with its link intact
  (proven #7). Only NEW/CHANGED assignments against an INACTIVE catalog are
  rejected (proven #6).
- **No automatic backfill or linking**: legacy capabilities keep a NULL link
  even when a matching catalog exists (proven #8 — verified at the DB level).

## P3.7 Client isolation

- Catalog Client scope on the Vendor-capability link is enforced at the service
  layer: `catalog.clientId === vendor.clientId` (cross-Client → 400, proven #5).
- The readiness snapshot's composite scope-FK structurally prevents a
  cross-Client catalog reference at the DB level too.
- The existing Client/Building isolation of readiness evaluation (Vendor must be
  in the request's Client; Building access asserted) is unchanged.

## P3.8 Targeted validation evidence (PART 03 scope; no broad regression)

All 8 required proofs are explicitly covered:

| # | Proof | Result |
|---|---|---|
| 1 | governed ID match = eligible (READY) | pass |
| 2 | governed ID mismatch = NOT eligible even when legacy codes match (NOT_READY) | pass |
| 3 | legacy↔legacy unchanged (match + non-match) | pass |
| 4 | one-sided adoption follows governance (string fallback; codes differ → not eligible) | pass |
| 5 | cross-Client catalog rejected | pass |
| 6 | INACTIVE catalog cannot be newly assigned | pass |
| 7 | historical anchored capability remains readable after deactivation | pass |
| 8 | no automatic backfill/linking | pass |

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/vendor-capability-identity.test.ts` (14 tests / 2 suites, port 55503) | 14/14 pass |
| `tests/vendor-capabilities.test.ts` (directly affected existing suite) | pass (all) |
| `tests/vendor-selection-readiness.test.ts` (directly affected existing suite) | pass (all) |
| `git diff --check` | clean |

44 existing tests across the two directly affected suites pass. No CI run;
KI-003 untouched; no broad regression executed. RFQ/quotation/comparison/award/
PO behavior is unchanged beyond the readiness identity propagation governed
for PART 03; SERVICE pricing and OpenAPI are out of scope.

## P3.9 Files changed in PART 03

- `src/database/migrations/0323_add_vendor_capability_service_identity.ts` (new)
- `src/database/migrations/index.ts` (register 0323)
- `src/modules/vendor-capabilities/` — types/errors/validation/repository/service
  carry the governed link end-to-end
- `src/modules/vendor-selection-readiness/` — types/repository/service carry the
  governed identity snapshot + matching precedence
- `src/shared/errors.ts` (3 codes)
- `tests/vendor-capabilities.test.ts` (one additive expected key — exact stale
  assertion updated, not weakened)
- `tests/vendor-capability-identity.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (these notes)

## P3.10 PART 04 readiness

**READY.** PART 04 (SERVICE lineage identity snapshots) may build on this
foundation:

- The governed `service_catalog` identity is now adopted by Service Requests
  (PART 02) and Vendor capabilities (PART 03), and propagated through Vendor
  Selection Readiness with the governed matching precedence proven.
- PART 04 adds additive nullable `source_service_id` (or analogous) snapshots
  on `rfq_lines`, `vendor_quotation_lines`, and `purchase_order_lines` for
  SERVICE traceability — identity only, never introducing item/UOM/quantity
  (PRO-02/R2P-01 SERVICE shape invariants stay byte-identical). The next free
  migration number is **0324**.
- DoD additions expected: additive nullable identity snapshots, frozen at
  creation/commit, NULL when no governed anchor, SERVICE shape CHECKs
  unchanged, no price/quantity/UOM behavior.

---

# PART 04 — SERVICE Procurement Lineage Identity (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** `0324_add_service_lineage_identity` (next free:
**0325**)

## P4.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0324_add_service_lineage_identity.ts` — additive nullable `source_service_id` on `rfq_lines` (composite scope FK + mode CHECK), `vendor_quotation_lines` (plain FK + mode CHECK), and `purchase_order_lines` (composite scope FK + request-type CHECK); partial indexes |
| RFQ module | `rfq.service.ts`/`.repository.ts`/`.types.ts` — `ServiceSource` carries the SR `serviceCatalogId`; SERVICE `resolveLine` snapshots `sourceServiceId`; column in select/map/insert |
| Vendor quotation module | `vendor-quotation.*` — `RfqLineSource` carries `sourceServiceId`; `resolveLineInput` propagates it; line select/map/insert carry it (frozen; Vendor cannot set it) |
| RFQ→PO conversion | `rfq-po-conversion.service.ts` — `loadConversionLines` reads `source_service_id`; the PO line carries it through provenance |
| Purchase orders | `purchase-order-line.*` + `purchase-order-line.service.ts` — PO line carries `sourceServiceId`; `resolveServiceRequestLine` snapshots `request.serviceCatalogId`, `resolveMaterialRequestLine` returns NULL |
| Tests | `tests/service-lineage-identity.test.ts` — 7 tests / 4 suites (embedded PG port 55504) proving all 8 required proofs |
| Directly affected tests | none required an assertion change — all additive fields; no shape-key assertions existed |

## P4.2 Schema as implemented (additive, identity-only)

- `source_service_id` is **nullable** on all three tables. Historical rows keep
  NULL and behave exactly as before. No backfill, no auto-mapping.
- **SERVICE identity ONLY**: a DB CHECK forbids a non-NULL `source_service_id`
  on MATERIAL rows (`rfq_lines`/`vendor_quotation_lines`: `source_mode <>
  'MATERIAL'`; `purchase_order_lines`: `request_line_type <>
  'MATERIAL_REQUEST'`). MATERIAL lineage is byte-identical.
- **No item/UOM/quantity introduced for SERVICE**: the existing PRO-02 /
  R2P-01 SERVICE shape CHECKs are untouched — `source_service_id` is an
  identity snapshot, independent of the shape constraints.
- Scope-FK precedent (`0313`/`0319`/`0322`): composite
  `(source_service_id, client_id)` on `rfq_lines` and `purchase_order_lines`
  (both carry `client_id`); plain FK on `vendor_quotation_lines` (no
  `client_id` column — Client scope is inherited via the client-scoped
  `rfq_line_id`, and the identity is snapshotted from a client-scoped line).

## P4.3 Lineage propagation (proven end-to-end)

```
Service Request (service_catalog_id)
   └─► rfq_lines.source_service_id          (resolveLine SERVICE branch)
        └─► vendor_quotation_lines.source_service_id   (resolveLineInput, frozen)
             └─► purchase_order_lines.source_service_id  (RFQ→PO conversion + provenance)
```

- **SR → RFQ line**: a governed SERVICE RFQ line derives `source_service_id`
  from the Service Request's `serviceCatalogId` (PART 02). NULL when the
  request is un-governed.
- **RFQ → quotation line/revision**: the quotation line propagates the RFQ
  line's identity; the Vendor **cannot** set it (it is derived, not in the
  line input). Frozen once SUBMITTED.
- **Award → PO line**: the RFQ→PO conversion reads `rfq_lines.source_service_id`
  and freezes it onto the PO line through the award/provenance chain (the
  identity reaches the PO line joined via `rfq_award_po_line_provenance`).
- The manual PO-line add path (`resolveServiceRequestLine`) also snapshots
  `request.serviceCatalogId` for direct (non-RFQ) SERVICE PO lines.

## P4.4 SERVICE shape preservation (proven)

Every SERVICE lineage row keeps the PRO-02/R2P-01 shape: `source_item_id`/
`item_id` NULL, `source_uom_id`/`uom_id` NULL, `quantity_snapshot` NULL.
`source_service_id` is identity-only. Verified at the RFQ line, quotation line,
and PO line in the suite. The new mode CHECKs make a MATERIAL row carrying a
service identity structurally impossible.

## P4.5 MATERIAL compatibility (proven)

A MATERIAL RFQ line keeps `source_service_id` NULL and retains the full
MATERIAL shape (`item_id`, `uom_id`, `quantity_snapshot` populated). The 70-test
directly-affected RFQ/quotation/comparison/award/PO suite passes unchanged.

## P4.6 Isolation / history behavior (proven)

- **Cross-Client injection is structurally impossible**: a direct cross-Client
  `source_service_id` write to `rfq_lines` is rejected by the composite scope FK
  (proven by a DB guard). The identity is never caller-widenable — it is derived
  from the (client-scoped) Service Request / RFQ line, never accepted from the
  caller.
- **Historical NULL identity remains valid**: an un-governed SERVICE request's
  lineage has NULL `source_service_id` at every stage; the RFQ still opens and
  the chain works.
- **No auto-backfill/linking**: even when a matching catalog exists, an
  un-governed request's lineage stays NULL (verified at the DB level).

## P4.7 Targeted validation evidence (PART 04 scope; no broad regression)

All 8 required proofs are explicitly covered:

| # | Proof | Result |
|---|---|---|
| 1 | governed Service Request identity reaches RFQ line | pass |
| 2 | RFQ identity reaches quotation line/revision | pass |
| 3 | awarded SERVICE identity reaches RFQ→PO provenance/PO line | pass |
| 4 | MATERIAL rows unchanged (NULL identity + full MATERIAL shape) | pass |
| 5 | SERVICE rows have no item/UOM/quantity | pass |
| 6 | historical NULL identity remains valid | pass |
| 7 | cross-Client identity injection impossible | pass |
| 8 | no auto-backfill/linking | pass |

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/service-lineage-identity.test.ts` (7 tests / 4 suites, port 55504) | 7/7 pass |
| `tests/rfqs.test.ts` (directly affected) | pass (all) |
| `tests/vendor-quotations.test.ts` (directly affected) | pass (all) |
| `tests/rfq-comparisons.test.ts` (directly affected) | pass (all) |
| `tests/rfq-comparison-reference-price.test.ts` (directly affected) | pass (all) |
| `tests/rfq-po-conversions.test.ts` (directly affected) | pass (all) |
| `tests/rfq-recommendations-awards.test.ts` (directly affected) | pass (all) |
| `tests/purchase-order-lines.test.ts` / `purchase-orders.test.ts` / `purchase-order-issuance.test.ts` / `purchase-order-price-deviation.test.ts` (directly affected) | pass (all) |
| `git diff --check` | clean |

100 directly affected existing tests pass across the RFQ/quotation/comparison/
award/PO chain (no assertion changes needed — all additive fields). No CI run;
KI-003 untouched; no broad regression executed. PRICE-01 SERVICE pricing, the
PRICE-01 resolver, OpenAPI, and SERVICE pricing are all out of scope (PART 05).

## P4.8 Files changed in PART 04

- `src/database/migrations/0324_add_service_lineage_identity.ts` (new)
- `src/database/migrations/index.ts` (register 0324)
- `src/modules/rfqs/` — `rfq.service.ts` (`ServiceSource` + `loadServiceSource` +
  `resolveLine`), `rfq.repository.ts` (select/map/insert), `rfq.types.ts`
  (`sourceServiceId`)
- `src/modules/vendor-quotations/` — `vendor-quotation.service.ts`
  (`RfqLineSource` + load + `resolveLineInput`), `vendor-quotation.repository.ts`
  (select/map/insert), `vendor-quotation.types.ts` (`sourceServiceId`)
- `src/modules/rfq-po-conversions/rfq-po-conversion.service.ts`
  (`ConversionLine` + `loadConversionLines` + PO line creation)
- `src/modules/purchase-orders/` — `purchase-order-line.repository.ts`
  (select/insert), `purchase-order-line.service.ts` (resolve functions),
  `purchase-order-line.types.ts` (`sourceServiceId`)
- `tests/service-lineage-identity.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (these notes)

## P4.9 PART 05 readiness

**READY.** PART 05 (PRICE-01 SERVICE price subject widening) may now build on
the complete governed SERVICE identity:

- The governed `service_catalog` identity is adopted end-to-end (Service
  Request PART 02, Vendor capability PART 03, full procurement lineage PART 04),
  so a SERVICE price entry's `service_id` FK would point at a populated,
  referenced master.
- PART 05 widens `price_catalog_entries` to admit SERVICE: nullable `service_id`
  (+ scope FK), `source_mode` CHECK widened, a discriminated-union shape CHECK,
  **split** partial exclusion constraints (MATERIAL/SERVICE have genuinely
  different identity keys — SERVICE has no UOM), and a no-UOM
  resolver/comparison/PO-deviation branch. MATERIAL PRICE-01 behavior stays
  byte-identical (governance §10).
- The next free migration number is **0325**.

---

# PART 05 — SERVICE Reference Price Activation (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** `0325_activate_service_reference_price` (next free:
**0326**)

## P5.1 What was built

| Surface | Artifact |
|---|---|
| Migration | `src/database/migrations/0325_activate_service_reference_price.ts` — `price_catalog_entries` SERVICE widening (`service_id`, `source_mode` CHECK widened, `item_id`/`uom_id` nullable, discriminated-union `subject_shape_check`, composite service scope-FK, **split** MATERIAL/SERVICE ACTIVE-window exclusions, SERVICE resolution index) + `rfq_comparison_lines` mode-aware reference-shape CHECK |
| Price Catalog module | `price-catalog-entry.*` + `price-catalog-lookup.*` — SERVICE subject (serviceId + currency, no item/UOM/quantity); mode-dispatched resolver; split-exclusion overlap detection; mode-aware create/replace/validate/lookup/list |
| RFQ comparison | `rfq-comparison.service.ts` — governed SERVICE `resolveLineReference` (resolves a SERVICE reference; unit-only advisory, NULL reference total/variance); un-governed SERVICE stays NOT_REQUESTED |
| PO price deviation | `purchase-order-price-deviation.service.ts` — governed SERVICE deviation (unit-only) |
| Tests | `tests/service-reference-price.test.ts` — 6 tests / 2 suites (embedded PG port 55505) |
| Directly affected tests | 4 exact stale assertions updated (SERVICE DB guard → `subject_shape_check`; 3 AMBIGUOUS-path constraint names → `material_window_exclusion`); no assertion weakened |

## P5.2 SERVICE subject model realized (§10)

`price_catalog_entries` now admits both modes by a discriminated union enforced
structurally:

```
MATERIAL ⇒ item_id + uom_id NOT NULL, service_id NULL   (item priced per UOM)
SERVICE  ⇒ service_id NOT NULL, item_id + uom_id NULL   (service priced per 1)
```

`source_mode` CHECK widened to `IN ('MATERIAL','SERVICE')`. SERVICE has **no
item, no UOM, no quantity** — the unit price is the service amount.

## P5.3 Split exclusion (the key structural decision)

The single ACTIVE-window exclusion was **split** into two mode-scoped partials:

- `material_window_exclusion`: `(client, item, uom, currency, building, vendor, window)` `WHERE status='ACTIVE' AND source_mode='MATERIAL'`
- `service_window_exclusion`: `(client, service, currency, building, vendor, window)` `WHERE status='ACTIVE' AND source_mode='SERVICE'` — **no uom**

MATERIAL pricing stays **byte-identical**: the MATERIAL constraint is the old
one narrowed by an additive `source_mode='MATERIAL'` qualifier that excludes
zero rows today (proven by the full PRICE-01 PART 01–05 suite). The
`isExclusionOverlap` detector recognizes both new names (plus the legacy name
for safety).

## P5.4 Resolver extension (§8/§10)

`lookupPriceCatalogEntry` takes a discriminated input and branches:

- **MATERIAL**: exact current logic (item + UOM + currency); outcomes
  `MATCHED/NO_REFERENCE_PRICE/UOM_INCOMPATIBLE/CURRENCY_INCOMPATIBLE/AMBIGUOUS`.
- **SERVICE**: `serviceId + currency`, **no UOM**; outcomes
  `MATCHED/NO_REFERENCE_PRICE/CURRENCY_INCOMPATIBLE/AMBIGUOUS` (no
  `UOM_INCOMPATIBLE` — SERVICE has no UOM). Same fixed tier precedence and
  fail-closed AMBIGUOUS trip.

Scope precedence (Vendor+Building → Vendor → Building → Client-wide) is reused
unchanged for both modes.

## P5.5 Comparison + PO-deviation SERVICE advisory (§12/§13)

- **Comparison**: a governed SERVICE line (`rfq_lines.source_service_id` set,
  PART 04) resolves a SERVICE reference at run creation; the snapshot is
  **unit-only** — `reference_uom_id`, `reference_total`, `total_variance` are
  **NULL** (SERVICE has no governed quantity), while `unit_variance`,
  `variance_percent`, `position` are present. Un-governed SERVICE lines stay
  `NOT_REQUESTED` (no inference/backfill). The comparison shape CHECK was
  relaxed to be mode-aware to accept this.
- **PO price deviation**: a governed SERVICE PO line (`source_service_id` set)
  resolves a unit-only SERVICE advisory; otherwise `NOT_REQUESTED`.
- **No reference total / total variance for SERVICE** (no governed quantity) —
  proven end-to-end through the real comparison API.

## P5.6 Compatibility / isolation / history

- MATERIAL behavior byte-identical (PART 01–05 PRICE-01 suites all pass).
- Historical NULL SERVICE identity → `NOT_REQUESTED`/`NO_REFERENCE_PRICE`
  (no inference/backfill from service_type — proven).
- Cross-Client catalog rejected (composite `(service_id, client_id)` scope-FK
  + service-layer validation). No FX, no pricing gate, no commitment change.

## P5.7 Targeted validation evidence (PART 05 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/service-reference-price.test.ts` (6 / 2 suites, port 55505) | 6/6 pass |
| PRICE-01 price-catalog suites (PART 01/02/03/05/06-OpenAPI) | 57/57 pass |
| PRICE-01 comparison + PO-deviation integration (PART 04/06) | 18/18 pass |
| rfqs / rfq-comparisons / rfq-po-conversions / purchase-order-lines | 34/34 pass |
| SVC-01 PART 01–04 suites (regression) | 47/47 pass |
| `git diff --check` | clean |

4 exact stale assertions updated (no weakening). No CI run; KI-003 untouched;
no broad regression executed. OpenAPI remains MATERIAL-only in the spec
(lands in PART 06) — the spec-pinning OpenAPI test passes unchanged.

## P5.8 Files changed in PART 05

- `src/database/migrations/0325_activate_service_reference_price.ts` (new)
- `src/database/migrations/index.ts` (register 0325)
- `src/modules/price-catalog-entries/` — `price-catalog-entry.types.ts`,
  `.repository.ts`, `.service.ts`, `.validation.ts`,
  `price-catalog-lookup.types.ts`, `price-catalog-lookup.service.ts`
- `src/modules/rfq-comparisons/rfq-comparison.service.ts`
- `src/modules/purchase-orders/purchase-order-price-deviation.service.ts`
- `tests/price-catalog-entries.test.ts`, `tests/price-catalog-selection.test.ts`,
  `tests/rfq-comparison-reference-price.test.ts`,
  `tests/purchase-order-price-deviation.test.ts` (exact stale assertions)
- `tests/service-reference-price.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (these notes)

## P5.9 PART 06 readiness

**READY.** The governed SERVICE reference-price authority is live end-to-end
(create/resolve/comparison/PO-deviation), closing START GOVERNANCE blocker
B-01. PART 06 (Read API + OpenAPI + Closure) documents the now-widened
surface: the `sourceMode`/`serviceId` request/response fields on
`/price-catalog/entries` and `/price-catalog/lookup`, the SERVICE resolver
outcomes, and the SERVICE comparison/deviation reference shape — pinning the
runtime enums (now `MATERIAL`+`SERVICE`) against the OpenAPI spec. The next
free migration number is **0326** (no schema change expected for PART 06).

---

# PART 06 — Read API + OpenAPI + Closure (implementation notes)

**Status:** complete
**Branch:** `arena/01a0324c-asentra-backend`
**Migration consumed:** none (next free remains **0326**) — documentation-only
PART

## P6.1 What was documented

This PART is OpenAPI + closure only: no migration, no runtime change, no
backfill, no UOM/quantity for SERVICE, no MATERIAL behavior change.

| Surface | Documentation |
|---|---|
| Service Catalog API (PART 01) | New paths `POST/GET /service-catalog/entries`, `GET/PATCH /service-catalog/entries/{id}`, `POST .../{id}/deactivate`; schemas `ServiceCatalogEntry`, `CreateServiceCatalogEntryRequest`, `UpdateServiceCatalogEntryRequest`, `ServiceCatalogStatus`; `ServiceCatalogEntryIdPath` parameter; `Service Catalog` tag |
| Service Request `serviceCatalogId` (PART 02) | `ServiceRequest` + `CreateServiceRequestRequest` schema fields (nullable governed anchor) |
| Vendor Selection governed identity (PART 03) | `VendorSelection.serviceCatalogId` + the governed `capabilityMatch` semantics documented |
| SERVICE lineage (PART 04) | `RfqLine.sourceServiceId`, `VendorQuotationLine.sourceServiceId`, `PurchaseOrderLine.sourceServiceId` (additive) |
| PRICE-01 MATERIAL \| SERVICE (PART 05) | `PriceCatalogSourceMode` enum; `PriceCatalogEntry.sourceMode` → `$ref`, `itemId`/`uomId` nullable, `serviceId` added; `CreatePriceCatalogEntryRequest`/`Update...` carry `sourceMode`/`serviceId`; `PriceCatalogLookupResult` mode-aware; `/price-catalog/lookup` params (`sourceMode`, `serviceId`, optional `itemId`/`uomId`) |

## P6.2 Runtime/OpenAPI alignment (kept)

The contract tests pin runtime enums against the spec. PART 06 resolved the
PART 05 drift: `sourceMode` is now `MATERIAL`+`SERVICE` everywhere (spec ==
`PRICE_CATALOG_SOURCE_MODES`), the lookup documents the mode-dispatched
subject params, and the lookup result documents `sourceMode`/`serviceId`. The
spec-pinning `price-catalog-openapi.test.ts` was updated to assert against the
runtime constants (no literal `['MATERIAL']` remains). The pre-existing
`openapi-contract.test.ts` "every documented route is registered" still holds
(the Service Catalog routes were registered in PART 01).

## P6.3 Deferred boundaries (not in this CR)

- **Vendor Capability routes** (`/vendors/{vendorId}/capabilities`,
  `/vendor-capabilities/{id}`) remain a pre-existing **undocumented** surface;
  the governed `serviceCatalogId` link (PART 03) is therefore not yet in the
  spec. Documenting the full Vendor Capability surface is a separate
  documentation follow-up (it predates SVC-01). The governed link's behavior is
  proven by `tests/vendor-capability-identity.test.ts`.
- **Vendor Service Category master** promotion (free `category` → governed
  master, governance §4.3) remains a future additive CR.
- **Reactivation lane** for deactivated catalog entries (governance §11) is
  future, if ever required.
- **Price adoption/backfill** tooling (governance §19 / blocker B-03) remains a
  separate approved process.
- **UOM conversion** (governance §10/B-04) remains out of scope.
- The pre-existing OpenAPI drift debt noted in PRICE-01 PART 06
  (`Configuration` undeclared tag; duplicate operationIds in
  `r2p-openapi-contract` / `mobile-openapi-completeness` / `utility-part15/16`)
  is unchanged — SVC-01 PART 06 adds no new such debt (all new operationIds
  unique, the `Service Catalog` tag is declared).

## P6.4 Targeted validation evidence (PART 06 scope; no broad regression)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `tests/price-catalog-openapi.test.ts` (updated — enum/lookup/result alignment) | pass |
| `tests/service-catalog-openapi.test.ts` (new — Service Catalog surface) | pass |
| `tests/openapi-contract.test.ts` (foundation + every documented route registered) | pass |
| `tests/rfq-openapi.test.ts`, `tests/material-chain-openapi.test.ts`, `tests/audit-part05-openapi.test.ts`, `tests/operational-commitment-openapi.test.ts` (directly affected contract tests) | pass |
| `git diff --check` | clean |

No CI run; KI-003 untouched; no broad regression executed; no runtime change.

## P6.5 Files changed in PART 06

- `docs/api/openapi.yaml` (Service Catalog paths/schemas/parameter/tag;
  PRICE-01 SERVICE alignment; lineage additive fields)
- `tests/price-catalog-openapi.test.ts` (assertion alignment)
- `tests/service-catalog-openapi.test.ts` (new)
- `docs/CR-BE-SVC-01_START_GOVERNANCE.md` (PART 06 notes + FINAL REVIEW)

---

# FINAL REVIEW — CR-BE-SVC-01 closure statement

**All six PARTs delivered; the governed Service Catalog identity is live
end-to-end on `arena/01a0324c-asentra-backend`.** CR-BE-SVC-01 closes START
GOVERNANCE blocker **B-01** that PRICE-01 left open.

| Frozen governance area | Delivery |
|---|---|
| §4/§5 Service master + code rules | PART 01 (`0321`, `service_catalog`, immutable Client-scoped code, ACTIVE/INACTIVE) |
| §6 Client scope (no Building master) | PART 01 (Client-scoped; Building specialization on the price/vendor tier) |
| §7 Vendor capability governed match | PART 03 (`0323` link + identity-only match precedence, fail-open fallback) |
| §8 Service Request governed anchor | PART 02 (`0322` nullable FK, consistency rule, free `service_type` retained) |
| §9 SERVICE lineage snapshots | PART 04 (`0324` `source_service_id` on rfq/quotation/PO lines; SERVICE shape intact) |
| §10 PRICE-01 SERVICE subject | PART 05 (`0325` split exclusion, discriminated-union shape, no-UOM resolver/comparison/deviation) |
| §11 lifecycle (terminal INACTIVE) | PART 01 (no reactivation lane; deactivation is soft) |
| §12 RBAC | `service_catalog.read/.manage` (PART 01); no `.override` (reference master) |
| §13 audit/isolation | `recordOperationalEvent` + Client isolation (PART 01); governed validation + FK isolation (PART 02–05) |
| §14/§19 no backfill | Additive nullable adoption throughout; no inference, no auto-mapping, no historical rewrite |
| §20 API/OpenAPI | PART 06 — Service Catalog API + PRICE-01 SERVICE alignment + lineage fields documented |

**Readiness statements:**

- **B-01 (PRICE-01) — CLOSED.** SERVICE price tiers are activated (PART 05);
  every governed SERVICE touchpoint now resolves a real reference. MATERIAL
  PRICE-01 behavior is proven byte-identical across the full PART 01–06 suite.
- **B-03 (Service Category master)** remains a future additive promotion
  (§4.3); the free `category` column is the v1 surface.
- **B-04 (UOM conversion)** remains out of scope (§10); no conversion lane.
- **Vendor Capability routes** documentation is a separate follow-up (the
  governed link behavior is proven by tests; the surface predates SVC-01).

**Remaining gap against the frozen CR:** none. Only pre-existing, CR-external
debt remains (KI-003 assertion debt; the PRICE-01 PART 06-noted OpenAPI drift
in unrelated CRs; the undocumented Vendor Capability routes).

**CR-BE-SVC-01 is READY FOR FINAL REVIEW SIGN-OFF.**

---

## FINAL REVIEW — validation record

**Stage:** Fix → Final Validation → Commit → Push → Pull Request
**Reviewer finding:** no CR-related defects found. No code/migration/OpenAPI fix
was required at final review — the implementation matches the governance
contract across all reviewed dimensions (Service Catalog authority; Service
Request adoption; Vendor capability/readiness governed identity; SERVICE
procurement lineage; SERVICE reference pricing; RFQ comparison + PO
price-deviation integration; RBAC/isolation/audit; OpenAPI/runtime alignment;
MATERIAL backward compatibility; no invented SERVICE item/UOM/quantity; no
inference/backfill).

### Final validation (targeted; no broad regression, no CI, KI-003 untouched)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| SVC-01 suites (service-catalog, service-request-catalog-adoption, vendor-capability-identity, service-lineage-identity, service-reference-price) | 53/53 pass |
| PRICE-01 directly-affected price-catalog suites (PART 01/02/03/05) | 52/52 pass |
| PRICE-01 comparison + PO-deviation integration (PART 04/06) | 23/23 pass |
| Procurement lineage (rfqs, rfq-po-conversions, po-lines, recommendations-awards) | 32/32 pass |
| SVC-01 adoption existing suites (service-requests, vendor-capabilities, vendor-selection-readiness) | 70/70 pass |
| Purchase orders + issuance | 38/38 pass |
| OpenAPI contract (openapi-contract, price-catalog-openapi, service-catalog-openapi, rfq-openapi, material-chain-openapi) | 25/25 pass |
| Seeds (permission/seed contract) | 1/1 pass |
| `git diff --check` | clean |

### Migration sequence (applied in order, never edited)

`0321_create_service_catalog` →
`0322_add_service_request_catalog_anchor` →
`0323_add_vendor_capability_service_identity` →
`0324_add_service_lineage_identity` →
`0325_activate_service_reference_price`.
Next free migration number: **0326**. Materialized on the Arena branch only.

### Deferred items (unchanged from PART 06)

Vendor Capability routes documentation; Service Category master promotion
(§4.3); reactivation lane (§11); price adoption/backfill tooling (§19/B-03);
UOM conversion (§10/B-04); pre-existing KI-003 assertion debt and the
PRICE-01-noted OpenAPI drift in unrelated CRs.

### Merge readiness

**READY TO MERGE.** All six PARTs delivered; PRICE-01 blocker B-01 closed;
MATERIAL PRICE-01 behavior byte-identical; OpenAPI/runtime aligned; no
inference/backfill; no invented SERVICE item/UOM/quantity. A pull request from
`arena/01a0324c-asentra-backend` to `main` is opened for review/sign-off.



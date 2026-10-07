# CR-BE-MAT-01 — Controlled Material Fulfilment & Work-Order Cost — GOVERNANCE AUDIT

> **Type:** AUDIT ONLY. No implementation, no migrations, no OpenAPI redesign, no frontend/mobile change, no PR.
> **Baseline:** `main` @ `b972dee` (merged PR #32).
> **Date:** 2026-08-18
> **Method:** source inspection only — migrations (`src/database/migrations/0071, 0166–0183, 0201–0202`), module services/routes (`src/modules/inventory-*`, `material-requests`, `purchase-requests`, `procurement-approvals`, `vendor-selection-readiness`, `purchase-order-readiness`, `receivings`, `work-order-procurement-bindings`, `uoms`, `vendor-service-costs`, `basic-expenses`, `consumable-readiness`), `src/routes/index.ts`, `docs/api/openapi.yaml`. No tests run.

---

## 1. Audited chain — actual implementation

| Step | Implemented by | Status |
|---|---|---|
| Material Request | `material_requests` (0177) — line on Purchase Request (0176), FK `inventory_items`, qty>0, UOM derived from item | ✅ exists |
| Approval | `procurement_approval_bindings` (0179) — append-only PENDING→APPROVED/REJECTED per request, authorized approver | ✅ exists (boolean, no quantity; does **not** change MR/PR state) |
| Procurement / PO Readiness | `purchase_order_readiness` (0181) — snapshot of approvalOk + vendorOk + materialContextOk → READY/NOT_READY/BLOCKED | ✅ exists (header-level, **no quantities**) |
| Receiving | `receivings` (0182) — requires READY PO readiness for request+vendor; MATERIAL type posts BE-16 STOCK_IN and stores `stock_movement_id` | ✅ exists (header-level, **not bound to MR line**) |
| Stock In | `inventory_stock_movements` (0169) via `postStockMovement` — BEGIN / `FOR UPDATE` / balance update / movement insert / COMMIT | ✅ exists |
| Inventory Balance | `inventory_stock_balances` (0168) — unique (warehouse,item), non-negative CHECKs, generated `available_quantity` | ✅ exists |
| Stock Out | same movement service; available ≥ qty enforced under lock | ✅ exists (also reachable **unbound to any WO/demand**) |
| WO Material Usage | `inventory_work_order_material_usages` (0174) — tx-safe stock-out + audit STOCK_OUT movement `source='WORK_ORDER:{id}'` | ✅ exists (no UOM, **no cost**) |
| Operational Cost | `vendor_service_costs` (0201, VENDOR_WORK / SERVICE_REQUEST only) + `basic_expenses` (0202) | ❌ **no material cost anywhere** — zero `unit_cost`/`unit_price` fields in the entire codebase |

---

## 2. Authority determination

| # | Authority | Owner | Verdict |
|---|---|---|---|
| 1 | Material Request | `material_requests` | Single. But status is only OPEN/CANCELLED — approval never freezes the line (qty editable after APPROVED decision). |
| 2 | Procurement / PO readiness | `purchase_order_readiness` | Single, but a **stored snapshot** — receiving trusts the persisted `readiness='READY'` row, which can go stale vs. later MR/approval changes. Not a commitment: no ordered lines, no ordered quantity. |
| 3 | Receiving | `receivings` | Single. Header-scoped (PR+vendor); receiving line is free-form (any item/warehouse/qty), not validated against MR lines. |
| 4 | Inventory transaction | `inventory_stock_movements` | Ledger is single, but balance-mutation logic is **re-implemented in 4 services** (movements, transfers, adjustments, WO usage). Transfers and WO usage do emit movement rows; **stock adjustments mutate the balance WITHOUT a movement row** → ledger ≠ balance. |
| 5 | Inventory balance | `inventory_stock_balances` | Single table, but `POST` initialize (`initializeStockBalance`) can seed a **non-zero on-hand with no movement** — a competing write path around the ledger. |
| 6 | WO material usage | `inventory_work_order_material_usages` | Single, append-only, atomic. |
| 7 | Material / spare-part identity | `inventory_items` (client+code unique; SPARE_PART/MATERIAL/CONSUMABLE as data). `inventory_asset_spare_parts` binds asset↔item without duplicating the master | Single. No duplicate item master. |
| 8 | Quantity / UOM | `units_of_measure` (BE-07). `inventory_items.uom_id` **optional**; MR resolves/validates UOM against item | Weak. Movements, receivings, usages, balances carry **no UOM column** — quantity unit is implicit and may be undefined (item with NULL uom). No UOM snapshot on transactional rows. |
| 9 | Operational material cost | — | **MISSING.** `vendor_service_costs.context_type` CHECK excludes any material context; no price/cost on receiving, movement, or usage. |

**Duplicate / competing authorities found:** (a) 4 independent balance-mutation code paths; (b) balance initialize vs. movement ledger; (c) adjustments bypassing the ledger; (d) generic STOCK_OUT endpoint vs. WO material usage as two uncoordinated issue paths (a WO consumption can be posted as a plain movement, invisible to WO usage).

---

## 3. Binding verification

| Binding | Exists? | Evidence / gap |
|---|---|---|
| Material Request → procurement | ✅ | `material_requests.purchase_request_id` (line→header). |
| Procurement → receiving | ⚠️ header only | `receivings.purchase_request_id` + vendor + READY readiness. **No `material_request_id` on receiving** — the received item is never matched to a requested line. |
| Receiving line → material/spare part | ✅ | `receivings.item_id` FK (nullable; single line per record). |
| Receiving → Stock In | ✅ | `receivings.stock_movement_id` FK, movement posted in `createReceiving`. Movement and receiving insert are **not in one DB transaction** (movement commits first; receiving insert failure would orphan the stock-in). |
| Stock In → inventory balance | ✅ | atomic in `postStockMovement`. |
| Stock Out → Work Order | ⚠️ | Only via WO usage service (`source='WORK_ORDER:{id}'`, text convention, not FK). Generic `/stock-movements` STOCK_OUT has free-text `reference` — issuable with no WO binding. |
| Work Order → material usage | ✅ | `inventory_work_order_material_usages.work_order_id` FK; `work_order_procurement_bindings` (unique per WO) links WO→PR→(MR)→receiving. |
| Material usage → quantity/UOM | ⚠️ | quantity ✅ (>0, atomic); UOM ❌ not recorded. |
| Material usage → unit/total cost | ❌ | no cost fields anywhere in the chain. |

---

## 4. Fulfilment control check

| Control quantity | State |
|---|---|
| Requested | ✅ `material_requests.quantity` — but mutable while OPEN, including **after approval** (approval doesn't transition MR). |
| Approved | ❌ none. Approval is per-request boolean; no approved quantity, no line freeze. |
| Ordered / readiness | ❌ none. `purchase_order_readiness` carries no quantities. |
| Received | ⚠️ per-receiving only. **No cumulative received-vs-requested check.** |
| Remaining | ❌ not computed anywhere. |
| Stock | ✅ authoritative (`on_hand`/`reserved`/generated `available`, non-negative CHECKs, `FOR UPDATE`). |
| Issued | ⚠️ available-stock guarded, but not tied to any demand/WO cap. |
| Consumed / used | ⚠️ available-stock guarded per posting; no cap vs requested/approved; no idempotency key → duplicate postings possible. |
| Reserved | Dead control: `reserved_quantity` exists but **nothing ever reserves** (no reservation flow). |

**Where over-receipt / over-issue / duplicate fulfilment can occur today:**
1. **Over-receipt:** unlimited `POST /receivings` for the same PR+vendor; any item, any quantity, no relation to MR lines and no cumulative cap.
2. **Duplicate fulfilment:** re-posting the same receiving (no idempotency / line-remaining check); RECEIVED→FINALIZED guards the *record*, not the *quantity*.
3. **Over-issue vs. demand:** WO usage limited only by warehouse stock, never by requested/approved/received quantity; and the generic STOCK_OUT endpoint bypasses WO usage entirely.
4. **Ledger drift:** stock adjustments and non-zero balance initialization change stock with no movement row — the movement ledger cannot fully reconstruct balances.
5. **Post-approval mutation:** MR quantity/item edits after APPROVED decision are accepted; readiness snapshot is not invalidated.

---

## 5. Work Order cost check

WO → usage → **quantity** is traceable end-to-end. WO → usage → **unit cost → material cost** is **not possible**: no price captured at receiving, no cost snapshot on usage, no valuation of any kind, and `vendor_service_costs` structurally excludes material contexts. This is the operational-cost gap only — GL / inventory accounting / valuation engine / AP / tax are explicitly out of scope and NOT proposed.

---

## 6. Housekeeping

The same foundation safely supports HK consumables **without a second stock engine**: `inventory_housekeeping_consumable_bindings` (0175) binds `consumable_requirements` (BE-11 consumable-readiness) → `inventory_items` + `inventory_warehouses` and already reads live balance for stock visibility. HK consumption, when needed, should post the existing STOCK_OUT authority (same over-issue caveat as §4.3). No separate engine exists and none is needed. No HK scope expansion proposed.

---

## 7. OpenAPI check

`docs/api/openapi.yaml` (CR-BE-API-01 PART 01, declared incremental) has 185 paths — **zero coverage of this chain**: no paths for inventory items/warehouses/balances/movements/transfers/adjustments/minimum-stocks/asset-spare-parts/HK bindings, WO material usages, purchase requests, material requests, procurement approvals, vendor selection readiness, PO readiness, receivings, WO procurement bindings, UOMs, vendor service costs, or basic expenses — all of which are live registered routes. Gap type: **missing** (not inconsistent). No redesign performed.

---

## 8. Output summary

**Reusable foundations (keep, do not rebuild):** item master; balance table with DB-level invariants; append-only movement ledger with `FOR UPDATE` transactions; WO usage with automatic audit movement; PR/MR intake; append-only approval bindings; PO readiness gate; receiving→STOCK_IN reuse; WO procurement binding; BE-07 UOM; `vendor_service_costs`/`basic_expenses` DRAFT→FINALIZED/CANCELLED + history pattern (template for material cost); HK binding reuse of inventory.

**Missing authorities:** operational material-cost authority; approved-quantity authority; remaining-quantity authority; single balance-mutation authority (logic duplicated ×4, adjustments off-ledger).

**Missing bindings:** receiving → material_request line; stock-out → WO as structural reference (text convention only); usage → UOM; usage → cost.

**Quantity/UOM gaps:** item UOM optional; no UOM snapshot on movement/receiving/usage; no cross-line UOM consistency enforcement beyond MR create.

**Fulfilment-control gaps:** §4 items 1–5 (over-receipt, duplicate fulfilment, over-issue, ledger drift, post-approval mutation); dormant `reserved_quantity`.

**WO cost gap:** §5 — quantity traceable, cost non-existent.

**OpenAPI gaps:** §7 — entire BE-16/BE-17 + cost surface undocumented.

**Migration impact (informational, none executed):** all remediation is **additive** — new nullable FK on `receivings` (`material_request_id`), approved-quantity/state columns or snapshot table, UOM snapshot columns, cost columns on receiving/usage, movement rows for adjustments/opening balances. No destructive change, no data backfill hazard beyond nullable columns.

---

## 9. Recommended SMALL PART breakdown

Each part ≤ 2–3 major domains; sequence chosen so controls land before cost.

| PART | Scope (small) | Domains |
|---|---|---|
| **01 — Receiving line binding & over-receipt control** | Add `receivings.material_request_id`; validate received item/warehouse against the MR line; enforce cumulative received ≤ requested (remaining-quantity guard); make movement+receiving insert one transaction | receivings, material-requests |
| **02 — Approval freeze** | APPROVED state (or approved-qty snapshot) on MR/PR; block MR edits after approval; readiness/receiving require approved line | material-requests, procurement-approvals, purchase-order-readiness |
| **03 — Ledger completeness** | Adjustments emit movement rows; opening balance posted as movement; restrict balance initialize to zero-seed | inventory-stock-adjustments, -movements, -balances |
| **04 — UOM hardening** | UOM snapshot on movement/receiving/usage; require item UOM for transactable items | inventory, receivings |
| **05 — Material cost (operational only)** | `unit_cost` on material receiving; cost snapshot (unit + total) on WO usage from receiving cost; no valuation engine | receivings, inventory-work-order-material-usages |
| **06 — WO issue control** | Cap WO usage vs approved/received where a procurement binding exists; require WO context (or explicit source) for STOCK_OUT issue paths; HK consumption reuses same authority | inventory-work-order-material-usages, inventory-stock-movements |
| **07 — OpenAPI wave (docs only)** | Document the BE-16/BE-17/cost chain contracts incrementally per CR-BE-API-01 rules | docs/api |

**Blockers:** none hard. Ordering constraint only — PART 02 must precede PART 05 (cost must snapshot against frozen approved lines); PART 03 should precede PART 05 (cost source integrity).

**Ready for PART 01: YES** (audit-only; PART 01 not implemented).

**STOP.**

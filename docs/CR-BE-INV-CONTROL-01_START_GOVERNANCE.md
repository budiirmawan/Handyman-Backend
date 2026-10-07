# CR-BE-INV-CONTROL-01 — START GOVERNANCE

## Reservation + Demand-Capped Material Issue

**Status:** FINAL REVIEW PASS. PART 01–04 implementation, consolidated validation, and contract/documentation closure are complete.

**Repository:** `asentra-backend`

**Inspected branch:** `arena/01a02bc6-asentra-backend`

**Inspected head:** `f9fb299c14466ff1f30f96c4aef75c170c1246fd`

**Inspection date:** 2026-08-23

---

## 1. Existing authority map

| Authority / concern | Existing owner | Current implementation and boundary |
|---|---|---|
| Item master | `inventory_items` (migration `0166`, `inventory-items`) | Client-owned item identity, item type, optional Item Master UOM, and ACTIVE/INACTIVE lifecycle. No quantity is stored here. |
| Warehouse / store | `inventory_warehouses` (migration `0167`, `inventory-warehouses`) | Building- and Client-scoped storage location. The service derives and validates Client/Building context. |
| Inventory balance | `inventory_stock_balances` (migration `0168`, `inventory-stock-balances`) | One row per `(warehouse_id, item_id)`. `quantity_on_hand` and existing `reserved_quantity` are constrained non-negative; `available_quantity` is a generated `on_hand - reserved` value. This remains the current-stock authority. |
| Stock movement ledger | `inventory_stock_movements` (migration `0169`, `inventory-stock-movements`) | Append-only `STOCK_IN` / `STOCK_OUT` ledger. `postStockMovement` and `postStockMovementWithClient` lock the balance with `FOR UPDATE` and commit the balance/movement atomically. |
| Material demand | `material_requests` (migration `0177`, `material-requests`) | Existing request-line authority under a Purchase Request. It references the Item Master and derives Client/Building from the Purchase Request. |
| Approved quantity | `material_requests.approved_quantity` (migration `0265`, `procurement-approvals`) | Existing fulfilment authority. Approval transitions the line to `APPROVED`; explicit approval is capped at requested `quantity`, and omitted approval defaults to requested quantity. Approved lines are frozen by the service. Historical/unapproved rows may still have `approved_quantity = NULL`; current receiving/read code falls back to requested `quantity`. |
| Existing remaining calculation | `materialRequestService.getMaterialRequestById` + `materialRequestRepository.sumReceivedQuantity` | Detail reads derive `receivedQuantity` and `remainingQuantity = (approvedQuantity ?? quantity) - receivedQuantity`. This is a receiving/fulfilment read calculation, not an issue ledger. |
| Work Order ↔ demand association | `work_order_procurement_bindings.material_request_id` (migration `0183`, `work-order-procurement-bindings`) | Optional existing binding from a Work Order to one Material Request line. One binding is allowed per Work Order. There is no Work Order material-demand table and no direct demand reference on a material usage row. |
| Material issue / usage | `inventory_work_order_material_usages` (migration `0174` plus `0266–0268`, `0288`, `0290`, `inventory-work-order-material-usages`) | Append-only Work Order usage. New controlled issues resolve the approved Material Request through `work_order_procurement_bindings`, cap cumulative issue, persist `materialRequestId`, and optionally persist `reservationId`; historical rows remain unlinked. It retains stable `stockMovementId`, UOM, cost, and atomic ledger behavior. |
| Generic stock-out | `POST /warehouses/:warehouseId/stock-movements` and client-scoped equivalent | Generic ledger behavior remains available for unrelated sources. PART 03 rejects the exact valid `WORK_ORDER:{uuid}` source convention so that identifiable Work Order consumption cannot use this route as a bypass; arbitrary free-text purposes remain a deferred boundary. |
| Receiving / stock-in | `receivings` (migration `0182` plus `0264`, `receivings`) | Material receiving can bind to a Material Request, locks the line, caps cumulative receipt by `approved_quantity ?? quantity`, and posts `STOCK_IN` through the existing movement core in one transaction. It is not the issue authority. |
| RBAC / isolation | `inventory_stock.*`, `material_request.*`, `wo_procurement.*`, `contextAccessService` | Existing routes use bearer authentication, existing permissions, and Client/Building access checks. No new bypass or role assumption is appropriate. |
| Audit / event foundation | `operational_events` / `recordOperationalEvent` and existing movement/usage rows | Reservation lifecycle changes should reuse the append-only operational-event helper, preferably with the transaction client when the event is part of a reservation command. Existing stock movement and usage records remain the operational stock trace. |

### Existing controlled chain

```text
Purchase Request
  → Material Request line
  → procurement approval / approved_quantity
  → receiving (optional stock-in)
  → inventory_stock_movements + inventory_stock_balances
  → Work Order material usage (stock-out)
```

The missing segment for this CR is:

```text
APPROVED MATERIAL REQUEST
  → reservation allocation
  → demand-capped Work Order issue
  → existing Work Order material usage
```

---

## 2. Safest extension points

1. **Add an allocation-only reservation module/table.** A reservation row should have a mandatory FK to the existing `material_requests` row and should derive Client, Building, item, and UOM context from validated existing records. A Work Order and warehouse may be recorded as allocation context, but reservation quantity must remain an allocation, not a second demand authority.

2. **Use the existing `work_order_procurement_bindings.material_request_id` relationship where a Work Order demand relationship is required.** Do not add a `work_order_material_demands` table. A new reservation/issue must reject a Material Request that is not valid for the target Work Order under the chosen contract.

3. **Extend the existing Work Order usage record with source links.** Add nullable `material_request_id` and `reservation_id` references for backward compatibility with historical usages, while requiring the source link for new controlled issues. Preserve the existing `stock_movement_id`, UOM snapshot, cost snapshot, append-only behavior, and usage authority.

4. **Extend the existing transaction-aware stock movement core rather than creating a reservation stock engine.** Generic/unreserved issue continues to use `available_quantity`; an allocated issue must consume the selected reservation and reduce `reserved_quantity` and `quantity_on_hand` together. The movement must still be written by the existing ledger authority and remain in the same transaction as the usage/reservation update.

5. **Centralize demand reads in a locked source calculation.** Under a transaction lock on the Material Request line, derive:

   ```text
   authorizedDemand = approved_quantity ?? quantity
   cumulativeIssued = SUM(new controlled usage rows for that Material Request)
   remainingDemand = authorizedDemand - cumulativeIssued
   activeReserved = SUM(unissued quantity of active reservations for that Material Request)
   reservableDemand = remainingDemand - activeReserved
   ```

   The requested `quantity`, `approved_quantity`, and usage rows remain owned by their existing authorities. No `remaining_demand` counter should be persisted as a competing authority.

6. **Keep UOM and scope checks at the existing boundaries.** Reservation and issue UOM must match the Item Master / Material Request UOM exactly because no conversion authority exists. Client, Building, Work Order, warehouse, item, and Material Request relationships must be derived and revalidated server-side.

7. **Use existing permissions initially.** Reservation and controlled issue mutations should use the existing `inventory_stock.manage` permission and reads should use `inventory_stock.read`, with the same Building/Client checks as the current inventory and usage routes. `material_request.manage` must not be inferred from stock permission, and vice versa.

---

## 3. Detected constraints, conflicts, and risks

- **Generic `STOCK_OUT` remains intentionally narrow at the current boundary.** PART 03 rejects the exact `WORK_ORDER:{uuid}` convention on the public generic route and leaves legitimate unrelated generic sources unchanged. Because `source` is otherwise free text, arbitrary caller labels cannot be treated as proof of intent; a broader purpose policy is deferred and must not be inferred from this CR.

- **Historical Work Order usage is demand-free, but new controlled usage is not.** Existing rows may have no Material Request link and remain readable. The current issue endpoint requires the existing Work Order procurement binding to an APPROVED Material Request; no new unbound usage path is advertised.

- **Historical usage rows cannot be reliably backfilled to a demand line.** Existing usages have the text source `WORK_ORDER:{id}` and a stable movement link, but no Material Request identity. New nullable source columns preserve those rows; cumulative demand calculations must define whether legacy unlinked usage is excluded, conservatively counted by Work Order/item, or blocks a new controlled binding. No heuristic backfill should invent authority.

- **Legacy `reserved_quantity` is not fully represented by reservation rows.** The reservation lifecycle now exists, but balance initialization can still preserve nonzero reserved quantity without a reservation row. The implementation does not assume `SUM(reservations) == balance.reserved_quantity`, reset legacy values, or create a second balance authority; commands apply only their own delta.

- **Material Request warehouse is optional.** When a request line has no target warehouse, reservations/issues may need to select among warehouses. All such operations must lock the same Material Request row before aggregating reservations/issues; otherwise two warehouses can independently over-reserve or over-issue one demand line. If a target warehouse is present, cross-warehouse allocation must be rejected.

- **Material Request cancellation is now coordinated with reservations.** PART 03 reuses `cancelMaterialRequest`, locks the source, and blocks cancellation while an ACTIVE reservation with remaining allocation exists. Release, cancellation, or full consumption must occur first; automatic release is not performed.

- **Existing balance mutation code is distributed.** Movement, transfer, adjustment, receiving, and Work Order usage each contain balance mutation logic. The reservation/allocated-issue path must extend the existing transaction-aware movement primitive and must not introduce another copy. Transfer/adjustment behavior must continue to consume only unreserved availability and preserve non-negative constraints.

- **Lock ordering must be uniform.** Demand operations should lock `material_requests` first, then a selected reservation (when applicable), then the `inventory_stock_balances` row. This aligns with the existing receiving path (`Material Request → balance`) and prevents concurrent reservations/issues from passing separate stale aggregates. Multi-warehouse transfer locks must retain its existing deterministic warehouse ordering.

- **Numerical precision matters.** Database quantities are PostgreSQL `NUMERIC`, while current DTOs map them to JavaScript `number`. New remaining/aggregate comparisons should use PostgreSQL numeric arithmetic in the transaction; do not make concurrency decisions from independently rounded JS sums.

- **Receiving and PO snapshots are not issue authorities.** `receivings` and `purchase_order_lines.quantity_snapshot` must not be promoted into a new issue quantity authority. The source for this CR should remain the existing Material Request approved/authorized quantity; receiving remains stock-in and its own approved-demand cap.

- **The prior `docs/reviews/CR_BE_MAT_01_AUDIT.md` is stale for this branch.** It documents the pre-`0264–0268` state (no approved quantity, no receiving binding, no UOM/cost/usage movement linkage). It is useful historical context, but the live code and current OpenAPI/tests above are the inspection baseline for this CR.

---

## 4. Proposed small PART breakdown

| PART | Scope | Main outcome | Targeted validation |
|---|---|---|---|
| **01 — Reservation foundation** | New allocation table/module, mandatory Material Request source reference, state transitions, create/read/list/release/cancel routes, source/item/warehouse/Work Order scope checks, balance `reserved_quantity` delta, operational events | A reservation can only allocate against a valid existing demand line and cannot exceed locked reservable demand or available stock. Release/cancel restores only the unissued allocation. | New focused reservation tests: create, zero/over-demand, insufficient stock, scope/RBAC, release/cancel/partial lifecycle; `npm run typecheck`. |
| **02 — Demand-linked issue** | Add demand/reservation references to new Work Order usage rows; extend the existing usage issue service and stock-movement transaction core; enforce `issueQty <= remainingDemand`; consume selected reservation when supplied; preserve movement/usage atomicity and snapshots | New material issues are source-bound, cumulative-demand capped, reservation-aware, and still use the existing stock ledger and usage authority. | Extend `tests/work-order-material-issue-control.test.ts` or add a focused demand-control suite for cumulative cap, exact remaining, reservation allocation, unreserved available stock, rollback, and existing UOM/state checks. |
| **03 — Concurrency and lifecycle hardening** | Lock-order proof for concurrent reservation/issue/release; Material Request cancellation interaction; duplicate/idempotent command handling; explicit policy for generic unbound `STOCK_OUT`; legacy-row compatibility | No concurrent over-reservation/over-issue, no negative stock, and no valid demand source can be silently bypassed. | Concurrent `Promise.all` reservation and issue tests; balance/usage/movement invariants; targeted receiving and material-approved-quantity suites; no full regression. |
| **04 — Contract/documentation closure** | Add reservation and source fields/routes/errors to the existing OpenAPI incrementally; update material-chain route/schema contract tests and this governance documentation with final semantics | API contract exposes only implemented routes and preserves current response/error/RBAC/isolation conventions. | `tests/material-chain-openapi.test.ts`, relevant mobile material contract checks if fields are published to mobile, `npm run typecheck`, and affected suites only. |

Each implementation PART should be committed and pushed to the fixed Arena branch. No PR or merge is part of these PARTs; PR/review remains deferred to FINAL REVIEW.

---

## 5. Expected files/modules to touch

### New or additive persistence/module surface (future PARTs)

- `src/database/migrations/0287+_create_inventory_material_reservations.ts` (exact migration split to be chosen in PART 01)
- `src/database/migrations/index.ts`
- `src/modules/inventory-material-reservations/index.ts`
- `inventory-material-reservation.types.ts`
- `inventory-material-reservation.errors.ts`
- `inventory-material-reservation.repository.ts`
- `inventory-material-reservation.service.ts`
- `inventory-material-reservation.controller.ts`
- `inventory-material-reservation.routes.ts`
- `inventory-material-reservation.validation.ts`
- `src/routes/index.ts`
- `src/shared/errors.ts`

### Existing material/inventory extension points (only as required)

- `src/modules/inventory-work-order-material-usages/*`
- `src/modules/inventory-stock-movements/inventory-stock-movement.service.ts` and its types/repository if the central transaction contract is extended
- `src/modules/material-requests/material-request.repository.ts` / `.service.ts` for locked source calculation and cancellation coordination
- `src/modules/work-order-procurement-bindings/work-order-procurement-binding.repository.ts` for existing Work Order ↔ Material Request validation, if a helper is needed
- `src/modules/operational-events/index.ts` only if a transaction-compatible event call needs a narrowly scoped additive helper

### Contract/tests/docs

- `docs/api/openapi.yaml`
- `tests/work-order-material-issue-control.test.ts` and/or a new focused reservation/demand-control test
- `tests/material-chain-openapi.test.ts`
- `tests/inventory-ledger-completeness.test.ts` and `tests/material-request-approved-quantity.test.ts` as targeted compatibility checks
- `tests/mobile-material-context-contract.test.ts` only if the published material usage contract changes for mobile consumers

No procurement, costing, price, SLA, notification, stock-ledger rebuild, inventory-balance rebuild, Material Request rebuild, or CI/KI-003 remediation files are expected.

---

## 6. PART 01–02 implementation notes

- Migration `0287_create_inventory_material_reservations` adds the allocation-only `inventory_material_reservations` table with `ACTIVE → RELEASED | CANCELLED` lifecycle metadata; PART 02 adds terminal `CONSUMED` only when an allocation is fully issued. It does not add an approved quantity or stock balance authority.
- Migration `0288_add_material_request_link_to_wo_usage` adds only a nullable `material_request_id` FK/index to existing Work Order usage rows. Historical rows remain valid; PART 02 now writes the link only for new controlled issues.
- Migrations `0289_add_material_reservation_consumption` and `0290_add_reservation_link_to_wo_usage` add the minimum reservation progress/usage linkage required by PART 02: partial consumption remains `ACTIVE`, exact consumption transitions to `CONSUMED`, and generated `remaining_quantity` is authoritative for the allocation remainder.
- New module: `src/modules/inventory-material-reservations`. Routes are source-nested for create/list and id-nested for get/release/cancel. Existing `inventory_stock.manage` and `inventory_stock.read` permissions are reused.
- Creation locks `material_requests` first, requires `APPROVED`, calculates authorized/issued/active-reserved demand with PostgreSQL `NUMERIC`, then locks the existing `(warehouse_id, item_id)` balance. It increases only `reserved_quantity`; `quantity_on_hand` and the generated `available_quantity` relationship are preserved.
- Demand-linked issue now resolves the Material Request from `work_order_procurement_bindings.material_request_id`, re-locks the approved request before calculating `authorizedDemand - cumulativeIssued`, and persists `material_request_id` on every new controlled usage. Receiving quantity is not used as issued quantity.
- A reservation-backed issue locks `Material Request → Reservation → Stock Balance`, consumes the selected allocation before the shared stock movement core posts `STOCK_OUT`, and reduces on-hand and reserved quantities together so available stock is not double-decremented. Partial consumption remains active; full consumption is terminal `CONSUMED`.
- Non-reservation controlled issues use the existing available-stock path. Existing movement/usage atomicity, UOM snapshot, cost snapshot, duplicate-reference, and stock movement linkage behavior remain intact. Historical unlinked usages remain readable.
- Release and cancel now reduce only the reservation's generated remaining allocation, exactly once. Legacy nonzero `inventory_stock_balances.reserved_quantity` is preserved as-is; reservation rows are not treated as the sole authority for historical reserved stock.
- Controlled issue linkage and reservation consumption use `recordOperationalEvent`. The generic unbound `STOCK_OUT` routes were deliberately not restricted in PART 02; PART 03 now rejects only the exact valid `WORK_ORDER:{uuid}` source convention on the public generic route and preserves unrelated generic sources.
- Material Request cancellation now uses the existing state-transition service inside a transaction, locks the source first, and blocks `CANCELLED` while any ACTIVE reservation with remaining allocation exists. RELEASED, CANCELLED, and CONSUMED reservations are not active allocations.
- All controlled reservation/issue/lifecycle commands preserve the final lock order `Material Request → Reservation when applicable → Stock Balance → movement/usage persistence`. No migration was required for PART 03.
- Existing terminal-state guards make repeated release/cancel and post-CONSUMED reservation use mutation-safe. No platform-wide request idempotency was added; network replay idempotency remains outside this PART.
- OpenAPI and `tests/material-chain-openapi.test.ts` publish and validate the reservation lifecycle, controlled issue source/reservation fields, permissions, generic bypass error, and lifecycle error contract.

## 7. Validation strategy

- Governance stage: source inspection only; no database was started and no tests were run.
- PART 01 validation completed: `npm run typecheck`, the focused reservation test, the material-chain OpenAPI contract test, and directly affected inventory/material suites all passed using isolated embedded PostgreSQL test instances.
- PART 02 validation completed: `npm run typecheck`, the focused reservation test, `tests/work-order-material-issue-control.test.ts`, the material-chain OpenAPI contract test, and directly affected inventory/material suites all passed using isolated embedded PostgreSQL test instances.
- PART 03 validation completed: `npm run typecheck`, reservation/lifecycle tests, Work Order issue/concurrency tests, stock-ledger/generic-boundary tests, Material Request approved-quantity/receiving compatibility tests, and the material-chain OpenAPI contract test all passed using isolated embedded PostgreSQL test instances.
- PART 04 validation completed: `npm run typecheck` and `tests/material-chain-openapi.test.ts` passed. No runtime code or business behavior changed in this PART, so unrelated inventory suites were not rerun.
- Do not run `npm test` or a full inventory regression as a PART validation unless a later instruction explicitly promotes the scope.

---

## 8. PART 04 final contract and authority closure

The completed API contract and authority chain are:

```text
Material Request approved quantity
        ↓
Authorized Material Demand
        ↓
Material Reservation
        ↓
Controlled Work Order Material Issue
        ↓
Inventory Stock Movement
        ↓
Work Order Material Usage
```

Final authorities:

- **Demand authority:** `material_requests.approved_quantity` (with the existing `approved_quantity ?? quantity` compatibility rule).
- **Reservation authority:** `inventory_material_reservations`, including allocation lifecycle and generated remaining allocation.
- **Stock authority:** `inventory_stock_balances`.
- **Stock ledger authority:** `inventory_stock_movements`.
- **Usage authority:** `inventory_work_order_material_usages`.
- **Work Order ↔ demand relationship:** existing `work_order_procurement_bindings.material_request_id`.

Final invariants documented by the implementation:

```text
cumulativeIssued <= authorizedDemand
reservationConsumed <= reservationReserved
quantity_on_hand >= 0
reserved_quantity >= 0
```

Partial reservation consumption remains `ACTIVE`; full consumption becomes `CONSUMED`. RELEASED, CANCELLED, and CONSUMED reservations are not active allocations. The controlled issue contract documents approved demand, optional reservation linkage, reservation allocation limits, stock availability, Material Request cancellation conflicts, and the exact generic `WORK_ORDER:{uuid}` STOCK_OUT bypass error.

No runtime business functionality was added in PART 04. True network request idempotency, broader load/stress testing, and any future generic STOCK_OUT policy beyond the exact identifiable convention remain deferred.

## 9. Stop state

FINAL REVIEW PASS. PART 01–04 implementation and consolidated validation are complete. No CR-scoped runtime defect required a fix, no unrelated code was refactored, no migration was added in PART 03 or PART 04, and no contract inconsistency remains known. No merge was performed.

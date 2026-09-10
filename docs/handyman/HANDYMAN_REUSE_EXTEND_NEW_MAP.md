# HANDYMAN — REUSE / EXTEND / NEW CAPABILITY MAP

Status: GOVERNANCE (HC-00 PART 02)
Date: 2026-09-10
Authoritative base: `main` @ `9d36eebbe85604cde2ba6cf3ba816c5395a7aec7` (merged PR #1)
Frozen roadmap: `docs/roadmap/HANDYMAN_BACKEND_FROZEN_ROADMAP_v1.1.md` (FROZEN, not modified by this PART)

This document is a capability map only. It contains no runtime code, implements no
HC-01+ wave, and does not alter the frozen roadmap.

---

## 1. BOUNDED-CONTEXT RULE

Handyman is a **separate bounded context** that runs on top of the existing Asentra
operational foundation. It is not a rewrite, not a fork, and not a parallel platform.

R1.1 — One context identity.
Every Handyman module, route, table, and event lives under the single identity
established by HC-00 PART 01:

- `HANDYMAN_CONTEXT_NAME = 'handyman'`
- `HANDYMAN_API_NAMESPACE = '/handyman'`

Defined in `src/modules/handyman-foundation/handyman-foundation.types.ts` and exported
from `src/modules/handyman-foundation/index.ts`. Mounted once in the composition root
`src/routes/index.ts` as `router.use(HANDYMAN_API_NAMESPACE, createHandymanRouter())`.

R1.2 — Every Handyman route is served under `/handyman`.
No Handyman route may be mounted outside `HANDYMAN_API_NAMESPACE`. A route that cannot
be expressed under `/handyman` is a boundary error, not a routing detail.

R1.3 — Every Handyman table is prefixed `handyman_`.
Reserved for HC-01+. The migration sequence is currently consumed through
`0336_create_notification_push_deliveries.ts`; Handyman migrations begin at `0337`.

R1.4 — One lifecycle authority.
Handyman owns Handyman lifecycle states. Handyman never becomes the authority for an
Asentra-owned lifecycle (Work Order, Permit, BAST Document, Evidence Submission,
Notification, SLA clock, Inventory stock). Where Handyman needs that state it **reads**
the owning module; it does not shadow it.

R1.5 — Asentra core stays context-agnostic.
Asentra modules keep working unchanged when no Handyman feature is enabled. Handyman
attaches to them; they never attach to Handyman.

---

## 2. REUSE CAPABILITIES

Reused **as-is**, by reference. No Handyman copy, no Handyman fork, no Handyman
re-implementation. Handyman code imports the owning module's public exports or reads
its tables through the owning repository.

| # | Capability | Actual source path | Reuse rule |
|---|---|---|---|
| R-01 | Building / location hierarchy | `src/modules/campuses/`, `src/modules/properties/`, `src/modules/buildings/`, `src/modules/floors/`, `src/modules/rooms/`, `src/modules/spaces/`, `src/modules/areas/`, `src/modules/functional-locations/`, `src/modules/structure-context/` | Read-only reference. A Handyman request points at an existing `building` / `space`; it never defines its own location tree. |
| R-02 | Tenant / Tenant PIC | `src/modules/tenant-companies/`, `src/modules/tenant-pics/`, `src/modules/tenant-spaces/`, `src/modules/tenant-building-contexts/` | Read-only reference. The customer of a Handyman request is an existing Tenant PIC. |
| R-03 | Vendor / provider master | `src/modules/vendors/`, `src/modules/vendor-categories/`, `src/modules/vendor-capabilities/`, `src/modules/vendor-pics/`, `src/modules/vendor-buildings/`, `src/modules/vendor-workforce/`, `src/modules/vendor-verification/`, `src/modules/vendor-assignments/`, `src/modules/vendor-licenses/`, `src/modules/vendor-compliance-documents/` | Read-only reference. A Handyman Provider is an existing Vendor row plus Handyman-side channel/entitlement attributes (NEW, §4). |
| R-04 | Workforce | `src/modules/workforce/`, `src/modules/workforce-skills/`, `src/modules/workforce-building-assignments/`, `src/modules/workforce-shifts/`, `src/modules/skills/`, `src/modules/positions/`, `src/modules/teams/`, `src/modules/attendance/` | Read-only reference. Crew **membership** is NEW (§4); the person record is reused. |
| R-05 | Work Order | `src/modules/work-orders/`, `src/modules/work-requests/`, `src/modules/work-order-assignments/`, `src/modules/work-order-actions/`, `src/modules/work-order-history/`, `src/modules/work-order-evidence/`, `src/modules/work-order-verification/` | Read-only reference / linkage. Handyman orchestration (HC-11) wraps and drives it; it does not replace it. |
| R-06 | Permit | `src/modules/permits/`, `src/modules/permit-applications/`, `src/modules/permit-approvals/`, `src/modules/permit-workers/`, `src/modules/permit-work-contexts/`, `src/modules/permit-work-lifecycle/`, `src/modules/permit-validities/`, `src/modules/permit-equipment/`, `src/modules/permit-safety-requirements/`, `src/modules/permit-evidence/`, `src/modules/work-permit-readiness/` | Read-only reference. HC-14 consumes permit state; it does not re-issue permits. |
| R-07 | Scheduling | `src/modules/schedules/`, `src/modules/due-job-scheduler/`, `src/modules/task-assignments/`, `src/modules/tasks/` | Reuse **where compatible**. Where Handyman needs appointment slots against Building policy, that is Handyman-side (HC-14) and binds to these, not replaces them. |
| R-08 | Checklist engine | `src/modules/checklist-templates/`, `src/modules/checklist-executions/`, `src/modules/checklist-administration/`, `src/modules/inspection-bindings/`, `src/modules/mobile-checklist/`, `src/modules/form-templates/`, `src/modules/form-instances/` | Read-only reference. HC-18 **binds** a dynamic QC checklist to this engine; it must not create a second checklist engine. |
| R-09 | Finding / Rework | `src/modules/findings/`, `src/modules/finding-rework/`, `src/modules/finding-closure/`, `src/modules/finding-classifications/`, `src/modules/finding-severities/`, `src/modules/finding-assignments/`, `src/modules/finding-reviews/`, `src/modules/finding-escalations/`, `src/modules/finding-history/` | Read-only reference. HC-20 defect/rectification/re-inspection rides this engine. |
| R-10 | SLA | `src/modules/sla-definitions/`, `src/modules/applied-slas/` (incl. `sla-clock-lifecycle.service.ts`), `src/modules/sla-escalation-policies/`, `src/modules/sla-escalation-actions/` | Read-only reference. HC-30 measures Handyman performance against applied SLAs. |
| R-11 | Notification orchestration data | `src/modules/notifications/`, `src/modules/notification-templates/`, `src/modules/notification-history/`, `src/modules/notification-subscriptions/`, `src/modules/notification-reminders/`, `src/modules/notification-escalations/`, `src/modules/notification-secure-links/`, `src/modules/recipient-resolution/` | Read-only reference. HC-29 composes Handyman events into this engine. |
| R-12 | WhatsApp / Email / Push infrastructure | `src/modules/whatsapp-delivery/`, `src/modules/whatsapp-callback/`, `src/modules/email-delivery/`, `src/modules/push-delivery/`, `src/modules/push-tokens/`, `src/modules/notification-delivery/`, `src/modules/notification-outbound-deliveries/`, `src/modules/notification-push-deliveries/` | Read-only reference. No new transport adapter may be written for Handyman. |
| R-13 | Outbox / Webhook | `src/modules/integration-outbox/` (`integration-outbox.enqueue.ts`, `integration-outbox.payload.ts`), `src/modules/integration-webhook-endpoints/`, `src/modules/integration-webhook-deliveries/` | Read-only reference. HC-31 BM Super App callbacks/outbox use the existing outbox; no second outbox. |
| R-14 | Audit | `src/modules/audit/`, `src/modules/configuration-audit/` | Read-only reference / write-through. Handyman audit rows go to the existing audit store. |
| R-15 | Price Catalog (price authority / reference) | `src/modules/price-catalog-entries/` incl. `price-catalog-lookup.service.ts`, `price-catalog-lookup.types.ts` (migration `0319_create_price_catalog_entries.ts`) | Reuse as **price authority/reference where compatible**. Verified constraint: the lookup resolver currently excludes SERVICE prices, so Handyman service pricing must EXTEND rather than assume it (§3, E-06). |
| R-16 | UOM / classification masters | `src/modules/uoms/`, `src/modules/asset-categories/` | Read-only reference. Material/SKU quantities reuse `uoms`. |
| R-17 | Cross-cutting platform | `src/shared/` (`api-response.ts`, `errors.ts`, `pagination.ts`, `request-context.ts`, `due-retrieval.ts`, `logger.ts`, `provider-result.ts`), `src/middleware/` (`request-id.ts`, `security.ts`, `cors.ts`, `error-handler.ts`, `not-found.ts`, `request-logger.ts`, `mobile-context.ts`), `src/database/` (`connection.ts`, `transaction.ts`, `migrations/`), `src/config/` | Reuse. Handyman writes no parallel envelope, error, pagination, transaction, or migration mechanism. |
| R-18 | Data-scope / context access | `src/modules/context-access/` (`context-access.middleware.ts`, `context-access.service.ts`), `src/modules/management-read-scope/` | Read-only reference. HC-33 RBAC/data scope builds on this rather than inventing a second scope model. |

---

## 3. EXTEND CAPABILITIES

An existing Asentra capability is **close but not sufficient**. Handyman adds a bounded
extension — additive columns, binding tables, or a new state attached to the existing
aggregate — and the existing Asentra behavior stays intact and usable without Handyman.

Extension rule: an extension is additive and reversible-in-principle. It must not change
the meaning of an existing Asentra field, must not repurpose an existing table, and must
not require Asentra callers to know Handyman exists.

| # | Capability | Existing base (verified) | Handyman extension | Wave |
|---|---|---|---|---|
| E-01 | Tenant Service Request → Tenant Handyman Request | `src/modules/tenant-service-requests/` (`tenant-service-request.types.ts`; migration `0148_create_tenant_service_requests.ts`). Verified today: statuses `OPEN` / `CANCELLED` / `CONVERTED`, links `workRequestId` / `workOrderId`, FM intake only. | Extend with Handyman channel attribution, catalog/variant selection, commercial track, and Handyman lifecycle. The existing FM intake path must keep working. Handyman requests carry immutable channel attribution (HC-03). | HC-03, HC-04 |
| E-02 | Service Catalog | `src/modules/service-catalog/` (migration `0321_create_service_catalog.ts`). Verified today: `service_catalog` is Client-scoped **identity only** — `code`, `name`, `description`, `category`, `status`; explicitly no demand/price/quantity/UOM behavior. | Extend with Service Variant, Common Material Profile binding, discovery/publishing attributes, and the HC-04 catalog chain in §9. | HC-04 |
| E-03 | Evidence | `src/modules/evidence/` (`evidence.service.ts`, `evidence-integrity.ts`, `evidence-integrity-verification.service.ts`, `mobile-evidence.routes.ts`), `src/modules/evidence-requirements/` (`0072`), evidence submissions (`0073`), `src/modules/evidence-retention-policies/` (`0304`, `0305`), integrity metadata (`0303`) | Extend with Handyman evidence contracts and the photo-quality gate. Integrity, retention, and purge semantics are reused, not rewritten. | HC-19, HC-18 |
| E-04 | Inventory / Material | `src/modules/inventory-items/` (migration `0166_create_inventory_items.ts`; verified `itemType` ∈ `SPARE_PART` / `MATERIAL` / `CONSUMABLE`, `uomId` FK), `src/modules/inventory-warehouses/`, `inventory-stock-balances/`, `inventory-stock-movements/`, `inventory-stock-adjustments/`, `inventory-stock-transfers/`, `inventory-minimum-stocks/`, `inventory-material-reservations/`, `inventory-work-order-material-usages/` (`0288`), `src/modules/material-requests/` (`0177`), `src/modules/purchase-requests/` | Extend with Handyman material request/approval/issue/usage/return and **final usage** semantics against a Handyman work session. `inventory_items` remains the single item master; no Handyman SKU table. | HC-17 |
| E-05 | BAST | `src/modules/bast-documents/` (`bast-document.service.ts`, `bast-closure-readiness.service.ts`, `bast-reconciliation.repository.ts`; migrations `0226`, `0259`, `0260`), `src/modules/vendor-bast-bindings/` (`0162`), `src/modules/work-completion-documents/`, `src/modules/acceptance-sign-offs/`, `src/modules/handover-documents/` | Extend with Digital BAST, customer acceptance, and BAST dispute for Handyman. Migration `0226` states there is ONE authoritative BAST foundation for INTERNAL / TENANT / VENDOR and "no second BAST engine" — Handyman obeys that and extends it. | HC-22 |
| E-06 | Price / pricing execution | `src/modules/price-catalog-entries/price-catalog-lookup.service.ts` + `price-catalog-lookup.types.ts`. Verified constraint: resolution outcomes `MATCHED` / `NO_REFERENCE_PRICE` / `UOM_INCOMPATIBLE` / `CURRENCY_INCOMPATIBLE` / `AMBIGUOUS`, scope tiers `VENDOR_BUILDING` / `VENDOR` / `BUILDING` / `CLIENT_WIDE`, and SERVICE prices explicitly out of scope. | Extend for Handyman rate/pricing execution. Reference prices keep coming from the price catalog; Handyman rate execution is NEW (§4) and must not fork the catalog. | HC-08 |
| E-07 | Quotation / commercial documents | `src/modules/vendor-quotations/`, `src/modules/vendor-quotations/` lineage, `src/modules/rfqs/`, `src/modules/vendor-service-costs/` | Extend for customer-facing Handyman quotation with immutable versioning, expiry, and revision. Vendor-side RFQ/quotation flow stays as-is. | HC-09 |
| E-08 | Provider dispatch / assignment | `src/modules/work-order-assignments/`, `src/modules/vendor-assignments/`, `src/modules/vendor-work/`, `src/modules/task-assignments/` | Extend with accept / decline / reassignment / escalation semantics for Handyman dispatch. | HC-12 |
| E-09 | Location / arrival verification | `src/modules/mobile-verification/`, `src/modules/mobile-qr-resolution/`, `src/modules/visit-check-ins/`, `src/modules/mobile-assignments/` | Extend for Handyman arrival and location verification at the tenant unit. | HC-15 |
| E-10 | Warranty | `src/modules/asset-warranties/` | Extend as a **pattern reference** only — service warranty (HC-27/28) is a distinct aggregate and is NEW (§4). Reuse the lifecycle/vocabulary conventions, not the asset table. | HC-27, HC-28 |

---

## 4. NEW HANDYMAN CAPABILITIES

No Asentra equivalent exists. These are built inside the Handyman bounded context,
under `src/modules/handyman-*`, prefixed `handyman_`, mounted under `/handyman`.

Landed so far:

| # | Capability | Path | Status |
|---|---|---|---|
| N-00 | Handyman bounded-context identity + namespace gateway | `src/modules/handyman-foundation/` (`index.ts`, `handyman-foundation.types.ts`, `handyman-foundation.routes.ts`); test `tests/handyman-foundation.test.ts` | LANDED (HC-00 PART 01) |

To be built by their owning wave:

| # | Capability | Owning wave | Notes |
|---|---|---|---|
| N-01 | Building Handyman enablement & channel configuration | HC-01 | Per-Building on/off, allowed channels, service scope. |
| N-02 | BM Super App secure handoff + resident/tenant/building/unit context | HC-02 | Signed, expiring, replay-protected handoff token → resolved Handyman context. |
| N-03 | Immutable channel attribution | HC-03 | Written once at request creation; never mutable, never inferable later. |
| N-04 | Handyman service discovery surface + Tenant Handyman Request aggregate | HC-04 | Catalog projection for the Super App WebView/native; see §9. |
| N-05 | Initial triage, inspection routing & specialist escalation | HC-05 | Handyman-side routing decision. |
| N-06 | Inspection, diagnosis & scope classification | HC-06 | In-unit vs out-of-scope FM decision point (§8 boundary gate). |
| N-07 | Commercial Agreement + fee-rule versioning + commercial snapshot foundation | HC-07 | Versioned fee rules; immutable snapshot per request. |
| N-08 | Handyman pricing / rate execution | HC-08 | Executes rates; consumes price catalog as reference (§3 E-06). |
| N-09 | Customer decision, cancellation / reschedule policy & approval | HC-10 | Customer-side acceptance of a quotation. |
| N-10 | Handyman work order orchestration | HC-11 | Orchestrates the reused Work Order (§2 R-05). |
| N-11 | Provider dispatch lifecycle (accept/decline/reassign/escalate) | HC-12 | Extends assignment (§3 E-08). |
| N-12 | Work Crew, Lead Worker, Helper & crew replacement | HC-13 | Helpers have **no app and no login**; only the Lead Worker authenticates. |
| N-13 | Schedule / Building policy / access / no-show handling | HC-14 | Building policy is data, not code. |
| N-14 | Crew attendance & work-session lifecycle | HC-16 | The Work Session is the Handyman execution unit. |
| N-15 | Dynamic QC checklist binding | HC-18 | Binds to the reused checklist engine (§2 R-08). |
| N-16 | QC completion gate | HC-21 | Gate authority. |
| N-17 | Final charge authority & customer transaction ledger | HC-23 | Handyman-owned ledger; append-only. |
| N-18 | Provider entitlement & BM fee entitlement | HC-25 | Split of the final charge. |
| N-19 | Settlement & reconciliation | HC-26 | |
| N-20 | Service warranty activation, claim, eligibility, free rework vs chargeable additional work | HC-27, HC-28 | Distinct from asset warranty (§3 E-10). |
| N-21 | BM Super App integration APIs, callbacks, idempotency & replay protection | HC-31 | On top of the reused outbox/webhook (§2 R-13). |
| N-22 | Handyman exception-state orchestration & lifecycle consistency | HC-34 | |

---

## 5. DEPENDENCY DIRECTION

Strictly one-way. Handyman depends on Asentra. Asentra never depends on Handyman.

```
              composition root only
   src/app.ts  ──────────────►  src/routes/index.ts
                                        │
                                        ▼  (single mount point)
                        HANDYMAN_API_NAMESPACE  ('/handyman')
                                        │
                                        ▼
                        src/modules/handyman-foundation/
                                        │
                                        ▼
                        src/modules/handyman-*   (HC-01+)
                          │           │           │
              read-only   │           │           │  imports
              reference   ▼           ▼           ▼
        ┌──────────────────────────────────────────────────────┐
        │  Asentra capability modules  (src/modules/*)         │
        └──────────────────────────────────────────────────────┘
                          │
                          ▼
        src/shared/ · src/middleware/ · src/database/ · src/config/
```

D-01 — `src/modules/handyman-*` MAY import:
`src/shared/*`, `src/middleware/*`, `src/database/*`, `src/config/*`,
`src/modules/handyman-foundation/*`, and the **public exports** (`index.ts`) of
reused Asentra modules.

D-02 — `src/modules/handyman-*` MUST NOT import Asentra internal files
(`*.repository.ts`, `*.service.ts` internals) directly; it consumes the module's
`index.ts` surface.

D-03 — **No Asentra module may import anything from `src/modules/handyman-*`.**
Verified today, the only non-foundation reference to Handyman in `src/` is the mount
line in `src/routes/index.ts`. That must stay the only one.

D-04 — The composition root (`src/routes/index.ts`, reached from `src/app.ts`) is the
only place allowed to wire Handyman into the app.

D-05 — No import cycles. Handyman ↔ Asentra cycles are a design failure, not a lint
inconvenience.

D-06 — Dependency direction is checked at review time by grepping Asentra modules for
`handyman` imports.

---

## 6. ANTI-DUPLICATION RULE

A-01 — **No duplicate engine.** Where an Asentra capability can satisfy the requirement
through reuse or a bounded extension, a new Handyman engine is prohibited.

A-02 — Explicitly forbidden duplicates:

| Forbidden | Reuse / extend instead |
|---|---|
| A second building / location hierarchy | §2 R-01 |
| A second tenant or PIC registry | §2 R-02 |
| A second vendor / provider registry | §2 R-03 |
| A second workforce / person record | §2 R-04 |
| A second Work Order engine | §2 R-05 |
| A second Permit engine | §2 R-06 |
| A second scheduler / recurrence engine | §2 R-07 |
| A second checklist / form engine | §2 R-08 |
| A second finding / rework engine | §2 R-09 |
| A second SLA clock | §2 R-10 |
| A second notification engine or new transport adapter | §2 R-11, R-12 |
| A second outbox or webhook dispatcher | §2 R-13 |
| A second audit log | §2 R-14 |
| A second price catalog / rate table | §2 R-15, §3 E-06 |
| A second item master / SKU table | §3 E-04 (`inventory_items`) |
| A second BAST engine | §3 E-05 |
| A second evidence store / integrity or retention mechanism | §3 E-03 |
| A second UOM or category vocabulary | §2 R-16 |
| A second response envelope, error model, pagination, transaction helper, or migration runner | §2 R-17 |
| A second data-scope / RBAC model | §2 R-18 |

A-03 — Binding tables are the default extension mechanism. Prefer
`handyman_<x>_bindings` referencing an existing Asentra aggregate over copying that
aggregate's fields into a Handyman table.

A-04 — Snapshot ≠ duplicate. Where the roadmap requires immutability (commercial
snapshot HC-07, quotation version HC-09, channel attribution HC-03, final charge
HC-23), a frozen snapshot column is required and is **not** a duplication violation —
provided the live master remains the Asentra module and the snapshot is never read back
as master data.

A-05 — Any proposed new `src/modules/handyman-*` module must state, in its header
comment, which existing capability it reuses or extends, and why neither was sufficient.
This is the same convention already used in `src/modules/handyman-foundation/`.

---

## 7. HANDYMAN vs FM BOUNDARY

**Handyman does not absorb building / common-area Facility Management.**

Handyman is **in-unit, tenant-requested, chargeable** work inside a tenant's demised
space, initiated through the BM Super App and settled through the Handyman commercial
chain.

Building / common-area FM is **already owned** by the existing Asentra modules and stays
there.

### 7.1 Explicitly OUTSIDE Handyman (remain FM / Asentra)

- Main / riser pipe
- Pumps
- Building drainage
- Electrical distribution
- Fire systems
- Lift / elevator
- Genset
- AHU / chiller
- Structural systems
- Common-area systems generally

These remain outside the Handyman bounded context in full: no Handyman lifecycle, no
Handyman pricing, no Handyman BAST, no Handyman settlement, no Handyman warranty.

### 7.2 Boundary gate

B-01 — A Handyman request whose diagnosed scope touches §7.1 is **not** continued as
Handyman work. HC-05 (triage) and HC-06 (diagnosis / scope classification) are the
decision points that route it out.

B-02 — Routing out is a first-class outcome, not an error: the request is closed or
handed to the FM path with the reason recorded. Handyman must not quietly execute
common-area work.

B-03 — Handyman may **read** FM asset / location data (§2 R-01) to establish context.
Reading is not ownership.

B-04 — If a common-area system is genuinely in scope for a tenant charge, that is a
scope change to the frozen roadmap and requires an explicit CR. It is not decided inside
a PART.

---

## 8. HC WAVE OWNERSHIP

Derived from the frozen HC-00 … HC-35 sequence. Wave numbers, order, and scope are
frozen; this table only records which wave owns which capability decision.

| Wave | Owns | R/E/N |
|---|---|---|
| HC-00 | Governance, domain boundary, reuse map (PART 01 identity, PART 02 this map) | NEW (identity) |
| HC-01 | Building Handyman enablement & channel configuration | NEW |
| HC-02 | BM Super App secure handoff, resident/tenant/building/unit context | NEW + REUSE (R-01, R-02) |
| HC-03 | Immutable channel attribution | NEW |
| HC-04 | Service catalog / discovery & Tenant Handyman Request | EXTEND (E-01, E-02) + NEW |
| HC-05 | Initial triage, inspection routing, specialist escalation | NEW + boundary gate (§7.2) |
| HC-06 | Inspection, diagnosis & scope classification | NEW + boundary gate (§7.2) |
| HC-07 | Commercial Agreement, fee-rule versioning, commercial snapshot foundation | NEW |
| HC-08 | Pricing / rate execution foundation | EXTEND (E-06) + NEW |
| HC-09 | Quotation, immutable versioning, expiry / revision | EXTEND (E-07) + NEW |
| HC-10 | Customer decision, cancellation / reschedule policy, approval | NEW |
| HC-11 | Work order orchestration | REUSE (R-05) + NEW |
| HC-12 | Provider dispatch, accept/decline, reassignment, escalation | EXTEND (E-08) + NEW |
| HC-13 | Work crew, lead worker, helper, crew replacement | REUSE (R-04) + NEW |
| HC-14 | Schedule, building policy, permit, access, no-show / reschedule | REUSE (R-06, R-07) + NEW |
| HC-15 | Arrival & location verification | EXTEND (E-09) |
| HC-16 | Crew attendance & work-session lifecycle | REUSE (R-04) + NEW |
| HC-17 | Material request, approval, issue/purchase, usage, return, final usage | EXTEND (E-04) |
| HC-18 | Dynamic Handyman QC checklist binding | REUSE (R-08) + NEW |
| HC-19 | Evidence capture contract & photo-quality gate | EXTEND (E-03) |
| HC-20 | Defect/finding, rectification, re-inspection, rework | REUSE (R-09) |
| HC-21 | QC completion gate | NEW |
| HC-22 | Digital BAST, customer acceptance, BAST dispute | EXTEND (E-05) |
| HC-23 | Final charge authority & customer transaction ledger | NEW |
| HC-24 | Payment, receipt, failure, refund, reversal, adjustment | REUSE (R-05/R-17 patterns) + NEW |
| HC-25 | Provider entitlement & BM fee entitlement | NEW |
| HC-26 | Settlement & reconciliation | NEW |
| HC-27 | Service warranty activation | NEW |
| HC-28 | Warranty claim, eligibility, free rework vs chargeable additional work | NEW |
| HC-29 | Notification orchestration | REUSE (R-11, R-12) |
| HC-30 | SLA & provider performance | REUSE (R-10) |
| HC-31 | BM Super App integration APIs, callbacks, outbox/webhooks, idempotency, replay protection | REUSE (R-13) + NEW |
| HC-32 | Reporting / read models for customer, provider, BM finance & operations | REUSE (R-18) + NEW |
| HC-33 | Security, RBAC / data scope, privacy, retention, audit closure | REUSE (R-14, R-18) + NEW |
| HC-34 | Exception-state orchestration & lifecycle consistency | NEW |
| HC-35 | Full backend end-to-end journey validation | validation only |

Ownership rule: a capability has exactly **one** owning wave. A later wave may consume an
earlier wave's capability; it may not restate or re-implement it. Cross-wave needs are
resolved by dependency, never by duplication.

---

## 9. HC-04 FUTURE REQUIREMENT — SERVICE + COMMON MATERIAL PROFILE

HC-04 must deliver the Handyman catalog as a chain, not a flat list of services. This is
a **requirement recorded now** so HC-01–HC-03 do not build anything that contradicts it.
It is implemented in HC-04 only.

### 9.1 Required chain

```
Service
  → Service Variant
    → Common Material Profile
      → Material / SKU
        → image
        → specification / compatibility
        → reference price
        → typical quantity
        → commonality
        → customer-material option
```

### 9.2 Element definitions and anchors

| Element | Definition | Anchor (reuse / extend) |
|---|---|---|
| **Service** | Governed service identity offered to the tenant (e.g. "AC Service", "Leaking Tap Repair"). | EXTEND `src/modules/service-catalog/` (`0321`). Verified today it holds identity only (`code`, `name`, `description`, `category`, `status`) — variants, materials, and prices are HC-04 additions. |
| **Service Variant** | A concrete offering under a Service that changes scope/effort/price (e.g. AC Service 0.5 PK / 1 PK / 2 PK; wall type; single vs multi unit). One Service may expose many variants. | NEW `handyman_service_variants` (HC-04), referencing `service_catalog.id`. |
| **Common Material Profile** | The reusable, variant-level definition of the materials a job of this kind *typically* consumes — authored once, shared across requests. Not a per-request list. | NEW `handyman_common_material_profiles` + profile lines (HC-04). |
| **Material / SKU** | The actual material identity. | REUSE `src/modules/inventory-items/` (`0166`; `itemType` ∈ `SPARE_PART` / `MATERIAL` / `CONSUMABLE`, `uomId`). **No Handyman SKU table** (§6 A-02). |
| **image** | Display image for catalog presentation in the Super App. | REUSE the existing document/evidence storage conventions (§3 E-03) — no new storage mechanism. |
| **specification / compatibility** | Which variant/equipment the material applies to; prevents incompatible material selection at quotation and at issue time. | Profile-line attribute (HC-04); validated against variant context. |
| **reference price** | Indicative price shown/used as reference. | REUSE `src/modules/price-catalog-entries/` (`0319`) as price authority/reference (§2 R-15). Verified constraint: `price-catalog-lookup` currently excludes SERVICE prices, so service-level reference pricing is an EXTEND item (E-06), owned by HC-08 — HC-04 stores a reference only and never becomes the price authority. |
| **typical quantity** | The usual consumed amount, expressed in the material's UOM. | Profile-line attribute; UOM REUSE `src/modules/uoms/` (§2 R-16). |
| **commonality** | How routinely the material is consumed for this variant — the signal that separates "always needed" from "sometimes needed". Drives pre-staging and expectation setting. | Profile-line attribute (HC-04). |
| **customer-material option** | Whether the customer may supply the material themselves instead of purchasing it, and what that implies for charge, warranty, and responsibility. | Profile-line / variant attribute (HC-04); the commercial consequence is owned by HC-07/HC-08/HC-23, not by HC-04. |

### 9.3 HC-04 constraints

- The Common Material Profile is a **template**, not a commitment. Actual consumption is
  recorded by HC-17 against `inventory_items` and the material request/usage modules
  (§3 E-04). The profile never becomes the stock or usage record.
- Reference price in the catalog is **not** the charge. The charge comes from HC-08
  execution → HC-09 quotation → HC-23 final charge.
- `customer-material option` affects commercial outcome but does not create a second
  price path.
- Catalog content must be Client/Building-scoped consistently with the reused
  `service_catalog` scoping, and readable through the HC-02 secure handoff context.

---

## 10. SCOPE OF THIS PART

In scope (done here):
- This capability map document.

Out of scope (deliberately not done):
- No edit to `docs/roadmap/HANDYMAN_BACKEND_FROZEN_ROADMAP_v1.1.md`.
- No runtime code, no migration, no schema, no route, no module.
- No HC-01+ implementation.
- No broad repository audit, no unrelated refactor.

Validation for this PART: `npm run typecheck` (documentation-only change; expected
0 errors, confirming the baseline still compiles).

---

## 11. OPEN ITEM FOR HC-00 PART 03

Not a blocker for this PART. Recorded for the next PART:

- **HC-00 PART 03 scope is not yet defined.** This map fixes REUSE / EXTEND / NEW,
  dependency direction, the anti-duplication rule, the FM boundary, and wave ownership.
  The remaining HC-00 governance surface (as implied by the frozen title "Governance,
  Domain Boundary & Reuse Map" and by §7.2 boundary gate ownership in HC-05/HC-06) still
  needs its own PART definition before implementation begins.
- Dependency-direction and anti-duplication rules in §5/§6 are review-time rules today.
  Whether they get an automated check is a decision for a later PART, not this one.

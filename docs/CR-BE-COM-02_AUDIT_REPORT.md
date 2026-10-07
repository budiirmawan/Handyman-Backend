# CR-BE-COM-02 — AUDIT REPORT

**Commercial Commitment, Vendor Settlement & Closure**

Date: 2026-08-18  
Branch: `arena/01a0138c-asentra-backend`  
Baseline: `e7836a7` from `main`  
Scope: AUDIT ONLY — no implementation

---

## 1. Current PO Authority

| Component | Module | Status | Permission | Binding |
|---|---|---|---|---|
| Purchase Request (BE-17A) | `purchase-requests` | **EXISTS** — `OPEN → CANCELLED` | `purchase_request.read / .manage` | Client + Building scoped |
| Material Request (BE-17B) | `material-requests` | **EXISTS** — `OPEN → CANCELLED` | `material_request.read / .manage` | Scoped to Purchase Request |
| Service Request (BE-17C) | `service-requests` | **EXISTS** — `OPEN → CANCELLED` | `service_request.read / .manage` | Scoped to Purchase Request |
| Procurement Approval (BE-17D) | `procurement-approvals` | **EXISTS** — `PENDING → APPROVED / REJECTED` | `procurement_approval.read / .manage` | Binds to PR / MR / SR |
| Vendor Selection Readiness (BE-17E) | `vendor-selection-readiness` | **EXISTS** — `READY / NOT_READY / EXPIRED / INELIGIBLE` | `vendor_selection.read / .manage` | Evaluates Vendor vs Request |
| PO Readiness (BE-17F) | `purchase-order-readiness` | **EXISTS** — `READY / NOT_READY / BLOCKED` | `po_readiness.read / .manage` | Evaluates Approved + Vendor Selected → Ready |
| Receiving (BE-17G) | `receivings` | **EXISTS** — `RECEIVED → FINALIZED` | `receiving.read / .manage` | Requires READY PO Readiness; drives STOCK_IN |
| WO Procurement Binding (BE-17H) | `work-order-procurement-bindings` | **EXISTS** — `BOUND → READY → RECEIVED` | `work_order_procurement.read / .manage` | Links WO ↔ PR + optional MR/SR + Receiving |

**Verdict:** The full **Request → Approval → Vendor Selection → PO Readiness → Receiving** chain exists with backend-authoritative readiness gates. No formal Purchase Order (PO number / issue date / PO line items) entity exists — PO Readiness is a readiness snapshot, not an issued order. This is **by design** (no full procurement ERP per boundary).

**Gap:** No PO issuance entity. A READY PO Readiness is the closest authority to "PO is ready to issue." If downstream needs an explicit PO number/issue event, that is a missing authority.

---

## 2. Whether SPK / Service Order Exists

**No SPK (Surat Perintah Kerja) or Service Order module exists.** A search for `SPK`, `service_order`, `surat_perintah` across the entire source returns zero results.

The closest existing concept is the **BE-08 Work Order** (`work-orders`), which serves as the formal operational work record. The Work Order lifecycle (`OPEN → ASSIGNED → IN_PROGRESS → ON_HOLD → COMPLETED → CLOSED`) plus `BAST_REQUIREMENT` policy (`NONE / WORK_ORDER / EACH_VENDOR_WORK`) already carries the "formal work instruction" role that an SPK would serve.

**The BE-17C Service Request** is a procurement/service-demand line item, not an operational execution order. It feeds into PO Readiness but does not dispatch work.

**Verdict:** No SPK/Service Order module. The Work Order (BE-08) absorbs the SPK role. This is adequate for the current boundary (no full procurement ERP).

---

## 3. Request → PO/SPK Binding

| From | To | Binding Mechanism | Exists? |
|---|---|---|---|
| Purchase Request (BE-17A) | PO Readiness (BE-17F) | `purchaseRequestId` on `purchase_order_readiness` | ✅ Direct FK |
| Service Request (BE-17C) | PO Readiness (BE-17F) | `serviceRequestId` on `purchase_order_readiness` | ✅ Direct FK |
| Purchase Request (BE-17A) | Procurement Approval (BE-17D) | `purchaseRequestId` on `procurement_approval_bindings` | ✅ Direct FK |
| Service Request (BE-17C) | Procurement Approval (BE-17D) | `serviceRequestId` on `procurement_approval_bindings` | ✅ Direct FK |
| Purchase Request (BE-17A) | Vendor Selection (BE-17E) | `purchaseRequestId` on `vendor_selection_readiness` | ✅ Direct FK |
| Service Request (BE-17C) | Vendor Selection (BE-17E) | `serviceRequestId` on `vendor_selection_readiness` | ✅ Direct FK |
| Purchase Request (BE-17A) | Receiving (BE-17G) | `purchaseRequestId` on `receivings` | ✅ Direct FK |
| Service Request (BE-17C) | Receiving (BE-17G) | `serviceRequestId` on `receivings` | ✅ Direct FK |
| Purchase Request (BE-17A) | Work Order (BE-08) | **Via WO Procurement Binding (BE-17H)** | ✅ Indirect |
| Service Request (BE-17C) | Work Order (BE-08) | **Via WO Procurement Binding (BE-17H)** | ✅ Indirect |

**Traceability chain for procurement goods:**
```
PR → Approval → Vendor Selection → PO Readiness → Receiving → WO Procurement Binding → WO
```

**Traceability chain for service procurement:**
```
SR → Approval → Vendor Selection → PO Readiness → Receiving → WO Procurement Binding → WO
```

**Gap:** There is no direct `PR → WO` or `SR → WO` FK. The binding goes through `work_order_procurement_bindings`. This is correct (indirection allows many-to-one evolution), but it means tracing Request → WO requires a join through the binding table.

---

## 4. PO/SPK → Vendor Work / Work Order Binding

| From | To | Binding Mechanism | Exists? |
|---|---|---|---|
| Work Order (BE-08) | Vendor Assignment (BE-15A) | `workOrderId` on `vendor_assignments` | ✅ Direct FK |
| Vendor Assignment (BE-15A) | Vendor Work (BE-15B) | `vendorAssignmentId` on `vendor_works` (1:1 resolve) | ✅ Direct FK |
| Work Order (BE-08) | Vendor Work (BE-15B) | `workOrderId` on `vendor_works` (via assignment) | ✅ Transitive |
| WO Procurement Binding (BE-17H) | Work Order (BE-08) | `workOrderId` on binding | ✅ Direct FK |
| WO Procurement Binding (BE-17H) | Purchase/Service Request | `purchaseRequestId` / `serviceRequestId` on binding | ✅ Direct FK |
| WO Procurement Binding (BE-17H) | Receiving (BE-17G) | `receivingId` on binding (optional, linked later) | ✅ Direct FK |

**Full traceability:**
```
Request → [Approval] → [Vendor Selection] → [PO Readiness] → Receiving
  → WO Procurement Binding → Work Order → Vendor Assignment → Vendor Work
```

**Verdict:** The binding chain from procurement request through receiving to vendor work is fully wired. Each link has FK integrity, Client/Building scope validation, and backend-authoritative lifecycle gates.

**Gap:** The WO Procurement Binding does not carry a `vendorId`. Vendor identity flows through the Vendor Assignment on the WO side, and through the PO Readiness / Vendor Selection on the procurement side. There is no explicit cross-check that the vendor who was selected in procurement matches the vendor assigned to the work order. This is a **traceability gap** — not a data integrity gap (each side is independently valid), but a **commercial consistency** gap.

---

## 5. Completion / Verification / BAST Linkage

| Step | Module | Authority | Status |
|---|---|---|---|
| Vendor Work Completion | `vendor-work` | `COMPLETED` is terminal (rework via BE-15J) | ✅ |
| Vendor Completion Report | `vendor-completion-reports` | Pinned on BAST via `completionReportId` | ✅ |
| Vendor Service Report | `vendor-service-reports` | Pinned on BAST via `serviceReportId` | ✅ |
| Work Completion Document | `work-completion-documents` | Pinned on BAST via `workCompletionDocumentId` | ✅ |
| Work Order Verification (BE-08I) | `work-order-verification` | Reuses BE-07 Review: `APPROVED / REJECTED / REWORK_REQUIRED` | ✅ |
| Vendor Work Rework (BE-15J) | `vendor-rework` | `REQUESTED → RESUBMITTED`, gates BAST resubmission | ✅ |
| BAST Document (CR-BE-BAST-01) | `bast-documents` | `DRAFT → SUBMITTED → ACCEPTED / REJECTED`; canonical lifecycle | ✅ |
| BAST Closure Readiness | `bast-closure-readiness` | Evaluates `bastRequirement` policy per WO | ✅ |
| BAST Reconciliation | `bast-reconciliation` | Inventory / severity / classification; quarantine gate | ✅ |
| Vendor BAST Bindings (BE-15H compat) | `vendor-bast-bindings` | Legacy shape with `bast_document_id` → canonical link | ✅ Compatibility |
| Work Order `bastRequirement` | `work-orders` | `NONE / WORK_ORDER / EACH_VENDOR_WORK` | ✅ Policy on WO |

**BAST submission gates (all enforced):**
1. Work Order must be `COMPLETED`
2. Vendor Work (if applicable) must be `COMPLETED`
3. Latest Work Order verification review must be `APPROVED`
4. Latest Vendor Work verification review must be `APPROVED` (if vendor-scoped)
5. No open Vendor Work rework
6. No open BAST acceptance Findings (on first submit)
7. Completion Report must be `SUBMITTED` with evidence ready (for vendor-scoped BAST)
8. Service Report must be `FINALIZED` (if present)
9. No open reconciliation quarantine
10. Required evidence must be satisfied

**BAST closure readiness gates (evaluated, not enforced):**
- `CANONICAL_CONTEXT_MISMATCH`
- `NO_APPLICABLE_VENDOR_WORK`
- `REQUIRED_BAST_MISSING`
- `REQUIRED_BAST_CARDINALITY_VIOLATION`
- `REQUIRED_BAST_NOT_ACCEPTED`
- `ACCEPTANCE_NOT_TRACEABLE`
- `RECONCILIATION_QUARANTINED`
- `UNRESOLVED_BAST_REWORK`
- `UNRESOLVED_VENDOR_REWORK`

**Verdict:** The Completion → Verification → BAST chain is the most mature and fully-wired part of the commercial domain. CR-BE-BAST-01 established a canonical BAST with all the necessary gates.

**Gap:** BAST closure readiness is *evaluated* (read-only) but does not *enforce* closure. Work Order closure (`COMPLETED → CLOSED`) is the sole owner of the transition. The closure readiness result could be made a mandatory pre-condition (hard gate) rather than just informational. Currently, a Work Order can theoretically be closed without all BASTs being accepted — the readiness is advisory only.

---

## 6. Vendor Invoice Authority

**No Vendor Invoice module exists.** There is no `vendor-invoices` or `vendor-invoice` module, no `vendor_invoice` table in migrations, and no `VENDOR_INVOICE` entity type anywhere in the codebase.

The closest existing modules:

| Module | Role | Limitation |
|---|---|---|
| `tenant-invoices` | Tenant-facing invoices (DRAFT → FINALIZED → CANCELLED) | Scoped to `tenantCompanyId`, sourced from `TENANT_CHARGE` or `UTILITY_BILL` only. **Not vendor-facing.** |
| `vendor-service-costs` (BE-19G) | Operational costing (DRAFT → FINALIZED → CANCELLED) | Cost recording only, `VENDOR_WORK` or `SERVICE_REQUEST` context. **No invoice number, no due date, no line items, no tax, no AP.** |
| `invoice-payment-status` (BE-19E) | Settlement state tracking | Hard-bound to `tenant-invoices` (`invoiceId` → `tenantInvoiceId`). **Cannot reference a vendor invoice because none exists.** |
| `payment-receipts` | Payment receipt (ISSUED / VOID) | Hard-bound to `invoicePaymentStatusId` which chains to `tenantInvoiceId`. **Tenant-only.** |

**Verdict:** **Critical gap.** There is no vendor invoice authority. The entire tenant invoice → payment status → payment receipt chain exists only for tenant receivables. No vendor payables chain exists.

**What exists for vendor cost tracking:**
- `vendor-service-costs` records costs with `vendorWorkId` / `serviceRequestId` context
- Costs go `DRAFT → FINALIZED → CANCELLED`
- A finalized cost is an immutable cost record, but it is **not an invoice** — no invoice number, no due date, no payment terms, no line-item structure

---

## 7. Vendor Invoice Verification Authority

**Does not exist.** Since no vendor invoice entity exists, there is naturally no verification authority for vendor invoices.

The existing verification chain is:
- Work Order verification (BE-08I) — reuses BE-07 Review
- Vendor Work verification — reuses BE-07 Review (via `vendor-rework`)
- BAST acceptance — `SUBMITTED → ACCEPTED / REJECTED` with sign-offs

None of these verify a **vendor's invoice** (a document claiming payment). They verify **work completion and acceptance**.

**Gap:** A vendor invoice verification step (3-way match: PO Readiness → Receiving → Vendor Invoice, or 2-way match: Service Cost → Vendor Invoice) is entirely absent.

---

## 8. Payment Readiness / Status Authority

| Module | Scope | Status |
|---|---|---|
| `invoice-payment-status` | Tenant invoices only (`UNPAID / PARTIALLY_PAID / PAID / OVERDUE / CANCELLED`) | ✅ Exists, tenant-only |
| `payment-receipts` | Tenant receipts only (`ISSUED / VOID`) | ✅ Exists, tenant-only |
| `service-charge-readiness` | Tenant service charge readiness (`READY / NOT_READY / INCOMPLETE`) | ✅ Exists, tenant-only |
| Vendor payment status | — | ❌ **Does not exist** |
| Vendor payment readiness | — | ❌ **Does not exist** |

The `invoice-payment-status` service correctly resolves derived status (OVERDUE vs PARTIALLY_PAID) and supports `refreshDerived` for time-based transitions. But it is architecturally bound to `tenant-invoices` via `invoiceId` FK.

**Gap:** No vendor payment authority. There is no way to:
1. Track vendor invoice payment status
2. Record vendor payment events
3. Determine payment readiness for a vendor (e.g., "all accepted BASTs + finalized vendor service costs → payable")
4. Issue vendor payment disbursements

---

## 9. End-to-End Traceability Gaps

### Gaps Found

| # | Gap | Severity | Description |
|---|---|---|---|
| G1 | **No Vendor Invoice** | **CRITICAL** | No vendor-facing invoice entity. The entire AP side of commercial commitment is absent. |
| G2 | **No Vendor Payment Status** | **CRITICAL** | No vendor payment tracking. `invoice-payment-status` is tenant-only. |
| G3 | **No Vendor Invoice Verification** | **HIGH** | No 2-way/3-way match authority. Cannot verify a vendor's invoice against receiving + cost records. |
| G4 | **Vendor Consistency Cross-Check** | **MEDIUM** | No validation that the vendor selected in procurement (Vendor Selection / PO Readiness) matches the vendor assigned to the corresponding Work Order (Vendor Assignment). Two independent vendor references with no reconciliation. |
| G5 | **No PO Issuance Entity** | **MEDIUM** | PO Readiness is a snapshot, not an issued PO. No PO number, issue date, or line items. If external parties (vendor, auditor) need a PO document, it must be generated. |
| G6 | **BAST Closure Not a Hard Gate** | **LOW** | Work Order closure readiness is advisory only. A WO can be closed without all required BASTs being accepted. |
| G7 | **No Vendor Settlement Summary** | **MEDIUM** | No module aggregates finalized vendor service costs + accepted BASTs into a settlement-readiness view per vendor per period. |
| G8 | **OpenAPI Coverage Gap** | **LOW** | Only `/bast-documents` paths are in the OpenAPI spec. Purchase requests, PO readiness, vendor selection, receivings, procurement approvals, WO procurement bindings, vendor service costs, invoice payment statuses — all absent from `openapi.yaml`. |

### Connected Trace (what works today)

For **goods procurement** (full chain with receiving):
```
PR ──→ Approval ──→ Vendor Selection ──→ PO Readiness ──→ Receiving (STOCK_IN)
 │                                                          │
 └──→ WO Procurement Binding ──→ Work Order ──→ Vendor Assignment ──→ Vendor Work
                                       │
                                       └──→ Completion → Verification → BAST → Acceptance
```

For **service procurement** (no stock movement):
```
SR ──→ Approval ──→ Vendor Selection ──→ PO Readiness ──→ Receiving (SERVICE)
 │                                                          │
 └──→ WO Procurement Binding ──→ Work Order ──→ Vendor Assignment ──→ Vendor Work
                                       │
                                       └──→ Completion → Verification → BAST → Acceptance
```

For **vendor cost recording** (partial):
```
Vendor Work ──→ Vendor Service Cost (DRAFT → FINALIZED)
                    │
                    └──→ ❌ NO VENDOR INVOICE
                              ❌ NO VENDOR PAYMENT
```

For **tenant settlement** (fully wired, but tenant-side only):
```
Tenant Charge / Utility Bill ──→ Tenant Invoice (DRAFT → FINALIZED)
                                       │
                                       └──→ Invoice Payment Status (UNPAID → PAID)
                                              │
                                              └──→ Payment Receipt (ISSUED / VOID)
```

---

## Reusable Foundations

| Foundation | Module | Reusability for Vendor Side |
|---|---|---|
| Invoice pattern (DRAFT → FINALIZED → CANCELLED) | `tenant-invoices` | **High** — same lifecycle, line-item pattern, Client/Building scope |
| Payment status resolver (UNPAID / PARTIALLY_PAID / PAID / OVERDUE) | `invoice-payment-status` | **High** — `resolveInvoicePaymentStatus` is pure logic, already parameterized |
| Payment receipt (ISSUED / VOID) | `payment-receipts` | **High** — same pattern, just needs vendor-scoped FK |
| Readiness pattern (evaluate checks → resolve status) | `vendor-selection-readiness`, `purchase-order-readiness` | **High** — same check/resolution pattern reusable for settlement readiness |
| Cost recording (DRAFT → FINALIZED → CANCELLED) | `vendor-service-costs` | **Already vendor-side** — extends naturally |
| Document foundation | `documents` | **High** — versioned, immutable, evidence-attached documents |
| BAST canonical lifecycle | `bast-documents` | **Already canonical** — vendor BASTs already exist |
| Procurement approval binding | `procurement-approvals` | **High** — same pattern could bind approval to vendor invoices |
| RBAC permission pattern | `permissions` | **High** — `vendor_invoice.read / .manage`, `vendor_payment.read / .manage` follow existing convention |

---

## Missing Authorities

| Authority | Priority | Effort | Depends On |
|---|---|---|---|
| Vendor Invoice (DRAFT → FINALIZED → CANCELLED) | **P0** | Small-Medium | `vendor-service-costs` (for line items or cost reference), `vendor` master, `work-orders` or `vendor-work` (for scope) |
| Vendor Invoice Verification (2-way match: Cost → Invoice) | **P1** | Small | Vendor Invoice, `vendor-service-costs`, `receivings` |
| Vendor Payment Status (UNPAID → PAID) | **P1** | Small | Vendor Invoice, `invoice-payment-status` pattern |
| Vendor Payment Receipt / Disbursement Record | **P2** | Small | Vendor Payment Status, `payment-receipts` pattern |
| Vendor Settlement Readiness (aggregates costs + accepted BASTs → payable) | **P2** | Small | Vendor Invoice, `bast-documents`, `vendor-service-costs` |
| Vendor Consistency Cross-Check (procurement vendor = WO assignment vendor) | **P3** | Trivial | `work-order-procurement-bindings`, `vendor-assignments` |
| BAST Closure Hard Gate | **P3** | Trivial | `bast-closure-readiness`, `work-orders` |

---

## Recommended PART Breakdown

### PART 01 — Vendor Invoice Authority (P0)
**Scope:** Vendor Invoice entity (DRAFT → FINALIZED → CANCELLED) with:
- `vendorId` (required, ACTIVE vendor in same Client)
- `workOrderId` (optional scope)
- `vendorWorkId` (optional scope)
- `serviceRequestId` (optional scope)
- Line items referencing `vendor_service_costs` (FINALIZED costs only)
- Invoice number (unique per Client), invoice date, due date
- Client/Building scoping, RBAC (`vendor_invoice.read / .manage`)
- Reuse `tenant-invoices` patterns for lifecycle

**Dependencies:** `vendor-service-costs`, `vendor` master, `work-orders`, `vendor-work`  
**Does NOT include:** Payment, tax, GL, AP, verification/matching

### PART 02 — Vendor Invoice Verification / Matching (P1)
**Scope:** 2-way match authority:
- Cost-to-invoice matching: each vendor invoice line must reference a FINALIZED vendor service cost
- Optional receiving cross-reference (for goods: receiving → cost → invoice chain)
- Verification status: `UNVERIFIED / MATCHED / DISPUTED`
- RBAC: `vendor_invoice_verification.read / .manage`

**Dependencies:** PART 01, `receivings`, `vendor-service-costs`

### PART 03 — Vendor Payment Status (P1)
**Scope:** Vendor payment tracking:
- Reuse `invoice-payment-status.resolveInvoicePaymentStatus` pattern
- Scoped to vendor invoice (not tenant invoice)
- Status: `UNPAID / PARTIALLY_PAID / PAID / OVERDUE / CANCELLED`
- Payment recording (paid amount, paid date, reference)
- Derived status refresh (OVERDUE resolution)
- RBAC: `vendor_payment_status.read / .manage`

**Dependencies:** PART 01, `invoice-payment-status` (pattern reuse)

### PART 04 — Vendor Settlement Readiness (P2)
**Scope:** Settlement readiness evaluation per vendor per period:
- Aggregates: all FINALIZED vendor invoices with MATCHED verification
- Prerequisite: all applicable BASTs for the vendor's work must be ACCEPTED
- Readiness: `READY / NOT_READY / BLOCKED`
- Blocker reasons: `UNVERIFIED_INVOICE / UNACCEPTED_BAST / OPEN_REWORK / OUTSTANDING_COSTS`

**Dependencies:** PART 01, PART 02, PART 03, `bast-documents`, `vendor-service-costs`

### PART 05 — Vendor Consistency Cross-Check + BAST Hard Gate + OpenAPI (P3)
**Scope:**
- WO Procurement Binding vendor consistency: validate procurement vendor = WO assignment vendor
- BAST closure hard gate: Work Order closure requires `bastClosureReadiness.ready === true`
- OpenAPI paths for all commercial endpoints

**Dependencies:** `work-order-procurement-bindings`, `vendor-assignments`, `bast-closure-readiness`, `work-orders`

---

## Dependencies

```
PART 01 (Vendor Invoice)
  ├── vendor-service-costs (FINALIZED costs as line items)
  ├── vendor (master, ACTIVE check)
  ├── work-orders (scope context)
  ├── vendor-work (scope context)
  └── tenant-invoices (pattern reuse: lifecycle, line items)

PART 02 (Vendor Invoice Verification)
  ├── PART 01
  ├── receivings (3-way reference for goods)
  └── vendor-service-costs (2-way match source)

PART 03 (Vendor Payment Status)
  ├── PART 01
  └── invoice-payment-status (pattern reuse: resolver, derived refresh)

PART 04 (Vendor Settlement Readiness)
  ├── PART 01
  ├── PART 02
  ├── PART 03
  ├── bast-documents (ACCEPTED BAST prerequisite)
  └── vendor-service-costs (outstanding cost check)

PART 05 (Consistency + Hard Gate + OpenAPI)
  ├── work-order-procurement-bindings
  ├── vendor-assignments
  ├── bast-closure-readiness
  └── work-orders
```

---

## Blockers

| Blocker | Severity | Description |
|---|---|---|
| **No vendor invoice entity** | **Hard** | PART 01 cannot proceed without defining the vendor invoice schema, migration, types, repository, service, controller, routes, and validation. However, all patterns are well-established in `tenant-invoices` — this is a greenfield implementation with proven patterns, not an architectural blocker. |
| **No vendor payment permission seeds** | **Soft** | `vendor_invoice.read / .manage` and `vendor_payment_status.read / .manage` permissions must be seeded. The existing seed infrastructure (`db:seed`) supports this — not a real blocker. |
| **OpenAPI contract incomplete** | **Soft** | Commercial endpoints are absent from `openapi.yaml`. This does not block implementation (the backend router is the registration authority per README), but should be addressed in PART 05. |

---

## Ready for PART 01: **YES**

**Rationale:**

1. All dependencies for PART 01 exist and are production-quality:
   - `vendor-service-costs` provides FINALIZED cost records as line-item sources
   - `vendor` master provides ACTIVE vendor validation and Client/Building scope
   - `work-orders` and `vendor-work` provide operational scope context
   - `tenant-invoices` provides a proven lifecycle pattern to reuse
   - RBAC infrastructure is mature (`requirePermission` middleware)
   - Building isolation infrastructure is mature (`contextAccessService`)

2. No architectural blockers exist — PART 01 is a standard entity following existing patterns.

3. The scope is bounded correctly:
   - No full AP (no GL, no tax engine, no 3-way matching)
   - No payment (that's PART 03)
   - No verification (that's PART 02)
   - Invoice entity + lifecycle + line items only

4. The codebase conventions are clear and consistent across all inspected modules:
   - Types → Repository → Service → Controller → Routes → Validation → Index
   - `toPublic*` projection, `New*` / `Create*Input` separation
   - Client/Building scope assertion
   - Operational event recording
   - Permission-based RBAC on routes

**STOP. PART 01 is NOT implemented. No PR. No merge.**

# CR-HM-06 — START GOVERNANCE (Quotation & Customer Approval)

**Status: DRAFT GOVERNANCE, base `8b71d1c`, 2026-09-27.** Docs-only:
NO code, NO migration, NO test, NO OpenAPI change. Sources read
(exclusive): frozen roadmap CR-HM-06 row + matrix/derivation rows;
CR-HM-00 capability-map rows 8/9 (Quotation / Customer Quotation
Approval) + ownership-matrix rows 8/9/18/27; CR-HM-02 request/catalogue/
material-reference public seams; CR-HM-03 diagnosis + referral public
seams (incl. 0382 scope authority); CR-HM-04 PART 04 assignment
boundary; CR-HM-05 PART 05 target-binding contract; nearest existing
quotation/estimate/price-approval patterns (`src/modules/vendor-
quotations`, `src/modules/price-catalog-entries`, `src/modules/
bast-documents` names only). No broad repo scan performed.

## Frozen wording basis (roadmap, verbatim)

- Scope list: *quotation, labor/material separation, scope snapshot,
  customer quotation approval*.
- Preserve: *SaaS Package Price != Handyman quotation/final charge;
  Quotation Approval != Payment Confirmation.*
- Matrix row: *…approval creates authorized execution scope…*
- Dependencies: **CR-HM-02, CR-HM-03 → CR-HM-06**; CR-HM-06 →
  CR-HM-05, CR-HM-07, CR-HM-09, CR-HM-13, CR-HM-17.
- Capability-map rows 8/9: quotation = **NEW**, approval = **NEW**;
  `bast-documents` is post-work acceptance, **not** quotation-approval
  authority; `price-catalog-entries` is reference-price input only.

## A. Quotation authority

The authoritative Handyman quotation is a **NEW Handyman-owned,
immutable, versioned** document created **after** the CR-08 lineage:

`request (0378) → diagnosis/scope authority (0382, entity `handyman_request_diagnoses`) → estimate composition → quotation version →
customer decision`

Minimum mapped content (contract mapping only, NOT persistence):

- **request lineage**: `clientId`, `channelAttributionId`,
  `handymanRequestId`, `tenantCompanyId`, `tenantPicId` (nullable,
  preserved-not-fabricated), `buildingId`, `spaceId`,
  `originChannel/originReference` — all derived from the CR-HM-01/02
  attribution+request chain, never caller-supplied.
- **service/scope snapshot**: `handymanDiagnosisId`, verbatim
  `disciplineCode`, server-derived `scopeClassification` snapshot,
  `recommendedServiceCatalogId` / `serviceVariantId` snapshots. The
  quotation never re-classifies scope; it snapshots CR-HM-03's
  authority.
- **labor lines** and **material lines** (separation mandatory per
  frozen roadmap wording) with **quantity + unit (UOM)** per line;
  other governed charge lines only where an existing authority exists —
  none exists at freeze, so none are invented.
- **amounts per line**: reference unit price (informational input),
  **final quoted unit amount** (the commercial fact the customer sees),
  line total; **subtotal** = sum of lines; **total** = subtotal.
  **Tax/discount: NO authority exists at freeze ⇒ NOT included** (CR-HM-12 may later supply governed
  commercial adjustments; inventing one now would steal future
  authority).
- **validity**: expiry timestamp per quotation version.
- **version/revision**: integer version; each version is an immutable
  record; a revision NEVER mutates an earlier version's commercial
  facts.
- **status**: bounded lifecycle per §F.
- **customer approval provenance**: reference to the exact approved
  version + approval record (§D).

NOT implemented in this governance PART.

## B. Pricing boundary (CR-HM-12 interlock)

CR-HM-12 (Pricing & Commercial Agreement, later CR) remains authority
for pricing-mode execution, commercial agreement versioning, and BM fee
rules. CR-HM-06 may:

- **consume** the existing governed `price-catalog-lookup` resolver
  (building scope anchor + exact currency + as-of, fail-closed) and
  CR-HM-02 material **reference-price views** as *inputs only*;
- persist **bounded actor-chosen final quoted amounts** as immutable
  quotation snapshots.

CR-HM-06 must NOT: create pricing rules/modes, commercial agreements,
BM fee calculations, FX/currency logic, or any SaaS-subscription price
semantics. **Catalogue/reference price != final quoted charge** —
enforced structurally: the frozen amount on a quotation version is the
only charge-visible fact a customer can approve.

## C. Material boundary

CR-HM-02 common material profiles + composed reference price are
**informational at read time** (never persisted there). Quotation
material lines must be **immutable commercial snapshots**: item identity
+ specification + quantity + UOM + final quoted unit amount are copied
onto the line; later inventory price/catalog changes CANNOT alter an
approved quotation. Reuse: inventory-item existence validation and the
price-catalog lookup at composition time. NEW: quotation material-line
snapshot persistence (live FK pointers to mutable price facts are
FORBIDDEN on approved versions).

## D. Customer approval

Authoritative customer identity/context available from the chain:

- `tenantCompanyId` + `tenantPicId` (+ building/space) snapshotted
  from CR-HM-01 channel attribution into the CR-HM-02 request — the
  customer *context holder*; the attribution's `createdByUserId` and the
  request's session actor provide audit provenance but are NOT assumed
  to be the customer.
- **Actor rule**: the approver is the **authenticated local session
  user** holding client-scoped RBAC on the request's `clientId`
  (existing `tenant_company.*` conventions); the backend derives the
  customer context from the request. **Caller-supplied customer
  identity is never trusted**; `tenantPicId` is never required to equal
  the acting session user (BM/tenant-org delegation is a policy later
  CRs may encode, not authority we invent).

Approval semantics:

- an explicit decision record **APPROVE | REJECT** (or a
  **policy-permitted revision request** per capability-map row 9),
  bound to the **exact quotation version presented** (quotationId +
  version), with server timestamp and actor;
- exactly **one decision per quotation version** (uniqueness +
  serialized lock in one transaction — follow the existing
  `withTransaction` convention);
- **replay/idempotency**: follow the existing vendor-quotation
  `idempotencyKey`/`idempotencyFingerprint` pattern;
- **concurrency**: `lockById` on the target version before decision
  evaluation; a second concurrent decision against a decided/superseded
  version fails closed;
- rejection is terminal **for that version**; changes require a NEW
  immutable version (revision), never mutation of presented/approved
  facts.

## E. Execution scope (critical governance decision)

Frozen roadmap wording: *"approval creates authorized execution scope."*
The **authoritative Handyman Execution Scope** is created **only** as
the transactional side-effect of a valid Customer Quotation Approval —
in the SAME atomic transaction as the approval record (no approval
without scope, no scope without approval).

Minimum scope identity + lineage (contract shape only):

- `executionScopeId`, `clientId`;
- lineage: `handymanRequestId`, `channelAttributionId`,
  `tenantCompanyId`, `tenantPicId` (nullable), `buildingId`, `spaceId`;
- provenance: `quotationId`, `quotationVersion`, `approvalId`,
  server timestamps, `createdByUserId`;
- **verbatim commercial/scope snapshot refs**: the approved quotation
  version (itself carrying diagnosis/discipline/service snapshot) — the
  execution scope references the immutable commercial facts it is
  authorized to perform, without copying pricing authority;
- **location authority preserved**: buildingId/spaceId chain required
  by CR-HM-07 expected-location verification;
- **lifecycle status**: bounded, starting at an APPROVED/ASSIGNABLE
  state; work/session semantics are CR-HM-08's, never encoded here.

This is sufficient authority for: CR-HM-04's §3/§4 future assignment
target validation (same-client target in assignable state, provider
authorization), CR-HM-05 PART 05's §3/§4 binding shape
(`executionScopeId` + schedulable state + request-lineage agreement),
CR-HM-07 arrival verification (expected building/floor/unit via the
location chain against approved/scheduled/assigned work), and
CR-HM-08's future work-session anchor.

**Execution Scope != FM work order.** Existing FM `work_orders` are
FORBIDDEN as substrate (CR-HM-04 PART 04 §2/§10; CR-HM-05 PART 05 token
`FM_WORK_ORDER_REUSE=FORBIDDEN`): no reuse, no enrichment of FM WO,
no FM lifecycle adoption. Placeholder targets likewise FORBIDDEN
(`PLACEHOLDER_TARGET=FORBIDDEN`).

## F. Lifecycle (minimum, Handyman-only)

Quotation version lifecycle (bounded vocabulary, NO procurement/FM
states imported):

- `DRAFT` — preparation; freely editable prior to presentation;
- `ISSUED` — submitted/presented to the customer (one presented version
  at a time per quotation thread; presentation freezes facts);
- `APPROVED` — terminal; immutable; creates Execution Scope (§E);
- `REJECTED` — terminal for that version;
- `EXPIRED` — validity passed without decision (server-evaluated);
- `SUPERSEDED` — replaced by a newer issued version (facts preserved).

**Revision = NEW immutable version**, never mutation of approved
commercial facts (mandatory; capability-map row 8: snapshots immutable,
later catalog/pricing changes do not alter a presented quotation).
`WITHDRAWN` (vendor-side concept from `vendor-quotations`) is NOT
imported: customer-facing withdrawal is a policy concern for later CRs,
not CR-HM-06 authority. Execution-scope lifecycle beyond
APPROVED/ASSIGNABLE is owned by CR-HM-07/08 consumers and is out of
CR-HM-06 scope.

## G. Existing seams classification

| Seam | Class | Basis |
|---|---|---|
| Quotation | **NEW** | capability-map row 8 = NEW; `vendor-quotations` is pattern-only (revision immutability + idempotency pattern), never reused (RFQ/vendor semantics) |
| Pricing snapshot | **REUSE + NEW** | REUSE `price-catalog-lookup` governed resolver + CR-HM-02 reference-price view as inputs; NEW immutable line snapshots |
| Customer approval | **NEW** | capability-map row 9 = NEW; `bast-documents` NOT reused (post-work acceptance ≠ quotation approval) |
| Execution scope | **NEW** | no Handyman target entity exists (CR-HM-04 PART 04 §0; CR-HM-05 PART 05 §1); FM `work_orders` FORBIDDEN |
| Audit/history | **REUSE** | `operational_events` + append-only/snapshot conventions; `src/modules/audit` shared infrastructure per capability-map row 9 dependency list |
| RBAC/session/idempotency | **REUSE** | `tenant_company.*` permissions, session actor derivation, `idempotencyKey/Fingerprint` + `withTransaction`/`lockById` conventions |

## H. Firewalls (frozen for CR-HM-06)

- Quotation approval != BAST acceptance (CR-HM-11).
- Quotation approval != payment (CR-HM-13 owns transaction/ledger).
- Quotation approval != work completion (CR-HM-08/10).
- Execution Scope != Work Session (CR-HM-08); Execution Scope != FM
  Work Order.
- NO scheduling/crew binding runtime in CR-HM-06 (bound by the frozen
  CR-HM-05 PART 05 activation rule + CR-HM-04 PART 04 deferral).
- NO payment ledger (CR-HM-13), NO BAST (CR-HM-11), NO tax/discount
  invention (§A), NO pricing rules (CR-HM-12, §B).

## Questions (explicit answers)

**Q1 Reusable vs pattern-only pricing/quotation seams:**
Reusable: `price-catalog-lookup` governed resolver (input only),
CR-HM-02 material reference-price view (input only), `operational_events`/
audit, RBAC/session/idempotency/`lockById`/`withTransaction`
  conventions.
Pattern-only: `vendor-quotations` (immutable revisions, idempotency
fields, line composition), `bast-documents` (decision-provenance
shape), FM PTW checks. NO existing quotation/approval/FM table is reused as
substrate.

**Q2 Customer approval identity/context authority:**
The authenticated local session user with client-scoped RBAC on the
request's `clientId`; customer context (`tenantCompanyId`,
`tenantPicId`, building/space) derived server-side from the CR-HM-01
attribution → CR-HM-02 request chain. Caller-supplied identity never
trusted.

**Q3 Minimum immutable approved-quotation snapshot:**
request lineage refs (client/attribution/request/tenant/company/PIC);
location chain (building/space); verbatim scope snapshot (diagnosisId,
disciplineCode, scopeClassification, service catalogue/variant refs);
labor lines + material lines separated, each with quantity, UOM,
reference unit price (informational), final quoted unit amount, line
total; currency; subtotal; total; validity/expiry; version number;
status; actor + server timestamps; approval provenance reference.
NO tax/discount (no authority at freeze).

**Q4 Exact event creating the Execution Scope:**
A valid customer **APPROVE decision against the exact presented
quotation version** — one atomic transaction that (a) persists the
terminal approval record and (b) inserts the Execution Scope. The
scope has no other creation path.

**Q5 Minimum Execution Scope shape for CR-HM-04/05/07/08:**
identity + client + full request/channel lineage + approved
quotation-version provenance (immutable commercial facts ref) +
location chain (building/space for expected-location verification) +
bounded lifecycle starting at an assignable/schedulable approved
state + actor/server timestamps. No scheduling, assignment, session,
or verification fields (consumer-owned later).

**Q6 Can execution scope be created before customer approval?**
**NO.** Frozen roadmap: approval creates the scope; CR-HM-05 PART 05
§1/§10 forbids binding before the entity exists and forbids
placeholders; CR-HM-04 PART 04 §0/§2 confirms no assignable target
exists until the owning CR creates it. No frozen authority supports
pre-approval scope creation.

**Q7 CR-HM-12 dependency = blocker?**
**NO blocker.** CR-HM-12 supplies pricing-mode execution/commercial
agreement/fee-rule authority *later*; CR-HM-06 requires none of those
at freeze: consumed inputs already exist (governed lookup + reference
prices), and final quoted amounts are CR-HM-06's own immutable
commercial snapshots approved by the customer — CR-HM-12's future
contracts will govern *how prices are computed/managed*, without
retroactively invalidating approved snapshots (immutability preserved
by both capability-map rows and the matrix).

## CR-HM-05 carried observation

`operational_events` rows written inside one transaction share a
transaction `created_at`; ordering assertions that tie-break on UUID
`id` are nondeterministic (P02/P03 atomicity-test flake class, PART 04
history suite already resolves events by `event_type`/`entity_id`).
**Non-blocking hardening debt** — journal ordering is audit-only, not
authority (CR-HM-05 FINAL VALIDATION §12). CR-HM-06 does NOT fix it
unless directly required; new CR-HM-06 surfaces should resolve journal
rows deterministically from day one.

## Governance outcome

No unresolved authority. Execution-scope-before-approval = NO (§E/Q6).
Quotation pricing proceeds on bounded snapshots with CR-HM-12 intact
(§B/Q7). **Not BLOCKED_FOR_DECISION.**

---
*This document freezes governance mapping only. Any runtime/migration/
test/OpenAPI work requires explicit subsequent PARTs.*

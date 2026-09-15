# CR-BE-PRO-02 — START GOVERNANCE

## RFQ + Quotation + Multi-Vendor Comparison

**Inspection date:** 2026-08-23 (UTC)
**Stage:** START GOVERNANCE + PART 01–06 implementation notes
**Implementation status:** PART 01–06 complete; FINAL REVIEW complete
**Repository:** `budiirmawan/Asentra-Backend`

This document governs the next procurement capability. The original START
GOVERNANCE stage created no implementation artifacts; the implementation notes
below record the subsequent PART 01 and PART 02 changes.

---

## 1. Repository baseline / branch / main commit

| Item | Verified value |
|---|---|
| Arena branch | `arena/01a02f63-asentra-backend` |
| Branch base / main commit | `32e63f4c51755b52a0b120deb52153032f1f5492` |
| `origin/main` after fetch | `32e63f4c51755b52a0b120deb52153032f1f5492` |
| Latest migration at PART 01 baseline | `0312_create_operational_commitment_entries` |
| PART 01 migration | `0313_create_rfqs` |
| PART 02 migration | `0314_create_rfq_vendor_invitations_and_sessions` |
| PART 03 migration | `0315_create_vendor_quotations_and_revision_attachments` |
| PART 04 migration | `0316_create_rfq_comparisons_and_evaluations` |
| PART 05 migration | `0317_create_rfq_recommendations_approvals_awards` |
| PART 06 migration | `0318_create_rfq_award_po_provenance` |
| Next free migration after PART 06 | **0319** |
| Working-tree state at inspection | Clean before this document |

The baseline is the requested post-`CR-BE-COMM-VAR-01` main. The commitment and
variance implementation is present in this baseline; it is not treated as a
future assumption.

The migration runner is ordered from `src/database/migrations/index.ts` and
records migration IDs in `schema_migrations`. PART 01 consumes `0313`, PART 02
consumes `0314`, PART 03 consumes `0315`, PART 04 consumes `0316`, PART 05
consumes `0317`, and PART 06 consumes `0318`; future PARTs must use `0319`
onward, in order, and must not edit an already-applied migration.

### Corrected assumptions from the request

Repository evidence changes or confirms the following assumptions:

1. Purchase Requests, Material Requests, Service Requests, Procurement Approval
   Bindings, Vendor Selection Readiness, Purchase Order Readiness, Purchase
   Orders, Purchase Order Lines, Issuance, and Receiving are already live
   authorities. RFQ and quotation are not.
2. A Purchase Order is not merely a readiness snapshot. `purchase_orders`
   exists (`0269`), its lifecycle is extended by `0271`, and it has priced
   `purchase_order_lines` (`0270`).
3. The financial rule is narrower than the general PO business description:
   the only automatic priced **operational commitment source** is an
   **ISSUED Purchase Order line**. PO issuance itself does not silently create
   an operational commitment in the current COMM-VAR design; the existing
   finance command materializes one from that eligible source with an explicit
   budget category and idempotency key.
4. Material quantity approval already exists. Migration `0265` adds
   `approved_quantity` and `APPROVED` to Material Requests, and receiving uses
   the approved/requested quantity authority. This does not add price.
5. Service procurement is not absent. `service_requests` is an existing
   procurement demand line under a Purchase Request, and PO Lines support
   `SERVICE_REQUEST`. It carries no quantity in the existing authority.
6. Vendor Selection Readiness is not a tender, RFQ, comparison, score, or award
   engine. It is a snapshot of vendor eligibility/readiness.
7. There is no Vendor Portal principal, vendor login, vendor quotation API, or
   vendor-specific session boundary. Existing `user_invitations` is the
   internal user/account invitation authority and must not be repurposed to
   make a vendor an internal Building Management user.
8. There is no quotation attachment target. Shared Documents and Supporting
   Documents exist, but the current supporting-document parent vocabulary does
   not include RFQ or quotation entities; Evidence Submissions are execution
   evidence, not general quotation attachments.

---

## 2. Existing authority map

### 2.1 Procurement foundation

| Concern | Existing authority | Verified result | CR-BE-PRO-02 treatment |
|---|---|---|---|
| Procurement header intake | `purchase_requests` (`0176`) and `purchase-requests` module | Client/Building-scoped, number unique per Client, `OPEN`/`CANCELLED`; no approval or price | Reuse as demand container; do not duplicate it |
| Material demand | `material_requests` (`0177`, `0265`) and `material-requests` module | One inventory item line; quantity, item, warehouse, UOM; `OPEN` → `APPROVED`/`CANCELLED`; approved quantity is authoritative for fulfilment | RFQ material lines reference this ID; do not make RFQ quantity authoritative |
| Service demand | `service_requests` (`0178`) and `service-requests` module | Service type/title/description/date/location, optional vendor; `OPEN`/`CANCELLED`; no quantity or price | RFQ service lines reference this ID; do not duplicate service execution |
| Procurement approvals | `procurement_approval_bindings` (`0179`) and module | Typed request binding for Purchase Request, Material Request, or Service Request; assigned approver; append-only terminal decision | Extend this typed binding for RFQ award only if implementation confirms additive widening is safe; no second approval engine |
| Vendor eligibility snapshot | `vendor_selection_readiness` (`0180`) and module | Vendor active, Building relationship, capability, compliance, license, and approval checks; `READY`/`NOT_READY`/`EXPIRED`/`INELIGIBLE` | Reuse and revalidate at comparison/award/conversion; it is not a quote or award |
| PO precondition | `purchase_order_readiness` (`0181`) and module | Snapshot for approved request + selected vendor; `READY`/`NOT_READY`/`BLOCKED` | Remains the sole PO readiness authority; do not create RFQ readiness |
| PO header | `purchase_orders` (`0269`, `0271`) and `purchase-orders` module | Context derived from PO Readiness; `DRAFT`/`ISSUED`/`CANCELLED`; issue provenance; no PO total column | Reuse for conversion; add only an additive RFQ-award provenance link if required |
| PO commercial line | `purchase_order_lines` (`0270`) and line module | Exactly one Material Request or Service Request line; material quantity/UOM snapshot; `unit_price`, derived `line_amount`; DRAFT-only edit/remove; append-only line history | This remains the downstream priced commitment source. Quote price is not a commitment |
| PO issuance | `0271`, `purchaseOrderService.issuePurchaseOrder` | DRAFT → ISSUED, row lock, issue-readiness recheck, at least one line, vendor/scope/request validation, operational event | Conversion never auto-issues; issue remains explicit |
| Receiving | `receivings` (`0182`, `0264`, `0266`) and module | Material can bind to a Material Request and stock-in in one transaction; cumulative over-receipt guard and UOM snapshot; service receiving has no stock movement | No RFQ/quote value is copied into receiving; downstream receiving remains unchanged |
| Procurement-to-work execution | `work_order_procurement_bindings` and `work_contracts` (`0272`/`0273`) | Existing PO/vendor/request execution chain; SPK and Work Order are not price authorities | Reuse only after PO conversion; no RFQ execution engine |

The existing code is already mounted in `src/routes/index.ts` and the existing
procurement endpoints are partially covered by `docs/api/openapi.yaml`.
There are no RFQ, quotation, comparison, evaluation, or award paths in either
runtime routes or OpenAPI.

### 2.2 Vendor foundation

| Concern | Existing authority | Verified result |
|---|---|---|
| Vendor master | `vendors` (`0054`) / `src/modules/vendors` | Client-scoped vendor, stable `vendor_code`, `ACTIVE`/`INACTIVE`; no portal identity |
| Vendor category | `vendor_categories` (`0055`/`0056`) | Client-scoped classification; optional on vendor |
| Vendor/Building scope | `vendor_building_relationships` (`0058`) / `vendor-buildings` | Many-to-many service relationship, active/inactive history and optional effective window; grants no user data access |
| Vendor capability | `vendor_capabilities` (`0059`) / `vendor-capabilities` | Vendor capability, optionally narrowed by an existing vendor-building relationship; capability codes are data-driven |
| Vendor PIC | `vendor_pics` (`0057`) / `vendor-pics` | Contact/person master for vendor operations; not a vendor portal account and not an internal user assignment |
| Vendor compliance | `vendor_compliance_documents` (`0061`) | Metadata plus opaque file reference; expiry/status history; no quotation target |
| License/certification | `vendor_licenses_certifications` (`0062`) | License/certification status and expiry resolution; may reference the vendor compliance document |
| Vendor workforce | `vendor_workforce` / external-workforce links | Workforce affiliation and operational binding; explicitly does not grant User, Credential, or Building access |
| Vendor service cost | `vendor_service_costs` (`0201`) | Operational cost record for service work/request; no currency and not an approved commitment |
| Vendor invoice | `vendor_invoices` (`0261`, `0274`) | Payable invoice authority; currency/amount; PO/SPK linkage and later verification/payment; not a quotation |

**Reuse decision:** RFQ invitation eligibility must use the existing vendor,
Client, Building relationship, capability, compliance, and license authorities.
It must not infer a vendor price from `vendor_service_costs`, invoices, prior PO
lines, or any unrelated table.

**Vendor access finding:** no current Vendor Portal capability exists. A future
vendor-facing boundary needs an explicitly governed vendor principal or
invitation-scoped session. It must not rely on a `user_building_assignments`
row, internal `User` role grant, or broad `vendor.*` permission.

### 2.3 Commercial / financial authority

| Concern | Existing authority | Governance consequence |
|---|---|---|
| Operational budget | `operational_budgets` (`0283`) | Building-scoped period, explicit currency, planned amount; no source amounts stored |
| Budget category | `operational_budget_categories` (`0283`) | Explicit category and planned amount; category is not inferred from RFQ/service type |
| Typed source lineage | `operational_budget_source_bindings` (`0284`) | Lineage only, no copied amount; source types include PO/PO_LINE but not RFQ/quotation |
| Commitment header | `operational_commitments` (`0311`) | Immutable monetary snapshot, explicit origin/source, currency, budget/category scope, no-double-counting uniqueness |
| Commitment ledger | `operational_commitment_entries` (`0312`) | Append-only signed entries, SQL NUMERIC amounts, idempotency, actualization/release/correction history |
| PO-line commitment integration | `operational-commitment-material.service.ts` and `operational-commitment-vendor.service.ts` | ISSUED PO line is the sole priced automatic source for material/service vendor commitment; no RFQ or award path exists |
| Overspend | `operational_budget.overspend_policy` and `operational_budget.override` | Decision is made at commitment time under budget lock; override is exceptional and unassigned by default |
| Currency | Existing nine-code whitelist in PO, invoice, budget, and commitment authorities | `IDR`, `USD`, `SGD`, `MYR`, `AUD`, `EUR`, `GBP`, `JPY`, `CNY`; exact matching only; no FX authority |
| Decimal convention | PO lines and commitments use `NUMERIC(18,2)`; SQL derives amount; public mappers convert at API boundary | Future quotation money must use the same precision convention and must not use floating-point authority |

**Frozen financial boundary:** RFQ header, invitation, quotation, comparison,
evaluation, recommendation, approval, and award do not create a budget
commitment. A converted DRAFT PO does not create one. The existing finance
boundary is reached only from a qualifying ISSUED PO line, and the existing
PO-line/commitment controls remain authoritative.

### 2.4 Workflow / approval authority

1. `reviews` (`0074`) and `src/modules/reviews` are a shared review pattern, but
   their original target vocabulary is form/checklist execution (with later
   additive document targets). They are not a commercial award engine.
2. `procurement_approval_bindings` is the closest procurement authority. It
   already provides assigned approver, pending/approved/rejected state,
   available-actions behavior, Building isolation, decision guards, and
   Material Request approved-quantity application.
3. `tenant_approval_bindings` (`0151`) confirms the repository pattern:
   typed target references, assigned approver, one-way decision, partial unique
   pending protection, and caller-specific available actions.
4. No generic configurable workflow designer or multi-stage procurement award
   engine was found. Do not introduce one for this capability.

**Approval decision:** use the existing procurement approval binding pattern and
add an RFQ target to that same authority only if the additive schema/service
extension is accepted in implementation review. An RFQ award approval must bind
to the exact RFQ/recommendation, not merely to the source Purchase Request.

### 2.5 Security / governance authority

| Authority | Evidence | Required reuse |
|---|---|---|
| RBAC catalogue | `permissions`, foundation seed, `requirePermission` | Default-deny; reuse existing source/vendor/PO/document permissions where semantically correct |
| Building isolation | `contextAccessService`, `resolveBuildingsForUser`, `requireBuildingAccess` | Every internal RFQ read/command resolves and checks the RFQ Building; no Client-wide sibling expansion |
| Client isolation | Client derived through Building/Property and vendor Client ownership checks | RFQ, invitation, quote and document scopes must agree on Client and Building |
| Operational events | `operational_events` (`0080`) plus `recordOperationalEvent` | New material RFQ/quote/evaluation/award state changes record an append-only event |
| Request correlation | `0309_add_operational_event_correlation`, request context middleware | HTTP events use the server request UUID and source `HTTP`; event metadata does not become idempotency authority |
| Document/evidence | Shared Documents (`0224`), versions (`0230`), Supporting Documents (`0229`), Evidence Submission (`0073` and later extensions) | Reuse opaque file references and document history; extend typed parent vocabulary rather than creating a new storage engine |
| Integration | Transactional outbox (`0306`), webhook endpoints/deliveries (`0307`/`0308`) | Publish prospective domain events through existing outbox/webhook seams; no direct provider calls from procurement |
| Notification | Notifications/templates/subscriptions and outbound delivery ledger | Reuse only once a vendor-recipient/contact authority exists; do not infer vendor phone or portal identity from unrelated rows |

---

## 3. Verified gaps

The following were verified as gaps at the PART 01 baseline. PART 02 resolved
the Vendor invitation/session and contact-boundary items, and PART 03 resolved
the quotation/revision/attachment items described here. Remaining gaps are
still not implemented:

1. No `rfqs`, RFQ lines, vendor invitations, quotations, quotation revisions,
   quote lines, comparison runs, evaluation records, recommendations, or RFQ
   awards exist in migrations, modules, routes, or OpenAPI.
2. No typed RFQ-to-demand lineage exists. Existing PO lines reference demand
   lines, but nothing represents a pre-PO sourcing event.
3. Existing Vendor Selection Readiness is a single vendor/request snapshot and
   cannot represent several invited vendors, vendor responses, quote versions,
   line-by-line deviations, or evidence-backed comparison.
4. Existing procurement approval bindings cannot currently target an RFQ or an
   award. Existing shared reviews are not a safe substitute.
5. No Vendor Portal principal, vendor-specific authentication, invitation
   session, vendor-only visibility rule, or vendor quotation submission
   boundary exists.
6. The shared Supporting Document parent check allows `WORK_COMPLETION`, `BAST`,
   `HANDOVER`, `SIGN_OFF`, `TENANT_COMPANY`, `VENDOR`, and `DOCUMENT`, but not
   RFQ/quotation parents. Evidence Submission is constrained to execution types
   and is not a general quotation attachment authority.
7. No authoritative RFQ currency, quote validity, lead-time, delivery/service
   terms, technical compliance response, or deviation model exists.
8. Payment terms, tax, discount, and other commercial components are not
   present in existing PO Lines or the verified procurement authority. Adding
   them to RFQ v1 would invent a new financial model.
9. Older Purchase Request, Material Request, Service Request, Procurement
   Approval, Vendor Selection Readiness, PO Readiness, and Receiving services
   do not consistently emit `recordOperationalEvent`. This capability must not
   repeat that omission for its own material state changes; retrofitting old
   domains is outside this START GOVERNANCE change.
10. Existing PO line removal is DRAFT-only, but physically deletes the line and
    cascades its line-history rows; an operational event survives. Existing
    PO/line DRAFT editing is therefore not, by itself, sufficient historical
    protection for an RFQ-converted commercial package.
11. Existing nullable triple-column unique indexes on Vendor Selection
    Readiness and PO Readiness do not provide the strongest possible typed
    uniqueness under PostgreSQL NULL semantics. New RFQ constraints must use
    typed partial unique indexes or a non-null typed source key.
12. Existing procurement creates and readiness evaluations have no general
    HTTP idempotency-key authority. New material commands need explicit
    idempotency design rather than treating request correlation as idempotency.
13. Existing notification recipient resolution is user-oriented. Vendor master
    email/phone fields are not a governed vendor-portal recipient or consent
    authority for this flow.
14. Existing PO has no RFQ/award provenance FK. `vendor_reference` is free text
    and cannot be the sole conversion lineage.

### Gaps that block vendor-self-service implementation

Vendor quotation submission cannot be safely exposed to an external vendor until
one of these is explicitly chosen and governed:

- a distinct vendor portal principal/session authority, or
- a deliberately invitation-scoped, non-user submission authority with a
  complete actor/audit model.

The current internal user invitation, role, and Building assignment authorities
are not acceptable substitutes. PART 01 can proceed with the internal RFQ
foundation and lineage, but vendor-facing submission is blocked until this
boundary is approved.

---

## 4. RFQ domain model

### 4.1 Model decision

Use one RFQ model with an explicit **homogeneous typed source mode**, not two
parallel Material RFQ and Service RFQ engines and not an untyped polymorphic
`source_id`.

A v1 RFQ is one of:

- `MATERIAL`: every RFQ line references one `material_requests.id`; or
- `SERVICE`: every RFQ line references one `service_requests.id`.

Both modes use the same RFQ header, invitation, quotation, comparison, and award
lifecycle. An RFQ does not mix Material Request and Service Request lines in v1.
This avoids ambiguity in the existing PO request-type/readiness model and keeps
source validation deterministic. A later governed change may permit mixed
lines only if PO conversion and approval semantics are proven safe.

An RFQ is also restricted to one originating Purchase Request container in v1.
The source Purchase Request is derived through each line and all lines must
resolve to the same Client, Building, and Purchase Request. A bare Purchase
Request with no demand line is not a quoteable RFQ source.

### 4.2 Proposed authority records

The following are proposed new domain records for implementation, not created by
this change:

#### RFQ header

`rfqs` should own:

- stable RFQ identity and `rfq_number`, unique within Client;
- `client_id` and `building_id`, derived from the first source line and checked
  against every later line;
- `source_mode` (`MATERIAL` or `SERVICE`);
- the originating `purchase_request_id` as a derived lineage anchor;
- title, scope/description, required date snapshot for communication only;
- explicit commercial `currency` using the existing nine-code whitelist;
- response deadline and closure provenance;
- lifecycle status and actor/timestamps;
- created-by identity and immutable creation provenance.

The RFQ header contains no budget amount, quote total, commitment amount, tax,
discount, payment term, or selected-vendor price.

#### RFQ lines

`rfq_lines` should own:

- deterministic `line_number`, unique per RFQ;
- exactly one typed source FK: `material_request_id` for `MATERIAL`, or
  `service_request_id` for `SERVICE`;
- a display description snapshot and source identity for the invitation;
- material quantity/UOM display snapshots derived from the Material Request;
  the Material Request remains quantity authority;
- service type/title/description display snapshots derived from the Service
  Request; Service Request remains demand authority;
- required date snapshot where needed for vendor communication;
- line status/void history if line-level correction is later required.

RFQ line snapshots are explanatory history only. They must never be used to
change requested quantity, approved quantity, fulfilment, receiving, inventory,
or service execution.

### 4.3 RFQ source constraints

Implementation must enforce, in the service and as far as possible in the
schema:

- exactly one source mode and one typed source FK per line;
- source line is in an allowed state (`APPROVED` Material Request for material;
  `OPEN`/otherwise explicitly governed Service Request for service) at RFQ
  opening and again at award/conversion;
- every source line belongs to the RFQ's Purchase Request, Client, and Building;
- no source line is silently copied from an unrelated table;
- no live duplicate sourcing of the same demand line unless an explicit
  re-RFQ policy allows a prior RFQ to be terminal (`CANCELLED`/`NO_AWARD`);
- source line identity and RFQ lineage cannot be edited after the RFQ is OPEN;
  correction is a new RFQ or an explicit pre-open amendment with history;
- RFQ number uniqueness is scoped to Client, not globally.

A typed non-null source key or two typed partial indexes is preferred over a
nullable `(material_request_id, service_request_id)` uniqueness expression.

---

## 5. Vendor invitation model

### 5.1 Invitation authority

`rfq_vendor_invitations` should be one record per RFQ and vendor attempt, with:

- RFQ, Client, Building and vendor references;
- an explicit invitation attempt/sequence and idempotency key;
- invitation status, invited-at, viewed/accepted/declined/no-bid timestamps;
- response deadline snapshot from the RFQ;
- decline/no-bid reason where supplied;
- actor/provenance fields for internal or vendor-originated actions;
- no copied vendor legal/contact identity beyond safe display snapshots;
- no quote amount.

A vendor invitation does not grant the vendor internal Building access. It is
not a User Building Assignment, Vendor Workforce Binding, or internal RBAC
role.

### 5.2 Eligibility and selection

Invitation creation must resolve the current Vendor and existing authorities:

1. vendor exists, belongs to the RFQ Client, and is `ACTIVE`;
2. active Vendor ↔ Building relationship is present and in its effective window;
3. capability/category is compatible with the homogeneous RFQ source mode;
4. current compliance/license status is checked using existing vendor services;
5. the vendor is not invited twice in the same live invitation attempt;
6. invitation scope agrees with RFQ Client and Building.

The existing `vendor_selection_readiness` record can be reused as an eligibility
snapshot, but it must not be treated as proof that the vendor submitted a quote
or as a ranking. At award/conversion, eligibility is re-read; a stale snapshot
cannot make an inactive or de-scoped vendor awardable.

### 5.3 Invitation statuses

Proposed v1 status vocabulary:

| Status | Meaning | Quote submission |
|---|---|---|
| `INVITED` | Invitation is active and awaiting vendor action | Allowed until deadline |
| `ACCEPTED` | Vendor acknowledged intention to respond, if the chosen portal supports acknowledgement | Allowed until deadline |
| `DECLINED` | Vendor explicitly declined the invitation | Not allowed |
| `NO_BID` | Vendor explicitly states it will not provide a quotation, with optional reason | Not allowed |
| `QUOTATION_SUBMITTED` | At least one valid quotation revision was submitted | Revision policy applies |
| `EXPIRED` | Deadline passed without a valid response, resolved by command/read time | Not allowed |
| `REVOKED` | Internal issuer withdrew this invitation | Not allowed |

`DECLINED` and `NO_BID` are intentionally distinct. A decline is a response to
being invited; no-bid records a decision not to quote after considering the
request. Neither is a quotation and neither affects budget.

An active invitation should be unique by `(rfq_id, vendor_id)`. Re-invitation
must create a new attempt only after the earlier attempt is terminal and must
preserve the earlier history.

### 5.4 Vendor-facing boundary

The internal API may create and administer invitations. Vendor response routes
must be a separate, explicitly governed boundary with these properties:

- invitation-scoped or vendor-principal-scoped authentication;
- vendor can see only its own invitation, RFQ content permitted for response,
  its own quotations and its own attachments;
- vendor cannot see another vendor's price, comparison, evaluation, rank,
  recommendation, approval, award, budget, or internal notes;
- vendor cannot create or change an internal User, Role, Credential, or Building
  Assignment through the quotation flow;
- a vendor action has a durable invitation/principal actor trail even when it
  has no internal `users.id`;
- expiration/revocation is checked on every vendor command, not only at login.

This boundary is a blocker for the vendor-self-service PART until the principal,
credential/session, audit actor, and notification choices are approved.

---

## 6. Quotation + revision model

### 6.1 Header versus revision

Use a stable quotation header plus immutable submitted revisions:

- `vendor_quotations` identifies one vendor response to one invitation. It
  contains no mutable copy of the awarded price and no overwritten commercial
  history.
- `vendor_quotation_revisions` contains sequential `revision_number`, submitter,
  submitted-at, validity, lead time, terms, and the revision status.
- `vendor_quotation_lines` belongs to exactly one revision and maps one-to-one to
  an RFQ line. A line stores the vendor's response to that line, not an inferred
  value from a PO, invoice, cost, or prior quote.

A draft revision may be edited only before submission. Once submitted, its
commercial terms are immutable. A correction is a new revision with a new
number; the previous revision becomes historical/superseded and remains
readable. An awarded or evaluated revision must never be overwritten or deleted.

### 6.2 Quotation header authority

The quotation header should carry:

- RFQ, invitation, vendor, Client, Building and source scope;
- vendor quotation number/reference;
- vendor submission status and current/latest revision pointer, if a pointer is
  needed for convenience;
- explicit response currency, which must match the RFQ currency for a
  comparable submission;
- vendor-level notes that are not line prices;
- created/submitted/withdrawn provenance.

The revision, not the header pointer, is the historical commercial authority.
The award must reference the exact immutable revision ID.

### 6.3 Quotation line authority

A submitted quotation line should carry:

- RFQ line and source line identity;
- description/offer description;
- unit price as `NUMERIC(18,2)`-compatible data;
- derived line extension using the RFQ/material quantity snapshot for material;
- explicit service quoted amount semantics for a Service Request, because the
  existing Service Request has no quantity;
- quantity compliance response for material;
- technical compliance response and deviation text;
- optional lead-time/delivery response at line level only if the implementation
  needs line-specific terms;
- no budget category, commitment, actual, tax, discount, GL account, or payment
  state.

For material, the quoted quantity must be explicit. v1 should require exact
quantity compliance for a comparable line; partial/alternative quantities are
recorded as deviations and are not silently normalized. For service, no
quantity is invented.

### 6.4 Validity, lead time, and terms

The following are new quotation concepts, not existing financial authorities:

- `valid_until` is an explicit vendor-submitted date/time. Validity is checked
  at comparison, recommendation, award, and conversion as-of the command time.
  No scheduler is required to mutate rows.
- `lead_time_days` or an equivalent deterministic promised-date field may be
  accepted as an optional response. If both are supported, their relationship
  must be defined before implementation; do not derive one from free text.
- delivery/service terms may be retained as vendor-submitted text or a small
  governed vocabulary. They are evidence for evaluation, not a financial
  amount authority.
- payment terms are **deferred** in v1 because no repository authority supports
  them in the existing PO/quotation chain.

### 6.5 Unsupported commercial components

Tax, discount, surcharge, freight, withholding, other commercial components,
AP, invoice matching, and accounting are explicitly out of the v1 quotation
model. The existing PO Line authority has only unit price and derived line
amount, and existing vendor service costs have no currency. No such component
may be added to a quote merely because it is common in procurement products.

If a future change requires them, it must first define one authoritative
commercial calculation model, precision/rounding, currency behavior, PO
mapping, invoice mapping, and audit/revision rules.

---

## 7. Material vs service procurement lineage

### 7.1 Material flow (supported)

```text
Purchase Request
  └─ Material Request (approved quantity + item + UOM authority)
       └─ RFQ(source_mode=MATERIAL)
            └─ RFQ Material Line
                 └─ Vendor Invitation
                      └─ Quotation Revision + Material Quote Line
                           └─ Comparison / Evaluation / Recommendation
                                └─ RFQ Award
                                     └─ existing PO Readiness
                                          └─ DRAFT Purchase Order
                                               └─ PO Material Line
                                                    └─ ISSUED PO Line
                                                         └─ commitment source
```

Material Request remains authoritative for requested/approved quantity,
fulfilment and receiving. RFQ and quotation quantities are response/comparison
facts. PO Line `quantity_snapshot` remains a frozen commercial snapshot; it is
not a second fulfilment ledger.

### 7.2 Service flow (supported)

```text
Purchase Request
  └─ Service Request (service demand + scope authority)
       └─ RFQ(source_mode=SERVICE)
            └─ RFQ Service Line
                 └─ Vendor Invitation
                      └─ Quotation Revision + Service Quote Line
                           └─ Comparison / Evaluation / Recommendation
                                └─ RFQ Award
                                     └─ existing PO Readiness
                                          └─ DRAFT Purchase Order
                                               └─ PO Service Line
                                                    └─ ISSUED PO Line
                                                         └─ commitment source
```

Service Request remains authoritative for service demand, title, type,
description, location, and required date. Because the existing service source
has no quantity, a service quote must not invent a quantity-based extension.
The existing PO Service Line convention—unit price is the line amount—must be
preserved unless a separately governed service-unit authority is introduced.

### 7.3 Why the modes are typed but not duplicated

A shared RFQ/quotation/comparison model avoids two parallel procurement engines,
while the explicit source mode prevents accidental mixed material/service
semantics. The model is safe to extend because every line is typed and every
source FK can be validated against its existing authority. No untyped
`source_type + source_id` convention is approved.

---

## 8. Multi-vendor comparison model

### 8.1 Evidence source

Comparison values must come only from:

- the RFQ and its typed source-line snapshots;
- invited vendor identity and existing vendor readiness authorities;
- submitted, immutable quotation revisions and quote lines;
- explicitly recorded evaluation responses and notes;
- shared document/version metadata for attached evidence.

Comparison must not infer price, lead time, compliance, or ranking from vendor
invoices, vendor service costs, PO history, receiving, Work Order cost, or any
unrelated table.

### 8.2 Comparison run and matrix

Use an immutable comparison-run/read-model concept rather than overwriting one
live matrix:

- one `comparison_run` identifies RFQ, evaluator, as-of time, and source
  revision IDs;
- one entry per invited quotation revision/vendor records the exact source
  revision, currency, total/line values, and deterministic compliance flags;
- comparison entries are snapshots for evidence and repeatability, not a new
  price authority;
- a new revision or changed eligibility creates a new run; an old run remains
  historical;
- the run records excluded vendors and reasons, including declined/no-bid,
  expired, incomplete, currency mismatch, ineligible, and non-compliant.

### 8.3 Authoritative comparison dimensions

| Dimension | v1 decision | Authority / behavior |
|---|---|---|
| Total price | Authoritative comparison fact when all required lines are valid | Derived from submitted quote lines and RFQ quantity semantics; no cross-currency arithmetic |
| Line price | Authoritative evidence | Submitted quote-line unit price; material extension uses RFQ quantity snapshot |
| Currency | Eligibility gate | Quote currency must equal RFQ currency; mismatch is non-comparable, never FX-converted |
| Technical compliance | Required response dimension | Vendor response per line/requirement plus evidence/deviation; no inferred compliance |
| Quantity compliance | Required for material | Exact required quantity in v1; alternatives are deviations, not hidden substitutions |
| Lead time | Optional but deterministic if supplied | Compare explicit days/promised date; missing values are missing evidence, not zero |
| Validity | Required to award | `valid_until` must cover comparison/award/PO conversion command time |
| Delivery/service terms | Optional evidence | Recorded and visible; no automatic normalization in v1 |
| Payment terms | Deferred | No current repository authority |
| Vendor qualification/compliance | Required award gate | Reuse/revalidate Vendor master, Building scope, capability, compliance, license |
| Deviations | Required when a response differs | Explicit text/structured flag; blocks silent equivalence |
| Evaluation score | Not automatic in v1 | Manual notes/recommendation only; no AI or hidden score |

### 8.4 No automatic “best vendor”

The system must not declare a best vendor based on price alone or an invented
score. A comparison is evidence; recommendation is an accountable human act.

Weighted scoring is **not proposed for v1**. Therefore no weights, score
configuration authority, tie formula, or automatic score binding is introduced.
If a future change proposes weighted scoring, it must define all of the
following before coding:

- weights are configured by a Client-authorized procurement administrator under
  a dedicated configuration authority, not by a vendor or ordinary evaluator;
- the formula, scale, rounding, missing-data behavior, and source revision
  snapshot are deterministic and reproducible;
- a tie remains a tie and does not select by array order, creation order, or
  vendor code;
- manual recommendation remains an explicit authority with a mandatory reason;
- an override records actor, reason, prior score/rank, and exact evidence;
- scoring is advisory unless a later governance change expressly makes it
  binding.

---

## 9. Evaluation / recommendation / award governance

### 9.1 Evaluation

Evaluation begins only after the RFQ is closed. It must capture:

- evaluator and evaluation time;
- exact quotation revision IDs reviewed;
- line-level technical/quantity/commercial conclusions;
- vendor qualification/compliance recheck result;
- evaluation notes and deviations;
- excluded or missing-response reasons.

Evaluation records should be immutable snapshots or append-only entries. Editing
a note or changing a conclusion after recommendation requires a new evaluation
version/revision; it must not rewrite the evidence used by an earlier
recommendation.

### 9.2 Recommendation

A recommendation is a manual, explicit selection proposal referencing:

- one exact submitted quotation revision and vendor, or an explicit `NO_AWARD`
  outcome;
- one comparison run;
- recommendation reason and evaluation notes;
- supporting evidence/document references where applicable;
- actor and timestamp.

A recommendation does not allocate budget, create a commitment, issue a PO, or
change the selected vendor on a Purchase Request/Service Request.

The recommendation is blocked when:

- there is no valid submitted revision;
- required RFQ lines are missing or ambiguous;
- currency differs;
- the quote is expired at the decision time;
- vendor scope/qualification is no longer valid;
- competing revisions or vendors are tied without an explicit human decision;
- a prior award/recommendation is already terminal and no correction command
  exists.

The system must fail closed. It must never choose the first, cheapest, newest,
or highest-ranked row when the comparison is ambiguous.

### 9.3 Approval

Use the existing procurement approval binding pattern, extended with a typed
RFQ target such as `RFQ` and an award-specific `approval_type` (exact naming is
an implementation decision). The binding must point to the exact RFQ and
recommendation/quotation revision. It must preserve pending and terminal
history and expose caller-specific available actions.

For v1, one explicitly designated award approver is the minimum safe policy
because no existing procurement approval policy configuration for required
multi-approver quorum was found. If implementation permits multiple award
bindings, the quorum rule must be explicit before use; “any one approved” is
not a safe default for a sensitive award.

Existing `procurement_approval.manage` can remain the approval-engine command
permission, but it must not alone grant the ability to finalize an award. The
new award command must use the narrow RFQ award permission described in §13.

### 9.4 Award

Award is an explicit command after the required approval is terminal-approved.
It must:

- lock the RFQ and recommendation;
- re-read the current RFQ state, exact quote revision, vendor status/scope,
  source-line state, and quote validity;
- reject an award after cancellation or invalid closure;
- set one immutable selected vendor/revision or record `NO_AWARD`;
- require a reason for manual deviations/overrides;
- write an operational event with actor, request correlation, exact IDs, and
  non-sensitive summary;
- never write an operational commitment or budget source binding.

An awarded RFQ cannot be silently re-awarded. Re-award, if eventually allowed,
requires an explicit reversal/correction command with reason, actor, history,
and a fresh approval; otherwise the RFQ is terminal and a new RFQ is required.

---

## 10. PO conversion boundary

### 10.1 Conversion is explicit and two-phase

RFQ award does not silently create or issue a PO. The governed conversion is:

1. lock the approved RFQ award and exact quotation revision;
2. revalidate source lines, current vendor eligibility, Client/Building scope,
   currency, quote validity, and required date;
3. use the existing `purchase_order_readiness` authority for the selected
   source request/vendor;
4. call the existing PO creation authority to create a **DRAFT** PO from that
   readiness;
5. add PO lines through the existing PO Line authority, deriving source line,
   item/UOM/quantity snapshot and copying only the selected quote's unit price
   and description where appropriate;
6. create an additive, typed RFQ-award conversion lineage link to the PO and
   exact quote revision; it stores lineage, not an amount;
7. return the DRAFT PO for explicit internal review and issuance;
8. invoke no budget commitment operation during award or conversion.

No alternative PO table, PO total, PO issuance engine, or RFQ financial ledger
is approved.

### 10.2 Required RFQ-to-PO provenance

The current PO has no RFQ/award FK and `vendor_reference` is not a reliable
lineage authority. Implementation should add an additive provenance link (a
small typed link table is preferred if it avoids widening unrelated PO
semantics) with composite scope checks for:

- PO, RFQ, award/recommendation, selected vendor and Client/Building;
- exact selected quotation revision;
- one live conversion per award;
- optional per-PO-line mapping to the source quotation line;
- conversion actor, time, and idempotency key.

Historical POs remain valid with a nullable/no-link state. No historical
backfill is authorized.

### 10.3 PO DRAFT edit risk

Existing PO DRAFT commands allow commercial edits and DRAFT line removal.
Before implementing RFQ conversion, decide one of these safe policies:

- an RFQ-linked DRAFT PO is locked against unapproved commercial edits/removal;
  or
- every edit is an explicit commercial deviation that creates history, marks
  the quote-to-PO package as changed, and requires re-evaluation/re-approval.

A silent edit after an RFQ award is not acceptable. The existing generic DRAFT
edit behavior cannot be assumed safe for awarded sourcing history.

### 10.4 Issuance and commitment

The existing PO issue command remains the authority for DRAFT → ISSUED. It
rechecks readiness, request line validity, vendor scope, and line presence.
Conversion must not call issue automatically.

Once a PO line is ISSUED, the existing COMM-VAR authority may use that priced
line for the operational commitment path. RFQ, quotation, comparison,
recommendation, approval, award, and DRAFT PO values are never also bound as
commitments. A PO header and its PO lines must not both be counted.

---

## 11. Budget / commitment interaction

The following table is normative:

| Procurement event | Budget/commitment effect |
|---|---|
| Create RFQ | None |
| Add/edit RFQ line before opening | None |
| Open/close RFQ | None |
| Invite vendor | None |
| Vendor decline/no-bid | None |
| Submit quotation/revision | None |
| Compare/evaluate | None |
| Recommend vendor | None |
| Approve recommendation/award | None |
| Award vendor | None; award alone never silently commits |
| Convert award to DRAFT PO | None |
| Add/edit DRAFT PO line | None |
| Issue PO | No alternate RFQ commitment; existing finance rule remains the only source boundary |
| Create operational commitment | Only through the existing eligible ISSUED PO-line authority, with explicit budget category, currency match, overspend policy, lock, and idempotency |
| Receiving/invoice/actualization | Existing receiving/invoice/commitment actualization authorities only |

RFQ/quotation totals must never be added to `operational_budget_source_bindings`
and must not become a new `source_type`. The existing binding table's PO and
PO_LINE types are not an invitation to bind both. The line authority wins for a
priced issued obligation; a PO header is not additionally counted.

No RFQ command may block on available budget because RFQ and award do not
commit. Any budget/overspend decision happens at the existing commitment
boundary. The `operational_budget.override` permission remains exceptional and
unassigned by default.

---

## 12. Currency / commercial-value rules

1. RFQ currency is explicit, required for a comparable commercial RFQ, and
   selected from the existing nine-code whitelist. It is not inferred from the
   Client, Building, Vendor, budget, invoice, prior PO, or vendor master.
2. Every submitted quotation revision must state currency explicitly and match
   the RFQ currency to be comparable/awardable. A mismatch is a deterministic
   non-comparable result, not an FX opportunity.
3. No FX rate, conversion, rounding conversion, or base-currency normalization
   is introduced.
4. RFQ/quotation monetary values use the existing `NUMERIC(18,2)` convention for
   persisted unit price and derived line amount. SQL/decimal arithmetic is the
   authority; JavaScript public numbers are presentation only.
5. Material line extension is derived from the authoritative RFQ quantity
   snapshot, which came from the Material Request. It is not a fulfilment
   ledger and cannot alter the Material Request.
6. Service line commercial semantics follow the existing Service PO convention:
   there is no invented quantity; a submitted service unit/amount model must be
   explicitly defined before coding. v1 should retain a single quoted service
   amount per service demand line.
7. Comparison totals are derived from the selected revision's own quote lines.
   They are not copied from PO, invoice, service-cost, or budget tables.
8. Tax, discount, freight, surcharge, withholding, payment terms and accounting
   are not v1 authorities.
9. At PO conversion, the selected revision currency must equal PO currency.
   At commitment creation, PO-line/commitment currency must equal the budget
   currency under the existing fail-closed rule.
10. Missing currency is an invalid/incomplete quotation, never a default to IDR
    or the budget currency.

---

## 13. RBAC + Client/Building/Vendor isolation

### 13.1 Reuse existing permissions

These existing permissions remain authoritative for existing records and
cross-domain checks:

- `purchase_request.read/manage`;
- `material_request.read/manage`;
- `service_request.read/manage`;
- `vendor.read/manage`, plus existing vendor capability/building/compliance/
  license routes;
- `vendor_selection.read/manage` for eligibility snapshots only;
- `procurement_approval.read/manage` for the existing approval binding engine;
- `po_readiness.read/manage`;
- `purchase_order.read/manage`;
- `document.read/manage/approve/archive` and `evidence.read/manage` where their
  existing semantics apply;
- `operational_event.read` for audit reads;
- existing notification/integration permissions for their own authorities.

`vendor.manage` must not be used as permission to submit vendor quotations or
see internal evaluation. `purchase_order.manage` must not be used as an
implicit RFQ award permission.

### 13.2 Genuinely new permissions

The RFQ domain has no semantically equivalent existing permission. The minimum
new catalogue proposal is:

| Proposed code | Purpose | Default assignment |
|---|---|---|
| `rfq.read` | Read internal RFQ, invitation status, quotation/comparison data permitted to the internal caller | No broad automatic grant; assign by Client/Building procurement role |
| `rfq.manage` | Create/edit/open/close RFQs, administer invitations, record internal evaluation data, and perform non-award commands | No broad automatic grant |
| `rfq.award` | Finalize an approved recommendation/award and initiate governed conversion | Sensitive; explicitly assigned only to designated award authority |

No separate `quotation.manage` permission is proposed for internal v1 unless
implementation separates vendor response and internal administration into
independent modules. Vendor response authorization belongs to the distinct
vendor-facing boundary, not an internal role grant.

Do not automatically grant `rfq.award` to `PLATFORM_ADMIN` through a new seed
change. Any default-role decision must be a separate, explicit governance
review. `procurement_approval.manage` remains required for approval-engine
commands, but it is not a substitute for the narrow award command permission.

### 13.3 Isolation rules

- RFQ Client/Building is derived from demand and cannot be caller-selected to
  widen scope.
- Internal queries use accessible Building IDs from the existing context-access
  service; by-ID commands load the record and assert Building access.
- Vendor must belong to the RFQ Client and have active service scope to the RFQ
  Building. Vendor/building relationship does not grant the vendor user access.
- A vendor-facing principal is scoped to its own vendor and invitation, with no
  internal Building assignment and no access to peer vendor data.
- All attached document metadata carries Client/Building/vendor checks. A
  `VENDOR` document context does not by itself grant access to a vendor user.
- Cross-Client, cross-Building, and cross-vendor typed references fail closed.
- Lists must be scope-filtered in the query, not fetched globally and filtered
  after disclosure.

---

## 14. Audit / evidence / document handling

### 14.1 Operational event requirements

Every material RFQ capability state change must use
`recordOperationalEvent` with:

- Client and Building;
- entity type and entity ID;
- actor identity where the actor is an internal user;
- request correlation from the existing request context;
- source `HTTP` for API actions;
- event type and stable summary;
- metadata containing IDs, status transitions, revision numbers, reasons, and
  non-sensitive evidence references.

Minimum event families include RFQ created/edited/opened/closed/cancelled,
invitation created/revoked/declined/no-bid/expired, quotation submitted/
withdrawn/revised, comparison run created, evaluation recorded, recommendation
created/changed, approval submitted/decided, award finalized/no-award, and PO
conversion created/failed/completed.

Operational events are append-only. Event metadata must not carry credentials,
portal tokens, raw uploaded files, or unnecessary sensitive vendor payloads; the
existing event scrubber remains authoritative.

### 14.2 Shared document authority

Use the existing shared Document foundation for quotation/RFQ attachments:

- `documents` supplies Client/Building/context metadata and opaque
  `file_reference` only;
- `document_versions` supplies immutable version history;
- `supporting_documents` supplies parent linkage and context;
- `document.approve` is used only if a document approval is explicitly required,
  not as a substitute for RFQ award approval.

The implementation should add the smallest typed parent vocabulary needed for
`RFQ` and `QUOTATION_REVISION` (or an equivalent governed parent choice) to the
existing Supporting Document authority. It must not add a second file store or
put binary content in PostgreSQL. The link must validate exact Client/Building
and vendor scope in the service and use composite database keys where possible.

Quotation attachments are evidence of the vendor submission. They do not make
an attachment itself a quote, price, compliance result, or award approval.

### 14.3 Evidence boundary

Existing Evidence Submission is constrained to form/checklist/work-operation
execution types. It should not be widened casually to become an RFQ file
engine. If the implementation review finds a genuine need for evidence
requirements on quotation responses, that must be an additive extension of the
existing evidence vocabulary with retention/integrity behavior preserved. The
default v1 decision is shared Documents + Supporting Documents, not a new
quotation evidence table.

### 14.4 Historical handling

- No hard delete for RFQ, invitation, quotation, revision, comparison,
  evaluation, recommendation, approval, award, or conversion history.
- Vendor withdrawal, RFQ cancellation, and no-bid are status/history actions.
- Submitted revisions remain readable after supersession or award.
- Document retention/integrity/hold rules remain those of the shared document /
  evidence authorities.
- No historical backfill or fabricated RFQ/quote records is authorized.

---

## 15. Concurrency + idempotency

### 15.1 Command requirements

| Race / duplicate | Required behavior |
|---|---|
| Duplicate RFQ creation | Require an explicit client/actor command idempotency key; replay returns the same RFQ. Do not use request UUID as the key. |
| Duplicate RFQ line | Unique line number and typed source-line identity; source-line live uniqueness prevents two active RFQs from silently sourcing one demand line. |
| Duplicate vendor invitation | Unique active `(rfq_id, vendor_id)`/attempt rule plus idempotency key; concurrent insert maps to one existing invitation. |
| Duplicate quotation submission | Lock invitation/quotation header; `(quotation_id, idempotency_key)` returns the same revision/result. |
| Quotation revision race | Lock quotation header, allocate next revision under lock, and enforce unique `(quotation_id, revision_number)`; submitted revisions are immutable. |
| Invitation deadline race | Lock or re-read RFQ/invitation and compare server time inside the transaction; after close/deadline, submission fails without mutation. |
| Concurrent comparison | A comparison run references fixed revision IDs and as-of time; two runs may coexist as historical, but neither mutates the other. |
| Concurrent recommendation | Lock RFQ and require `EVALUATION`/allowed state; only one active recommendation/version; ambiguous evidence fails closed. |
| Concurrent award | Lock RFQ/recommendation and use one live award unique constraint; only an approved, exact recommendation can win. A second command returns already-awarded/conflict, never a different winner. |
| Award after RFQ closure | Closure is not a bypass. Award is allowed only from the explicit post-close evaluation/approval state; cancelled, no-award, expired/invalid, or otherwise terminal RFQs reject. |
| Duplicate PO conversion | Lock award; unique award-to-PO provenance and conversion idempotency key return the same DRAFT PO. Existing PO readiness uniqueness remains a second guard. |
| Vendor status/qualification race | Revalidate under the conversion/award transaction boundary; no stale readiness snapshot may silently authorize an inactive/de-scoped vendor. |
| PO line commitment race | Reuse existing PO-line uniqueness, ISSUED check, budget row lock, currency check, and commitment idempotency. RFQ must not add another financial path. |

### 15.2 Database invariants required

Future migrations should include, as applicable:

- Client-scoped RFQ number unique constraint;
- RFQ line-number unique constraint;
- typed exactly-one source check and composite source scope constraints;
- typed partial unique live-source-line index;
- invitation active uniqueness and attempt/idempotency uniqueness;
- one quotation header per invitation attempt;
- quotation revision number unique per quotation;
- one immutable submitted revision pointer/state rule at a time;
- quote-line unique `(revision_id, rfq_line_id)`;
- award unique per RFQ and per selected revision where applicable;
- RFQ approval pending uniqueness using the existing procurement approval
  pattern;
- one conversion link per award and one live RFQ link per converted PO;
- composite Client/Building/Vendor FKs wherever the referenced authorities
  expose matching unique keys;
- append-only/history tables with no application update/delete surface for
  submitted commercial revisions;
- all monetary checks non-negative/positive as appropriate, with no zero-value
  commitment masquerading as an obligation.

Do not rely on nullable-column `UNIQUE` behavior for critical typed invariants.

---

## 16. Lifecycle/state-machine proposal

### 16.1 RFQ

Proposed normal lifecycle:

```text
DRAFT
  └─ OPEN
       └─ CLOSED
            └─ EVALUATION
                 └─ RECOMMENDED
                      └─ APPROVAL_PENDING
                           └─ AWARDED
```

`DRAFT`, `OPEN`, `CLOSED`, `EVALUATION`, `RECOMMENDED`, and
`APPROVAL_PENDING` may have an explicit `CANCELLED` path with actor/reason.
`AWARDED` is terminal for normal commands. A `NO_AWARD` terminal outcome is
preferred over silently returning an RFQ to OPEN. Re-RFQ is a new RFQ linked to
prior history, not an overwrite.

State changes are commands, not arbitrary PATCH values. Response deadline is
enforced by command-time checks; expiry does not require a scheduler.

### 16.2 Invitation

```text
INVITED ──► ACCEPTED ──► QUOTATION_SUBMITTED
   │            │
   ├─► DECLINED ├─► NO_BID
   ├─► NO_BID   ├─► EXPIRED
   ├─► EXPIRED  └─► REVOKED
   └─► REVOKED
```

`ACCEPTED` is optional if the chosen vendor boundary has no acknowledgement
step. The status must not pretend that acceptance is a quote.

### 16.3 Quotation and revision

Quotation header:

```text
DRAFT ──► SUBMITTED ──► WITHDRAWN (explicit vendor/internal action)
```

Revision:

```text
DRAFT ──► SUBMITTED ──► SUPERSEDED
```

A submitted revision may be selected by a comparison/recommendation. It remains
historical after supersession or award. A new revision is the only correction
path. The award points to the exact revision ID, never only to “latest”.

### 16.4 Evaluation / recommendation / approval / award

- Evaluation can begin only from RFQ `CLOSED`.
- Recommendation can be created only from a completed comparison/evaluation.
- Approval binding is `PENDING`/`APPROVED`/`REJECTED` under the existing
  procurement approval pattern; terminal decisions cannot be overwritten.
- Award requires an approved recommendation, exact submitted non-expired
  revision, current vendor eligibility, and a locked RFQ state.
- Award is terminal and immutable in normal operation; corrections require an
  explicit governed reversal/re-RFQ policy.

### 16.5 PO conversion

Conversion is a command from `AWARDED` to an existing DRAFT PO plus an additive
conversion link. It is not an RFQ lifecycle shortcut to `ISSUED`. PO lifecycle
remains the existing `DRAFT` → `ISSUED` / `CANCELLED` authority.

---

## 17. API boundary proposal

No API is added in START GOVERNANCE. Future API work must preserve the existing
`/api/v1` envelope, auth middleware, error contract, and OpenAPI authority.

### 17.1 Internal procurement boundary (proposed)

A small internal surface may include:

- `POST /rfqs`, `GET /rfqs`, `GET /rfqs/:id`, `PATCH /rfqs/:id` (DRAFT-only
  fields);
- `POST /rfqs/:id/lines`, `GET /rfqs/:id/lines`;
- `POST /rfqs/:id/open`, `POST /rfqs/:id/close`, `POST /rfqs/:id/cancel`;
- `POST /rfqs/:id/invitations`, list/detail/revoke invitation commands;
- internal quotation read/list endpoints and controlled internal capture only if
  approved by the vendor-boundary decision;
- comparison run, evaluation, recommendation, approval-context, award, and
  conversion commands;
- an RFQ audit/history and conversion-link read projection.

Commands must be explicit; no generic status PATCH should bypass guards.

### 17.2 Vendor-facing boundary (proposed, not currently available)

Do not put vendor response operations behind ordinary internal Building routes.
The future boundary should expose only invitation-scoped operations such as:

- view permitted RFQ/invitation content;
- accept/decline/no-bid;
- create/update a draft response;
- submit a quotation revision;
- submit a new revision before the governed deadline;
- upload/list its own quotation attachments;
- view its own submission history/status.

It must expose no comparison, recommendation, approval, award, budget, peer
vendor, internal note, or internal operational-event data.

### 17.3 Notification and integration boundary

RFQ events may feed existing notification intent and integration-outbox seams.
The domain must emit the event; notification/webhook modules decide whether a
subscription exists and how delivery is retried. No procurement code should
call SMTP, WhatsApp, webhook HTTP, or a provider directly.

Vendor notifications remain blocked until the vendor contact/portal recipient
authority is governed. Existing `vendors.email` or `vendors.phone` must not be
silently treated as consented recipient data for a new channel.

### 17.4 Scheduler decision

No scheduler is required for v1. Deadline, validity, and expiry behavior can be
resolved at command/read time and by explicit close commands. Do not create a
new scheduler. Existing due-job infrastructure is not a reason to add one.

---

## 18. Explicit non-goals

CR-BE-PRO-02 v1 does not create or govern:

- budget reservation at RFQ, quote, recommendation, approval, or award;
- a second commitment or financial ledger;
- FX, currency conversion, tax, discount, freight, surcharge, withholding, AP,
  accounting, payment, or invoice matching;
- a second PO, PO issuance engine, receiving engine, inventory engine, service
  execution engine, or Work Order engine;
- automatic best-vendor/AI scoring or hidden weighted ranking;
- a generic workflow/approval designer;
- a generic evidence or document storage engine;
- vendor employee/workforce access to internal management data;
- automatic PO issue on award or automatic budget commitment;
- historical RFQ/quotation backfill;
- silent overwrite/delete of commercial revisions, evaluations, awards, or
  attachments;
- a new scheduler;
- vendor price inference from invoices, costs, old POs, or unrelated tables;
- cross-Client or cross-Building sourcing;
- mixed Material/Service RFQs until a separate safety decision proves the
  downstream PO and approval semantics.

---

## 19. Risks / blockers / deferred gaps

| ID | Risk / blocker | Severity | Boundary / mitigation |
|---|---|---:|---|
| B-01 | No Vendor Portal principal/session/audit authority | High | Govern a separate vendor-facing boundary before vendor self-service submission |
| B-02 | Vendor notification recipient/consent source is not governed | High | Defer outbound vendor notifications or define a dedicated vendor contact authority |
| B-03 | Procurement approvals do not target RFQ awards | High | Add RFQ as a typed target to the existing engine; do not create a second engine |
| B-04 | Supporting Documents do not target RFQ/quotation parents | Medium | Additive parent vocabulary/link checks; reuse Documents and Versions |
| B-05 | Existing PO has no typed RFQ/award provenance | High | Add nullable typed conversion lineage; no text-only `vendor_reference` solution |
| B-06 | Existing PO DRAFT edits/removes lines after conversion | High | Lock RFQ-linked PO or require explicit deviation/re-approval before implementation |
| B-07 | Existing demand state differences | Medium | Require approved Material Request for material; explicitly define Service Request award state and recheck |
| B-08 | Existing Vendor/PO Readiness snapshots can stale | High | Revalidate vendor/source/currency/validity at comparison, award, conversion, and issue |
| B-09 | Existing readiness uniqueness uses nullable fields | Medium | New RFQ constraints use non-null typed keys/partial indexes |
| B-10 | Older procurement lifecycle changes lack operational events | Medium | New RFQ domain emits events; legacy audit remediation is separate scope |
| B-11 | Service Request has no quantity authority | Medium | Use one quoted service amount per demand line; do not invent quantity |
| B-12 | Payment/tax/discount authority absent | Medium | Exclude in v1; require a future commercial model before adding |
| B-13 | Multi-approver quorum policy is not configured | High | Start with one designated award approver or govern quorum before multi-approval |
| B-14 | Quote expiry/deadline automation could invite scheduler creep | Low | Resolve at command/read time; no new scheduler |
| B-15 | RFQ-linked DRAFT PO and commitment command are separate operations | Medium | Keep conversion, review, issue, and commitment boundaries explicit/idempotent |

No blocker prevents writing this governance document. B-01/B-02 block a safe
vendor-self-service implementation, and B-05/B-06 must be resolved before
RFQ-to-PO conversion is declared production-ready.

---

## 20. Proposed minimal PART breakdown

The roadmap is intentionally six implementation PARTs. Each PART should remain
small enough for Arena and must not mix unrelated authority changes.

### PART 01 — RFQ foundation + typed demand lineage

- Add RFQ header/line authority with homogeneous `MATERIAL`/`SERVICE` source
  mode.
- Bind Material Request and Service Request lines with Client/Building/PR
  invariants.
- Add RFQ lifecycle foundation and command idempotency.
- Add only internal create/read/open/close behavior needed to establish a safe
  sourcing record.
- No vendor portal, quotation price, award, budget, PO conversion, or OpenAPI
  closure yet.

### PART 02 — Vendor invitation + access boundary

- Add invitation authority, statuses, duplicate protection, eligibility
  revalidation, and audit events.
- Resolve and document the vendor principal/invitation session boundary before
  enabling vendor response.
- Use existing vendor scope/readiness authorities; no vendor data-access grant.
- Integrate notification intent only if a governed vendor recipient exists.

### PART 03 — Quotation + immutable revisions + attachments

- Add quotation header, immutable revision, and typed quote lines for both source
  modes.
- Add exact currency, numeric price, validity, lead-time, compliance,
  quantity/deviation, and supported terms.
- Extend shared Supporting Document parent vocabulary and versioning safely.
- Add vendor-only submit/decline/no-bid behavior after PART 02 boundary approval.

### PART 04 — Evidence-based comparison + evaluation

- Add immutable comparison runs/matrix and evaluator notes.
- Derive only from exact quote revisions and existing vendor authorities.
- Add deterministic completeness/currency/validity/quantity/technical and
  compliance dimensions.
- Keep ranking/recommendation manual; no automatic best-vendor score.

### PART 05 — Recommendation + approval + award

- Extend existing procurement approval binding to an RFQ award target.
- Add recommendation snapshots, designated approver checks, award/no-award,
  conflict/concurrency guards, narrow `rfq.award` authorization, and events.
- Preserve revision/evaluation history and fail closed on ambiguity.
- Still no budget commitment and no automatic PO issue.

### PART 06 — PO conversion + integration/API closure

- Resolve B-05/B-06 PO provenance/edit policy.
- Reuse existing PO Readiness, PO, PO Line, issue, and finance boundaries.
- Convert an approved award to an idempotent DRAFT PO with exact quote lineage;
  do not issue or create a second commitment path.
- Complete OpenAPI, notification/integration event mapping, targeted tests,
  migration verification, and governance closure.

No separate scheduler PART, budget PART, invoice PART, inventory PART, or second
workflow PART is justified by the inspected repository.

---

## 21. PART 01 readiness

### PART 01 implementation status

PART 01 is **implemented** as a narrowly scoped internal RFQ foundation and
typed source-lineage capability. The following acceptance conditions remain
true:

- use the existing Purchase Request, Material Request, Service Request, Vendor,
  Building, RBAC, context-access, operational-event, and migration authorities;
- implement one shared RFQ model with explicit homogeneous `MATERIAL` or
  `SERVICE` source mode;
- do not add quotation price, vendor portal submission, comparison, award,
  PO conversion, budget, commitment, notification provider, scheduler, or
  OpenAPI changes in PART 01;
- use explicit command idempotency and typed database invariants;
- preserve source demand authority and Client/Building isolation;
- make RFQ state changes auditable through `operational_events` with AUDIT-01
  request correlation;
- use migration `0313_create_rfqs` as the PART 01 migration; no later
  migration number was consumed.

### PART 01 implementation notes — DONE (2026-08-23)

Implemented files and authority changes:

- Added `0313_create_rfqs` with `rfqs` and `rfq_lines`.
- Added composite scope keys to the existing Purchase Request, Material Request,
  and Service Request authorities so RFQ lineage cannot drift across Client,
  Building, or Purchase Request.
- Added typed `MATERIAL`/`SERVICE` source mode and exactly-one typed line
  reference constraints. A MATERIAL RFQ cannot contain Service Request lines,
  and a SERVICE RFQ cannot contain Material Request lines. Active source-line
  claims are unique and are released on RFQ cancellation without deleting the
  historical RFQ line.
- Added immutable sourcing snapshots for Client/Building/Purchase Request
  context, source request identity, and demand-line display/quantity/UOM data.
  Source authorities remain authoritative; no price is stored.
- Added idempotent RFQ creation through body `idempotencyKey` or the
  `Idempotency-Key` header, with a payload fingerprint conflict guard.
- Added internal RFQ read/manage routes for DRAFT creation, DRAFT updates,
  typed line addition, line reads, available actions, OPEN/CLOSED/CANCELLED
  foundation transitions, and no vendor/quote/award operations.
- Registered only `rfq.read` and `rfq.manage`; no award or vendor-portal
  permission was added.
- Added append-only operational events for RFQ creation, update, line addition,
  open, close, and cancel through `recordOperationalEvent`, preserving AUDIT-01
  correlation and transactional event/state writes.
- No RFQ operation creates a PO, PO line, budget source, commitment, or budget
  consumption. No OpenAPI change was made because PART 01 governance explicitly
  defers OpenAPI closure.

Validation recorded:

- `npm run typecheck` — PASS.
- `npx tsx --test --test-concurrency=1 tests/rfqs.test.ts` — test database
  unavailable in the default environment; all eight tests were skipped.
- The same exact RFQ suite was then run against an isolated embedded PostgreSQL
  instance — **8/8 PASS**.
- Directly affected `tests/material-requests.test.ts` and
  `tests/service-requests.test.ts` were run against the same isolated database —
  **50/50 PASS**.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

### PART 02 readiness

PART 02 is complete using the approved invitation-scoped external session gate.
Automatic email remains optional and non-blocking; Vendor WhatsApp remains
unavailable because no Vendor consent authority exists.

PART 05 approval/award is not ready until the RFQ target extension and award
permission policy are confirmed. PART 06 conversion is not ready until B-05
and B-06 are resolved.

### PART 01 stop condition

This is the end of CR-BE-PRO-02 PART 01. No Vendor Invitation, Vendor Portal,
Quotation, Comparison, Evaluation, Recommendation, Approval/Award, PO
conversion, budget commitment, scheduler, notification provider integration,
OpenAPI closure, or historical backfill was implemented.

---

## 22. PART 02 implementation notes — DONE (2026-08-23)

### Delivered authority

- Migration `0314_create_rfq_vendor_invitations_and_sessions` adds
  `rfq_vendor_invitations` and `rfq_vendor_access_sessions`.
- Invitations bind RFQ, Vendor, Client, and Building with composite foreign
  keys and preserve `vendors.email` plus Vendor-name snapshots.
- Invitation attempts are immutable history rows. Active invitations are unique
  per `(rfq_id, vendor_id)`; resend creates a new attempt rather than
  overwriting history.
- Internal invitation management is mounted under the existing RFQ domain and
  uses only `rfq.read` / `rfq.manage`. No new permission was added.
- The external boundary is separate from internal authentication and RBAC.
  It supports one-time invitation-token exchange, a dedicated hashed external
  session, Vendor-safe RFQ reads, and accept/decline/no-bid commands.
- Vendor sessions are bound to one invitation and are checked against the
  current RFQ, Vendor, Client, Building, invitation state, and deadline.
- Resend and revoke invalidate prior tokens/sessions. Expiry is resolved at
  command time; no scheduler was introduced.
- No internal User, Credential, Role, User Building Assignment, synthetic User,
  quotation, comparison, award, PO, budget, commitment, or Vendor WhatsApp
  authority was added.
- Automatic invitation email was deliberately not wired. The existing
  notification ledger is User-recipient-only; invitation creation remains
  valid and auditable without delivery. The existing `vendors.email` snapshot
  is preserved for a later non-blocking external-recipient notification seam.

### Token and audit boundary

- Invitation and external-session bearer tokens are generated from
  cryptographically secure randomness and persisted only as SHA-256 hashes.
- Raw tokens are returned only at their one-time issuance boundary and are not
  returned by detail/list/replay reads.
- External actions use `actor_user_id = NULL`, `source = HTTP`, and structured
  `VENDOR_RFQ_SESSION` metadata containing only RFQ/Vendor/invitation/session
  identifiers. Raw token material and token-bearing URLs are never included.
- Operational-event writes are transactional with invitation/session state
  changes where applicable and use AUDIT-01 request correlation.

### Validation recorded

- `npm run typecheck` — PASS.
- Exact PART 02 invitation/session suite — **10/10 PASS** against an isolated
  embedded PostgreSQL instance.
- Covered idempotency, hash-only storage, token replay/expiry/revocation,
  resend invalidation, session expiry, Vendor-safe reads, accept/decline/no-bid,
  cross-invitation/RFQ/Client/Building isolation, no synthetic User creation,
  and audit token non-leakage.
- Default local PostgreSQL was unavailable for the first direct invocation; the
  suite was then rerun successfully against isolated embedded PostgreSQL.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

### PART 03 readiness

PART 03 is complete. PART 04 may now govern and implement evidence-based
multi-vendor comparison and evaluation. It must derive only from immutable
submitted quotation revisions and existing Vendor authorities, and must not
introduce ranking, recommendation, award, or financial commitment behavior.

---

## 23. PART 03 implementation notes — DONE (2026-08-23)

### Delivered authority

- Migration `0315_create_vendor_quotations_and_revision_attachments` adds
  `vendor_quotations`, `vendor_quotation_revisions`, and
  `vendor_quotation_lines`.
- One quotation is bound to one RFQ Vendor Invitation. Every quotation line is
  bound to an RFQ line from that invited RFQ; no unrelated source line can be
  submitted.
- Draft revisions support Vendor-authored currency, validity date, lead time,
  mode-appropriate delivery/service terms, notes, line price, optional
  description, technical compliance, and deviations.
- Material line totals use the existing RFQ quantity snapshot and
  `NUMERIC(18,2)` unit prices. Service lines preserve the existing no-invented-
  quantity convention. Quotation totals are derived from SQL `NUMERIC` line
  totals and are not a commitment authority.
- Submitted revisions are frozen. A later Vendor change requires a new
  sequential revision; prior submitted revisions become `SUPERSEDED` and
  remain readable.
- Attachments reuse shared `documents`, `document_versions`, and
  `supporting_documents`. The shared Supporting Document parent vocabulary was
  widened additively for `RFQ` and `QUOTATION_REVISION`; no parallel file or
  evidence engine was created.
- Vendor quotation reads and commands use the invitation-scoped external
  session. Internal reads use `rfq.read` and existing Building isolation.
- No new permission was added. No RFQ, quotation, revision, comparison,
  recommendation, award, PO, budget, commitment, FX, tax, discount, payment,
  scheduler, or Vendor WhatsApp authority was introduced.

### Revision and audit boundary

- Draft quotation/revision/line updates are guarded by current revision state
  and invitation/Vendor scope.
- Submission revalidates RFQ status, exact RFQ lines, currency, validity,
  technical compliance, deviations, and material quantity compliance before
  freezing the revision.
- Invitation status remains the invitation authority; quote submission marks
  the invitation `QUOTATION_SUBMITTED` through its existing repository seam.
- Quotation, revision, line, submission, and attachment changes are recorded
  through `recordOperationalEvent` with external Vendor actor metadata
  (`actor_user_id = NULL`, `actorType = VENDOR_RFQ_SESSION`) and AUDIT-01
  request correlation.
- Attachment Documents retain the existing internal document creator FK for
  compatibility; the quotation attachment operational event is the external
  Vendor actor audit record. Raw tokens are never included.

### Validation recorded

- `npm run typecheck` — PASS.
- Exact PART 03 quotation/revision suite — **7/7 PASS** against isolated
  embedded PostgreSQL.
- Covered draft ownership, idempotent quotation create, currency/terms/
  compliance validation, submitted revision immutability, new revision flow,
  SQL-derived totals, shared Document/Version/Supporting Document attachments,
  Vendor/internal visibility, no-commitment behavior, and audit token
  non-leakage.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

### PART 04 readiness

PART 04 is **READY** for evidence-based comparison and evaluation only. It must
read submitted quotation revisions as immutable evidence, preserve Vendor and
Building isolation, fail closed on ambiguity, and must not select a Vendor or
create a financial commitment.

---

## 24. PART 04 implementation notes — DONE (2026-08-24)

### Delivered authority

- Migration `0316_create_rfq_comparisons_and_evaluations` adds immutable
  `rfq_comparison_runs`, fixed `rfq_comparison_evidence`, line-level
  `rfq_comparison_lines`, reference-only comparison attachment links, and
  human-authored `rfq_comparison_evaluations`.
- A comparison run is an append-only snapshot for one RFQ. It records the
  exact submitted quotation revision IDs, invitation/Vendor/Client/Building
  scope, submission facts, line evidence, derived totals, and attachment
  references. It does not copy document content.
- Only one applicable `SUBMITTED` revision per valid quotation invitation is
  included. Draft-only quotations are excluded; superseded revisions are not
  selected. Duplicate submitted revisions, inconsistent scope, inactive Vendor
  scope, missing lines, and currency mismatch fail closed.
- Comparison arithmetic is factual only. Material quantity remains the RFQ
  quantity snapshot. Service lines retain null required and quoted quantities.
  Unit price, line total, quotation total, lowest/highest values, deltas, and
  mathematically valid percentage deltas are exposed without selecting a
  Vendor.
- Existing submitted technical compliance and deviation evidence is copied as
  a comparison fact snapshot. No technical score or price-derived compliance
  is calculated.

### Evaluation and access boundary

- Internal comparison reads use `rfq.read` plus existing Building isolation.
  Comparison creation and human evaluation create/update use `rfq.manage`.
- Vendor RFQ sessions have no comparison or evaluation route and cannot see
  peer prices or evaluator notes. No Vendor permission or internal identity was
  added.
- Evaluation rows bind to one exact comparison evidence row and expose only
  commercial, technical, compliance, and evaluator observations. There is no
  weighted scoring, winner, recommendation, approval, award, or automatic
  selection field.
- A later submitted quotation revision never mutates an existing run. A new
  comparison request explicitly snapshots the newly applicable revision.

### Audit and financial boundary

- Comparison creation and evaluation create/update actions record operational
  events with the exact comparison/evidence/quotation-revision/Vendor IDs and
  AUDIT-01 request correlation. No invitation or session token is persisted in
  event metadata.
- The comparison and evaluation paths create no PO, invoice, budget source,
  operational commitment, commitment ledger entry, accounting posting, or
  other financial side effect. The existing ISSUED PO-line boundary remains
  unchanged.

### API and validation recorded

- Internal routes are limited to RFQ-scoped comparison creation/list/read and
  comparison-scoped evaluation create/read/update. No external Vendor route is
  mounted.
- `npm run typecheck` — PASS.
- Exact PART 04 comparison/evaluation suite — **5/5 PASS** against an isolated
  embedded PostgreSQL instance.
- Directly affected PART 03 quotation suite — **7/7 PASS** against an isolated
  embedded PostgreSQL instance.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

## 25. PART 05 implementation notes — DONE (2026-08-24)

### Pre-check and delivered authority

- PART 03 was confirmed present before implementation: commit `3bc2192`
  contains the immutable Vendor quotation/revision implementation and
  migration `0315_create_vendor_quotations_and_revision_attachments` is
  registered in the migration runner.
- Migration `0317_create_rfq_recommendations_approvals_awards` adds one
  immutable human recommendation per RFQ, exact comparison/evidence linkage,
  the RFQ target extension on the existing procurement approval binding, and
  one immutable RFQ award record per RFQ.
- A recommendation is a human-selected Vendor/evidence revision or an
  explicit `NO_AWARD` proposal. The reason is mandatory; notes are preserved.
  No price, array order, score, or automatic selection is used.
- Recommendation creation requires a CLOSED RFQ, a valid comparison snapshot,
  and a current applicable submitted revision. A changed current revision,
  withdrawn/invalid quotation, expired validity, inactive Vendor, or invalid
  Vendor-Building scope fails closed.

### Approval and award

- Existing `procurement_approval_bindings` is extended with typed `RFQ`,
  `rfq_id`, and `recommendation_id` fields. RFQ approval requires
  `approval_type = RFQ_AWARD`, the exact recommendation, and one pending
  designated approver. Existing Purchase/Material/Service approval behavior is
  preserved.
- Approval transitions update the recommendation under the existing approval
  transaction boundary and emit RFQ approval audit events. A terminal approval
  cannot be overwritten.
- Award requires the exact recommendation to be approved by the existing
  procurement approval authority. The award command locks the RFQ and
  recommendation, revalidates source lines, Vendor scope, currency, validity,
  and the exact current submitted revision, then stores an immutable reference.
  A unique RFQ award constraint and row locking make concurrent award attempts
  fail closed rather than choose a second Vendor.
- `rfq.award` is registered as a sensitive permission and is explicitly
  unassigned by default, including from `PLATFORM_ADMIN`. Award routes do not
  use `rfq.manage` as a substitute.

### Access, audit, and financial boundary

- Internal recommendation/award reads use `rfq.read` and Building isolation;
  recommendation creation uses `rfq.manage`; final award uses `rfq.award`.
  Vendor RFQ sessions receive no recommendation, approval, or award routes.
- Recommendation creation, RFQ approval submission/decision, and award/no-award
  finalization emit operational events with exact RFQ, comparison, evidence,
  recommendation, approval, quotation revision, and Vendor IDs. Request
  correlation remains provided by AUDIT-01.
- Recommendation, approval, and award create no PO, PO line, budget source,
  operational commitment, invoice, accounting entry, or payment. The ISSUED
  Purchase Order line remains the sole automatic priced commitment authority.

### Validation recorded

- `npm run typecheck` — PASS.
- Exact PART 05 recommendation/approval/award suite — **3/3 PASS** against an
  isolated embedded PostgreSQL instance, including concurrent award,
  stale-revision, default-permission, approval-gate, and financial-boundary
  checks.
- Directly affected PART 04 comparison suite — **5/5 PASS** against an
  isolated embedded PostgreSQL instance.
- Directly affected procurement approval suite — **20/20 PASS** against an
  isolated embedded PostgreSQL instance.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

## 26. PART 06 implementation notes — DONE (2026-08-24)

### Conversion authority and provenance

- Migration `0318_create_rfq_award_po_provenance` adds typed conversion and
  per-line provenance links. It does not add a second PO model, price ledger,
  quantity ledger, or commitment source.
- Conversion accepts only a finalized Vendor RFQ award, a matching READY
  existing Purchase Order Readiness, and the exact awarded submitted quotation
  revision. It reuses the existing Purchase Order and Purchase Order Line
  repository authorities to create an existing DRAFT PO.
- The stored chain is RFQ → Award → Vendor → Quotation → Quotation Revision →
  PO → PO Lines. Each RFQ line maps deterministically to its awarded quote line
  and preserves Material/Service request lineage. No FX or currency conversion
  is performed.
- Conversion is idempotent by `(award_id, idempotency_key)` and serialized by
  the award lock. A second conversion returns the same result only for the
  same payload/key; another key fails with an already-converted conflict.

### DRAFT PO policy and financial boundary

- RFQ-derived DRAFT PO headers and lines are guarded from generic update,
  cancel, add, edit, or removal routes. This restriction applies only to
  RFQ-derived POs; normal non-RFQ DRAFT PO behavior remains unchanged.
- Explicit PO issuance remains available through the existing PO issuance
  authority. Conversion, DRAFT PO creation, PO Readiness, award, and approval
  create no budget reservation, operational commitment, invoice, accounting
  entry, or payment. Only an eligible ISSUED PO Line reaches the existing
  COMM-VAR commitment authority.

### Integration and OpenAPI closure

- Conversion provenance is readable through internal Building-scoped routes;
  Vendor RFQ sessions have no Purchase Order or provenance access.
- Conversion emits an AUDIT-01-correlated operational event with exact RFQ,
  award, recommendation, comparison, evidence, quotation revision, Vendor,
  PO, readiness, and PO-line IDs. Shared Documents/Supporting Documents remain
  the quotation attachment authorities; conversion adds no file engine.
- OpenAPI now documents PART 01–06 RFQ surfaces, including the separate
  invitation-scoped `vendorRfqSession` security scheme, quotation revisions and
  attachments, comparisons/evaluations, recommendation, RFQ approval/award,
  conversion/provenance, and the `rfq.award` boundary. It explicitly documents
  that peer-Vendor/comparison/award/PO data is unavailable to Vendors and that
  only ISSUED PO Lines can create commitments.

### Validation recorded

- `npm run typecheck` — PASS.
- Exact PART 06 conversion/provenance suite — **2/2 PASS** against isolated
  embedded PostgreSQL, including idempotent/concurrent conversion, provenance,
  DRAFT mutation guards, issuance, and no-commitment checks.
- OpenAPI contract suite — **2/2 PASS**.
- Directly affected PART 04 comparison suite — **5/5 PASS**.
- Directly affected procurement approval suite — **20/20 PASS**.
- Directly affected RFQ/invitation/Vendor suites — **42/42 PASS**.
- Foundation seed/default-permission check — **1/1 PASS**.
- `git diff --check` — PASS.
- No broad regression suite, CI, or KI-003 work was run.

### FINAL REVIEW readiness

PART 06 is complete. The full RFQ procurement capability is implemented
through conversion and provenance. No PR or merge is part of this work. The
repository is ready for FINAL REVIEW; downstream finance remains governed by
the existing ISSUED PO-line authority.

## Repository inspection references

The principal inspected authorities were:

- `src/database/migrations/0176_create_purchase_requests.ts`
- `src/database/migrations/0177_create_material_requests.ts`
- `src/database/migrations/0178_create_service_requests.ts`
- `src/database/migrations/0179_create_procurement_approval_bindings.ts`
- `src/database/migrations/0180_create_vendor_selection_readiness.ts`
- `src/database/migrations/0181_create_purchase_order_readiness.ts`
- `src/database/migrations/0182_create_receivings.ts`
- `src/database/migrations/0264_add_receiving_material_request_binding.ts`
- `src/database/migrations/0265_add_material_request_approved_quantity.ts`
- `src/database/migrations/0269_create_purchase_orders.ts`
- `src/database/migrations/0270_create_purchase_order_lines.ts`
- `src/database/migrations/0271_add_purchase_order_issuance.ts`
- `src/database/migrations/0283_create_operational_budget_foundation.ts`
- `src/database/migrations/0284_create_operational_budget_source_bindings.ts`
- `src/database/migrations/0309_add_operational_event_correlation.ts`
- `src/database/migrations/0310_add_operational_budget_overspend_policy.ts`
- `src/database/migrations/0311_create_operational_commitments.ts`
- `src/database/migrations/0312_create_operational_commitment_entries.ts`
- `src/database/migrations/0314_create_rfq_vendor_invitations_and_sessions.ts`
- `src/database/migrations/0315_create_vendor_quotations_and_revision_attachments.ts`
- `src/database/migrations/0316_create_rfq_comparisons_and_evaluations.ts`
- `src/database/migrations/0317_create_rfq_recommendations_approvals_awards.ts`
- `src/database/migrations/0318_create_rfq_award_po_provenance.ts`
- `src/database/migrations/0054`–`0062` vendor foundation migrations
- `src/database/migrations/0224`, `0229`, `0230` shared document authorities
- `src/database/migrations/0303`–`0305` evidence integrity/retention authorities
- `src/database/migrations/0306`–`0308` integration outbox/webhook authorities
- `src/modules/purchase-orders`, `material-requests`, `service-requests`,
  `procurement-approvals`, `vendor-selection-readiness`,
  `purchase-order-readiness`, `receivings`, `operational-finance`,
  `rfq-recommendations`, `rfq-po-conversions`
- `src/modules/operational-events`, `context-access`, `auth`, `documents`,
  `document-versions`, `supporting-documents`, `evidence`, `vendor-quotations`
- `src/routes/index.ts`, `docs/api/openapi.yaml`, and
  `src/database/seeds/foundation-access.seed.ts`
- `docs/CR-BE-COMM-VAR-01_START_GOVERNANCE.md`,
  `docs/CR-BE-AUDIT-01_START_GOVERNANCE.md`,
  `docs/CR-BE-DOC-CONTROL-01_START_GOVERNANCE.md`,
  `docs/CR-BE-INTEG-01_START_GOVERNANCE.md`, and
  `docs/reviews/CR_BE_MAT_01_AUDIT.md`

PART 01–06 validation is recorded in §§21–26. No broad regression, CI, or
KI-003 work was run.

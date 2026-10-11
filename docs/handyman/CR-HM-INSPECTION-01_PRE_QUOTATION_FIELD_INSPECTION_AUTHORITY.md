# CR-HM-INSPECTION-01 — PRE-QUOTATION FIELD INSPECTION AUTHORITY FREEZE

| Field | Value |
|---|---|
| Status | **Design proposed; owner business direction approved; not frozen pending §12 decisions** |
| Date | 2026-10-11 (Asia/Jakarta) |
| Branch / reviewed baseline | `arena/b4a8612c-handyman-backend` / `65c3ea0fc44b1ec9543c4e419ad71efa48272b40` |
| Change class | Design contract only — no production code, migration, permission seed, or test change |
| Related review | [`W03_INSPECTION_TO_QUOTATION_GAP_REVIEW.md`](../e2e/W03_INSPECTION_TO_QUOTATION_GAP_REVIEW.md), including the historical Part 02 STOP and owner-direction follow-up |
| Final reconciliation | [`CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md`](CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md) — owner proposals 1–8 and freeze verdict |

> **Freeze condition:** the approved business direction below is sufficient to design the additive authority, but this contract is not implementation-ready until the authority and compatibility decisions in §12 are answered. No unresolved policy is inferred here.

## 1. Purpose and scope

This contract defines an additive pre-quotation inspection workflow for Handyman requests whose Operations triage disposition is `INSPECTION_REQUIRED`:

1. Operations assigns an individual Field Worker/Surveyor to the request before quotation. This design proposes completing that assignment before the physical inspection, subject to confirmation under D5.
2. The assigned Field user submits immutable, versioned technical inspection reports.
3. Operations accepts or returns each submitted version. A returned report is corrected by a **new version**, never by editing the returned version.
4. An accepted report is a prerequisite for preparing a quotation DRAFT for an inspection-required request.

The Field assignment is a pre-quotation request task. It is **not** CR-HM-04 crew assignment, provider assignment, Execution Scope authorization, or work-execution authority. It creates no quotation, customer approval, price, or service commitment.

This contract does not decide which `DIAGNOSIS` (direct-to-diagnosis) requests are eligible for quotation. That service-policy decision remains deferred. It does not add an issue-time quotation gate, evidence subsystem, reinspection capability, execution assignment, or new request status.

## 2. Owner-approved business direction

The following direction is treated as approved for this design:

- Operations assigns a Field Worker/Surveyor before quotation, independently of the post-approval CR-HM-04 crew assignment.
- Field assessments are versioned and immutable. Operations accepts or returns each version; corrections append a new version.
- Report estimates express technical scope and quantities, not final commercial prices.
- For requests triaged `INSPECTION_REQUIRED`, acceptance is required before quotation DRAFT preparation.
- Direct-to-diagnosis remains an exception whose service-policy eligibility authority is still pending; this contract adds no eligibility criteria.
- Assignment, report submission, and report review use three dedicated permissions in the existing RBAC architecture.

## 3. Compatibility with frozen authorities

### 3.1 CR-HM-03 request and inspection authority

- **F1 remains unchanged.** Do not add request statuses for report-submitted, accepted, or returned. Report lifecycle is separate authority, derived from report and review records.
- **F2 remains immutable.** Migration `0381` remains the one-per-request physical inspection/outcome fact (`INSPECTED` or `NOT_INSPECTABLE`, actor, time, and existing scope snapshot). New report versions do not update or repurpose that row.
- **F3 remains closed.** No evidence references, uploads, attachments, checklists-as-evidence, or parallel evidence engine are introduced. Evidence remains under CR-HM-10 authority.
- **F6 remains audit-only.** Operational events record who did what and when, but report/review rows remain the source of current business state.
- **F7 remains server-authenticated and request-scoped.** Actor identity comes from the authenticated local user; client, request, and Building scope are derived from the request, never trusted from the body.
- **F8 needs a narrow follow-up.** The existing lifecycle API surface is not expanded into a generic workflow router. Assignment and report/review routes belong to a separate CR-HM-INSPECTION-01 API surface. The existing `POST /inspection` write cannot remain an unrestricted `tenant_company.manage` path for post-cutover inspection-required requests, and `POST /diagnosis` cannot publish a diagnosis from a pending or returned report. Those writes must delegate to the new authority or fail closed for the in-scope path; the existing direct `DIAGNOSIS` diagnosis flow remains. Exact endpoint compatibility is open in §12.
- **F9 remains server-derived.** The Field may recommend a discipline/service and describe scope; the service validates the active discipline/service relationship and derives classification from the existing mapping. A client-supplied classification is ignored or rejected.

The existing `handyman_request_inspections` row is still the physical inspection record. Versioned report content and review facts are separate additive records. Corrections to a report do not imply a second site visit or mutate the 0381 row.

### 3.2 CR-HM-04 assignment and Execution Scope

The new assignment targets a Handyman request before quotation. It does not target `handyman_execution_scopes`, require an `AUTHORIZED` Execution Scope, select a provider crew, or grant execution authority. The CR-HM-04 post-PIC assignment gate remains exactly where it is. Do not backdate, pre-create, or simulate an Execution Scope to represent inspection assignment.

The owner-approved Field assignment is an explicit additive authority outside CR-HM-04. It must be recorded as such in the frozen roadmap/contract map before runtime implementation; it is not a reinterpretation of CR-HM-03's existing provider/crew exclusion.

### 3.3 Quotation, PIC, integration, and pricing authorities

- The accepted-report prerequisite applies only to **quotation DRAFT preparation** for requests triaged `INSPECTION_REQUIRED` (initial DRAFT and any later DRAFT revision).
- Do not add a quotation issue gate. Do not change Tenant/PIC approval authority, session validation, approval binding, audit/binding behavior, S1 staff decision 403, B12 OFF, migration 0441 behavior, or the 0443 Execution Scope gate.
- BM remains the integration/customer channel. Handyman owns integration configuration. Tenant/PIC remains the quotation decision actor; neither BM channel-level integration attestation nor PIC authority assigns Field staff or accepts inspection reports. Channel attestation is not company/Building membership, Field authorization, or quotation decision scope.
- Report estimate lines carry quantities and units only. They do not carry unit prices, extended amounts, currency, markup, supplier cost, or a final charge. CR-HM-12 and quotation-line pricing authorities remain downstream and unchanged.
- The direct `DIAGNOSIS` route remains outside the accepted-report gate. Its quotation eligibility is not established by this contract; no direct-service policy is invented.

## 4. Actors, RBAC, and resource scope

### 4.1 Dedicated write permissions

Register these exact permission codes through the existing permission registry and seed conventions:

| Permission | Authority |
|---|---|
| `handyman.operations.inspection.assign` | Assign or reassign a Field user to an inspection-required request |
| `handyman.field.inspection.report.submit` | Record the assigned Field user's inspection/report submission and submit a report version |
| `handyman.operations.inspection.report.review` | Accept or return a submitted report version |

Add the new codes to the existing `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` pattern. Do not add a new role, auto-grant any of these permissions, introduce role provisioning, create a Platform Admin/Operations Security role, or build a generic permission framework. Grant administration remains in the existing RBAC process.

`tenant_company.manage` and `handyman.operations.request.triage` are not substitutes or fallbacks for these three write authorities.

### 4.2 Identity and scope checks

- Every operation resolves the request first. `client_id` and exact `building_id` come from that persisted request; body-supplied tenant/client/building/channel/actor values are not authoritative.
- An Operations assigner or reviewer must hold the corresponding dedicated permission **and** pass the existing request-derived exact-Building resource-access check.
- The assigned target is a local `users.id`. The target user must be active, hold `handyman.field.inspection.report.submit`, and have active resource access to the request's exact Building. Assignment does not use provider, crew, Lead, Execution Scope, BM, Tenant, or PIC identity.
- Report submission requires the authenticated user to equal the active `assigned_field_user_id` and pass the exact-Building check. For version 1, the assignment target must match the physical inspector recorded in 0381. If an approved reassignment is allowed after a return, the new version records its actual submitter/assignment; it must not rewrite the original 0381 inspector. A user with the permission but without the current request assignment is denied.
- Review requires the review permission and exact-Building access. Whether a reviewer may be the report author or assigning Operations actor is not settled; the recommended no-self-review rule is an open decision under D6, not an assumed grant boundary.
- Read access reuses existing scoped request-read authority. The assigned Field user may read their own assignment, report versions, and return reasons; Operations may read within its existing request-read scope. No BM/customer/PIC report surface is added by this contract.

## 5. Proposed lifecycle and API boundary

The status values below belong to the inspection-report aggregate, not `handyman_service_requests.status`.

1. **Triage:** request is explicitly `INSPECTION_REQUIRED`. The direct `DIAGNOSIS` path is not eligible for Field assignment under this contract.
2. **Assignment:** Operations creates one active request assignment before quotation. This design proposes creating it before the physical inspection; confirm that stricter cutoff under D5. Assignment is a durable business fact with assigner, target, server time, and request scope.
3. **Physical inspection:** the assigned Field user records the existing 0381 physical inspection fact. For in-scope, post-cutover requests, this write must enforce the new assigned-Field permission and binding; the old generic manage path must not bypass it. The request's existing projection to `DIAGNOSIS` is unchanged.
4. **Report submission:** the assigned Field user submits version 1 linked to the 0381 row and assignment. The report begins as derived `PENDING_REVIEW`; no separate mutable status is written.
5. **Review:** Operations reviews only the latest pending version and writes exactly one immutable decision for it:
   - `ACCEPTED` is terminal for that report/request workflow. It does not approve a quotation or authorize work.
   - `RETURNED` requires a non-empty correction reason. It does not change the report. The assigned Field user corrects it by submitting version `n+1`, linked to the previous returned version and the applicable assignment.
6. **Quotation DRAFT:** for an inspection-required request, initial quotation creation and creation of each later DRAFT revision require a latest accepted report and the canonical diagnosis/scope required by the existing quotation service. The inspection gate is checked from persisted triage/report/review facts, not request JSON or audit events.

Only the latest submitted version may be reviewed. A new version is allowed only when the preceding version was returned. A report cannot be returned after acceptance; a new physical inspection, post-acceptance amendment, or reinspection is outside this contract.

### Proposed HTTP surface

The exact router names may follow repository conventions; these operations must remain a separate inspection-authority surface rather than expanding the frozen eight-operation lifecycle router:

- `POST /handyman/requests/:handymanRequestId/inspection-assignment`
- `GET /handyman/requests/:handymanRequestId/inspection-assignment`
- `POST /handyman/requests/:handymanRequestId/inspection-reports`
- `GET /handyman/requests/:handymanRequestId/inspection-reports`
- `GET /handyman/requests/:handymanRequestId/inspection-reports/:reportId`
- `POST /handyman/requests/:handymanRequestId/inspection-reports/:reportId/review`

The current `POST /handyman/requests/:handymanRequestId/inspection` remains the physical inspection capture path unless the route decision in §12 selects a replacement. Regardless of path, there must be one assignment-gated writer for in-scope requests; no legacy route may create an inspection that bypasses the assigned Field authority. A report version must reference the existing 0381 physical inspection row.

## 6. Proposed minimal persistence

All records are additive. `client_id`, `building_id`, and request linkage are server-derived snapshots consistent with existing request-scoped records. No migration may update or synthesize historical 0381/0382 facts.

### 6.1 Request inspection assignments

Logical table: `handyman_request_inspection_assignments`.

Minimum facts:

- assignment id; request/client/building scope;
- `assigned_field_user_id` and `assigned_by_user_id`;
- server `assigned_at`; active/superseded state and supersession link/time;
- optional reassignment reason; and
- FK constraints binding the assignment to the same request/client/building.

There is at most one active assignment per request. Reassignment preserves the prior row and audit history; it is not an update that erases the former assignee. The proposed policy creates assignment while the request is `INSPECTION_REQUIRED` and before 0381 inspection capture; the exact assignment cutoff (before physical inspection versus before report submission) must be confirmed under D5. The target must pass the identity/permission/scope checks in §4.2. Whether reassignment is allowed after a returned report, and whether it can change the report author for a correction, remains open in §12.

### 6.2 Versioned technical reports

Logical table: `handyman_request_inspection_reports`.

Minimum facts:

- report id; request/client/building scope;
- FK to the existing 0381 inspection row and the assignment used;
- positive per-request `version_number` and optional `supersedes_report_id`;
- authenticated `submitted_by_user_id` and server `submitted_at`;
- bounded technical findings and proposed diagnosis/scope;
- active Handyman discipline id and optional recommended service-catalog id, validated against existing client/discipline rules; and
- server-derived classification only (never a client-authoritative classification).

A unique `(handyman_request_id, version_number)` constraint enforces version identity. Version allocation is serialized under the request/report aggregate lock. Submitted report rows and their estimate children are immutable; a correction is a new row, not an update.

### 6.3 Technical estimate lines

Logical child table: `handyman_request_inspection_report_estimates`, keyed to a report version.

Each line contains only a line type (`LABOR` or `MATERIAL`), a technical description, a positive quantity, and a reference to the existing unit-of-measure authority. Lines express estimated scope/quantity. There are no price, amount, currency, tax, markup, supplier, or customer-charge fields. Do not write these lines into quotation lines or CR-HM-12 pricing-basis tables.

### 6.4 Immutable review decisions

Logical table: `handyman_request_inspection_report_reviews`.

Minimum facts:

- one review id and unique report-version FK;
- request/client/building scope copied from the report by the server and constrained to that report (supports scoped reads and a one-accepted-report-per-request index);
- `ACCEPTED` or `RETURNED` decision;
- authenticated reviewer id and server `reviewed_at`;
- return reason (required for `RETURNED`; accepted note optional); and
- on acceptance, a link to the canonical diagnosis created from that accepted report, if the diagnosis-link decision in §7 is approved.

A report version has at most one review decision. The write service locks the request/report chain and permits review only for the latest pending version. At most one report version per request can be accepted. Report status is derived from the presence/decision of its immutable review row.

### 6.5 Integrity and immutability

Use same-request/same-client/same-building composite foreign keys where supported by the existing schema. Enforce the one-active-assignment, unique-version, one-review-per-version, and one-accepted-report-per-request invariants in the database as well as the service. Report, estimate, and review history cannot be updated or deleted. The prior assignment remains queryable after supersession. Do not store idempotency keys on these business rows; use the shared idempotency substrate in §8.

## 7. Relationship to existing inspection and diagnosis records

### 7.1 Inspection record 0381

The 0381 row remains the single physical inspection/outcome record. It captures the existing `INSPECTED`/`NOT_INSPECTABLE` result, physical inspector, time and notes. A versioned report references this row; it does not copy/replace its outcome. Returning a report and submitting a corrected report does not create a second 0381 row or claim a second site visit.

Because 0381 is unique per request, this model supports report corrections based on the same visit, not a new physical inspection. It cannot silently simulate reinspection.

### 7.2 Diagnosis record 0382

The 0382 diagnosis remains the one-per-request immutable canonical diagnosis/scope authority. Proposed relationship:

- Field report versions contain the Field-authored technical findings and proposed diagnosis/scope.
- A returned version does not create or mutate a 0382 diagnosis.
- On accepting the report, the acceptance transaction materializes one canonical 0382 diagnosis from that accepted report and the accepted review record links to that diagnosis id. This prevents the existing diagnosis endpoint from publishing an unaccepted Field version and preserves the 0382 one-per-request constraint.
- The diagnosis row continues to use existing F9 server-derived discipline/classification rules. The existing `createHandymanQuotation()` diagnosis requirement and scope allowlist remain in force in addition to the accepted-report gate.

**Open provenance decision:** 0382 currently records `diagnosed_by_user_id` and `diagnosed_at`, while acceptance is performed later by Operations. The owner must confirm whether those canonical diagnosis facts represent the Field report author/submission time (recommended, with reviewer/time recorded separately in the review row), or the Operations reviewer/acceptance time. The implementation must not silently relabel the author or inject a historical actor/time through the existing diagnosis service. The accepted report-to-diagnosis link and the selected actor/time semantics must be explicit before freeze.

For `INSPECTION_REQUIRED`, the existing public diagnosis write must not create a 0382 row from a pending or returned report; acceptance is the sole materialization path. The direct `DIAGNOSIS` route retains its existing diagnosis behavior. The acceptance operation may use a private transaction-aware diagnosis materialization path; it must not grant the reviewer Tenant/PIC or quotation authority, reuse `tenant_company.manage` as an implicit reviewer grant, or create a second diagnosis record.

## 8. Audit, transaction, and idempotency contract

### 8.1 Audit

Persist business truth in assignment, report, estimate, and review rows. Append operational events in the same transaction for assignment/reassignment, report submission, and acceptance/return. Events should reference the relevant request, assignment/report ids, version, decision, authenticated actor, and server time. They must not copy full report contents, estimate payloads, return text, customer/PIC proof, or raw idempotency keys. Event history is not a substitute for a review row or current report state.

### 8.2 Shared idempotency

Use CR-BE-IDEMPOTENCY-CORE-01's existing `request_idempotency_records` and `executeIdempotent()` service; do not add a bespoke table, key column, cache, or generic idempotency framework.

Use required, normalized `Idempotency-Key` headers and server-defined operation keys in the existing `hm.*` namespace, for example:

- `hm.inspection.assignment.create`
- `hm.inspection.physical.capture` (if 0381 remains a separate write operation)
- `hm.inspection.report.submit`
- `hm.inspection.report.review`

Each stable request fingerprint includes the normalized semantic body and path/resource ids; actor identity is part of the shared idempotency identity. Expected inherited behavior:

- same actor + operation + key + fingerprint replays the stored successful status/body and does not create a second assignment, physical inspection, report version, review decision, or event;
- same actor + operation + key with a different fingerprint returns the shared 409 idempotency conflict;
- a different actor or operation is a separate namespace;
- the claim, business writes, audit event, and stored success commit or roll back in one transaction; failures leave no completed/poisoned record; and
- the raw key is hashed by the shared service and never stored in logs, events, errors, or audit metadata.

The shared success-response limit is 65,536 UTF-8 bytes. Mutation responses should return compact ids/version/decision facts; clients retrieve full report content through scoped GET routes. Version allocation and review/assignment invariants still require row locks and database constraints; idempotency does not replace business concurrency control.

## 9. Quotation DRAFT prerequisite

For a request whose persisted triage disposition is `INSPECTION_REQUIRED`, the quotation service must require all of the following before creating any new DRAFT:

1. a report version linked to the request's 0381 inspection and a valid Field assignment;
2. an immutable `ACCEPTED` review for the latest report version; and
3. the canonical, quoteable 0382 diagnosis/scope required by the existing quotation contract, linked to that accepted report as defined in §7.

Apply the same precondition to a later DRAFT revision. Do not apply it to requests whose persisted triage disposition is `DIAGNOSIS`; that direct path remains subject only to existing diagnosis/quoteability checks and the separately pending service-policy eligibility authority.

This is a prerequisite for DRAFT preparation only. It does not change quotation issue, expiry, PIC decision, approval binding/session, Execution Scope, crew assignment, or execution gates. Existing DRAFTs and issued/approved historical quote versions are not retroactively invalidated by this design. The behavior for new drafts from pre-cutover inspected requests without assignment/report facts is an explicit open decision (§12).

An accepted report is necessary, not by itself sufficient for a quote. Existing diagnosis quoteability and service policy remain applicable. In particular, `NOT_INSPECTABLE` must not become quoteable merely because a reviewer records `ACCEPTED`.

## 10. Non-goals and prohibitions

This contract does not authorize:

- defining direct-to-diagnosis or service-specific quotation eligibility;
- a quotation issue gate or change to PIC approval authority;
- evidence uploads, attachment references, or a parallel evidence engine;
- new request statuses or mutation of 0381/0382 history;
- reinspection, post-acceptance report amendment, or repeated Field trips;
- pre-PIC Execution Scope creation, provider/crew assignment, or execution rights;
- customer/BM/PIC acceptance of a Field report;
- final prices or commercial quote lines in an inspection report;
- a new RBAC framework, role, provisioning API, or automatic permission grants; or
- changes to integration ownership, migration 0441, S1, B12, binding/session behavior, or the 0443 gate.

## 11. Acceptance criteria and focused test matrix

These are design acceptance criteria for a later implementation; no tests are claimed as run in this design-only change.

| # | Focus | Expected result |
|---:|---|---|
| 1 | Dedicated permissions | Assignment, submit, and review each require their dedicated permission. `tenant_company.manage` and triage permission alone cannot perform them. No default grant is introduced. |
| 2 | Exact Building scope | An assigner/reviewer/Field user with access to another Building is denied; all persisted scope is derived from the request. |
| 3 | Assignment target | Inactive user, user without report-submit permission, wrong-building target, non-`INSPECTION_REQUIRED` request, and second active assignment are rejected. |
| 4 | Assigned Field binding | Unassigned Field, another Field user in the same Building, or stale/superseded assignee cannot submit. Version 1's assigned target matches the 0381 inspector; any reassigned correction records the new submitter without changing 0381. |
| 5 | First report | Version 1 links to the request, current assignment, and one 0381 inspection; server actor/time and F9 classification are correct. No client-supplied scope/actor/building is trusted. |
| 6 | Version immutability | Updates/deletes of a submitted report, estimates, or review fail. A pending report cannot be replaced or duplicated with a new idempotency key. |
| 7 | Return/correction chain | Review is allowed only on latest pending version; `RETURNED` requires a reason; v2 links to returned v1; v1 and its decision remain unchanged. |
| 8 | Acceptance/reviewer authority | Review permission and Building scope are required; a report gets only one decision; enforce any reviewer/author/assigner separation approved under D6; acceptance is terminal and links the canonical diagnosis. |
| 9 | Diagnosis relationship | A returned report creates no 0382 diagnosis. Accepted data materializes at most one immutable diagnosis with the agreed actor/time and report provenance. Existing F9 classification is server-derived. |
| 10 | Draft-only gate | For `INSPECTION_REQUIRED`, initial quotation DRAFT and DRAFT revision fail before acceptance and succeed only after accepted latest report plus quoteable diagnosis. Issue-time behavior is unchanged. |
| 11 | Direct diagnosis path | An existing `DIAGNOSIS` request does not require assignment/report acceptance; no test asserts a new direct-service eligibility policy. |
| 12 | Idempotent replay/conflict | Identical actor/op/key/fingerprint returns the original compact success and creates one business row/event; same key with changed body/resource conflicts; another actor is isolated; rollback leaves no idempotency success. |
| 13 | Audit | Assignment, submit, accept, and return events identify actor/resource/version/decision and omit raw key and report/estimate contents. Database rows, not events, determine current state. |
| 14 | Historical compatibility | Existing 0381/0382/quotation rows are not modified or synthetically accepted; existing quote versions remain intact; legacy draft behavior follows the approved cutover rule. |
| 15 | Existing route bypass | The legacy inspection write cannot create an in-scope 0381 row without active assignment and dedicated Field authority. |
| 16 | Evidence/pricing boundary | No evidence reference or commercial amount is accepted or persisted in the new report model. |
| 17 | `NOT_INSPECTABLE` | An accepted not-inspectable result cannot create a quote DRAFT absent a separate explicit authority decision. |

## 12. Decisions required before freeze

The following are unresolved. The recommendations are design defaults, not approved policy.

| ID | Decision | Recommended safe default / freeze requirement |
|---|---|---|
| D1 | **0382 actor/time and source linkage.** Does the canonical diagnosis represent the Field-authored accepted report (`diagnosed_by_user_id` = Field author; `diagnosed_at` = report submission time), or an Operations diagnosis/ratification at acceptance? How is the report id linked without rewriting history? | Prefer Field author/time in 0382 plus a review-row FK to the diagnosis and separate reviewer/time. Obtain explicit approval because current 0382 service semantics use the authenticated diagnosis actor. |
| D2 | **Existing inspection/diagnosis endpoint compatibility.** The current `POST /inspection` and `POST /diagnosis` writes use existing manage authority; leaving them as alternate in-scope writers could bypass assignment or report acceptance. | Choose whether each route delegates to the new assignment/review authority or fails closed for in-scope requests. The direct `DIAGNOSIS` route remains available under its existing contract. One writer only; record the narrow F8 permission/transition amendment. |
| D3 | **Historical/in-progress cutover.** Existing inspection-required requests may have 0381/0382 rows but no assignment/report/review; there must be no synthetic assignment or acceptance. | Preserve existing quotes and immutable rows. Decide whether a new DRAFT from a pre-cutover inspected-but-unquoted request is blocked until a valid accepted report is added, or explicitly grandfathered. If grandfathered, define a durable cutover marker/rule; do not infer from missing report data. |
| D4 | **`NOT_INSPECTABLE` and physical revisit.** 0381 permits one row per request and there is no reinspection authority. | Fail closed for quotation. Decide whether Operations may accept a not-inspectable report as a non-quoteable closure, return it, or require a separately authorized revisit workflow. A correction version cannot claim a second physical visit. |
| D5 | **Assignment timing, identity, and reassignment.** This design uses `users.id` plus the dedicated permission and exact Building access; it does not require a provider crew or CR-HM-04 workforce context. The owner direction says assignment before quotation; the proposed stricter cutoff is before the physical inspection. Reassignment after a return is not settled. | Confirm pre-visit versus pre-report assignment. Confirm whether an additional active workforce/certification fact is required. Define whether the same Field must correct a returned report or Operations may reassign before the next version; preserve every assignment row. |
| D6 | **Reviewer independence.** Owner direction assigns submission to Field and review to Operations, but it does not define whether the same local user may hold both permissions or whether the assigning Operations actor may review. | Recommend that a report author cannot review their own report. Explicitly decide whether that rule, assigner/reviewer separation, or reviewer separation across report versions is required before freeze. |
| D7 | **Inspection-specific F8/roadmap amendment.** The approved pre-quotation assignment/report authority is additive to old CR-HM-03/04 wording, and the new authority must close alternate inspection/diagnosis writes for in-scope requests. | Record the new CR authority and the narrow endpoint permission/transition boundary in the roadmap/contract map before implementation. Do not describe it as CR-HM-04 crew assignment. |

The previously deferred direct-quotation service-eligibility policy remains a separate owner decision. It is not a reason to add criteria to this inspection contract and is not resolved by an accepted report.

## 13. Freeze checklist

Before this contract is marked **FROZEN** or implemented:

- close D1–D7 and record the owner decisions;
- add this authority to the frozen roadmap/contract map and clarify the narrow CR-HM-03 F8 inspection/diagnosis write boundary;
- verify the final routes, permission checks, scope checks, and direct-route isolation against those decisions;
- approve the additive persistence and report-to-0381/0382 linkage; and
- run only the focused tests for this contract first. Do not use this design as authorization for a full-suite run, deploy, PIC/Execution Scope change, or direct-quotation policy implementation.

## 14. Final authority reconciliation — baseline `fe9ba93`

The dated [`Final Authority Reconciliation & Freeze Review`](CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md) records the owner's proposals 1–8 against the frozen CR-HM-03/04 authorities and current schema/services/routes/RBAC. That reconciliation supersedes earlier open items only where it explicitly says so (notably diagnosis-to-accepted-report linkage, use of the existing authenticated `users.id` identity without a new worker profile/context, and reviewer/submitter separation). For diagnosis provenance, it proposes retaining the existing separate diagnosis write after report acceptance and storing the accepted report id directly on 0382; it does not assume review-time diagnosis materialization. It **does not** mark this contract frozen. The companion [CR-HM-03 F8 amendment proposal](CR-HM-INSPECTION-01_CR-HM-03_F8_AMENDMENT_01_PROPOSAL.md) is also not ratified; roadmap numbering remains unchanged.

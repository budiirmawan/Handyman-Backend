# W03 — Inspection-to-Quotation Mechanism Gap Review

| Field | Value |
|---|---|
| Date | 2026-10-11 (Asia/Jakarta) |
| Branch / baseline | `arena/b4a8612c-handyman-backend` / `4cf29279b3bf8635a22e40f12327ac6f542c65fe` |
| Scope | Read-only review of triage, inspection, assignment, diagnosis, quotation draft/issue, exception authority, persistence/provenance, transitions, and E2E coverage |
| Changes | Report-only review at the baseline; see the dated implementation follow-up below for subsequent changes. |

> Historical findings below describe the reviewed baseline, before the CR-HM Inspection-Quotation Part 01 follow-up.

## Executive finding

The runtime has two request paths: Operations triage can require inspection or route directly to diagnosis; both paths can reach diagnosis, and quotation creation requires that diagnosis. **The implementation does not enforce the owner rule that inspection is the normal pre-quotation path and that skipping it is allowed only when scope is sufficiently clear under existing policy.** The direct lane is a real, Operations-permissioned `DIAGNOSIS` choice, but its only reason is the same generic free-text triage note used for all decisions. Neither quotation creation nor issue checks for an inspection or a defined direct-quotation criterion.

This is a policy-enforcement gap, not a missing diagnosis or quotation engine. Do not make inspection unconditional or remove the direct lane: frozen CR-HM-03 expressly allows `DIAGNOSIS` when inspection is not needed. Preserve the decision-maker and exception scope; criteria must come from the already-authorized owner policy, not be inferred in this review.

## Findings at a glance

| Mechanism | Status |
|---|---|
| Triage choice: inspect or direct-to-diagnosis | **PARTIAL** |
| Inspection report/evidence | **PARTIAL** |
| Pre-quotation assigned field worker | **MISSING** |
| Diagnosis and path transitions | **VERIFIED EXISTING** |
| Operations acceptance of inspection | **MISSING** |
| Direct-quotation exception authority/reason | **PARTIAL** |
| Quotation draft/issue against owner rule | **PARTIAL** |
| Persistence/report-to-quotation provenance | **PARTIAL** |
| Reinspection/diagnosis amendment | **MISSING** |
| Commercial quotation revisions | **VERIFIED EXISTING** |
| PIC approval/Execution Scope gate | **VERIFIED EXISTING — separate from inspection** |
| Requested 03H-05B E2E coverage | **NOT VERIFIED** |

Status legend: **VERIFIED EXISTING** = bounded mechanism is present; **PARTIAL** = a related mechanism exists but does not enforce/persist the full owner requirement; **MISSING** = absent or explicitly excluded by the frozen contract; **NOT VERIFIED** = required artifact/evidence was not found.

## Detailed findings

### 1. Triage choice: inspection or direct-to-diagnosis — **PARTIAL**

`src/modules/handyman-requests/handyman-request-triage.types.ts:11-17` defines exactly `INSPECTION_REQUIRED` and `DIAGNOSIS`. `recordHandymanRequestTriage()` validates the disposition and a required 1–500-character `triageNote`, checks `INTAKE`, persists one immutable decision, and projects the selected status (`src/modules/handyman-requests/handyman-request-triage.service.ts:73-159`). The HTTP write requires the dedicated `handyman.operations.request.triage` permission (`src/modules/handyman-lifecycle-api/handyman-lifecycle-api.routes.ts:45-60`).

This records an Operations choice; it does **not** encode a clarity threshold or test when inspection may be skipped. Frozen CR-HM-03 describes `DIAGNOSIS` as the alternative when physical inspection is not needed (`docs/handyman/CR-HM-03_START_GOVERNANCE.md:126-130, 200-210`), but does not define a measurable quote exception.

**Smallest follow-up:** use the existing triage authority and note. If an existing owner policy has objective criteria, document and test those at the triage decision boundary. Do not add a role or make inspection universal.

### 2. Inspection report and evidence — **PARTIAL**

`recordHandymanInspection()` accepts only `INSPECTION_REQUIRED`, persists `INSPECTED`/`NOT_INSPECTABLE`, bounded notes, local actor and server time, then advances to `DIAGNOSIS` (`src/modules/handyman-requests/handyman-request-inspection.service.ts:63-173`; `src/modules/handyman-requests/handyman-request-inspection.types.ts:15-53`). Migration `0381` stores these facts and enforces one immutable inspection per request (`src/database/migrations/0381_create_handyman_request_inspections.ts:39-59`). The record has no evidence reference or checklist result.

The evidence omission is intentional under CR-HM-03 F3: inspection evidence is deferred to CR-HM-10 (`docs/handyman/CR-HM-03_START_GOVERNANCE.md:144-152`; `docs/handyman/CR-HM-03_FINAL_VALIDATION.md:16-19`).

**Smallest follow-up:** if evidence is required for this journey, consume the existing CR-HM-10 evidence authority under its approved contract. Do not expand the frozen CR-HM-03 inspection record here.

### 3. Pre-quotation field-worker assignment and inspector authorization — **MISSING**

The inspection route requires `tenant_company.manage`; the service checks authenticated local-user identity and request-derived building access, not a worker/crew assignment (`src/modules/handyman-lifecycle-api/handyman-lifecycle-api.routes.ts:67-71`; `src/modules/handyman-requests/handyman-request-inspection.service.ts:76-79, 119-125`). CR-HM-03 explicitly excludes provider assignment (`docs/handyman/CR-HM-03_START_GOVERNANCE.md:181-182`). The existing CR-HM-04 assignment service is for an `AUTHORIZED` Execution Scope, not a pre-quotation inspection (`src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts:64-78, 198-229`; `src/modules/handyman-scope-assignments-api/handyman-scope-assignments-api.routes.ts:14-22`).

**Smallest follow-up:** first obtain an owner/roadmap decision on whether inspection must be assigned to a field worker before quotation; that changes the frozen CR-HM-03/CR-HM-04 boundary. Do not create an early Execution Scope or infer assignment authority.

### 4. Diagnosis/report and path transitions — **VERIFIED EXISTING**

`recordHandymanDiagnosis()` accepts only request status `DIAGNOSIS`; that status is reachable from either direct triage or a completed inspection. It derives classification and next status from an active Handyman discipline and persists an immutable diagnosis (`src/modules/handyman-requests/handyman-request-diagnosis.service.ts:28-40, 58-135, 169-217`; `src/modules/handyman-requests/handyman-request-diagnosis.types.ts:13-42`). Service tests separately exercise direct and inspected diagnosis (`tests/handyman-request-diagnosis.test.ts:284-327`).

This supplies a bounded diagnosis summary and scope classification. It is not an inspection acceptance or evidence report.

### 5. Operations review/acceptance of the field report — **MISSING**

The inspection transaction records an inspector and moves the request straight to `DIAGNOSIS` (`src/modules/handyman-requests/handyman-request-inspection.service.ts:133-171`). Diagnosis is a separate `tenant_company.manage` write; no inspection-review/acceptance state, decision row, release gate, or Operations acceptance route was found. Operations triage is the earlier routing decision, not acceptance of the later field report.

**Smallest follow-up:** the owner must decide whether a separate Operations release is required and, if so, its authority and place in the frozen transition chain. Do not treat diagnosis or Tenant/PIC quotation approval as that acceptance.

### 6. Direct-quotation exception authority and reason — **PARTIAL**

The direct lane is not a quote-from-triage shortcut: Operations selects `DIAGNOSIS`, a permitted manager records diagnosis, and quotation creation requires a quotable diagnosis. The triage note is mandatory and immutable, so a human-readable rationale can be recorded. But there is no distinct exception reason or structured “scope clear / policy permits” check; quotation creation does not read or validate the triage note or disposition.

**Smallest follow-up:** confirm whether the existing policy treats the Operations `DIAGNOSIS` disposition plus its note as sufficient exception authority. If it does, record that interpretation in the owner contract and add a no-inspection quote-path acceptance test. If it does not, obtain the policy decision before adding a gate; do not invent criteria here.

### 7. Quotation draft and issue gate — **PARTIAL**

`createHandymanQuotation()` derives lineage from the request and requires an existing diagnosis in its quotable allowlist before creating a DRAFT (`src/modules/handyman-quotations/handyman-quotation.service.ts:35-42, 84-163`). It does not require inspection. `issueHandymanQuotationVersion()` checks building access, `DRAFT`, at least one line and a future `validUntil`, then records `ISSUED` (`src/modules/handyman-quotations/handyman-quotation-lifecycle.service.ts:80-180`); it does not re-check inspection or a direct exception criterion. Thus the owner rule is not enforced at either quote creation or issue.

There is also a scope-token mismatch to resolve: diagnosis emits `SPECIALIST_REQUIRED` (`src/modules/handyman-requests/handyman-request-diagnosis.types.ts:13-29`), while the quotation allowlist is `GENERAL_HANDYMAN` and `SPECIALIST` (`src/modules/handyman-quotations/handyman-quotation.service.ts:53-54`). The emitted specialist classification is therefore rejected. Current quote tests cover general and out-of-scope cases, not specialist quotation (`tests/handyman-quotation.test.ts:371-393`).

**Smallest follow-up:** confirm the existing CR-HM-06 policy for `SPECIALIST_REQUIRED`; if quotable, align the allowlist with that existing token and add a regression. If not, make the restriction explicit. No scope expansion is assumed.

### 8. Persistence and report-to-quotation provenance — **PARTIAL**

Triage, inspection and diagnosis are immutable, one-per-request records (migrations `src/database/migrations/0380_create_handyman_request_triage.ts:48-68`, `src/database/migrations/0381_create_handyman_request_inspections.ts:39-59`, `src/database/migrations/0382_create_handyman_diagnosis_scope_authority.ts:94-119`). Quotation roots are unique per request; versions persist quote/version/lifecycle facts (`src/database/migrations/0391_create_handyman_quotations.ts:35-69`; `src/modules/handyman-quotations/handyman-quotation.types.ts:24-48`). The quote root/version does not persist a diagnosis ID or inspection ID.

Initial quotation creation does persist `handymanDiagnosisId` and request/version IDs in `HANDYMAN_QUOTATION_VERSION_CREATED` audit metadata (`src/modules/handyman-quotations/handyman-quotation.service.ts:142-159`); no inspection ID is included. The chain can be reconstructed by request ID, but the quote has no canonical direct inspection/report reference. CR-HM-03 governance says diagnosis relates to the request plus triage/inspection chain IDs (`docs/handyman/CR-HM-03_START_GOVERNANCE.md:154-162`), whereas migration `0382` contains only the request FK for that relationship.

**Smallest follow-up:** if explicit inspection provenance is required at audit level, add the existing inspection ID to the quotation-created event metadata when present (no new schema). If an immutable per-version FK/snapshot is required, that is a separate owner-approved schema decision and is outside this review.

### 9. Reinspection and diagnosis amendment — **MISSING**

Migration `0381` enforces `UNIQUE(handyman_request_id)` and documents one trip/no re-inspection vocabulary (`src/database/migrations/0381_create_handyman_request_inspections.ts:19-21, 54-55`). The service accepts inspection only while status is `INSPECTION_REQUIRED`; after the first inspection the request is `DIAGNOSIS`, and a second attempt fails (`src/modules/handyman-requests/handyman-request-inspection.service.ts:114-151`; `tests/handyman-request-inspection.test.ts:287-344`). Diagnosis is also unique and append-only (`src/database/migrations/0382_create_handyman_diagnosis_scope_authority.ts:114-119, 126-143`).

**Smallest follow-up:** keep this frozen boundary. If pre-quotation reinspection or diagnosis amendment is required, obtain an explicit roadmap/CR-HM-10 authority decision; do not simulate it with a quotation revision or mutate these records.

### 10. Commercial quotation revisions — **VERIFIED EXISTING**

`createHandymanQuotationRevision()` appends a monotonic new DRAFT version; prior versions are not rewritten (`src/modules/handyman-quotations/handyman-quotation.service.ts:167-219`). Issuing a replacement supersedes only the current ISSUED version, preserving approved/rejected/expired facts (`src/modules/handyman-quotations/handyman-quotation-lifecycle.service.ts:80-83, 120-152`). These are commercial revisions, not reinspection: a revision carries no new diagnosis/inspection reference, and the one-diagnosis/one-inspection records cannot be amended.

### 11. PIC approval and Execution Scope boundary — **VERIFIED EXISTING; separate from inspection**

Migration `0443` requires a matching Tenant/PIC `APPROVE`, the exact approved quotation version, an active approval binding/session and matching request context before an `AUTHORIZED` Execution Scope insert (`0443_handyman_execution_scope_approval_gate.ts:23-70, 142-159`). Crew assignment then requires that scope to be `AUTHORIZED` (`src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts:64-78`). This is the existing post-approval execution gate; it is **not** a pre-quotation inspection or quotation-issue gate.

B12 remains OFF, so issuing without a binding is intentionally allowed (`docs/e2e/W03_PART03E_TENANT_PIC_QUOTATION_DECISION_AUTHORITY.md:115`; `tests/handyman-pic-portal-decide.test.ts:1045-1062`). Preserve PIC approval authority and S1 staff decision 403.

### 12. Requested 03H-05B E2E and both paths — **NOT VERIFIED**

No tracked `03H-05B` file or exact identifier exists in this checkout. The tracked `tests/handyman-w03-03h05-integrated-journey.test.ts:8-14` is 03H-05, not 05B, and is `SKIP 1/1`; its journey is explicitly uncertified (`docs/e2e/W03_PART03H-05_INTEGRATED_E2E_JOURNEY.md:5, 13-18`). Existing tests cover triage and inspection through HTTP and direct/inspected diagnosis at service level, but quotation tests use the direct-diagnosis fixture; their `_inspectedDiagnosisFixture` helpers are not called (`tests/handyman-lifecycle-api.test.ts:220-250, 290-336`; `tests/handyman-quotation.test.ts:207-284`; `tests/handyman-quotation-lifecycle.test.ts:210-286, 340-356`). No existing E2E demonstrates both complete paths through quotation draft/issue.

**Smallest follow-up:** add/restore an HTTP journey with two request threads (one inspection-required, one policy-approved direct path), then exercise diagnosis, quote draft, lines and issue through production routes. The owner clarification in `docs/e2e/W03_G9_SIMPLIFICATION_REVIEW.md:18-32` permits a test-only BM integration/ephemeral-secret fixture; admission and PIC decisions must still use actual routes. Do not call protected services/repositories or write PIC decisions/Execution Scopes directly. The existing 03H-05 skip is not a pass.

## Implementation follow-up — CR-HM Inspection-Quotation Part 01 (2026-10-11)

This addendum records implementation after the read-only baseline review above; the findings above are not rewritten.

- Omitted triage disposition now defaults to `INSPECTION_REQUIRED` in both the HTTP parser and service. `DIAGNOSIS` remains an explicit direct-to-diagnosis exception.
- The existing required `triageNote` is documented and tested as the durable rationale for `DIAGNOSIS`. The immutable decision record retains actor/time and reason; the existing journal event links the decision ID and records its disposition. No migration or new audit payload was added.
- The requested direct-quotation clarity/service eligibility gate and its eligible/disallowed-service tests are **deferred** until authoritative service policy is supplied. This plumbing does not claim that a `DIAGNOSIS` decision alone establishes quotation eligibility.
- The quotation scope allowlist now uses canonical `SPECIALIST_REQUIRED` (the diagnosis classification); `SPECIALIST` remains the derived referral type. A focused regression covers specialist quotation preparation.
- No field assignment, Operations report acceptance, quotation issue gate, evidence expansion, new RBAC, or change to PIC approval, Execution Scope, S1, B12, migration 0441, or integration ownership was made.
- Validation on this follow-up: production `npm run typecheck` passed. Focused tests passed: `handyman-request-triage.test.ts` (10), `handyman-lifecycle-api.test.ts` (10), `handyman-quotation.test.ts` (11), and `handyman-intake-triage-journey.test.ts` (27). The test databases were temporary embedded PostgreSQL instances; the full suite was not run.

## Implementation follow-up — Part 02 STOP: pre-quotation Field report lifecycle (2026-10-11; baseline `66a0421`)

**Baseline:** branch `arena/b4a8612c-handyman-backend`; local and remote HEAD both `66a0421a1cdf76ce5ccea457f4f1708f66aa1900`; worktree clean.

**Outcome: no Part 02 runtime, migration, or new lifecycle tests were added.** The owner rule requires a new pre-quotation assignment/report/review lifecycle, but current authoritative persistence and assignment contracts cannot represent it. The requested stop rule is therefore triggered; implementation is paused for the owner decisions below. This is a boundary finding, not a test failure.

### Existing authorities verified

- **Inspection capture:** Migration `0381_create_handyman_request_inspections.ts` stores one immutable row per request (`UNIQUE(handyman_request_id)`): `inspection_result`, bounded `inspection_notes`, `inspected_by_user_id`, `inspected_at`, and the request-derived client/building/channel snapshot. Its trigger prohibits update/delete. `recordHandymanInspection()` accepts only `INSPECTION_REQUIRED`, checks the actor's request-building access, inserts the record, and immediately projects the request to `DIAGNOSIS`; it does not verify a request-specific Field assignment. The HTTP write uses `tenant_company.manage`. F3 still prohibits adding evidence here.
- **Diagnosis/scope:** Migration `0382_create_handyman_diagnosis_scope_authority.ts` stores one immutable diagnosis per request: diagnosis text, F9 discipline/classification, optional recommended `service_catalog` item, diagnosing user and timestamp. It has no assignment, inspection-report version or review reference. The service accepts only request status `DIAGNOSIS`; the inspection service has already projected to that status before any review step exists.
- **Assignment:** CR-HM-04 PART 04 explicitly deferred target binding until an authoritative operational target existed. The implemented CR-HM-04 assignment targets only a `HANDYMAN_EXECUTION_SCOPE` in `AUTHORIZED` status and binds a provider crew; that scope is created after PIC approval. It is not a pre-quotation request assignment, and does not implement the new owner rule that Operations assigns a Field Worker/Surveyor. Building assignment is resource-access scope, not work-item assignment.
- **Commercial amounts:** Existing quotation lines are immutable operator-authored commercial facts. CR-HM-12 labor basis consumes approved LABOR lines and governed time/crew inputs; material basis consumes approved MATERIAL snapshots and CR-HM-09 quantities. Neither is a pre-quotation Field estimate authority. No estimate was written into quotation lines or pricing-basis records.
- **Review authority and audit:** `handyman.operations.request.triage` authorizes triage, not inspection-report acceptance/return. The current inspection event (`HANDYMAN_INSPECTION_RECORDED`) links the inspection id/result and actor but is F6 audit history, not a review-state source. Reusing triage or generic `tenant_company.manage` for acceptance would extend authority without an explicit contract.

### Exact persistence and authority gap

1. **No pre-quotation assignment record:** there is no request-targeted row binding the inspection-required request to an assigned Field identity (local user/worker context versus provider crew/Lead is itself undecided), with assigner, timestamp, active/reassignment history, and an enforceable link checked by submission. The only implemented crew assignment is post-PIC-approval Execution Scope assignment.
2. **No versioned report/review lifecycle:** the one-per-request 0381 inspection row is immutable and cannot be returned then corrected/resubmitted. It has no assignment id, report version, structured technical findings/estimates, reviewer, review timestamp, accept/return disposition or return reason. The frozen F1 request status set has no report-submitted/accepted/returned states. Operational events cannot substitute for this business state.
3. **No supported pre-quotation estimate model:** the diagnosis record can hold a diagnosis and optional recommended service, but not Field-authored report revisions or itemized labor/material estimates. CR-HM-12 and quotation-line models are downstream commercial/pricing authorities, not a valid place to store unapproved inspection estimates.
4. **No actor contract for the two new actions:** inspection currently permits a building-scoped `tenant_company.manage` actor, not only the assigned Field Worker. No existing permission is defined for Operations report acceptance/return. The triage permission cannot be presumed to grant that new decision.

### Minimum owner decisions before implementation

- Amend/confirm the assignment boundary: is Operations the assigner of an individual local user/worker context, or does Operations select a provider crew whose current Lead is the Field submitter? Approve the pre-quotation Handyman request as an assignment target without creating an Execution Scope before Tenant/PIC approval.
- Define the actor authority for report submission and for Operations acceptance/return, including whether any existing permission is explicitly extended. Do not infer this from building access, `tenant_company.manage`, or triage permission.
- Approve additive, append-only persistence that preserves all 0381/0382 history: a request-scoped assignment fact; versioned report submissions tied to that assignment; and an immutable review decision per submission with `ACCEPTED`/`RETURNED`, reviewer, timestamp and correction reason. Decide how the current report state is projected/derived without expanding frozen F1 request statuses.
- Define how report submission carries technical findings, the diagnosis/recommended F9 scope, and indicative labor/material estimates (including units/currencies and whether values are informational or priced). Decide whether the canonical diagnosis row is created only after acceptance or is itself part of the Field report; it cannot be overwritten on return.
- Make the accepted-report prerequisite explicit at quotation **draft preparation** for inspection-required requests. No quotation issue gate is proposed or implemented in this PART; PIC approval and the post-approval Execution Scope gate remain unchanged.

Until those decisions authorize a lifecycle model, the requested new tests (assigned Field submit, same-building unassigned Field denial, wrong-building denial, report submission, Operations accept, and return/correction) have no valid persistence/authority contract to assert. Existing authority-only tests were run instead: inspection record `10/10` and Execution Scope assignment API `10/10`. Production `npm run typecheck` passed. No full suite was run.

## Guardrails and disposition

- CR-HM-03 F1/F3 and the frozen roadmap remain authoritative. Evidence and reinspection are not silently added to CR-HM-03; evidence stays with CR-HM-10.
- At the baseline review, no engine, schema, migration, production code, RBAC model or permission was created or requested; the implementation follow-up is scoped as described above.
- No change to Handyman-owned integration configuration, BM channel attribution, Tenant/PIC quotation decision authority, session validation, binding/audit behavior, S1 staff 403, B12 OFF, migration 0441 behavior, or the 0443 Execution Scope gate.
- At the baseline review, no tests were run. For the later focused validation, see the dated addendum. No full suite, PR, or deploy was performed.

## Recommended order if follow-up is authorized

1. Confirm the existing direct-to-diagnosis policy: what “scope sufficiently clear” means and whether the immutable Operations triage note is the approved exception reason.
2. The Part 02 owner rule now requires pre-quotation Field assignment and Operations report acceptance/return. Resolve its conflict with the frozen CR-HM-03/CR-HM-04 boundary by approving the assignment target/author, actor permissions, report version/review persistence, and quote-draft prerequisite before implementation.
3. Confirm whether `SPECIALIST_REQUIRED` is an allowed quotation scope; then align the existing token/check and add a focused regression.
4. Build an API-level two-path E2E using only the approved test fixture setup and real protected routes; retain the staff 403 and verify no Execution Scope exists before PIC approval.
5. Only after explicit approval, address inspection provenance/reinspection within the authority that owns it. Do not modify immutable history or enable B12 as part of this work.

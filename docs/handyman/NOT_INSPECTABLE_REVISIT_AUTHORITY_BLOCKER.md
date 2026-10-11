# NOT_INSPECTABLE / controlled revisit — authority blocker

## Verified baseline

- Expected ancestor: `3332e65`.
- Actual local and remote HEAD: `1ace12edc6ab92ea98f9c4ee806a05c44decf963`.
- Current branch: `arena/d04dc185-handyman-backend`; clean before this report.
- The additional commit records bounded quotation-journey revalidation only.
- Review confined to the existing inspection/report prerequisite, request lifecycle,
  scheduling/readiness and evidence contracts and their corresponding runtime.

**Outcome: BLOCKED before implementation.** This report is not a new authority,
ratification or completed workflow. No production code, migration, permission,
route or test was changed. No production typecheck or test was run in this task;
there is no new PASS/FAIL/SKIP result to claim.

## 1. Blocking mismatch: cancel/close through an existing authorized lifecycle

The requested Operations decision includes cancel/close **through an existing
 authorized lifecycle**. The request vocabulary has only:

`INTAKE`, `TRIAGE`, `INSPECTION_REQUIRED`, `DIAGNOSIS`,
`READY_FOR_NEXT_STEP`, `REFERRED`.

There is no pre-quotation cancellation/closure decision in the inspected Handyman
request/lifecycle surface. `REFERRED` is not a generic cancellation token: the
referral service requires an immutable diagnosis with an eligible F9 classification.
An inaccessible site does not establish an OUT_OF_HANDYMAN_SCOPE diagnosis.
Borrowing FM cancellation or post-execution closure would cross lifecycle authority.

Evidence:

- `src/modules/handyman-requests/handyman-service-request.types.ts` — bounded
  status vocabulary and explicit prohibition on borrowing FM cancellation semantics.
- `src/modules/handyman-lifecycle-api/handyman-lifecycle-api.routes.ts` — existing
  triage/inspection/diagnosis/referral surface, no request cancellation/closure operation.
- `src/modules/handyman-requests/handyman-request-referral.service.ts` — diagnosis
  is the sole source of referral eligibility (lines 109 onward).
- `docs/handyman/CR-HM-03_START_GOVERNANCE.md`, F1/F3/F5 — bounded lifecycle,
  evidence boundary and terminal referral semantics.
- `docs/handyman/CR-HM-INSPECTION-01_FINAL_AUTHORITY_RECONCILIATION.md`, §4.2 —
  cancellation/escalation semantics remained an explicit unresolved decision.

**Decision needed:** identify the intended existing pre-quotation cancel/close
contract if it exists outside these authorities, or explicitly authorize a new
bounded Operations terminal disposition. A possible additive design is an
append-only request-scoped closure fact, with no F1 status renaming, that blocks
further assignment, capture, report/review, diagnosis and new quotation writes.
Whether such closure is permanent or reopenable also needs to be explicit. This
proposal is not implemented or treated as approved by this report.

## 2. Scheduling boundary: preferred window is not a confirmed visit booking

The existing CR-HM-05 runtime supports request-scoped scheduling readiness,
Building-derived timezone and superseding preferred-window history. Those are
reusable before quotation. The service explicitly states that readiness does
not create an execution schedule, reserve worker capacity or bind an execution
 target.

The frozen target-binding contract distinguishes preferred windows from scheduled
commitments and requires the real CR-HM-06 Execution Scope created after customer
quotation approval. A pre-inspection revisit cannot satisfy that prerequisite.
Creating a placeholder scope or approving a quotation to obtain a scheduling
 target would violate the requested PIC/Execution Scope safeguards.

Evidence:

- `src/modules/handyman-scheduling/handyman-scheduling.service.ts` — readiness-only
  contract; create/supersede behavior, timezone and exact-Building guards.
- `src/modules/handyman-readiness-api/handyman-readiness-api.routes.ts` — existing
  readiness HTTP surface, not a target-binding scheduling operation.
- `docs/handyman/CR-HM-05_DECISION_FREEZE.md`, F2/F3/F9.
- `docs/handyman/CR-HM-05_PART05_TARGET_BINDING_CONTRACT.md`, §§1, 4–6 — real
  approved scope required; preferred and committed windows are distinct.

**Decision needed:** may this workflow record an Operations-requested revisit
linked to the exact existing readiness/preferred-window version, without claiming
a confirmed schedule/capacity reservation? If an actual confirmed Field-visit
booking is required, explicitly authorize a pre-quotation inspection-attempt
schedule subject rather than weakening the existing execution-scope binding.

## 3. Verified implementation constraints (not additional claimed blockers)

The owner's current request explicitly permits separately traceable revisit
attempts. The one-record constraint is therefore an additive design problem,
not a reason to ask again whether a second visit is wanted:

- Migration 0381 enforces one immutable physical inspection per request.
- PART A binds Field capture to an active request assignment and exact Building.
- PART B correction versions currently document that same physical inspection;
  a returned report alone does not represent a second visit.
- A new attempt/result link and attempt-specific assignment trace must preserve
  the original row and distinguish report correction from physical revisit.
  Migrations 0441–0448 must remain unchanged.

Evidence applicability also needs to remain honest. Request-intake evidence and
post-approval Execution-Scope evidence/QC already exist, but neither may silently
be relabeled as a new inspection-attempt upload authority. Where an existing
same-request evidence reference is applicable, its provenance/access must be
validated. No arbitrary URL, fake evidence parent or parallel storage engine is
introduced by this report.

## 4. Known gap against the new diagnosis requirement

Current `resolveAcceptedInspectionReport()` validates latest-report acceptance
but does not require physical result `INSPECTED`. The physical-result check is
currently inside `assertInspectionQuotationPrerequisite()` only.

Consequently an accepted `NOT_INSPECTABLE` report can currently source a diagnosis,
while initial/revision quotation DRAFT is refused. The existing focused test
`accepted NOT_INSPECTABLE cannot authorize initial or revision DRAFT` in
`tests/handyman-inspection-prerequisite.test.ts` explicitly expects diagnosis 201.

The new requirement to block **both diagnosis and quotation** is not yet
implemented. When work resumes, it requires a shared successful-attempt check at
diagnosis as well as quotation, a compatible additive database guard and updated
focused assertions. An Operations revisit/return/closure decision must never be
mistaken for technical inspection acceptance.

## 5. Stop state and next scope

Stopped rather than inventing cancellation authority or misrepresenting readiness
as a confirmed booking. After the two decisions above are resolved, the bounded
implementation can cover structured unsuccessful-result reasons, append-only
Operations resolution, traceable attempt/assignment history, readiness linkage,
success-only preparation prerequisites, concurrency/Building/actor guards and
focused PostgreSQL/revisit regression tests.

Both prior quotation journeys, signed PIC approval, S1 staff 403, B12 OFF and all
existing migrations are untouched. Their previous passing results are historical
results, not a claim that the requested revisit workflow now passes. No full suite,
PR, deploy, destructive Git operation or unrelated redesign occurred.
